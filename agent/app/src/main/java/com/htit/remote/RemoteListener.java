package com.htit.remote;

import org.json.JSONObject;

public interface RemoteListener {
    JSONObject onPrompt(String controllerName);
    void onAccepted(RemoteSession session);
    void onEnded(String reason);
    void onRegistered(String deviceCode);
    void onStatus(String status);
}
