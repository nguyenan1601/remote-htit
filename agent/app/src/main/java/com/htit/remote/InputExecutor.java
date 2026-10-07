package com.htit.remote;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

/** Applies decrypted INPUT packets; coordinates must be normalized in [0,1] and are rejected outside. */
public final class InputExecutor {
    private static final String TAG = "HTITRemote";

    private InputExecutor() { }

    public static void apply(Context context, byte[] plain) {
        try {
            JSONObject o = new JSONObject(new String(plain, java.nio.charset.StandardCharsets.UTF_8));
            String action = o.optString("a", "");
            switch (action) {
                case "tap": {
                    double[] p = point(o, "x", "y");
                    if (p != null) GestureGlobal.tap(p[0], p[1]);
                    break;
                }
                case "long": {
                    double[] p = point(o, "x", "y");
                    if (p != null) GestureGlobal.press(p[0], p[1], 800);
                    break;
                }
                case "swipe": {
                    double[] a1 = point(o, "x", "y");
                    double[] a2 = point(o, "x2", "y2");
                    if (a1 != null && a2 != null) {
                        long ms = clamp(o.optLong("ms", 300), 100, 1200);
                        GestureGlobal.swipe(a1[0], a1[1], a2[0], a2[1], ms);
                    }
                    break;
                }
                case "back":
                    GestureGlobal.back();
                    break;
                case "home":
                    GestureGlobal.home();
                    break;
                case "text": {
                    String text = o.optString("text", "");
                    if (!text.isEmpty() && text.length() <= 500) GestureGlobal.inputText(text);
                    break;
                }
                case "backspace":
                    GestureGlobal.backspace();
                    break;
                case "enter":
                    GestureGlobal.enter();
                    break;
                default:
                    Log.w(TAG, "Hành động không hỗ trợ: " + action);
            }
        } catch (Exception e) {
            Log.w(TAG, "input error", e);
        }
    }

    /** Normalized double only in [0,1], otherwise rejected (protocol contract). */
    private static double[] point(JSONObject o, String kx, String ky) {
        double x = o.optDouble(kx, Double.NaN);
        double y = o.optDouble(ky, Double.NaN);
        if (Double.isNaN(x) || Double.isNaN(y)) return null;
        if (x < 0 || x > 1 || y < 0 || y > 1) return null;
        return new double[] { x, y };
    }

    private static long clamp(long v, int min, int max) {
        return v < min ? min : (v > max ? max : v);
    }
}
