using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace HTITRemote.Tests;

/// <summary>
/// Full-stack e2e: real Kestrel server (LinkHub + AgentLink + static files) vs FakeAgent
/// acting as the Android side. Covers: connect flow, pairing, prompt accept, frame push
/// over WebSocket, input forward, disconnect, and token auth refusal without token.
/// </summary>
public sealed class WebE2ETests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;

    public WebE2ETests(WebApplicationFactory<Program> factory) => _factory = factory;

    private static string Token()
    {
        string path = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "HTITRemote", "webtoken.txt");
        return File.ReadAllText(path).Trim();
    }

    [Fact]
    public async Task Connect_updates_status_to_active_and_streams_frames_over_ws()
    {
        using var agent = new FakeAgent { DeviceCode = "991177" };
        agent.Start();

        var client = _factory.CreateDefaultClient();
        client.DefaultRequestHeaders.Add("X-Htit-Token", Token());

        // token guard: no token -> 401
        var bare = _factory.CreateClient();
        int status = (int)(await bare.GetAsync("/api/state")).StatusCode;
        Assert.Equal(401, status);

        // connect with pairing code
        var resp = await client.PostAsJsonAsync("/api/connect", new { host = "127.0.0.1", port = agent.Port, code = "991177" });
        resp.EnsureSuccessStatusCode();

        // wait for Active via /api/state
        object? snap = null;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < 8000)
        {
            var state = await client.GetFromJsonAsync<Dictionary<string, JsonElement>>("/api/state");
            if (state!["status"].GetString() == "active") { snap = state; break; }
            await Task.Delay(100);
        }
        Assert.NotNull(snap);
        var s = (Dictionary<string, JsonElement>)snap!;
        Assert.Equal("FAKE-AGENT", s["deviceName"].GetString());
        Assert.Equal(480, s["screenW"].GetInt32());

        // WebSocket receives binary frames and forwards inputs
        var wsUri = new Uri(new Uri("http://localhost"), "/api/ws?t=" + Token());
        var ws = await _factory.Server.CreateWebSocketClient().ConnectAsync(wsUri, CancellationToken.None);
        var buf = new byte[128];
        var frameBytes = await ws.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None);
        Assert.True(frameBytes.MessageType == WebSocketMessageType.Text);
        string hello = System.Text.Encoding.UTF8.GetString(buf, 0, frameBytes.Count);

        int binaryFrames = 0;
        byte[] big = new byte[64 * 1024];
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline && binaryFrames < 2)
        {
            var r = await ws.ReceiveAsync(new ArraySegment<byte>(big), CancellationToken.None);
            if (r.MessageType == WebSocketMessageType.Binary && r.EndOfMessage) binaryFrames++;
        }
        Assert.True(binaryFrames >= 2, $"binary frames kia quá ít: {binaryFrames}");

        // send an input through ws, agent must record it
        byte[] msg = System.Text.Encoding.UTF8.GetBytes("{\"t\":\"input\",\"a\":\"tap\",\"x\":0.4,\"y\":0.6}");
        await ws.SendAsync(msg, WebSocketMessageType.Text, true, CancellationToken.None);
        TestGate.Eventually(() => agent.ReceivedInputs.Count > 0);
        Assert.Contains("tap", agent.ReceivedInputs[0], StringComparison.Ordinal);

        // disconnect through REST
        _ = await client.PostAsync("/api/disconnect", null);
        TestGate.Eventually(() => agent.SawStop, 8000);
        Assert.True(agent.SawStop);
    }

    [Fact]
    public async Task Connect_without_code_succeeds_via_open_secret()
    {
        using var agent = new FakeAgent { DeviceCode = "746262", FramesToSend = 1 };
        agent.Start();
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Htit-Token", Token());

        // IP-only mode: no pairing code is required; the fixed open secret authenticates the session.
        await client.PostAsJsonAsync("/api/connect", new { host = "127.0.0.1", port = agent.Port });
        var sw = System.Diagnostics.Stopwatch.StartNew();
        string last = "";
        while (sw.ElapsedMilliseconds < 8000)
        {
            var state = await client.GetFromJsonAsync<Dictionary<string, JsonElement>>("/api/state");
            last = state!["status"].GetString()!;
            if (last is "active" or "error") break;
            await Task.Delay(100);
        }
        Assert.Equal("active", last);
        await client.PostAsync("/api/disconnect", null);
    }

    [Fact]
    public async Task Repeated_reconnects_without_code_keep_working_after_secret_rotation()
    {
        using var agent = new FakeAgent { DeviceCode = "445566", FramesToSend = 1 };
        agent.Start();
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Htit-Token", Token());

        // Pairing with the code, then two code-less reconnects. The agent rotates its stored
        // secret every session, so the controller must persist the same rotation or the third
        // connect would compute a different proof and be rejected.
        Assert.Equal("active", await ConnectAndWait(client, agent.Port, "445566"));
        await client.PostAsync("/api/disconnect", null);
        await Task.Delay(400);

        Assert.Equal("active", await ConnectAndWait(client, agent.Port, null));
        await client.PostAsync("/api/disconnect", null);
        await Task.Delay(400);

        Assert.Equal("active", await ConnectAndWait(client, agent.Port, null));
        await client.PostAsync("/api/disconnect", null);
    }

    private static async Task<string> ConnectAndWait(HttpClient client, int port, string? code)
    {
        await client.PostAsJsonAsync("/api/connect", new { host = "127.0.0.1", port, code });
        var sw = System.Diagnostics.Stopwatch.StartNew();
        string last = "";
        while (sw.ElapsedMilliseconds < 8000)
        {
            var state = await client.GetFromJsonAsync<Dictionary<string, JsonElement>>("/api/state");
            last = state!["status"].GetString()!;
            if (last is "active" or "error" or "pairing-required") break;
            await Task.Delay(100);
        }
        return last;
    }

    [Fact]
    public async Task Forget_pairing_removes_device_and_requires_token()
    {
        string id = "forget-" + Guid.NewGuid().ToString("N");
        PairingStore.Save(id, "FORGET-ME", new byte[32], "192.0.2.1");

        var bare = _factory.CreateClient();
        var denied = await bare.PostAsync($"/api/paired/{id}/forget", null);
        Assert.Equal(401, (int)denied.StatusCode);

        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Htit-Token", Token());
        var response = await client.PostAsync($"/api/paired/{id}/forget", null);
        response.EnsureSuccessStatusCode();
        Assert.Null(PairingStore.Get(id));

        var missing = await client.PostAsync($"/api/paired/{id}/forget", null);
        Assert.Equal(404, (int)missing.StatusCode);
    }
}
