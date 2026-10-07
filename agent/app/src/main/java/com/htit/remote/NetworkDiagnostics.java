package com.htit.remote;

import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/** Measures the Android's connection to the internal relay, on a worker thread. */
final class NetworkDiagnostics {
    private static final int BYTES = 8 * 1024 * 1024;

    static JSONObject measure(OkHttpClient http, String baseUrl, String testId) throws Exception {
        String url = baseUrl + "/api/network-test/" + testId;
        String pingUrl = url + "/ping";
        String downloadUrl = url + "/download";
        String uploadUrl = url + "/upload";
        OkHttpClient probe = http.newBuilder().retryOnConnectionFailure(false)
                .followRedirects(false).followSslRedirects(false)
                .connectTimeout(2, TimeUnit.SECONDS).readTimeout(2, TimeUnit.SECONDS)
                .callTimeout(2, TimeUnit.SECONDS).build();
        OkHttpClient transfer = probe.newBuilder().connectTimeout(3, TimeUnit.SECONDS)
                .readTimeout(12, TimeUnit.SECONDS).writeTimeout(12, TimeUnit.SECONDS)
                .callTimeout(12, TimeUnit.SECONDS).build();
        JSONObject result = new JSONObject();
        JSONArray errors = new JSONArray();
        List<Double> pings = new ArrayList<>();
        // Warm the DNS/TLS connection before sampling latency.
        try (Response ignored = probe.newCall(request(pingUrl).build()).execute()) { }
        catch (IOException ignored) { }
        for (int i = 0; i < 5; i++) {
            long start = SystemClock.elapsedRealtimeNanos();
            try (Response response = probe.newCall(request(pingUrl).build()).execute()) {
                if (!response.isSuccessful()) throw new IOException("Ping failed");
                if (response.body() != null) response.body().close();
                pings.add((SystemClock.elapsedRealtimeNanos() - start) / 1_000_000.0);
            } catch (IOException ignored) { }
        }
        double total = 0, min = Double.MAX_VALUE, max = 0, jitter = 0;
        for (int i = 0; i < pings.size(); i++) {
            double ping = pings.get(i);
            total += ping;
            min = Math.min(min, ping);
            max = Math.max(max, ping);
            if (i > 0) jitter += Math.abs(ping - pings.get(i - 1));
        }
        result.put("pingMs", pings.isEmpty() ? JSONObject.NULL : total / pings.size());
        result.put("minPingMs", pings.isEmpty() ? JSONObject.NULL : min);
        result.put("maxPingMs", pings.isEmpty() ? JSONObject.NULL : max);
        result.put("jitterMs", pings.size() < 2 ? JSONObject.NULL : jitter / (pings.size() - 1));
        result.put("lossPercent", (5 - pings.size()) * 20);
        if (pings.isEmpty()) errors.put("Không nhận được phản hồi ping HTTP");

        result.put("downloadMbps", JSONObject.NULL);
        long start = SystemClock.elapsedRealtimeNanos();
        try (Response response = transfer.newCall(request(downloadUrl).build()).execute()) {
            if (!response.isSuccessful() || response.body() == null) throw new IOException("Download failed");
            int bytes = 0;
            byte[] buffer = new byte[16 * 1024];
            try (InputStream stream = response.body().byteStream()) {
                int count;
                while ((count = stream.read(buffer)) != -1) {
                    bytes += count;
                    if (bytes > BYTES) throw new IOException("Unexpected download size");
                }
            }
            if (bytes != BYTES) throw new IOException("Incomplete download");
            result.put("downloadMbps", mbps(bytes, start));
        } catch (IOException ignored) { errors.put("Không đo được download trong thời gian chờ 12 giây"); }

        result.put("uploadMbps", JSONObject.NULL);
        byte[] upload = new byte[BYTES];
        // Avoid compressible content when an intermediary supports request compression.
        new java.util.Random().nextBytes(upload);
        start = SystemClock.elapsedRealtimeNanos();
        Request uploadRequest = request(uploadUrl)
                .post(RequestBody.create(upload, MediaType.get("application/octet-stream"))).build();
        try (Response response = transfer.newCall(uploadRequest).execute()) {
            if (!response.isSuccessful() || response.body() == null) throw new IOException("Upload failed");
            String body = response.body().string();
            if (new JSONObject(body).optInt("bytes") != BYTES) throw new IOException("Upload incomplete");
            result.put("uploadMbps", mbps(BYTES, start));
        } catch (Exception ignored) { errors.put("Không đo được upload trong thời gian chờ 12 giây"); }
        result.put("errors", errors);
        return result;
    }

    private static Request.Builder request(String url) {
        return new Request.Builder().url(url).header("Accept-Encoding", "identity").header("Cache-Control", "no-store");
    }

    private static double mbps(int bytes, long start) {
        return bytes * 8.0 * 1000 / Math.max(1, SystemClock.elapsedRealtimeNanos() - start);
    }
}
