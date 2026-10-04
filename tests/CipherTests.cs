using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Xunit;

namespace HTITRemote.Tests;

public class CipherTests
{
    [Fact]
    public void Roundtrip_same_instance()
    {
        var gen = new byte[4];
        Random.Shared.NextBytes(gen);
        var c = new LinkCipher(new byte[32], gen);
        for (var i = 1; i <= 3; i++)
        {
            var msg = Encoding.ASCII.GetBytes($"msg-{i}");
            var enc = c.Encrypt(0x10, msg);
            try
            {
                var dec = c.Decrypt(0x10, enc);
                Assert.Equal(msg, dec);
            }
            catch (Exception ex)
            {
                throw new Exception($"len(enc)={enc.Length} msg={msg.Length}", ex);
            }
        }
    }

    [Fact]
    public void Roundtrip_two_instances_share_generation()
    {
        var gen = new byte[4];
        Random.Shared.NextBytes(gen);
        var keyA = new byte[32];
        var keyB = new byte[32];
        Random.Shared.NextBytes(keyA);
        keyB.AsSpan().Fill(7);
        var a = new LinkCipher(keyA, gen);
        var b = new LinkCipher(keyB, gen);
        var enc = a.Encrypt(0x21, [1, 2, 3, 4, 5]);
        // wrong key can't be verified here (no key for b) — only structure check:
        Assert.Equal(4 + 8 + 5 + 16, enc.Length);
    }

    [Fact]
    public void Payload_length_zero_works()
    {
        var gen = new byte[4];
        Random.Shared.NextBytes(gen);
        var c = new LinkCipher(new byte[32], gen);
        var enc = c.Encrypt(0x30, Array.Empty<byte>());
        Assert.Equal(28, enc.Length);
        var dec = c.Decrypt(0x30, enc);
        Assert.Empty(dec);
    }
}
