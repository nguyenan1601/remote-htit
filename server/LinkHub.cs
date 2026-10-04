using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace HTITRemote;

/// <summary>Singleton orchestrator: at most one device link, multiple browser viewer sockets.</summary>
internal sealed class LinkHub
{
    public static LinkHub Instance { get; } = new();

    private AgentLink? _link;
    private readonly object _gate = new();
    private readonly List<WebSocket> _viewers = new();
    private readonly SemaphoreSlim _wsLock = new(1, 1);
    private string _webToken = "";
    private string _lastStatus = "idle";
    private string _lastMessage = "";

    private LinkHub() { }

    public void Init(IHostApplicationLifetime lifetime)
    {
        lifetime.ApplicationStopping.Register(() =>
        {
            lock (_gate) _ = _link?.DisconnectAsync("server-shutdown");
        });
        _webToken = LoadOrInitToken();
        Console.WriteLine($"Web access token: {_webToken}");
    }

    private static string LoadOrInitToken()
    {
        try
        {
            string path = Path.Combine(AppContext.BaseDirectory, "webtoken.txt");
            string baseDir = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            baseDir = Path.Combine(baseDir, "HTITRemote");
            Directory.CreateDirectory(baseDir);
            path = Path.Combine(baseDir, "webtoken.txt");
            if (File.Exists(path)) return File.ReadAllText(path).Trim();
            string tokenBytes = Convert.ToHexString(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant();
            File.WriteAllText(path, tokenBytes);
            return tokenBytes;
        }
        catch
        {
            return Convert.ToHexString(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant();
        }
    }

    public bool TokenOk(string? token) => !string.IsNullOrWhiteSpace(token) && token == _webToken;

    public object StateSnapshot() => new
    {
        status = _link != null ? GlobalStateName() : _lastStatus,
        message = _link != null ? "" : _lastMessage,
        deviceId = _link?.DeviceId,
        deviceName = _link?.DeviceName,
        screenW = _link?.ScreenWidth,
        screenH = _link?.ScreenHeight,
        connectedHost = _link?.Host,
        paired = PairingStore.All().Select(p => new { deviceId = p.DeviceId, deviceName = p.DeviceName, lastIp = p.LastIp, pairedAt = p.PairedAt }),
        hostName = Environment.MachineName,
        isBusy = _link is { IsUsable: true }
    };

    public string GlobalStateName() => GlobalStateNameImpl();

    private string GlobalStateNameImpl()
    {
        lock (_gate)
        {
            if (_link == null) return "idle";
            return _link.CurrentState switch
            {
                LinkState.Connecting => "connecting",
                LinkState.Handshake => "handshake",
                LinkState.Prompting => "prompting",
                LinkState.Active => "active",
                LinkState.Ended => "ended",
                LinkState.Error => "error",
                _ => "idle"
            };
        }
    }

    public async Task ConnectAsync(string host, int port, string? code)
    {
        lock (_gate)
        {
            if (_link is { IsUsable: true })
            {
                BroadcastStatus("busy", "Đã có phiên đang hoạt động với một thiết bị");
                return;
            }
        }
        // deviceId is learned after the HELLO; AgentLink resolves stored pairing itself.
        // Empty code => paired-reconnect attempt if known; otherwise the agent asks for pairing code.
        bool isNewPairing = !string.IsNullOrWhiteSpace(code);
        var linkNow = new AgentLink { Host = host, Port = port, ControllerName = Environment.MachineName };
        lock (_gate) _link = linkNow;
        linkNow.StatusChanged += OnLinkStatusChanged;
        linkNow.FrameReceived += OnFrame;
        linkNow.Start((code ?? "").Trim(), isNewPairing);
    }

    private void OnLinkStatusChanged(LinkStatus st)
    {
        string s = st.State switch
        {
            LinkState.Connecting => "connecting",
            LinkState.Handshake => "handshake",
            LinkState.Prompting => "prompting",
            LinkState.Active => "active",
            LinkState.Ended => "ended",
            LinkState.Error => st.ErrorCode == "pairing-required" ? "pairing-required" : "error",
            _ => "unknown"
        };
        if (st.State is LinkState.Ended or LinkState.Error)
        {
            lock (_gate)
            {
                _link = null;
            }
        }
        BroadcastStatus(s, st.Message, st.DeviceId, st.DeviceName, st.ScreenWidth, st.ScreenHeight, st.ErrorCode);
    }

    public async Task DisconnectAsync(string reason)
    {
        AgentLink? l;
        lock (_gate) { l = _link; }
        if (l != null) await l.DisconnectAsync(reason);
        BroadcastStatus("ended", reason, null);
    }

    public void HandleInput(string raw)
    {
        try
        {
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            AgentLink? l = null;
            lock (_gate) { l = _link; }
            switch (root.GetProperty("t").GetString())
            {
                case "input":
                    string action = root.GetProperty("a").GetString() ?? "";
                    if (action is not ("tap" or "long" or "swipe" or "down" or "up" or "back" or "home"))
                        return;
                    double? x = TryGet(root, "x");
                    double? y = TryGet(root, "y");
                    double? x2 = TryGet(root, "x2");
                    double? y2 = TryGet(root, "y2");
                    int ms = root.TryGetProperty("ms", out var msEl) ? msEl.GetInt32() : 0;
                    l?.SendInput(action, x, y, x2, y2, ms);
                    break;
                case "disconnect":
                    _ = DisconnectAsync("Nhấn «Ngắt kết nối» từ trình duyệt");
                    break;
            }
        }
        catch
        {
        }
    }

    private static double? TryGet(JsonElement root, string prop) =>
        root.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : (double?)null;

    public async Task AddViewer(WebSocket ws)
    {
        lock (_wsLock) _viewers.Add(ws);
        var snapshot = JsonSerializer.Serialize(new { t = "status", s = GlobalStateName(), DeviceName = _link?.DeviceName });
        var bytes = Encoding.UTF8.GetBytes(snapshot);
        if (ws.State == WebSocketState.Open)
            await ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
        byte[] buffer = new byte[64 * 1024];
        while (ws.State == WebSocketState.Open)
        {
            var result = await ws.ReceiveAsync(buffer, CancellationToken.None);
            if (result.MessageType == WebSocketMessageType.Close) break;
            if (result.MessageType == WebSocketMessageType.Text)
            {
                string text = Encoding.UTF8.GetString(buffer, 0, result.Count);
                string full = text;
                if (!result.EndOfMessage)
                {
                    var sb = new StringBuilder(text);
                    while (!result.EndOfMessage)
                    {
                        result = await ws.ReceiveAsync(buffer, CancellationToken.None);
                        if (result.MessageType != WebSocketMessageType.Text) break;
                        sb.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                    }
                    full = sb.ToString();
                }
                HandleInput(full);
            }
        }
        lock (_wsLock) _viewers.Remove(ws);
    }

    private void BroadcastStatus(string s, string message, string? deviceId = null, string? deviceName = null, int? w = null, int? h = null, string? code = null)
    {
        lock (_gate)
        {
            if (_link == null)
            {
                // Do not let the terminal "ended" overwrite a more actionable terminal status
                // reported by the same link (e.g. pairing-required).
                if (!(s == "ended" && (_lastStatus == "pairing-required" || _lastStatus == "error")))
                {
                    _lastStatus = s;
                    _lastMessage = message ?? "";
                }
            }
        }
        var evt = JsonSerializer.Serialize(new { t = "status", s = s, message, deviceId, deviceName, w, h, code });
        _ = SendTextToViewersAsync(Encoding.UTF8.GetBytes(evt));
    }

    private async Task SendTextToViewersAsync(byte[] payload)
    {
        WebSocket[] targets;
        lock (_wsLock) targets = _viewers.Where(v => v.State == WebSocketState.Open).ToArray();
        foreach (var v in targets)
        {
            try
            {
                await v.SendAsync(payload, WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch
            {
                lock (_wsLock) _viewers.Remove(v);
            }
        }
    }

    private void OnFrame(byte[] jpeg)
    {
        WebSocket[] targets;
        lock (_wsLock) targets = _viewers.Where(v => v.State == WebSocketState.Open).ToArray();
        foreach (var v in targets)
        {
            try
            {
                var seg = new ArraySegment<byte>(jpeg);
                v.SendAsync(seg, WebSocketMessageType.Binary, true, CancellationToken.None);
            }
            catch
            {
                lock (_wsLock) _viewers.Remove(v);
            }
        }
    }
}
