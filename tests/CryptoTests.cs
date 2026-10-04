using System.Security.Cryptography;
using System.Text;
using Xunit;

namespace HTITRemote.Tests;

public class CryptoTests
{
    [Fact]
    public void Hkdf_matches_known_rfc5869_case_1()
    {
        // RFC 5869 A.1 test vector (SHA-256)
        byte[] ikm = Enumerable.Repeat((byte)0x0b, 22).ToArray();
        byte[] salt = Convert.FromHexString("000102030405060708090a0b0c");
        byte[] info = Convert.FromHexString("f0f1f2f3f4f5f6f7f8f9");
        byte[] okm = CoreCrypto.HkdfExpand(CoreCrypto.HkdfExtract(salt, ikm), info, 42);
        Assert.Equal(42, okm.Length);
        Assert.Equal("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865", ToHex(okm));
    }

    [Fact]
    public void Hkdf_matches_known_rfc5869_case_2()
    {
        // RFC 5869 A.2 (SHA-256): ikm = 0x00..0x4f, salt = 0x60..0xaf, info = 0xb0..0xff
        byte[] ikm = Enumerable.Range(0, 80).Select(i => (byte)i).ToArray();
        byte[] salt = Enumerable.Range(0x60, 80).Select(i => (byte)i).ToArray();
        byte[] info = Enumerable.Range(0xb0, 80).Select(i => (byte)i).ToArray();
        byte[] okm = CoreCrypto.HkdfExpand(CoreCrypto.HkdfExtract(salt, ikm), info, 42);
        Assert.Equal("b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb", ToHex(okm));
    }

    [Fact]
    public void Hmac_transcript_probe_is_deterministic()
    {
        byte[] k = CoreCrypto.HkdfExpand(new byte[32], "htr c2s v1 proof", 32);
        byte[] t1 = CoreCrypto.HmacSha256(k, new byte[] { 1, 2, 3 }, "C".u8());
        byte[] t2 = CoreCrypto.HmacSha256(k, new byte[] { 1, 2, 3 }, "C".u8());
        Assert.Equal(t1, t2);
        Assert.NotEqual(t1, CoreCrypto.HmacSha256(k, new byte[] { 1, 2, 3 }, "S".u8()));
    }

    static string ToHex(byte[] b) => Convert.ToHexString(b).ToLowerInvariant();
}

public static class TestHelp
{
    public static byte[] u8(this string s) => Encoding.ASCII.GetBytes(s);
}
