package com.htit.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.os.Build;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;
import android.view.WindowManager;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Foreground service owning MediaProjection: captures screen frames and streams JPEG
 * frames to the single live AgentSession. Projection stop callbacks tear the session down.
 */
public final class ScreenCastService extends Service {
    private static final String TAG = "HTITRemote";
    private static final String CH_ID = "htit_remote_cast";
    private static final int FGS_ID = 91;
    static final long FRAME_INTERVAL_MS = 67; // cap at ~15 fps
    private static final int JPEG_QUALITY = 90;

    /** Session from MainActivity before the service starts (avoid bind races). */
    public static volatile RemoteSession pendingSession;

    private volatile MediaProjection projection;
    private volatile VirtualDisplay display;
    private volatile ImageReader reader;
    private volatile RemoteSession holder;
    private Handler castHandler;
    private HandlerThread castThread;
    private DisplayManager displayManager;
    private int captureWidth;
    private int captureHeight;
    private int captureRotation;
    private Bitmap paddedBitmap;
    private Bitmap frameBitmap;
    private Canvas frameCanvas;
    private final ByteArrayOutputStream jpegStream = new ByteArrayOutputStream(256 * 1024);
    private long lastFrameAtMs;
    private final AtomicBoolean streaming = new AtomicBoolean(false);
    private final AtomicBoolean tornDown = new AtomicBoolean(false);
    private static volatile ScreenCastService activeInstance;
    private final DisplayManager.DisplayListener displayListener = new DisplayManager.DisplayListener() {
        @Override public void onDisplayAdded(int displayId) { }
        @Override public void onDisplayRemoved(int displayId) { }
        @Override public void onDisplayChanged(int displayId) {
            if (displayId == Display.DEFAULT_DISPLAY && streaming.get()) resizeStream();
        }
    };

    public static void startStreaming(Context ctx, RemoteSession session, int resultCode, Intent resultData) {
        if (session == null || !session.isReady()) {
            pendingSession = null;
            return;
        }
        pendingSession = session;
        Intent i = new Intent(ctx, ScreenCastService.class);
        i.putExtra("code", resultCode);
        i.putExtra("data", resultData);
        ctx.startForegroundService(i);
    }

    public static void stopStreaming(Context ctx) {
        ScreenCastService inst = activeInstance;
        if (inst != null) inst.teardown("user-stop-service");
        ctx.stopService(new Intent(ctx, ScreenCastService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        activeInstance = this;
        holder = pendingSession;
        pendingSession = null;
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CH_ID, "HTIT Remote — Chia sẻ màn hình", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Chỉ báo khi đang chia sẻ màn hình tới người hỗ trợ");
        nm.createNotificationChannel(ch);
        Notification n = new Notification.Builder(this, CH_ID)
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle("Màn hình đang được chia sẻ")
                .setContentText("HTIT Remote đang chia sẻ màn hình tới người hỗ trợ")
                .setOngoing(true)
                .build();
        startForeground(FGS_ID, n);
        castThread = new HandlerThread("htr-cast");
        castThread.start();
        castHandler = new Handler(castThread.getLooper());
        displayManager = getSystemService(DisplayManager.class);
        displayManager.registerDisplayListener(displayListener, castHandler);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (castHandler != null && streaming.get()) castHandler.post(this::resizeStream);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        int resultCode = intent != null ? intent.getIntExtra("code", -1) : -1;
        Intent data = intent != null ? intent.getParcelableExtra("data") : null;
        if (pendingSession != null) { holder = pendingSession; pendingSession = null; }
        RemoteSession s = holder;
        if (data == null || s == null || !s.isReady()) {
            teardown("no-data");
            return START_NOT_STICKY;
        }
        try {
            projection = ((MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE))
                    .getMediaProjection(resultCode, data);
            projection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    teardown("projection-stopped");
                }
            }, castHandler);
            startStream();
        } catch (Exception e) {
            Log.e(TAG, "bật chia sẻ thất bại", e);
            MainActivity.showStatus("Không khởi tạo được chia sẻ màn hình: " + e.getMessage());
            teardown("start-failed");
        }
        return START_NOT_STICKY;
    }

    private void startStream() {
        int[] metrics = captureMetrics();
        int w = metrics[0];
        int h = metrics[1];
        int densityDpi = metrics[2];
        captureRotation = metrics[3];
        captureWidth = w;
        captureHeight = h;
        if (!streaming.compareAndSet(false, true)) return;
        reader = createReader(w, h);
        display = projection.createVirtualDisplay("htit-capture", w, h, densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC, reader.getSurface(), null, castHandler);
        try {
            JSONObjectAccept(w, h);
        } catch (Exception e) {
            teardown("accept-failed");
        }
    }

    private int[] captureMetrics() {
        DisplayMetrics dm = new DisplayMetrics();
        WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        Display currentDisplay = wm.getDefaultDisplay();
        currentDisplay.getRealMetrics(dm);
        int sourceW = Math.max(1, dm.widthPixels);
        int sourceH = Math.max(1, dm.heightPixels);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Rect bounds = wm.getMaximumWindowMetrics().getBounds();
            sourceW = Math.max(1, bounds.width());
            sourceH = Math.max(1, bounds.height());
        }
        int rotation = currentDisplay.getRotation();
        int orientation = getResources().getConfiguration().orientation;
        if ((orientation == Configuration.ORIENTATION_LANDSCAPE && sourceW < sourceH)
                || (orientation == Configuration.ORIENTATION_PORTRAIT && sourceW > sourceH)) {
            int swap = sourceW;
            sourceW = sourceH;
            sourceH = swap;
        }
        return new int[] { sourceW, sourceH, dm.densityDpi, rotation };
    }

    private ImageReader createReader(int width, int height) {
        ImageReader result = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        result.setOnImageAvailableListener(this::onImageAvailable, castHandler);
        return result;
    }

    private void resizeStream() {
        if (!streaming.get() || display == null) return;
        int[] metrics = captureMetrics();
        int w = metrics[0];
        int h = metrics[1];
        if (w == captureWidth && h == captureHeight) {
            captureRotation = metrics[3];
            return;
        }
        ImageReader replacement = createReader(w, h);
        try {
            ImageReader previous = reader;
            display.setSurface(null);
            display.resize(w, h, metrics[2]);
            display.setSurface(replacement.getSurface());
            reader = replacement;
            captureWidth = w;
            captureHeight = h;
            captureRotation = metrics[3];
            lastFrameAtMs = 0;
            releaseEncoderBuffers();
            if (previous != null) {
                previous.setOnImageAvailableListener(null, null);
                previous.close();
            }
        } catch (Exception e) {
            replacement.setOnImageAvailableListener(null, null);
            replacement.close();
            Log.w(TAG, "resize capture error", e);
            teardown("resize-failed");
        }
    }

    private void JSONObjectAccept(int w, int h) throws IOException {
        RemoteSession s = holder;
        if (s == null) throw new IOException("Không còn phiên đang hoạt động");
        JSONObject acc = new JSONObject();
        try {
            acc.put("w", w);
            acc.put("h", h);
        } catch (Exception ignored) { }
        s.startStreaming(w, h);
    }

    private void onImageAvailable(ImageReader source) {
        if (source != reader) return;
        WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        if (wm.getDefaultDisplay().getRotation() != captureRotation) {
            castHandler.post(this::resizeStream);
            return;
        }
        Image image = null;
        try {
            image = source.acquireLatestImage();
            if (image == null || !streaming.get()) return;
            long now = SystemClock.elapsedRealtime();
            if (now - lastFrameAtMs < FRAME_INTERVAL_MS) return;
            lastFrameAtMs = now;
            RemoteSession session = holder;
            if (session != null && session.canSendFrame()) session.sendFrame(encode(image));
        } catch (Exception e) {
            Log.w(TAG, "frame error: " + e);
            teardown("frame-failed");
        } finally {
            if (image != null) image.close();
        }
    }

    /** RGBA_8888 Image -> JPEG, reusing buffers to avoid a large allocation on every frame. */
    private synchronized byte[] encode(Image img) {
        Image.Plane p = img.getPlanes()[0];
        ByteBuffer buf = p.getBuffer();
        buf.rewind();
        int w = img.getWidth();
        int h = img.getHeight();
        int rowWidth = p.getRowStride() / p.getPixelStride();
        if (paddedBitmap == null || paddedBitmap.getWidth() != rowWidth || paddedBitmap.getHeight() != h) {
            releaseEncoderBuffers();
            paddedBitmap = Bitmap.createBitmap(rowWidth, h, Bitmap.Config.ARGB_8888);
            if (rowWidth != w) {
                frameBitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                frameCanvas = new Canvas(frameBitmap);
            }
        }
        paddedBitmap.copyPixelsFromBuffer(buf);
        Bitmap output = paddedBitmap;
        if (frameBitmap != null) {
            frameCanvas.drawBitmap(paddedBitmap, 0, 0, null);
            output = frameBitmap;
        }
        jpegStream.reset();
        output.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, jpegStream);
        return jpegStream.toByteArray();
    }

    private synchronized void releaseEncoderBuffers() {
        frameCanvas = null;
        if (frameBitmap != null) frameBitmap.recycle();
        if (paddedBitmap != null) paddedBitmap.recycle();
        frameBitmap = null;
        paddedBitmap = null;
        jpegStream.reset();
    }

    /** Central teardown — safe to call multiple times. */
    public void teardown(String reason) {
        if (!tornDown.compareAndSet(false, true)) return;
        streaming.set(false);
        try {
            RemoteSession s = holder;
            holder = null;
            if (s != null && s.isReady()) s.close("Thiết bị ngừng chia sẻ màn hình (" + reason + ")");
            if (display != null) {
                try { display.release(); } catch (Exception ignored) { }
                display = null;
            }
            if (reader != null) {
                reader.setOnImageAvailableListener(null, null);
                try { reader.close(); } catch (Exception ignored) { }
                reader = null;
            }
            releaseEncoderBuffers();
            if (projection != null) {
                try { projection.stop(); } catch (Exception ignored) { }
                projection = null;
            }
            MainActivity.notifyProjectionEnded();
        } catch (Exception e) {
            Log.w(TAG, "teardown: " + e);
        }
        stopSelf();
    }

    @Override
    public void onDestroy() {
        activeInstance = null;
        teardown("service-destroy");
        if (displayManager != null) displayManager.unregisterDisplayListener(displayListener);
        if (castThread != null) castThread.quitSafely();
        super.onDestroy();
    }
}
