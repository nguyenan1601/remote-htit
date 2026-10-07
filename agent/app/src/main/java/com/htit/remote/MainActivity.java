package com.htit.remote;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.media.projection.MediaProjectionManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.lang.ref.WeakReference;

@SuppressLint("SetTextI18n")
public final class MainActivity extends Activity {
    private static final int REQUEST_PROJECTION = 4001;
    private static final int PROMPT_TIMEOUT_MS = 30_000;
    private static final Handler UI = new Handler(Looper.getMainLooper());
    private static WeakReference<MainActivity> active = new WeakReference<>(null);
    private Button generateButton;
    private TextView codeView;
    private TextView ipView;
    private TextView statusView;
    private TextView accessibilityView;
    private MediaProjectionManager projectionManager;
    private volatile RemoteSession pendingProjection;

    public static void showStatus(String text) {
        MainActivity activity = active.get();
        if (activity != null && text != null) UI.post(() -> activity.statusView.setText(text));
    }

    public static void notifyProjectionEnded() {
        showStatus("Đã dừng chia sẻ màn hình");
    }

    public static void realSize(DisplayMetrics metrics) {
        MainActivity activity = active.get();
        if (activity != null) activity.getWindowManager().getDefaultDisplay().getRealMetrics(metrics);
        else { metrics.widthPixels = 1080; metrics.heightPixels = 1920; }
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        active = new WeakReference<>(this);
        projectionManager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        buildUi();
        AgentService.updateListener(listener);
        if (android.os.Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { android.Manifest.permission.POST_NOTIFICATIONS }, 4002);
        }
        if (AgentService.client() == null) generateCode();
    }

    @Override protected void onResume() {
        super.onResume();
        refreshIp();
        accessibilityView.setText(GestureGlobal.ready() ? "✓ Trợ năng đã bật" : "✕ Trợ năng chưa bật — chỉ xem, chưa thể điều khiển");
    }

    @Override protected void onDestroy() {
        if (active.get() == this) {
            active.clear();
            AgentService.updateListener(null);
        }
        super.onDestroy();
    }

    private void buildUi() {
        int blue = 0xff436ab3;
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(24), dp(18), dp(18));
        TextView title = text("HTIT Remote", 22);
        title.setTypeface(null, Typeface.BOLD);
        title.setTextColor(blue);
        root.addView(wrap(title, 8));
        TextView subtitle = text("Thiết bị nhận hỗ trợ nội bộ", 14);
        root.addView(wrap(subtitle, 18));

        ipView = text("", 16);
        refreshIp();
        root.addView(wrap(ipView, 12));
        generateButton = button("Sinh mã truy cập", blue, this::generateCode);
        root.addView(wrap(generateButton, 14));
        codeView = text("Mã thiết bị: —", 25);
        codeView.setTypeface(null, Typeface.BOLD);
        codeView.setTextColor(blue);
        root.addView(wrap(codeView, 12));
        accessibilityView = text("", 14);
        root.addView(wrap(accessibilityView, 8));
        root.addView(wrap(button("Bật quyền Trợ năng", blue, () -> {
            try { startActivity(new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS)); }
            catch (Exception e) { Toast.makeText(this, "Không mở được cài đặt Trợ năng", Toast.LENGTH_SHORT).show(); }
        }), 12));
        root.addView(wrap(button("Ngắt kết nối / Dừng chia sẻ", 0xffd5b34b, this::disconnect), 12));
        statusView = text("Đang đăng ký thiết bị để kết nối bằng IP hoặc mã", 14);
        root.addView(wrap(statusView, 4));
        TextView hint = text("Android 13+: nếu Trợ năng bị khóa, mở Thông tin ứng dụng → Cho phép cài đặt bị hạn chế.", 12);
        hint.setTextColor(0xff775511);
        root.addView(hint);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(root);
        setContentView(scroll);
    }

    private void refreshIp() {
        String ip = DeviceIdentity.get(this).deviceIp();
        ipView.setText(ip.isEmpty() ? "IP thiết bị: chờ kết nối Wi-Fi / Ethernet" : "IP thiết bị: " + ip);
        RelayClient client = AgentService.client();
        if (client != null) client.updateIp(ip);
    }

    private void generateCode() {
        generateButton.setEnabled(false);
        codeView.setText("Mã thiết bị: —");
        statusView.setText("Đang tìm máy chủ HTIT Remote trong mạng LAN…");
        new Thread(() -> {
            try {
                String server = ServerDiscovery.discover(this);
                UI.post(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    refreshIp();
                    statusView.setText("Đã tìm thấy máy chủ — đang sinh mã…");
                    generateButton.setEnabled(true);
                    AgentService.connect(this, server, listener);
                });
            } catch (Exception e) {
                UI.post(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    generateButton.setEnabled(true);
                    statusView.setText("Chưa tìm được máy chủ HTIT Remote. Kiểm tra kết nối mạng nội bộ rồi thử lại.");
                });
            }
        }, "server-discovery").start();
    }

    private void disconnect() {
        RemoteSession session = currentSession();
        if (session != null) session.close("Người dùng trên thiết bị đã ngắt kết nối");
        ScreenCastService.stopStreaming(this);
        AgentService.disconnect(this);
        codeView.setText("Mã thiết bị: —");
        statusView.setText("Đã ngắt kết nối máy chủ");
    }

    private RemoteSession currentSession() {
        RelayClient client = AgentService.client();
        return client != null ? client.currentSession() : null;
    }

    private final RemoteListener listener = new RemoteListener() {
        @Override public JSONObject onPrompt(String controllerName) {
            JSONObject[] result = new JSONObject[1];
            CountDownLatch latch = new CountDownLatch(1);
            UI.post(() -> {
                MainActivity activity = active.get();
                if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
                    result[0] = deny("Ứng dụng chưa mở để xác nhận");
                    latch.countDown();
                    return;
                }
                final boolean[] chosen = { false };
                AlertDialog dialog = new AlertDialog.Builder(activity)
                        .setTitle("Yêu cầu hỗ trợ từ xa")
                        .setMessage("Người hỗ trợ \"" + controllerName + "\" muốn xem màn hình và điều khiển chạm/vuốt. Bạn có đồng ý không?")
                        .setPositiveButton("Chấp nhận", (d, which) -> { chosen[0] = true; result[0] = accept(); })
                        .setNegativeButton("Từ chối", (d, which) -> { chosen[0] = true; result[0] = deny("Người dùng đã từ chối"); })
                        .setOnDismissListener(d -> { if (!chosen[0]) result[0] = deny("Không có xác nhận"); latch.countDown(); })
                        .create();
                dialog.show();
                UI.postDelayed(dialog::dismiss, PROMPT_TIMEOUT_MS);
            });
            try { latch.await(PROMPT_TIMEOUT_MS + 3_000, TimeUnit.MILLISECONDS); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            return result[0] != null ? result[0] : deny("Hết thời gian xác nhận");
        }

        @Override public void onAccepted(RemoteSession session) {
            UI.post(() -> {
                MainActivity activity = active.get();
                if (activity == null) { session.deny("Ứng dụng không còn mở"); return; }
                activity.pendingProjection = session;
                activity.startActivityForResult(activity.projectionManager.createScreenCaptureIntent(), REQUEST_PROJECTION);
            });
        }

        @Override public void onEnded(String reason) {
            UI.post(() -> {
                MainActivity activity = active.get();
                if (activity != null) ScreenCastService.stopStreaming(activity);
                showStatus("Phiên kết thúc: " + reason);
            });
        }

        @Override public void onRegistered(String code) {
            refreshIp();
            if (code.isEmpty()) {
                codeView.setText("Mã thiết bị: —");
            } else {
                codeView.setText("Mã thiết bị: " + code.replaceAll("(\\d{3})(?=\\d)", "$1 "));
                statusView.setText("Đang trực tuyến — chờ yêu cầu hỗ trợ");
            }
        }

        @Override public void onStatus(String status) { showStatus(status); }
    };

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_PROJECTION) return;
        RemoteSession session = pendingProjection;
        pendingProjection = null;
        if (resultCode == RESULT_OK && data != null && session != null) {
            ScreenCastService.startStreaming(this, session, resultCode, data);
            showStatus("Đang bắt đầu chia sẻ màn hình…");
        } else if (session != null) {
            session.deny("Người dùng không cấp quyền chia sẻ màn hình");
            showStatus("Không cấp quyền chia sẻ — phiên đã dừng");
        }
    }

    static JSONObject accept() { JSONObject value = new JSONObject(); try { value.put("accept", true); } catch (Exception ignored) { } return value; }
    static JSONObject deny(String reason) { JSONObject value = new JSONObject(); try { value.put("accept", false); value.put("why", reason); } catch (Exception ignored) { } return value; }
    private TextView text(String value, int size) { TextView view = new TextView(this); view.setText(value); view.setTextSize(size); return view; }
    private Button button(String label, int color, Runnable action) { Button view = new Button(this); view.setText(label); view.setBackgroundColor(color); view.setTextColor(0xffffffff); view.setOnClickListener(v -> action.run()); return view; }
    private LinearLayout wrap(android.view.View view, int bottom) { LinearLayout box = new LinearLayout(this); box.setPadding(0, 0, 0, dp(bottom)); box.addView(view, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)); return box; }
    private int dp(int value) { return (int) (value * getResources().getDisplayMetrics().density); }
}
