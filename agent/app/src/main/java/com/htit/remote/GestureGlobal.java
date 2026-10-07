package com.htit.remote;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.accessibilityservice.GestureDescription;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

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

    public static void inputText(String text) {
        if (text == null || text.isEmpty() || text.length() > 500) return;
        withFocusedEditable(node -> {
            if (!replaceSelection(node, text, false) && !pasteText(node, text)) {
                Log.w(TAG, "Ứng dụng đích không cho phép nhập văn bản bằng Trợ năng");
            }
        });
    }

    public static void backspace() {
        withFocusedEditable(node -> {
            if (!replaceSelection(node, "", true)) Log.w(TAG, "Ứng dụng đích không cho phép xóa văn bản bằng Trợ năng");
        });
    }

    public static void enter() {
        withFocusedEditable(node -> {
            boolean handled = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                    && node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
            if (!handled && node.isMultiLine()) replaceSelection(node, "\n", false);
        });
    }

    private interface FocusedNodeAction {
        void run(AccessibilityNodeInfo node);
    }

    private static void withFocusedEditable(FocusedNodeAction action) {
        GestureGlobal g = instance;
        if (g == null || g.gestureHandler == null) return;
        g.gestureHandler.post(() -> {
            AccessibilityNodeInfo root = g.getRootInActiveWindow();
            if (root == null) return;
            AccessibilityNodeInfo focused = null;
            try {
                focused = findFocusedEditable(root);
                if (focused == null) {
                    Log.w(TAG, "Không tìm thấy ô nhập đang được chọn");
                    return;
                }
                action.run(focused);
            } catch (Exception e) {
                Log.w(TAG, "keyboard input error", e);
            } finally {
                if (focused != null) focused.recycle();
                root.recycle();
            }
        });
    }

    private static AccessibilityNodeInfo findFocusedEditable(AccessibilityNodeInfo root) {
        AccessibilityNodeInfo focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (isEditable(focused)) return focused;
        if (focused != null) focused.recycle();
        return findFocusedEditableInTree(root);
    }

    private static AccessibilityNodeInfo findFocusedEditableInTree(AccessibilityNodeInfo node) {
        if (node.isFocused() && isEditable(node)) return AccessibilityNodeInfo.obtain(node);
        for (int i = 0; i < node.getChildCount(); i += 1) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            AccessibilityNodeInfo match;
            try {
                match = findFocusedEditableInTree(child);
            } finally {
                child.recycle();
            }
            if (match != null) return match;
        }
        return null;
    }

    private static boolean isEditable(AccessibilityNodeInfo node) {
        if (node == null) return false;
        CharSequence className = node.getClassName();
        return node.isEditable()
                || (node.getActions() & AccessibilityNodeInfo.ACTION_SET_TEXT) != 0
                || (className != null && className.toString().endsWith("EditText"));
    }

    private static boolean replaceSelection(AccessibilityNodeInfo node, String replacement, boolean deleteBackward) {
        CharSequence value = node.getText();
        String current = value == null || node.isShowingHintText() ? "" : value.toString();
        int start = node.getTextSelectionStart();
        int end = node.getTextSelectionEnd();
        if (start < 0 || end < 0 || start > current.length() || end > current.length()) {
            start = current.length();
            end = start;
        }
        if (start > end) {
            int swap = start;
            start = end;
            end = swap;
        }
        if (deleteBackward && start == end && start > 0) {
            start = current.offsetByCodePoints(start, -1);
        }
        String updated = current.substring(0, start) + replacement + current.substring(end);
        Bundle setText = new Bundle();
        setText.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, updated);
        if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, setText)) return false;
        int cursor = start + replacement.length();
        Bundle selection = new Bundle();
        selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor);
        selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor);
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selection);
        return true;
    }

    private static boolean pasteText(AccessibilityNodeInfo node, String text) {
        GestureGlobal g = instance;
        if (g == null) return false;
        ClipboardManager clipboard = (ClipboardManager) g.getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null) return false;
        boolean hadPrevious = clipboard.hasPrimaryClip();
        ClipData previous = hadPrevious ? clipboard.getPrimaryClip() : null;
        clipboard.setPrimaryClip(ClipData.newPlainText("HTIT Remote", text));
        boolean handled = node.performAction(AccessibilityNodeInfo.ACTION_PASTE);
        g.gestureHandler.postDelayed(() -> {
            ClipData current = clipboard.getPrimaryClip();
            CharSequence currentText = current != null && current.getItemCount() > 0
                    ? current.getItemAt(0).getText() : null;
            if (currentText == null || !text.contentEquals(currentText)) return;
            if (hadPrevious && previous != null) clipboard.setPrimaryClip(previous);
            else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) clipboard.clearPrimaryClip();
            else clipboard.setPrimaryClip(ClipData.newPlainText("", ""));
        }, 300);
        return handled;
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
        GestureGlobal g = instance;
        if (g != null) {
            WindowManager wm = (WindowManager) g.getSystemService(WINDOW_SERVICE);
            wm.getDefaultDisplay().getRealMetrics(dm);
        } else {
            MainActivity.realSize(dm);
        }
        return new int[] { dm.widthPixels, dm.heightPixels };
    }
}
