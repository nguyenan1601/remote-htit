namespace HTITRemote;

/// <summary>
/// Wire protocol spec (lite, handshake in cleartext, payload JSON as UTF-8 with base64 binary fields):
///   Frame = [4-byte big-endian length][1-byte message type][payload].
///   Length covers type byte only, not the 4-byte length prefix, but does include the payload bytes.
///   Cleartext handshake: Hello(0x01), Auth(0x02), Result(0x03). After Result both sides switch to an
///   encrypted envelope: [4B len][1B type][4B generation][8B txSeq BE][12B nonce][ct+16B tag].
///   AES-256-GCM. That is per-direction (c2s/s2c) HKDF branch keys. Frames use big JPEG binary payloads.
/// </summary>
internal static class Protocol
{
    // Handshake (cleartext)
    internal const byte Hello = 0x01;
    internal const byte Auth = 0x02;
    internal const byte Result = 0x03;

    // Session (encrypted)
    internal const byte Req = 0x10;        // C->S first encrypted message: ask for support session
    internal const byte Prompt = 0x11;     // S->C: prompting user on device
    internal const byte Accept = 0x12;     // S->C: user accepted, stream starting {w,h}
    internal const byte Deny = 0x13;       // S->C: user declined {why}
    internal const byte Frame = 0x20;      // S->C: JPEG bytes
    internal const byte Input = 0x21;      // C->S: {a,x,y,x2,y2,ms}
    internal const byte Stop = 0x22;       // both: stop session
    internal const byte Err = 0x24;        // S->C: {code,msg}
    internal const byte Ping = 0x30;       // C->S
    internal const byte Pong = 0x31;       // S->C

    internal const int ProtocolVersion = 1;
    internal static readonly byte[] Magic = [0x48, 0x54, 0x52, 0x31]; // "HTR1"

    internal static byte[] WritePacket(byte[] payload, byte type)
    {
        int total = 1 + payload.Length;
        byte[] buf = new byte[4 + total];
        buf[0] = (byte)(total >> 24);
        buf[1] = (byte)(total >> 16);
        buf[2] = (byte)(total >> 8);
        buf[3] = (byte)total;
        buf[4] = type;
        Buffer.BlockCopy(payload, 0, buf, 5, payload.Length);
        return buf;
    }

    internal static (byte type, byte[] payload, int consumed) ReadPacket(byte[] buffer, int available)
    {
        if (available < 5) return (0, [], 0);
        int len = (buffer[0] << 24) | (buffer[1] << 16) | (buffer[2] << 8) | buffer[3];
        if (len < 1 || len > 8 * 1024 * 1024) throw new IOException("Bad frame length");
        if (available < 4 + len) return (0, [], 0);
        byte type = buffer[4];
        byte[] payload = buffer[5..(4 + len)];
        return (type, payload, 4 + len);
    }
}
