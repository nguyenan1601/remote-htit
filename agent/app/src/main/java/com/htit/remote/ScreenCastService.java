package com.htit.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.DisplayMetrics;
import android.util.Log;
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
    static final long FRAME_INTERVAL_MS = 125; // ~8 fps MVP target

    /** Session from MainActivity before the service starts (avoid bind races). */
    public static volatile AgentServer.AgentSession pendingSession;

    private volatile MediaProjection projection;
    private volatile VirtualDisplay display;
    private volatile ImageReader reader;
    private volatile AgentServer.AgentSession holder;
    private Handler castHandler;
    private HandlerThread castThread;
    private final AtomicBoolean streaming = new AtomicBoolean(false);
    private static volatile ScreenCastService activeInstance;

    public static void startStreaming(Context ctx, AgentServer.AgentSession session, int resultCode, Intent resultData) {
        if (session == null || !session.active || !session.isReady()) {
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

    private void dlog(String m) {
        try {
            java.io.File f = new java.io.File(getExternalFilesDir(null), "cast.log");
            java.io.FileWriter w = new java.io.FileWriter(f, true);
            w.write(new java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US).format(new java.util.Date()) + " " + m + "\n");
            w.close();
        } catch (Exception ignored) { }
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
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        int resultCode = intent != null ? intent.getIntExtra("code", -1) : -1;
        Intent data = intent != null ? intent.getParcelableExtra("data") : null;
        if (pendingSession != null) { holder = pendingSession; pendingSession = null; }
        AgentServer.AgentSession s = holder;
        dlog("onStart data=" + (data != null) + " s=" + (s != null) + " active=" + (s != null && s.active) + " ready=" + (s != null && s.isReady()) + " code=" + resultCode);
        if (data == null || s == null || !s.active || !s.isReady()) {
            teardown("no-data");
            return START_NOT_STICKY;
        }
        try {
            projection = ((MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE))
                    .getMediaProjection(resultCode, data);
            dlog("projection created");
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
        DisplayMetrics dm = new DisplayMetrics();
        WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        wm.getDefaultDisplay().getRealMetrics(dm);
        int w = Math.max(1, dm.widthPixels);
        int h = Math.max(1, dm.heightPixels);
        reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2);
        display = projection.createVirtualDisplay("htit-capture", w, h, dm.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC, reader.getSurface(), null, castHandler);
        if (!streaming.compareAndSet(false, true)) return;
        try {
            JSONObjectAccept(w, h);
            dlog("accept sent " + w + "x" + h);
        } catch (Exception e) {
            dlog("accept-failed: " + e.getClass().getName() + " : " + e);
            teardown("accept-failed");
            return;
        }
        castHandler.post(frameLoop);
    }

    private void JSONObjectAccept(int w, int h) throws IOException {
        AgentServer.AgentSession s = holder;
        if (s == null) throw new IOException("Không còn phiên đang hoạt động");
        JSONObject acc = new JSONObject();
        try {
            acc.put("w", w);
            acc.put("h", h);
        } catch (Exception ignored) { }
        s.sendPacket(Wire.T_ACCEPT, acc.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private final Runnable frameLoop = new Runnable() {
        @Override
        public void run() {
            if (!streaming.get()) return;
            AgentServer.AgentSession s = holder;
            if (s != null && reader != null) {
                Image img = null;
                try {
                    img = reader.acquireLatestImage();
                    if (img != null) {
                        byte[] jpeg = encode(img);
                        if (jpeg != null) s.sendFrame(jpeg);
                    }
                } catch (Exception e) {
                    Log.w(TAG, "frame error: " + e);
                    teardown("frame-failed");
                    return;
                } finally {
                    if (img != null) img.close();
                }
            }
            castHandler.postDelayed(this, FRAME_INTERVAL_MS);
        }
    };

    /** RGBA_8888 Image -> scaled JPEG bytes. */
    private static byte[] encode(Image img) {
        Image.Plane p = img.getPlanes()[0];
        ByteBuffer buf = p.getBuffer();
        buf.rewind();
        int w = img.getWidth();
        int h = img.getHeight();
        int rowStride = p.getRowStride();
        Bitmap padded = Bitmap.createBitmap(rowStride / 4, h, Bitmap.Config.ARGB_8888);
        padded.copyPixelsFromBuffer(buf);
        Bitmap cropped = padded.getWidth() > w ? Bitmap.createBitmap(padded, 0, 0, w, h) : padded;
        Bitmap send = cropped;
        if (cropped.getWidth() > 1080) {
            int targetW = 1080;
            int targetH = cropped.getHeight() * targetW / cropped.getWidth();
            send = Bitmap.createScaledBitmap(cropped, targetW, Math.max(1, targetH), true);
        }
        ByteArrayOutputStream os = new ByteArrayOutputStream();
        try {
            send.compress(Bitmap.CompressFormat.JPEG, 60, os);
            return os.toByteArray();
        } finally {
            if (padded != cropped) padded.recycle();
            cropped.recycle();
            if (send != cropped) send.recycle();
        }
    }

    /** Central teardown — safe to call multiple times. */
    public void teardown(String reason) {
        dlog("teardown " + reason);
        if (!streaming.compareAndSet(true, false)) return;
        try {
            if (castHandler != null) castHandler.removeCallbacks(frameLoop);
            AgentServer.AgentSession s = holder;
            holder = null;
            if (s != null && s.isReady()) {
                try {
                    s.sendPacket(Wire.T_STOP,
                            ("{\"why\":\"Thiết bị ngừng chia sẻ màn hình (" + reason + ")\"}").getBytes(java.nio.charset.StandardCharsets.UTF_8));
                } catch (IOException ignored) { }
            }
            if (display != null) {
                try { display.release(); } catch (Exception ignored) { }
                display = null;
            }
            if (reader != null) {
                try { reader.close(); } catch (Exception ignored) { }
                reader = null;
            }
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
        if (castThread != null) castThread.quitSafely();
        super.onDestroy();
    }
}
