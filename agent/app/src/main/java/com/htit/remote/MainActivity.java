package com.htit.remote;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Bundle;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Setup + consent UI: device info, pairing code, accessibility prompt,
 * accept/reject dialog, projection consent, connection status.
 */
public final class MainActivity extends Activity {
    private static final String TAG = "HTITRemote";
    private static final int REQ_PROJECTION = 4001;
    private static final int PROMPT_TIMEOUT_MS = 30000;

    private static MainActivity activeInstance;
    private static final android.os.Handler ui = new android.os.Handler(android.os.Looper.getMainLooper());

    private TextView tvStatus;
    private TextView tvDevice;

    private MediaProjectionManager projectionManager;

    public static void showStatus(String text) {
        MainActivity m = activeInstance;
        if (m != null && text != null) {
            ui.post(() -> {
                if (m.tvStatus != null) m.setLine(text);
            });
        }
    }

    void setLine(String text) {
        tvStatus.setText(text);
    }

    public static void notifyProjectionEnded() {
        MainActivity m = activeInstance;
        if (m != null) ui.post(m::refreshLabels);
    }

    public static void realSize(DisplayMetrics dm) {
        MainActivity m = activeInstance;
        if (m != null) {
            m.getWindowManager().getDefaultDisplay().getRealMetrics(dm);
            return;
        }
        dm.widthPixels = 1080;
        dm.heightPixels = 1920;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        activeInstance = this;
        projectionManager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        buildUi();
        AgentService.startAgent(this, AgentServer.LISTEN_PORT, listener);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshLabels();
    }

    @Override
    protected void onDestroy() {
        if (activeInstance == this) activeInstance = null;
        super.onDestroy();
    }

    private void buildUi() {
        int blue = 0xFF436AB3;
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(24), dp(18), dp(18));

        TextView title = new TextView(this);
        title.setTextSize(20);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setTextColor(blue);
        title.setText("HTIT Remote");
        root.addView(wrap(title, 16));

        tvDevice = new TextView(this);
        tvDevice.setTextSize(15);
        root.addView(wrap(tvDevice, 12));

        TextView tvA11y = new TextView(this);
        tvA11y.setId(android.R.id.text2);
        tvA11y.setTextSize(14);
        root.addView(wrap(tvA11y, 12));

        Button a11yBtn = blueButton("Bật quyền Trợ năng (điều khiển)", () -> {
            try {
                startActivity(new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS));
            } catch (Exception e) {
                Toast.makeText(this, "Không mở được cài đặt Trợ năng", Toast.LENGTH_SHORT).show();
            }
        });
        root.addView(wrap(a11yBtn, 6));

        TextView a11yHint = new TextView(this);
        a11yHint.setTextSize(12);
        a11yHint.setTextColor(0xFF775511);
        a11yHint.setText("Android 13+: nếu không thấy HTIT Remote trong Trợ năng, hãy mở «Allow restricted settings» trong thông tin ứng dụng trước.");
        root.addView(wrap(a11yHint, 10));

        Button stopBtn = orangeButton("Ngắt kết nối / Dừng chia sẻ", this::disconnectNow);
        root.addView(wrap(stopBtn, 12));

        tvStatus = new TextView(this);
        tvStatus.setTextSize(13);
        tvStatus.setTextColor(0xFF333333);
        root.addView(wrap(tvStatus, 4));

        setContentView(root);
    }

    private LinearLayout wrap(android.view.View v, int space) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(0, 0, 0, dp(space));
        box.addView(v, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return box;
    }

    private Button blueButton(String label, Runnable r) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextColor(0xFFFFFFFF);
        b.setBackgroundColor(0xFF436AB3);
        b.setOnClickListener(v -> r.run());
        return b;
    }

    private Button orangeButton(String label, Runnable r) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextColor(0xFF442200);
        b.setBackgroundColor(0xFFE7CF7F);
        b.setOnClickListener(v -> r.run());
        return b;
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }

    private void refreshLabels() {
        try {
            DeviceIdentity id = DeviceIdentity.get(this);
            tvDevice.setText("Thiết bị: " + id.deviceName() + "\nĐịa chỉ kết nối: " + networkIpText());
            TextView tvA11y = findViewById(android.R.id.text2);
            boolean a11y = GestureGlobal.ready();
            AgentServer.AgentSession s = currentSession();
            tvA11y.setText((a11y ? "✔ Trợ năng: đã bật" : "✘ Trợ năng: chưa bật — chỉ xem, không điều khiển được"));
            if (s != null && s.active) {
                tvStatus.setText("ĐANG chia sẻ màn hình. Nút «Ngắt kết nối» dừng ngay lại.");
            } else {
                tvStatus.setText("Trạng thái: " + (AgentService.server() != null && AgentService.server().isReady() ? "chờ kết nối từ máy điều khiển…" : "đang lỗi dịch vụ"));
            }
        } catch (Exception e) {
            Log.w(TAG, "refresh", e);
        }
    }

    AgentServer.AgentSession currentSession() {
        AgentServer s = AgentService.server();
        return s != null ? s.currentSession() : null;
    }

    private String networkIpText() {
        try {
            java.util.Enumeration<java.net.NetworkInterface> en = java.net.NetworkInterface.getNetworkInterfaces();
            while (en != null && en.hasMoreElements()) {
                java.net.NetworkInterface n = en.nextElement();
                if (!n.isUp()) continue;
                java.util.Enumeration<java.net.InetAddress> ee = n.getInetAddresses();
                while (ee.hasMoreElements()) {
                    java.net.InetAddress a = ee.nextElement();
                    if (!a.isLoopbackAddress() && a instanceof java.net.Inet4Address) {
                        return a.getHostAddress() + ":" + AgentServer.LISTEN_PORT;
                    }
                }
            }
        } catch (Exception ignored) { }
        return "? :" + AgentServer.LISTEN_PORT;
    }

    private void disconnectNow() {
        AgentServer.AgentSession s = currentSession();
        if (s != null) {
            try {
                s.sendPacket(Wire.T_STOP,
                        "{\"why\":\"Người dùng trên thiết bị đã ngắt kết nối\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            } catch (Exception ignored) { }
        }
        ScreenCastService.stopStreaming(this);
        AgentServer srv = AgentService.server();
        if (srv != null) srv.uiEndSession("user-stop");
        showStatus("Đã ngắt kết nối");
        refreshLabels();
    }

    // ---- listener wired into AgentServer (usable even without activity open: default deny) ----
    private final AgentServer.Listener listener = new AgentServer.Listener() {
        @Override
        public JSONObject onPrompt(String controllerName) {
            JSONObject[] box = new JSONObject[1];
            CountDownLatch latch = new CountDownLatch(1);
            ui.post(() -> {
                MainActivity m = activeInstance;
                if (m == null || m.isFinishing() || m.isDestroyed()) {
                    box[0] = deny("Không có cửa sổ để hỏi");
                    latch.countDown();
                    return;
                }
                final boolean[] chosen = { false };
                try {
                    AlertDialog dialog = new AlertDialog.Builder(m)
                            .setTitle("Yêu cầu hỗ trợ từ xa")
                            .setMessage("Người hỗ trợ \"" + controllerName
                                    + "\" muốn:\n• xem màn hình của bạn theo thời gian thực\n"
                                    + "• điều khiển chạm / vuốt\n\nBạn có đồng ý không?")
                            .setPositiveButton("Chấp nhận", (d, w) -> {
                                chosen[0] = true;
                                box[0] = accept();
                                d.dismiss();
                            })
                            .setNegativeButton("Từ chối", (d, w) -> {
                                chosen[0] = true;
                                box[0] = deny("Người dùng đã từ chối");
                                d.dismiss();
                            })
                            .setOnDismissListener(d -> {
                                if (!chosen[0]) box[0] = deny("Người dùng đã đóng yêu cầu");
                                latch.countDown();
                            })
                            .create();
                    dialog.show();
                    ui.postDelayed(dialog::dismiss, PROMPT_TIMEOUT_MS); // default deny on no user action
                } catch (Exception e) {
                    // A stale window token must never crash the process while a controller waits.
                    Log.w(TAG, "Không hiển thị được hộp thoại xin phép", e);
                    box[0] = deny("Không hiển thị được hộp thoại xin phép");
                    latch.countDown();
                }
            });
            try {
                latch.await(PROMPT_TIMEOUT_MS + 3000, TimeUnit.MILLISECONDS);
            } catch (InterruptedException ignored) { }
            if (box[0] != null) return box[0];
            return deny("Không phản hồi sau " + (PROMPT_TIMEOUT_MS / 1000) + " giây — tự động từ chối");
        }

        @Override
        public void onAccepted(AgentServer.AgentSession session, JSONObject acceptInfo) {
            ui.post(() -> {
                MainActivity m = activeInstance;
                if (m == null || m.isFinishing() || m.isDestroyed()) {
                    AgentServer srv = AgentService.server();
                    if (srv != null) srv.uiEndSession("ui-unavailable");
                    return;
                }
                m.pendingProjection = session;
                try {
                    m.startActivityForResult(m.projectionManager.createScreenCaptureIntent(), REQ_PROJECTION);
                } catch (Exception e) {
                    MainActivity.showStatus("Không xin được quyền chia sẻ màn hình: " + e.getMessage());
                    AgentServer srv = AgentService.server();
                    if (srv != null) srv.uiEndSession("projection-unavailable");
                }
            });
        }

        @Override
        public void onEnded(String reason) {
            ui.post(() -> {
                ScreenCastService.stopStreaming(activeInstance);
                MainActivity.showStatus("Phiên kết thúc: " + reason);
                if (activeInstance != null) activeInstance.refreshLabels();
            });
        }
    };

    volatile AgentServer.AgentSession pendingProjection;

    static JSONObject accept() {
        try {
            JSONObject o = new JSONObject();
            o.put("accept", true);
            return o;
        } catch (Exception ignored) {
            return null;
        }
    }

    static JSONObject deny(String why) {
        try {
            JSONObject o = new JSONObject();
            o.put("accept", false);
            o.put("why", why);
            return o;
        } catch (Exception ignored) {
            return null;
        }
    }

    private void dlog(String m) {
        try {
            java.io.File f = new java.io.File(getExternalFilesDir(null), "agent.log");
            java.io.FileWriter w = new java.io.FileWriter(f, true);
            w.write(new java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US).format(new java.util.Date()) + " " + m + "\n");
            w.close();
        } catch (Exception ignored) { }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PROJECTION) {
            dlog("onActivityResult code=" + resultCode + " data=" + (data != null));
            AgentServer.AgentSession s = pendingProjection;
            pendingProjection = null;
            if (resultCode == RESULT_OK && data != null && s != null) {
                ScreenCastService.startStreaming(this, s, resultCode, data);
                showStatus("Đã cấp quyền chia sẻ — đang bắt đầu luồng hình ảnh");
            } else {
                AgentServer srv = AgentService.server();
                if (srv != null) srv.uiDeny("Bạn từ chối cấp quyền chia sẻ màn hình hệ thống");
                showStatus("Không cấp quyền chia sẻ — phiên đã dừng");
            }
        }
    }
}
