using System.Security.Cryptography;

namespace HTITRemote;

/// <summary>
/// AES-256-GCM per-direction cipher.
/// Each direction uses one LinkCipher with the direction's key and shared generation bytes.
/// Envelope layout: [4B generation][8B sequence BE][ciphertext][16B tag].
/// Nonce = generation(4) || sequence[4..8] (12 bytes). AAD = first 8 bytes of [type][seq[1..7]].
/// Sequences are strictly increasing starting at 1; replay/reorder is rejected.
/// </summary>
internal sealed class LinkCipher
{
    private const int GenLen = 4;
    private const int SeqLen = 8;
    private const int TagLen = 16;

    private readonly AesGcm _aes;
    private readonly byte[] _generation;
    private ulong _txSeq;
    private ulong _rxSeq;
    private bool _rxStarted;

    public LinkCipher(byte[] key, byte[] generation)
    {
        _aes = new AesGcm(key, TagLen);
        _generation = generation;
    }

    public static int EnvelopeOverhead => GenLen + SeqLen + TagLen;

    public byte[] Encrypt(byte type, byte[] plaintext)
    {
        ulong seq = ++_txSeq;
        byte[] seqBytes = new byte[SeqLen];
        WriteU64BE(seqBytes, seq);
        byte[] nonce = BuildNonce(_generation, seqBytes);
        byte[] outBuf = new byte[GenLen + SeqLen + plaintext.Length + TagLen];
        Buffer.BlockCopy(_generation, 0, outBuf, 0, GenLen);
        Buffer.BlockCopy(seqBytes, 0, outBuf, GenLen, SeqLen);
        byte[] ct = new byte[plaintext.Length];
        byte[] tag = new byte[TagLen];
        _aes.Encrypt(nonce, plaintext, ct, tag, Aad(type, seqBytes));
        Buffer.BlockCopy(ct, 0, outBuf, GenLen + SeqLen, ct.Length);
        Buffer.BlockCopy(tag, 0, outBuf, outBuf.Length - TagLen, TagLen);
        return outBuf;
    }

    public byte[] Decrypt(byte expectedType, byte[] envelope)
    {
        int header = GenLen + SeqLen;
        if (envelope.Length < header + TagLen) throw new InvalidOperationException("envelope too short");
        ValidateGeneration(envelope[0..GenLen]);
        ulong seq = ReadU64BE(envelope[GenLen..(GenLen + SeqLen)]);
        if ((_rxStarted && seq != _rxSeq + 1) || (!_rxStarted && seq < 1))
            throw new InvalidOperationException($"seq {seq} replay/reorder");

        byte[] ct = envelope[header..^TagLen];
        byte[] tag = envelope[^TagLen..];
        byte[] pt = new byte[ct.Length];
        byte[] nonce = BuildNonce(envelope[0..GenLen], envelope[GenLen..(GenLen + SeqLen)]);
        byte[] aad = Aad(expectedType, envelope[GenLen..(GenLen + SeqLen)]);
        _aes.Decrypt(nonce, ct, tag, pt, aad);
        _rxSeq = seq;
        _rxStarted = true;
        return pt;
    }

    private void ValidateGeneration(byte[] got)
    {
        if (!CryptographicOperations.FixedTimeEquals(got, _generation))
            throw new InvalidOperationException("unknown generation");
    }

    private static byte[] BuildNonce(byte[] gen, byte[] seqBytes)
    {
        byte[] nonce = new byte[12];
        Buffer.BlockCopy(gen, 0, nonce, 0, GenLen);
        Buffer.BlockCopy(seqBytes, 0, nonce, GenLen, 8); // nonce = gen(4) || full seq (8B) = 12 bytes
        return nonce;
    }

    private static byte[] Aad(byte type, byte[] seqBytes)
    {
        byte[] aad = new byte[8];
        aad[0] = type;
        Buffer.BlockCopy(seqBytes, 1, aad, 1, 7);
        return aad;
    }

    public static void WriteU64BE(byte[] buf, ulong v)
    {
        for (int i = 7; i >= 0; i--)
        {
            buf[i] = (byte)(v & 0xFF);
            v >>= 8;
        }
    }

    public static ulong ReadU64BE(byte[] buf)
    {
        ulong v = 0;
        for (int i = 0; i < 8; i++) v = (v << 8) | buf[i];
        return v;
    }
}
