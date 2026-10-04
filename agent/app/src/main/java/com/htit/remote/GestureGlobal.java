package com.htit.remote;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;

/**
 * Accessibility service with gesture dispatch. Must be enabled manually by the user in
 * system settings; commands are ignored otherwise. Enforces gesture capability checks.
 */
public final class GestureGlobal extends AccessibilityService {
    private static final String TAG = "HTITRemote";
    public static volatile GestureGlobal instance;
    private volatile boolean running;
    private Handler gestureHandler;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        running = true;
        gestureHandler = new Handler(getMainLooper());
        MainActivity.showStatus("Trợ năng: Đã bật (điều khiển sẵn sàng)");
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        running = false;
        instance = null;
        MainActivity.showStatus("Trợ năng: Đã TẮT — không thể điều khiển");
        return super.onUnbind(intent);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) { }

    @Override
    public void onInterrupt() { }

    public static boolean ready() {
        GestureGlobal g = instance;
        if (g == null || !g.running) return false;
        // gesture capability is encoded in the serviceInfo flags
        return (g.getServiceInfo().getCapabilities() & AccessibilityServiceInfo.CAPABILITY_CAN_PERFORM_GESTURES) != 0;
    }

    // ---- gesture building ----

    public static void tap(double nx, double ny) {
        dispatchPoint(nx, ny, 80);
    }

    public static void press(double nx, double ny, long ms) {
        dispatchPoint(nx, ny, ms);
    }

    public static void swipe(double nx1, double ny1, double nx2, double ny2, long ms) {
        GestureGlobal g = gestureOrLog();
        if (g == null) return;
        int[] size = realSize();
        Path path = new Path();
        path.moveTo((float) (nx1 * size[0]), (float) (ny1 * size[1]));
        path.lineTo((float) (nx2 * size[0]), (float) (ny2 * size[1]));
        GestureDescription.Builder b = new GestureDescription.Builder();
        b.addStroke(new GestureDescription.StrokeDescription(path, 0, Math.max(120, ms)));
        g.dispatchGestureClamped(b.build());
    }

    public static void back() {
        GestureGlobal g = instance;
        if (g == null) return;
        g.gestureHandler.post(() -> g.performGlobalAction(GLOBAL_ACTION_BACK));
    }

    public static void home() {
        GestureGlobal g = instance;
        if (g == null) return;
        g.gestureHandler.post(() -> g.performGlobalAction(GLOBAL_ACTION_HOME));
    }

    private static GestureGlobal gestureOrLog() {
        if (!ready()) {
            Log.w(TAG, "Trợ năng chưa bật hoặc thiết bị không cho phép dispatchGesture");
            return null;
        }
        return instance;
    }

    private static void dispatchPoint(double nx, double ny, long ms) {
        GestureGlobal g = gestureOrLog();
        if (g == null) return;
        int[] size = realSize();
        Path path = new Path();
        path.moveTo((float) (nx * size[0]), (float) (ny * size[1]));
        path.lineTo((float) (nx * size[0]) + 1f, (float) (ny * size[1]) + 1f);
        GestureDescription.Builder b = new GestureDescription.Builder();
        b.addStroke(new GestureDescription.StrokeDescription(path, 0, ms));
        g.dispatchGestureClamped(b.build());
    }

    private void dispatchGestureClamped(GestureDescription gd) {
        post(() -> dispatchGestureBackend(gd));
    }

    private void post(Runnable r) {
        if (gestureHandler != null) gestureHandler.post(r);
    }

    private void dispatchGestureBackend(GestureDescription gd) {
        try {
            dispatchGesture(gd, null, gestureHandler);
        } catch (Exception e) {
            Log.w(TAG, "dispatchGesture error", e);
        }
    }

    private static int[] realSize() {
        DisplayMetrics dm = new DisplayMetrics();
        MainActivity.realSize(dm);
        return new int[] { dm.widthPixels, dm.heightPixels };
    }
}
