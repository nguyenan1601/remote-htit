package com.htit.remote;

/**
 * Mirror of the C# implementation in server/CoreCrypto.cs. MUST stay byte-compatible:
 *  - prk      = HKDF-Extract(salt:"HTR-PWR-v1", ikm: transcript || secret)
 *  - hkey(dir) = HKDF-Expand(prk, "htr {dir} v1 key", 32)
 *  - proof(dir) = HMAC-SHA256(key = HKDF-Expand(prk, "htr {dir} v1 proof", 32), transcript || dirTag)
 *  - deviceSecret = HKDF-Expand(prk, "htr device secret v1", 32)
 *  - session envelope: [4B gen][8B seq BE][ciphertext][16B GCM tag]
 *    nonce(12B) = gen(4) || seq(8B); AAD(8B) = [type][seq[1..7]]
 *  - code-derived secret = SHA-256(ascii code)
 */
public final class Wire {
    public static final int PROTOCOL_VERSION = 1;
    public static final byte[] MAGIC = {'H', 'T', 'R', '1'};

    // Packet types (same values as C# Protocol class)
    public static final byte T_HELLO = 0x01;
    public static final byte T_AUTH = 0x02;
    public static final byte T_RESULT = 0x03;
    public static final byte T_REQ = 0x10;
    public static final byte T_PROMPT = 0x11;
    public static final byte T_ACCEPT = 0x12;
    public static final byte T_DENY = 0x13;
    public static final byte T_FRAME = 0x20;
    public static final byte T_INPUT = 0x21;
    public static final byte T_STOP = 0x22;
    public static final byte T_PING = 0x30;
    public static final byte T_PONG = 0x31;
    public static final byte T_ERR = 0x24;

    private Wire() { }
}
