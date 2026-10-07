package com.htit.remote;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.util.UUID;

/** Định danh ổn định của thiết bị, không phụ thuộc địa chỉ IP. */
public final class DeviceIdentity {
    private static final String PREFS = "htit-remote";
    private static final String DEVICE_ID = "device_id";
    private static final String DEVICE_NAME = "device_name";
    private static DeviceIdentity instance;
    private final Context context;
    private final SharedPreferences preferences;

    private DeviceIdentity(Context context) {
        this.context = context.getApplicationContext();
        preferences = this.context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static synchronized DeviceIdentity get(Context context) {
        if (instance == null) instance = new DeviceIdentity(context);
        return instance;
    }

    public synchronized String deviceId() {
        String id = preferences.getString(DEVICE_ID, null);
        if (id == null) {
            id = UUID.randomUUID().toString();
            preferences.edit().putString(DEVICE_ID, id).apply();
        }
        return id;
    }

    public synchronized String deviceName() {
        String name = preferences.getString(DEVICE_NAME, null);
        if (name == null || name.isEmpty()) {
            name = android.os.Build.MODEL + " (" + deviceId().substring(0, 4) + ")";
            preferences.edit().putString(DEVICE_NAME, name).apply();
        }
        return name;
    }

    /** Read the current Wi-Fi/Ethernet IPv4 address instead of a previously saved IP. */
    public synchronized String deviceIp() {
        ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
        if (manager == null) return "";
        String ip = networkIp(manager, manager.getActiveNetwork());
        if (ip.isEmpty()) {
            for (Network network : manager.getAllNetworks()) {
                ip = networkIp(manager, network);
                if (!ip.isEmpty()) break;
            }
        }
        return ip;
    }

    private static String networkIp(ConnectivityManager manager, Network network) {
        if (network == null) return "";
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
        if (capabilities == null || !(capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) return "";
        LinkProperties properties = manager.getLinkProperties(network);
        if (properties == null) return "";
        for (LinkAddress link : properties.getLinkAddresses()) {
            InetAddress address = link.getAddress();
            if (address instanceof Inet4Address && !address.isLoopbackAddress()
                    && !address.isLinkLocalAddress() && !address.isAnyLocalAddress()) {
                return address.getHostAddress();
            }
        }
        return "";
    }
}
