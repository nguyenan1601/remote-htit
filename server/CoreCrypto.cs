using System.Security.Cryptography;
using System.Text;

namespace HTITRemote;

internal static class CoreCrypto
{
    public static byte[] HmacSha256(byte[] key, params byte[][] parts)
    {
        using var h = new HMACSHA256(key);
        byte[] total = parts.SelectMany(p => p).ToArray();
        return h.ComputeHash(total);
    }

    public static byte[] HkdfExtract(byte[] salt, byte[] ikm)
    {
        using var h = new HMACSHA256(salt);
        return h.ComputeHash(ikm);
    }

    public static byte[] HkdfExpand(byte[] prk, string label, int length = 32) =>
        HkdfExpand(prk, Encoding.ASCII.GetBytes(label), length);

    public static byte[] HkdfExpand(byte[] prk, byte[] info, int length = 32)
    {
        byte[] resultBlock = Array.Empty<byte>();
        var chunks = new List<byte[]>();
        for (int i = 1; chunks.Sum(c => c.Length) < length; i++)
        {
            using var h = new HMACSHA256(prk);
            byte[] input = resultBlock.Concat(info).Append((byte)i).ToArray();
            resultBlock = h.ComputeHash(input);
            chunks.Add(resultBlock);
        }
        return chunks.SelectMany(c => c).Take(length).ToArray();
    }

    public static bool FixedTimeEquals(byte[] a, byte[] b) => CryptographicOperations.FixedTimeEquals(a, b);
}
