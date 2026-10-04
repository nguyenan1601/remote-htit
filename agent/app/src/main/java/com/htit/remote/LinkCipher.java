package com.htit.remote;

import java.io.ByteArrayOutputStream;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * One direction of the AES-256-GCM session, byte-compatible with server/CipherLink.cs.
 * Envelope: [4B gen][8B seq BE][ciphertext][16B tag]; nonce(12) = gen(4) || seq(8B BE);
 * AAD(8) = [type][seq low 7 bytes]; tag 128-bit.
 */
public final class LinkCipher {
    private static final int GEN_LEN = 4;
    private static final int SEQ_LEN = 8;
    private static final int TAG_LEN = 16;
    private static final int NONCE_LEN = 12;

    private final SecretKeySpec key;
    private final byte[] generation;
    private long txSeq;
    private long rxSeq;
    private boolean rxStarted;

    public LinkCipher(byte[] keyBytes, byte[] generation) {
        this.key = new SecretKeySpec(keyBytes, "AES");
        this.generation = generation;
    }

    public static int envelopeOverhead() {
        return GEN_LEN + SEQ_LEN + TAG_LEN;
    }

    public byte[] encrypt(byte type, byte[] plaintext) throws Exception {
        long seq = ++txSeq;
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_LEN * 8, nonceForSeq(seq)));
        cipher.updateAAD(aad(type, seq));
        byte[] ct = cipher.doFinal(plaintext); // ciphertext + 16B tag

        ByteArrayOutputStream env = new ByteArrayOutputStream(GEN_LEN + SEQ_LEN + ct.length);
        env.writeBytes(generation);
        env.writeBytes(seqBytesBE(seq));
        env.writeBytes(ct);
        return env.toByteArray();
    }

    public byte[] decrypt(byte expectedType, byte[] envelope) throws Exception {
        if (envelope.length < GEN_LEN + SEQ_LEN + TAG_LEN) throw new Exception("envelope too short");
        byte[] gen = new byte[GEN_LEN];
        System.arraycopy(envelope, 0, gen, 0, GEN_LEN);
        if (!Crypto.fixedTimeEquals(gen, generation)) throw new Exception("unknown generation");
        long seq = readLongBE(envelope, GEN_LEN);
        if ((rxStarted && seq != rxSeq + 1) || (!rxStarted && seq < 1))
            throw new Exception("replay/reorder seq=" + seq);

        // Java GCM expects ciphertext || tag in doFinal; unlike .NET, the tag must NOT be stripped.
        byte[] ct = new byte[envelope.length - GEN_LEN - SEQ_LEN];
        System.arraycopy(envelope, GEN_LEN + SEQ_LEN, ct, 0, ct.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_LEN * 8, nonceForSeq(seq)));
        cipher.updateAAD(aad(expectedType, seq));
        byte[] pt = cipher.doFinal(ct);
        rxSeq = seq;
        rxStarted = true;
        return pt;
    }

    private byte[] nonceForSeq(long seq) {
        byte[] nonce = new byte[NONCE_LEN];
        System.arraycopy(generation, 0, nonce, 0, GEN_LEN);
        byte[] sb = seqBytesBE(seq);
        System.arraycopy(sb, 0, nonce, GEN_LEN, 8);
        return nonce;
    }

    private static byte[] seqBytesBE(long seq) {
        byte[] b = new byte[SEQ_LEN];
        for (int i = 7; i >= 0; i--) { b[i] = (byte) (seq & 0xFF); seq >>>= 8; }
        return b;
    }

    private static byte[] aad(byte type, long seq) {
        byte[] aad = new byte[8];
        aad[0] = type;
        System.arraycopy(seqBytesBE(seq), 1, aad, 1, 7);
        return aad;
    }

    private static long readLongBE(byte[] buf, int off) {
        long v = 0;
        for (int i = 0; i < 8; i++) v = (v << 8) | (buf[off + i] & 0xFFL);
        return v;
    }

    public static byte[] randomBytes(int n) {
        byte[] b = new byte[n];
        new SecureRandom().nextBytes(b);
        return b;
    }
}
