using System.Buffers;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace HTITRemote.Tests;

/// <summary>
/// Stand-in server for the Android agent implementing the same agent-role protocol:
/// HELLO/AUTH/RESULT handshake, AES-GCM encrypted session, JPEG frames, input capture.
/// Used to e2e-test AgentLink over loopback without a physical device.
/// </summary>
public sealed class FakeAgent : IDisposable
{
    public int Port;
    public string DeviceCode = "123456";
    public string DeviceId = "fake-" + Guid.NewGuid().ToString("N")[..8];
    public string DeviceName = "FAKE-AGENT";
    public bool AutoAccept = true;
    public int FramesToSend = 3;

    public readonly List<string> ReceivedInputs = new();
    public bool SawStop;
    private byte[]? _deviceSecret; // rotated after each successful session, as the real agent does

    private TcpListener? _listener;
    private Thread? _acceptThread;
    private volatile bool _running;

    public void Start()
    {
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _running = true;
        _acceptThread = new Thread(() =>
        {
            while (_running)
            {
                try { Handle(_listener.AcceptTcpClient()); }
                catch (SocketException) { }
                catch (ObjectDisposedException) { break; }
                catch { Thread.Sleep(100); }
            }
        });
        _acceptThread.IsBackground = true;
        _acceptThread.Start();
    }

    private void Handle(TcpClient client)
    {
        try
        {
            Socket s = client.Client;
            s.ReceiveTimeout = 15000;

            // 1) magic + controller nonce (ad)
            byte[] head = new byte[20];
            ReadFully(s, head);
            bool magicOk = head[0] == 0x48 && head[1] == 0x54 && head[2] == 0x52 && head[3] == 0x31;
            if (!magicOk) throw new IOException("bad magic");
            byte[] ad = head[4..20];

            byte[] an = RandomNumberGenerator.GetBytes(16);
            byte[] gen = RandomNumberGenerator.GetBytes(4);
            byte[] transcript = ad.Concat(an).ToArray();

            // 2) HELLO
            SendPlaintext(s, Protocol.Hello, JsonBytes(new
            {
                v = Protocol.ProtocolVersion,
                id = DeviceId,
                dn = DeviceName,
                an = Convert.ToBase64String(an),
                g = Convert.ToBase64String(gen)
            }));

            // 3) AUTH
            var (authType, authPayload) = ReadPlaintextPacket(s);
            if (authType != Protocol.Auth) throw new IOException("auth expected");
            using var adoc = JsonDocument.Parse(authPayload);
            byte[] proofGot = Convert.FromBase64String(adoc.RootElement.GetProperty("p1").GetString()!);
            if (proofGot.Length != 32)
            {
                SendPlaintext(s, Protocol.Result, JsonBytes(new { ok = false, why = "Chưa ghép đôi" }));
                return;
            }

            byte[]? secret = null;
            byte[]? prk = null;
            byte[] codeSecret = SHA256.HashData(Encoding.ASCII.GetBytes(DeviceCode));
            byte[] openSecret = SHA256.HashData(Encoding.ASCII.GetBytes("HTR-OPEN-pairing-v1"));
            foreach (var cand in new[] { _deviceSecret, codeSecret, openSecret })
            {
                if (cand == null) continue;
                byte[] candidatePrk = CoreCrypto.HkdfExtract(
                    Encoding.ASCII.GetBytes("HTR-PWR-v1"), transcript.Concat(cand).ToArray());
                byte[] wantProof = CoreCrypto.HmacSha256(
                    CoreCrypto.HkdfExpand(candidatePrk, "htr c2s v1 proof", 32), transcript, Encoding.ASCII.GetBytes("C"));
                if (CoreCrypto.FixedTimeEquals(wantProof, proofGot))
                {
                    secret = cand;
                    prk = candidatePrk;
                    break;
                }
            }
            if (secret == null || prk == null)
            {
                SendPlaintext(s, Protocol.Result, JsonBytes(new { ok = false, why = "Mã ghép đôi không đúng" }));
                return;
            }

            byte[] proofS = CoreCrypto.HmacSha256(
                CoreCrypto.HkdfExpand(prk, "htr s2c v1 proof", 32), transcript, Encoding.ASCII.GetBytes("S"));
            SendPlaintext(s, Protocol.Result, JsonBytes(new
            {
                ok = true,
                p2 = Convert.ToBase64String(proofS),
                g = Convert.ToBase64String(gen)
            }));

            // rotate device secret like the real agent
            _deviceSecret = CoreCrypto.HkdfExpand(prk, "htr device secret v1", 32);

            // 4) encrypted session
            var tx = new LinkCipher(CoreCrypto.HkdfExpand(prk, "htr s2c v1 key", 32), gen);
            var rx = new LinkCipher(CoreCrypto.HkdfExpand(prk, "htr c2s v1 key", 32), gen);
            object writeLock = new();

            var (reqType, reqPayload) = ReadPacketEncrypted(s, rx);
            if (reqType != Protocol.Req) throw new IOException("req expected");

            if (AutoAccept)
            {
                lock (writeLock)
                    SendPacketEncrypted(s, tx, Protocol.Accept, JsonBytes(new { w = 480, h = 800 }));
                StartFakeFrames(s, tx, writeLock);
            }
            else
            {
                lock (writeLock)
                    SendPacketEncrypted(s, tx, Protocol.Deny, JsonBytes(new { why = "Người dùng đã từ chối" }));
                return;
            }

            while (true)
            {
                var (type, payload) = ReadPacketEncrypted(s, rx);
                switch (type)
                {
                    case Protocol.Ping:
                        lock (writeLock) SendPacketEncrypted(s, tx, Protocol.Pong, Array.Empty<byte>());
                        break;
                    case Protocol.Input:
                        ReceivedInputs.Add(Encoding.UTF8.GetString(payload));
                        break;
                    case Protocol.Stop:
                        SawStop = true;
                        return;
                    case Protocol.Req:
                        lock (writeLock) SendPacketEncrypted(s, tx, Protocol.Err, JsonBytes(new { code = "busy", msg = "đang bận" }));
                        break;
                    case Protocol.Frame:
                        throw new IOException("FRAME từ trình điều khiển là bất hợp pháp");
                    default:
                        break;
                }
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"[FakeAgent] session error: {e}");
#if false
            // socket-level noise after teardown is expected
#endif
        }
        finally
        {
            client.Close();
        }
    }

    private async void StartFakeFrames(Socket s, LinkCipher tx, object writeLock)
    {
        _ = Task.Run(() =>
        {
            try
            {
                for (int i = 0; i < FramesToSend; i++)
                {
                    Thread.Sleep(120);
                    byte[] jpeg = new byte[64];
                    jpeg[0] = (byte)0xFF; jpeg[1] = (byte)0xD8; // SOI
                    jpeg[2] = (byte)i;
                    jpeg[3] = (byte)0xFF; jpeg[4] = (byte)0xD9; // EOI
                    lock (writeLock) SendPacketEncrypted(s, tx, Protocol.Frame, jpeg);
                    Interlocked.Increment(ref SentOk);
                }
            }
            catch { /* socket closed */ }
        });
    }

    public int SentOk;

    // ---------- wire helpers ----------

    private static byte[] JsonBytes(object o) => JsonSerializer.SerializeToUtf8Bytes(o);

    private static void SendPlaintext(Socket s, byte type, byte[] payload) => SendPacketEncrypted(s, null, type, payload);

    private static void SendPacketEncrypted(Socket s, LinkCipher? tx, byte type, byte[] payload)
    {
        byte[] envelope = tx != null ? tx.Encrypt(type, payload) : payload;
        int total = 1 + envelope.Length;
        byte[] p = new byte[4 + total];
        p[0] = (byte)(total >> 24);
        p[1] = (byte)(total >> 16);
        p[2] = (byte)(total >> 8);
        p[3] = (byte)total;
        p[4] = type;
        Buffer.BlockCopy(envelope, 0, p, 5, envelope.Length);
        s.Send(p);
    }

    private static (byte type, byte[] payload) ReadPacketEncrypted(Socket s, LinkCipher rx)
    {
        var (type, env) = ReadPlaintextPacket(s);
        return (type, rx.Decrypt(type, env));
    }

    private static (byte type, byte[] payload) ReadPlaintextPacket(Socket s)
    {
        byte[] hdr = new byte[4];
        ReadFully(s, hdr);
        int total = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
        if (total < 1 || total > 16 * 1024 * 1024) throw new IOException("bad len");
        byte[] body = new byte[total];
        ReadFully(s, body);
        return (body[0], body[1..]);
    }

    private static void ReadFully(Socket s, byte[] target)
    {
        int off = 0;
        while (off < target.Length)
        {
            int n = s.Receive(target, off, target.Length - off, SocketFlags.None);
            if (n == 0) throw new IOException("EOF");
            off += n;
        }
    }

    public void Dispose()
    {
        _running = false;
        try { _listener?.Stop(); } catch { }
    }
}
