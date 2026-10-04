using System.Buffers;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace HTITRemote;

internal enum LinkState
{
    Connecting,
    Handshake,
    Prompting,
    Active,
    Ended,
    Error
}

internal record LinkStatus(LinkState State, string Message, string? DeviceId, string? DeviceName, int? ScreenWidth, int? ScreenHeight, string? ErrorCode);

/// <summary>
/// One live session to an Android agent: TCP + handcrafted secure handshake + AES-GCM session,
/// in/out packet pump, keepalive, and input forwarding.
/// Security invariants: content is never sent before mutual proof of the pairing secret;
/// screen frames are accepted only while the user accepted AND the link is active.
/// </summary>
internal sealed class AgentLink
{
    private const int ConnectTimeoutMs = 5000;
    private const int AuthWaitMs = 6000;
    private const int PromptWaitMs = 60000;
    private const int IdleMaxMs = 15000;

    // Fixed "open" pairing secret for IP-only mode: both sides derive the same session keys
    // without any code. MUST match DeviceIdentity.openSecret() on the Android agent.
    private static readonly byte[] OpenSecret = SHA256.HashData(Encoding.ASCII.GetBytes("HTR-OPEN-pairing-v1"));

    private TcpClient? _client;
    private NetworkStream? _stream;
    private LinkCipher? _tx;
    private LinkCipher? _rx;
    private volatile bool _encrypted;
    private CancellationTokenSource _cts = new();

    public string Host { get; init; } = "";
    public int Port { get; init; }
    public string ControllerName { get; set; } = Environment.MachineName;

    public LinkState CurrentState { get; private set; } = LinkState.Connecting;
    public string? DeviceId { get; private set; }
    public string? DeviceName { get; private set; }
    public int? ScreenWidth { get; private set; }
    public int? ScreenHeight { get; private set; }

    public event Action<LinkStatus>? StatusChanged;
    public event Action<byte[]>? FrameReceived;

    public bool IsUsable => CurrentState is LinkState.Active or LinkState.Prompting or LinkState.Handshake;

    public void Start(string pairingSecret, bool isNewPairing)
    {
        _ = Task.Run(() => RunAsync(pairingSecret, isNewPairing, _cts.Token));
    }

    private async Task RunAsync(string secret, bool isNewPairing, CancellationToken token)
    {
        try
        {
            SetState(LinkState.Connecting, $"Đang kết nối tới {Host}:{Port}…");
            var client = new TcpClient();
            _client = client;
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                timeout.CancelAfter(ConnectTimeoutMs);
                await client.ConnectAsync(Host, Port, timeout.Token);
            }
            _stream = client.GetStream();

            SetState(LinkState.Handshake, "Đang xác thực thiết bị…");
            byte[] ad = RandomNumberGenerator.GetBytes(16);
            await _stream!.WriteAsync(Protocol.Magic);
            await _stream!.WriteAsync(ad);
            var anAndMeta = await ReadPacketAsync(token);
            if (anAndMeta.type != Protocol.Hello) throw new IOException("Thiết bị trả lời sai giao thức");
            byte[] an = ParseHello(anAndMeta.payload);

            // IP-only mode: no pairing code. The session key is derived from a fixed "open"
            // pairing secret that the agent also accepts; authorization is the on-device
            // consent dialog, not a code. (Trade-off: the channel is encrypted but not
            // authenticated — anyone on the LAN who can reach this IP may attempt a session.)
            byte[] secretBytes = OpenSecret;
            byte[] transcript = ad.Concat(an).ToArray();
            byte[] prk = CoreCrypto.HkdfExtract(Encoding.ASCII.GetBytes("HTR-PWR-v1"), transcript.Concat(secretBytes).ToArray());
            _sendKeys = BranchKeys(prk, "c2s");
            _recvKeys = BranchKeys(prk, "s2c");

            byte[] proof1 = CoreCrypto.HmacSha256(_sendKeys.proof, transcript, Encoding.ASCII.GetBytes("C"));
            await SendPacket(Protocol.Auth, JsonPayloadExt.JsonPayload(new { p1 = JsonPayloadExt.ToB64(proof1) }), token);

            var result = await ReadPacketAsync(token);
            if (result.type != Protocol.Result) throw new IOException("Thiết bị trả lời sai giao thức lúc xác thực");
            using (var rdoc = JsonDocument.Parse(result.payload))
            {
                bool ok = rdoc.RootElement.TryGetProperty("ok", out var okEl) && okEl.ValueKind == JsonValueKind.True;
                if (!ok)
                    throw new InvalidOperationException("Mã ghép đôi không đúng");
                if (ok)
                {
                    byte[] gotProof = JsonPayloadExt.FromB64(rdoc.RootElement.GetProperty("p2").GetString()!);
                    byte[] wantProof = CoreCrypto.HmacSha256(_recvKeys.proof, transcript, Encoding.ASCII.GetBytes("S"));
                    if (!CoreCrypto.FixedTimeEquals(gotProof, wantProof))
                        throw new InvalidOperationException("Xác thực thiết bị thất bại (fingerprint không khớp)");
                    byte[] gen = JsonPayloadExt.FromB64(rdoc.RootElement.GetProperty("g").GetString()!);
                    _tx = new LinkCipher(_sendKeys.key, gen);
                    _rx = new LinkCipher(_recvKeys.key, gen);
                    _encrypted = true;
                }
            }

            // Persist the rotated secret on EVERY successful auth, not only first pairing.
            // The agent rotates its stored secret each session; if the controller does not
            // store the same value, the next code-less reconnect computes a different proof
            // and the agent rejects it with "Mã ghép đôi không đúng".
            byte[] rotatedSecret = CoreCrypto.HkdfExpand(prk, "htr device secret v1", 32);
            PairingStore.Save(DeviceId!, DeviceName ?? "?", rotatedSecret, Host);

            await SendPacket(Protocol.Req, JsonPayloadExt.JsonPayload(new { cn = ControllerName }), token);
            SetState(LinkState.Prompting, "Đã gửi yêu cầu hỗ trợ — chờ người dùng Android «Chấp nhận»…");
            _keepAliveTask = Task.Run(() => KeepAliveLoop(token));
            await MessagePumpAsync(token);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            SetState(LinkState.Error, $"Không kết nối được tới {Host}:{Port} (timeout/ KHÔNG PHẢN HỒI)", "timeout");
            await Teardown();
        }
        catch (Exception ex)
        {
            SetState(ErrorState(ex), Describe(ex));
            await Teardown();
        }
    }

    private Task? _keepAliveTask;
    private (byte[] key, byte[] proof) _sendKeys;
    private (byte[] key, byte[] proof) _recvKeys;

    private static (byte[] key, byte[] proof) BranchKeys(byte[] prk, string direction)
    {
        return (
            CoreCrypto.HkdfExpand(prk, $"htr {direction} v1 key", 32),
            CoreCrypto.HkdfExpand(prk, $"htr {direction} v1 proof", 32)
        );
    }

    private static LinkState ErrorState(Exception ex) => ex is OperationCanceledException ? LinkState.Error : LinkState.Error;

    private static string Describe(Exception ex) => ex switch
    {
        SocketException se => $"Không kết nối được tới thiết bị ({se.SocketErrorCode})",
        IOException => $"Kết nối tại bước bắt tay bị lỗi: {ex.Message}",
        InvalidOperationException => ex.Message,
        _ => $"Lỗi phiên: {ex.Message}"
    };

    private static byte[] DeviceSecretFromCode(string code)
    {
        // code: 6 digits typed by operator from the agent screen; K = SHA256(code bytes ASCII)
        return SHA256.HashData(Encoding.ASCII.GetBytes(code));
    }

    private byte[] ParseHello(byte[] payload)
    {
        using var doc = JsonDocument.Parse(payload);
        var root = doc.RootElement;
        DeviceId = root.GetProperty("id").GetString() ?? throw new IOException("HELLO thiếu deviceId");
        DeviceName = root.TryGetProperty("dn", out var dn) ? dn.GetString() : null;
        return JsonPayloadExt.FromB64(root.GetProperty("an").GetString()!);
    }

    private async Task KeepAliveLoop(CancellationToken token)
    {
        while (!token.IsCancellationRequested && IsUsable)
        {
            try
            {
                await Task.Delay(3000, token);
                if (_encrypted) await SendPacket(Protocol.Ping, Array.Empty<byte>(), token);
            }
            catch
            {
                // reader loop reports connection loss
            }
        }
    }

    public void SendInput(string action, double? x, double? y, double? x2, double? y2, int ms)
    {
        if (CurrentState != LinkState.Active) throw new InvalidOperationException("Chưa có phiên đang hoạt động");
        byte[] inputJson = JsonPayloadExt.JsonPayload(new { a = action, x = x, y = y, x2 = x2, y2 = y2, ms = ms });
        SendPacket(Protocol.Input, inputJson, CancellationToken.None).GetAwaiter().GetResult();
    }

    private readonly SemaphoreSlim _sendLock = new(1, 1);

    private async Task SendPacket(byte type, byte[] payload, CancellationToken token)
    {
        try
        {
            await _sendLock.WaitAsync(token);
            byte[] envelope = _encrypted && type != Protocol.Result && _tx != null
                ? _tx.Encrypt(type, payload)
                : payload;
            await _stream!.WriteAsync(Protocol.WritePacket(envelope, type));
        }
        finally
        {
            _sendLock.Release();
        }
    }

    private async Task<(byte type, byte[] payload)> ReadPacketAsync(CancellationToken token)
    {
        byte[] header = new byte[4];
        await ReadFully(header, token);
        int len = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3];
        if (len < 1 || len > 16 * 1024 * 1024) throw new IOException("Gói sai liên kết");
        byte[] buf = new byte[len];
        await ReadFully(buf, token);
        byte type = buf[0];
        return (type, buf[1..]);
    }

    private async Task ReadFully(byte[] target, CancellationToken token)
    {
        int toFill = target.Length;
        int off = 0;
        while (off < toFill)
        {
            using var readTimeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            // While the Android user is deciding on the consent dialog the agent sends nothing,
            // so use the prompt window instead of the short idle timeout, else we hang up early.
            readTimeout.CancelAfter(CurrentState == LinkState.Prompting ? PromptWaitMs : IdleMaxMs);
            int n;
            try
            {
                n = await _stream!.ReadAsync(target.AsMemory(off), readTimeout.Token);
            }
            catch (OperationCanceledException) when (!token.IsCancellationRequested)
            {
                throw new IOException("Thiết bị không phản hồi (timeout)", new TimeoutException());
            }
            if (n == 0) throw new IOException("Thiết bị đã đóng kết nối");
            off += n;
        }
    }

    private async Task MessagePumpAsync(CancellationToken token)
    {
        try
        {
            while (IsUsable && !token.IsCancellationRequested)
            {
                var (type, payload) = await ReadPacketAsync(token);
                if ( !_encrypted )
                    throw new IOException("Gói lúc chưa được mã hóa");
                payload = _rx!.Decrypt(type, payload);
                switch (type)
                {
                    case Protocol.Prompt:
                        SetState(LinkState.Prompting, "Thiết bị đang hiển thị hộp thoại xin phép tới người dùng…");
                        break;
                    case Protocol.Accept:
                        {
                            using var d = JsonDocument.Parse(payload);
                            ScreenWidth = d.RootElement.TryGetInt("w");
                            ScreenHeight = d.RootElement.TryGetInt("h");
                            SetState(LinkState.Active, "Phiên đang hoạt động — thiết bị chia sẻ màn hình tới bạn");
                            break;
                        }
                    case Protocol.Deny:
                        SetState(LinkState.Ended, "Người dùng Android đã từ chối yêu cầu hỗ trợ", "denied");
                        await Teardown();
                        return;
                    case Protocol.Stop:
                        SetState(LinkState.Ended, "Thiết bị đã ngừng chia sẻ màn hình", "peer-stop");
                        await Teardown();
                        return;
                    case Protocol.Err:
                        {
                            using var edoc = JsonDocument.Parse(payload);
                            string? msg = edoc.RootElement.TryGetString("msg", out var m) ? m : null;
                            SetState(LinkState.Error, msg ?? "Thiết bị báo lỗi", "peer-err");
                        }
                        await Teardown();
                        return;
                    case Protocol.Frame:
                        if (CurrentState == LinkState.Active) FrameReceived?.Invoke(payload);
                        break;
                    case Protocol.Pong:
                        break;
                    default:
                        // unknown message types are ignored for forward compatibility
                        break;
                }
            }
        }
        catch (Exception ex) when (ex is IOException or SocketException)
        {
            SetState(LinkState.Ended, "Kết nối tới thiết bị đã mất", "peer-lost");
            await Teardown();
        }
        catch (Exception ex)
        {
            SetState(LinkState.Error, $"Lỗi phiên: {ex.Message}", "pump");
            await Teardown();
        }
    }

    private void SetState(LinkState state, string message, string? errorCode = null)
    {
        CurrentState = state;
        StatusChanged?.Invoke(new LinkStatus(state, message, DeviceId, DeviceName, ScreenWidth, ScreenHeight, errorCode));
    }

    public async Task DisconnectAsync(string reason)
    {
        if (CurrentState == LinkState.Active || CurrentState == LinkState.Prompting)
        {
            try
            {
                if (_encrypted)
                    await SendPacket(Protocol.Stop, JsonPayloadExt.JsonPayload(new { why = reason }), CancellationToken.None);
            }
            catch { /* teardown below regardless */ }
        }
        SetState(LinkState.Ended, $"Bạn đã ngắt phiên: {reason}", "user-stop");
        await Teardown();
    }

    public async Task Teardown()
    {
        _cts.Cancel();
        try
        {
            _stream?.Close();
            _client?.Close();
        }
        catch { }
    }
}

static class JsonExt
{
    public static int? TryGetInt(this JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var p) && p.ValueKind == JsonValueKind.Number ? p.GetInt32() as int? ?? null : null;

    public static bool TryGetString(this JsonElement el, string prop, out string? value)
    {
        if (el.TryGetProperty(prop, out var p) && p.ValueKind == JsonValueKind.String)
        {
            value = p.GetString();
            return true;
        }
        value = null;
        return false;
    }

    public static byte[] u8Bytes(this string s) => Encoding.ASCII.GetBytes(s);
}

static class JsonPayloadExt
{
    public static byte[] JsonPayload(this AgentLink _, object body) => JsonSerializer.SerializeToUtf8Bytes(body);

    public static byte[] JsonPayload(object body) => JsonSerializer.SerializeToUtf8Bytes(body);

    public static string ToB64(byte[] b) => Convert.ToBase64String(b);
    public static byte[] FromB64(string b) => Convert.FromBase64String(b);
}
