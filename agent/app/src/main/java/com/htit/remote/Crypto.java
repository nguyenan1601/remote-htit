package com.htit.remote;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** HKDF (RFC 5869) + HMAC-SHA256 helpers, byte-compatible with server/CoreCrypto.cs. */
public final class Crypto {
    private Crypto() { }

    public static byte[] hmacSha256(byte[] key, byte[]... parts) {
        ByteArrayOutputStream total = new ByteArrayOutputStream();
        for (byte[] p : parts) total.writeBytes(p);
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(total.toByteArray());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    public static byte[] hkdfExtract(byte[] salt, byte[] ikm) {
        return hmacSha256(salt, ikm);
    }

    public static byte[] hkdfExpand(byte[] prk, String label, int length) {
        byte[] labelBytes = label.getBytes(StandardCharsets.US_ASCII);
        ByteArrayOutputStream chunks = new ByteArrayOutputStream();
        byte[] resultBlock = new byte[0];
        int i = 1;
        while (chunks.size() < length) {
            byte[] input = new byte[resultBlock.length + labelBytes.length + 1];
            System.arraycopy(resultBlock, 0, input, 0, resultBlock.length);
            System.arraycopy(labelBytes, 0, input, resultBlock.length, labelBytes.length);
            input[input.length - 1] = (byte) i;
            resultBlock = hmacSha256(prk, input);
            chunks.writeBytes(resultBlock);
            i++;
        }
        return Arrays.copyOfRange(chunks.toByteArray(), 0, length);
    }

    public static byte[] sha256(byte[] data) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(data);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    public static boolean fixedTimeEquals(byte[] a, byte[] b) {
        if (a == null || b == null || a.length != b.length) return false;
        int diff = 0;
        for (int i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        return diff == 0;
    }
}
