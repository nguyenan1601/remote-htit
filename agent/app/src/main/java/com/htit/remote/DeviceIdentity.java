package com.htit.remote;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Device identity + persisted pairing secret.
 * The pairing secret is stored encrypted with an AndroidKeyStore AES key, so simply
 * reading app storage does not reveal the shared secret.
 */
public final class DeviceIdentity {
    private static final String KEYSTORE_ALIAS = "htit-store-key";
    private static final String PREFS = "htit-remote";
    private static final String K_DEVICE_ID = "device_id";
    private static final String K_DEVICE_NAME = "device_name";
    private static final String K_SECRET = "paired_secret_enc";
    private static final String K_PAIRED_ID = "paired_controller_id";

    private static DeviceIdentity instance;
    private final Context appContext;
    private final SharedPreferences prefs;

    private DeviceIdentity(Context c) {
        appContext = c.getApplicationContext();
        prefs = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static synchronized DeviceIdentity get(Context c) {
        if (instance == null) instance = new DeviceIdentity(c);
        return instance;
    }

    public synchronized String deviceId() {
        String id = prefs.getString(K_DEVICE_ID, null);
        if (id == null) {
            id = java.util.UUID.randomUUID().toString();
            prefs.edit().putString(K_DEVICE_ID, id).apply();
        }
        return id;
    }

    public synchronized String deviceName() {
        String name = prefs.getString(K_DEVICE_NAME, null);
        if (name == null || name.isEmpty()) {
            name = android.os.Build.MODEL + " (" + deviceId().substring(0, 4) + ")";
            prefs.edit().putString(K_DEVICE_NAME, name).apply();
        }
        return name;
    }

    public void setDeviceName(String name) {
        prefs.edit().putString(K_DEVICE_NAME, name).apply();
    }

    /** Pairing code shown on the screen; generated once per install and kept stable. */
    public synchronized String pairingCode() {
        String code = prefs.getString("pairing_code", null);
        if (code == null) {
            code = String.format("%06d", new SecureRandom().nextInt(1000000));
            prefs.edit().putString("pairing_code", code).apply();
        }
        return code;
    }

    public synchronized byte[] storedSecret() {
        String enc = prefs.getString(K_SECRET, null);
        if (enc == null) return null;
        try {
            byte[] blob = Base64.getDecoder().decode(enc);
            byte[] iv = new byte[12];
            byte[] ct = new byte[blob.length - 12];
            System.arraycopy(blob, 0, iv, 0, 12);
            System.arraycopy(blob, 12, ct, 0, ct.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, keystoreKey(), new GCMParameterSpec(128, iv));
            return cipher.doFinal(ct);
        } catch (Exception e) {
            return null;
        }
    }

    public synchronized void storeSecret(byte[] secret) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, keystoreKey());
            byte[] iv = cipher.getIV();
            byte[] ct = cipher.doFinal(secret);
            byte[] blob = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, blob, 0, iv.length);
            System.arraycopy(ct, 0, blob, iv.length, ct.length);
            prefs.edit().putString(K_SECRET, Base64.getEncoder().encodeToString(blob)).apply();
        } catch (Exception e) {
            throw new IllegalStateException("Không lưu được secret", e);
        }
    }

    public synchronized void clearSecret() {
        prefs.edit().remove(K_SECRET).apply();
    }

    /** Code (6 digits typed on both ends) -> initial shared secret. SHA256(ascii) mirrors C# side. */
    public static byte[] secretFromCode(String code) {
        return Crypto.sha256(code.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
    }

    /** Fixed "open" secret for IP-only mode. MUST match AgentLink.OpenSecret (C#) on the controller. */
    public static byte[] openSecret() {
        return Crypto.sha256("HTR-OPEN-pairing-v1".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
    }

    private SecretKey keystoreKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        SecretKey existing = (SecretKey) ks.getKey(KEYSTORE_ALIAS, null);
        if (existing != null) return existing;

        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(KEYSTORE_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build());
        SecretKey key = gen.generateKey();
        ks.load(null); // refresh
        return key;
    }
}
