package com.htit.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;

/** Plain started service hosting the AgentServer listener so it survives when the UI is backgrounded. */
public final class AgentService extends Service {
    private static final String TAG = "HTITRemote";
    private static final String CH_ID = "htit_remote_wait";
    private static final int FGS_ID = 92;

    private static volatile AgentServer server;

    public static AgentServer server() {
        return server;
    }

    public static boolean ensureStarted(Context ctx) {
        AgentServer s = server;
        if (s == null) return false;
        if (!s.isReady()) ctx.startService(new Intent(ctx, AgentService.class));
        return true;
    }

    public static void startAgent(Context ctx, int port, AgentServer.Listener listener) {
        if (server != null) {
            server.listener = listener;
            return;
        }
        server = new AgentServer(ctx, port, listener);
        ctx.startForegroundService(new Intent(ctx, AgentService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CH_ID, "HTIT Remote", NotificationManager.IMPORTANCE_MIN);
        nm.createNotificationChannel(ch);
        Notification n = new Notification.Builder(this, CH_ID)
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle("HTIT Remote đang chờ kết nối")
                .setOngoing(true)
                .build();
        startForeground(FGS_ID, n);
        AgentServer s = server;
        if (s == null) {
            // Sticky restart after the process was killed: no UI listener exists yet, so listen
            // headlessly and auto-deny until the user opens the app and replaces the listener.
            s = new AgentServer(getApplicationContext(), AgentServer.LISTEN_PORT, DENY_ALL);
            server = s;
        }
        if (!s.start()) {
            Log.e(TAG, "Không mở được cổng " + AgentServer.LISTEN_PORT);
        }
    }

    private static final AgentServer.Listener DENY_ALL = new AgentServer.Listener() {
        @Override
        public org.json.JSONObject onPrompt(String controllerName) {
            org.json.JSONObject o = new org.json.JSONObject();
            try {
                o.put("accept", false);
                o.put("why", "Ứng dụng chưa mở trên thiết bị — tự động từ chối");
            } catch (Exception ignored) { }
            return o;
        }

        @Override
        public void onAccepted(AgentServer.AgentSession session, org.json.JSONObject acceptInfo) { }

        @Override
        public void onEnded(String reason) { }
    };

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        AgentServer s = server;
        if (s != null && !s.isReady()) s.start();
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        AgentServer s = server;
        if (s != null) s.stop();
        server = null;
        super.onDestroy();
    }
}
