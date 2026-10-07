package com.htit.remote;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

public final class RelayClient {
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final long MAX_FRAME_QUEUE_BYTES = 1024 * 1024;
    private final Context context;
    private final OkHttpClient http;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicReference<RemoteSession> session = new AtomicReference<>();
    private final AtomicBoolean reconnectScheduled = new AtomicBoolean(false);
    private final AtomicBoolean testingNetwork = new AtomicBoolean(false);
    private volatile RemoteListener listener;
    private volatile WebSocket socket;
    private volatile boolean stopped;
    private volatile String registrationCode = "";
    private final String baseUrl;

    RelayClient(Context context, String baseUrl, RemoteListener listener) {
        this.context = context.getApplicationContext();
        this.baseUrl = normalize(baseUrl);
        this.listener = listener;
        this.http = new OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build();
    }

    public void setListener(RemoteListener listener) {
        this.listener = listener;
        String code = registrationCode;
        if (listener != null && !code.isEmpty()) main.post(() -> listener.onRegistered(code));
    }

    public boolean isConnected() {
        return socket != null && !stopped;
    }

    public RemoteSession currentSession() {
        return session.get();
    }

    public void updateIp(String ip) {
        if (stopped || registrationCode.isEmpty()) return;
        JSONObject message = new JSONObject();
        try {
            message.put("type", "update-ip");
            message.put("ip", ip);
            send(message);
        } catch (Exception e) {
            status("Chưa cập nhật được IP thiết bị lên máy chủ");
        }
    }

    public void connect() {
        reconnectScheduled.set(false);
        stopped = false;
        status("Đang kết nối máy chủ…");
        Request request;
        try {
            request = new Request.Builder().url(baseUrl + "/api/agent/token")
                    .post(RequestBody.create("{}", JSON)).build();
        } catch (IllegalArgumentException e) {
            status("Địa chỉ máy chủ không hợp lệ");
            return;
        }
        http.newCall(request).enqueue(new Callback() {
            @Override public void onFailure(Call call, IOException e) { failed("Không kết nối được máy chủ — đang thử lại"); }
            @Override public void onResponse(Call call, Response response) throws IOException {
                try (Response closeable = response) {
                    String text = closeable.body() != null ? closeable.body().string() : "";
                    if (!closeable.isSuccessful()) {
                        status("Máy chủ từ chối tạo mã (HTTP " + closeable.code() + ")");
                        return;
                    }
                    try {
                        openSocket(new JSONObject(text).getString("token"));
                    } catch (Exception e) {
                        status("Phản hồi tạo mã không hợp lệ");
                    }
                }
            }
        });
    }

    private void openSocket(String token) {
        String wsUrl = baseUrl.replaceFirst("^http", "ws") + "/ws/agent";
        Request request;
        try {
            request = new Request.Builder().url(wsUrl).header("Authorization", "Bearer " + token).build();
        } catch (IllegalArgumentException e) {
            failed("Địa chỉ WebSocket không hợp lệ");
            return;
        }
        socket = http.newWebSocket(request, new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response response) {
                JSONObject register = new JSONObject();
                try {
                    DeviceIdentity identity = DeviceIdentity.get(context);
                    register.put("type", "register");
                    register.put("deviceId", identity.deviceId());
                    register.put("name", identity.deviceName());
                    register.put("ip", identity.deviceIp());
                    register.put("networkDiagnostics", true);
                    send(register);
                    status("Đã kết nối máy chủ");
                } catch (Exception e) { failed("Không đăng ký được thiết bị"); }
            }
            @Override public void onMessage(WebSocket ws, String text) { handle(text); }
            @Override public void onFailure(WebSocket ws, Throwable error, Response response) { failed("Mất kết nối máy chủ — đang thử lại"); }
            @Override public void onClosed(WebSocket ws, int code, String reason) { if (!stopped) failed("Máy chủ đã đóng kết nối"); }
        });
    }

    private void handle(String text) {
        try {
            JSONObject message = new JSONObject(text);
            String type = message.optString("type");
            if ("registered".equals(type)) {
                registrationCode = message.optString("code");
                RemoteListener current = listener;
                if (current != null) main.post(() -> current.onRegistered(registrationCode));
            } else if ("network-test-request".equals(type)) {
                testNetwork(message.optString("testId"), message.optString("scope"));
            } else if ("session-request".equals(type)) {
                beginSession(message);
            } else if ("input".equals(type)) {
                RemoteSession current = session.get();
                if (current != null && current.active && current.id.equals(message.optString("sessionId"))) {
                    message.put("a", message.optString("action"));
                    InputExecutor.apply(context, message.toString().getBytes(StandardCharsets.UTF_8));
                }
            } else if ("session-ended".equals(type)) {
                RemoteSession current = session.get();
                if (current != null && current.id.equals(message.optString("sessionId"))) finish(current, message.optString("reason", "Phiên đã kết thúc"));
            }
        } catch (Exception ignored) { }
    }

    private void testNetwork(String testId, String scope) {
        if (stopped || !"lan".equals(scope)
                || !testId.matches("[a-f0-9-]{36}") || !testingNetwork.compareAndSet(false, true)) return;
        WebSocket source = socket;
        new Thread(() -> {
            JSONObject result;
            try {
                result = NetworkDiagnostics.measure(http, baseUrl, testId);
            } catch (Exception ignored) {
                status("Chưa hoàn tất kiểm tra mạng");
                return;
            } finally {
                testingNetwork.set(false);
            }
            if (!stopped && socket == source) {
                try {
                    JSONObject message = new JSONObject();
                    message.put("type", "network-test-result");
                    message.put("testId", testId);
                    message.put("result", result);
                    send(message);
                } catch (Exception ignored) { }
            }
        }, "network-diagnostics").start();
    }

    private void beginSession(JSONObject message) {
        if (session.get() != null) return;
        RemoteSession next = new RemoteSession(message.optString("sessionId"), message.optString("controllerName", "Nhân viên hỗ trợ"), this);
        if (!session.compareAndSet(null, next)) return;
        new Thread(() -> {
            RemoteListener current = listener;
            JSONObject answer = current != null ? current.onPrompt(next.controllerName) : MainActivity.deny("Ứng dụng chưa mở");
            if (session.get() != next) return;
            boolean accepted = answer != null && answer.optBoolean("accept", false);
            JSONObject response = new JSONObject();
            try {
                response.put("type", "session-response");
                response.put("sessionId", next.id);
                response.put("accept", accepted);
                response.put("reason", answer != null ? answer.optString("why") : "Không thể hỏi người dùng");
                send(response);
            } catch (Exception ignored) { }
            if (accepted && current != null) current.onAccepted(next);
            else finish(next, "Đã từ chối yêu cầu");
        }, "relay-consent").start();
    }

    public void send(JSONObject message) throws IOException {
        WebSocket ws = socket;
        if (ws == null || !ws.send(message.toString())) throw new IOException("Kết nối relay chưa sẵn sàng");
    }

    void sendFrame(RemoteSession owner, byte[] jpeg) throws IOException {
        WebSocket ws = socket;
        if (session.get() != owner || ws == null) throw new IOException("Không gửi được khung hình");
        if (ws.queueSize() > MAX_FRAME_QUEUE_BYTES) return;
        if (!ws.send(ByteString.of(jpeg))) throw new IOException("Không gửi được khung hình");
    }

    boolean canSendFrame(RemoteSession owner) {
        WebSocket ws = socket;
        return session.get() == owner && ws != null && ws.queueSize() <= MAX_FRAME_QUEUE_BYTES;
    }

    void endSession(RemoteSession owner, String type, String reason) {
        if (session.get() != owner) return;
        JSONObject message = new JSONObject();
        try {
            message.put("type", type);
            message.put("sessionId", owner.id);
            message.put("reason", reason);
            send(message);
        } catch (Exception ignored) { }
        finish(owner, reason);
    }

    private void finish(RemoteSession owner, String reason) {
        if (!session.compareAndSet(owner, null)) return;
        owner.active = false;
        ScreenCastService.stopStreaming(context);
        RemoteListener current = listener;
        if (current != null) main.post(() -> current.onEnded(reason));
    }

    public void stop() {
        stopped = true;
        registrationCode = "";
        RemoteSession current = session.get();
        if (current != null) current.close("Dịch vụ Android đã dừng");
        WebSocket ws = socket;
        socket = null;
        if (ws != null) ws.close(1000, "stop");
        http.dispatcher().executorService().shutdown();
    }

    private void failed(String message) {
        socket = null;
        registrationCode = "";
        RemoteSession currentSession = session.get();
        if (currentSession != null) finish(currentSession, message);
        RemoteListener current = listener;
        if (current != null) main.post(() -> current.onRegistered(""));
        status(message);
        if (!stopped && reconnectScheduled.compareAndSet(false, true)) {
            main.postDelayed(() -> {
                reconnectScheduled.set(false);
                if (!stopped && socket == null) connect();
            }, 3_000);
        }
    }

    private void status(String message) {
        RemoteListener current = listener;
        if (current != null) main.post(() -> current.onStatus(message));
    }

    private static String normalize(String value) {
        String result = value == null ? "" : value.trim();
        while (result.endsWith("/")) result = result.substring(0, result.length() - 1);
        return result;
    }
}
