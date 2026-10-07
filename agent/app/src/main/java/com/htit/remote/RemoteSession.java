package com.htit.remote;

import org.json.JSONObject;

import java.io.IOException;

public final class RemoteSession {
    public final String id;
    public final String controllerName;
    public volatile boolean active;
    private final RelayClient relay;

    RemoteSession(String id, String controllerName, RelayClient relay) {
        this.id = id;
        this.controllerName = controllerName;
        this.relay = relay;
    }

    public boolean isReady() {
        return relay.isConnected();
    }

    public void sendFrame(byte[] jpeg) throws IOException {
        if (!active) throw new IOException("Phiên chưa hoạt động");
        relay.sendFrame(this, jpeg);
    }

    public boolean canSendFrame() {
        return active && relay.canSendFrame(this);
    }

    public void startStreaming(int width, int height) throws IOException {
        JSONObject message = new JSONObject();
        try {
            message.put("type", "session-active");
            message.put("sessionId", id);
            message.put("width", width);
            message.put("height", height);
        } catch (Exception e) {
            throw new IOException(e);
        }
        active = true;
        try {
            relay.send(message);
        } catch (IOException e) {
            active = false;
            throw e;
        }
    }

    public void deny(String reason) {
        relay.endSession(this, "session-denied", reason);
    }

    public void close(String reason) {
        relay.endSession(this, "session-ended", reason);
    }
}
