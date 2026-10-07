package com.htit.remote;

import android.content.Context;
import android.net.DhcpInfo;
import android.net.wifi.WifiManager;

import org.json.JSONObject;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.Set;

final class ServerDiscovery {
    private static final int PORT = 8363;
    private static final int TIMEOUT_MS = 2_500;
    private static final byte[] PROBE = "HTIT_REMOTE_DISCOVER_V1".getBytes(StandardCharsets.UTF_8);

    private ServerDiscovery() { }

    static String discover(Context context) throws IOException {
        long deadline = System.currentTimeMillis() + TIMEOUT_MS;
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true);
            boolean sent = false;
            for (InetAddress address : discoveryAddresses(context)) {
                try {
                    socket.send(new DatagramPacket(PROBE, PROBE.length, address, PORT));
                    sent = true;
                } catch (IOException ignored) { }
            }
            if (!sent) throw new IOException("Không thể gửi yêu cầu tìm máy chủ trong mạng LAN");

            byte[] buffer = new byte[1_024];
            while (System.currentTimeMillis() < deadline) {
                socket.setSoTimeout((int) Math.max(1, deadline - System.currentTimeMillis()));
                DatagramPacket response = new DatagramPacket(buffer, buffer.length);
                try {
                    socket.receive(response);
                } catch (SocketTimeoutException timeout) {
                    break;
                }
                String server = parse(response);
                if (server != null) return server;
            }
        }
        throw new IOException("Không tìm thấy máy chủ HTIT Remote trong mạng LAN");
    }

    private static Set<InetAddress> discoveryAddresses(Context context) throws IOException {
        Set<InetAddress> addresses = new LinkedHashSet<>();
        addresses.add(InetAddress.getByName("255.255.255.255"));
        Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
        while (interfaces != null && interfaces.hasMoreElements()) {
            NetworkInterface network = interfaces.nextElement();
            if (!network.isUp() || network.isLoopback()) continue;
            for (InterfaceAddress item : network.getInterfaceAddresses()) {
                if (item.getBroadcast() != null) addresses.add(item.getBroadcast());
            }
        }
        InetAddress gateway = wifiGateway(context);
        if (gateway != null) addresses.add(gateway);
        return addresses;
    }

    @SuppressWarnings("deprecation")
    private static InetAddress wifiGateway(Context context) {
        try {
            WifiManager wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            DhcpInfo info = wifi != null ? wifi.getDhcpInfo() : null;
            if (info == null || info.gateway == 0) return null;
            int value = info.gateway;
            return InetAddress.getByAddress(new byte[] {
                    (byte) (value & 0xff),
                    (byte) ((value >> 8) & 0xff),
                    (byte) ((value >> 16) & 0xff),
                    (byte) ((value >> 24) & 0xff)
            });
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String parse(DatagramPacket packet) {
        try {
            JSONObject value = new JSONObject(new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.UTF_8));
            if (!"htit-remote".equals(value.optString("service")) || value.optInt("version") != 1) return null;
            String advertised = normalize(value.optString("url"));
            if (advertised != null) return advertised;
            int port = value.optInt("port");
            if (port < 1 || port > 65_535) return null;
            String scheme = value.optBoolean("secure") ? "https" : "http";
            return scheme + "://" + packet.getAddress().getHostAddress() + ":" + port;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String normalize(String value) {
        String result = value == null ? "" : value.trim();
        if (!(result.startsWith("http://") || result.startsWith("https://"))) return null;
        while (result.endsWith("/")) result = result.substring(0, result.length() - 1);
        return result;
    }
}
