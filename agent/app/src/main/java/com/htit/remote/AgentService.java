package com.htit.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;

public final class AgentService extends Service {
    private static final String CHANNEL_ID = "htit_remote_wait";
    private static final int NOTIFICATION_ID = 92;
    private static volatile RelayClient client;

    public static RelayClient client() {
        return client;
    }

    public static void connect(Context context, String server, RemoteListener listener) {
        RelayClient previous = client;
        RelayClient next = new RelayClient(context, server, listener);
        client = next;
        if (previous != null) previous.stop();
        Intent intent = new Intent(context, AgentService.class);
        context.startForegroundService(intent);
    }

    public static void updateListener(RemoteListener listener) {
        RelayClient current = client;
        if (current != null) current.setListener(listener);
    }

    public static void disconnect(Context context) {
        RelayClient current = client;
        client = null;
        if (current != null) current.stop();
        context.stopService(new Intent(context, AgentService.class));
    }

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "HTIT Remote", NotificationManager.IMPORTANCE_LOW));
        Notification notification = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("HTIT Remote đang trực tuyến")
                .setContentText("Thiết bị đang chờ yêu cầu hỗ trợ nội bộ")
                .setOngoing(true)
                .build();
        startForeground(NOTIFICATION_ID, notification);
        if (client == null) stopSelf();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        RelayClient current = client;
        if (current == null) stopSelf();
        else current.connect();
        return START_NOT_STICKY;
    }

    @Override public IBinder onBind(Intent intent) {
        return null;
    }

    @Override public void onDestroy() {
        RelayClient current = client;
        client = null;
        if (current != null) current.stop();
        super.onDestroy();
    }
}
