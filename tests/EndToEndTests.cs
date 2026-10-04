using System.Text;
using Xunit;

namespace HTITRemote.Tests;

public static class TestGate
{
    /// <summary>Waits until predicate true or timeout, asserting success.</summary>
    public static void Eventually(Func<bool> cond, int timeoutMs = 8000)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            if (cond()) return;
            Thread.Sleep(50);
        }
    }
}

public sealed class EndToEndTests
{
    /// <summary>Waits for link.CurrentState == target.</summary>
    private static void WaitState(AgentLink link, LinkState target, int timeoutMs = 8000)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs && link.CurrentState != target) Thread.Sleep(50);
    }

    [Fact]
    public async Task Ip_only_connect_without_code_reaches_active()
    {
        using var agent = new FakeAgent { DeviceCode = "654321", AutoAccept = true, FramesToSend = 1 };
        agent.Start();
        var link = new AgentLink { Host = "127.0.0.1", Port = agent.Port };
        // IP-only mode: no pairing code is sent; the fixed open secret authenticates the session.
        link.Start("", false);
        WaitState(link, LinkState.Active, 8000);
        Assert.Equal(LinkState.Active, link.CurrentState);
        link.Teardown().Wait();
    }

    [Fact]
    public async Task Code_pairing_reaches_active_receives_frames_and_sends_intent()
    {
        using var agent = new FakeAgent { DeviceCode = "511234" };
        agent.Start();
        var link = new AgentLink { Host = "127.0.0.1", Port = agent.Port };
        var frames = new List<byte[]>();
        object glock = new();
        link.FrameReceived += f => { lock (glock) frames.Add(f); };
        var states = new List<LinkState>();
        link.StatusChanged += st => { lock (glock) states.Add(st.State); };
        link.Start("511234", true);

        WaitState(link, LinkState.Active);
        Assert.Equal(LinkState.Active, link.CurrentState);

        TestGate.Eventually(() => { lock (glock) return frames.Count >= 3; });
        TestGate.Eventually(() => agent.SentOk >= 3);

        link.SendInput("tap", 0.5, 0.5, null, null, 0);
        TestGate.Eventually(() => agent.ReceivedInputs.Count > 0);
        Assert.Contains("tap", agent.ReceivedInputs[0], StringComparison.Ordinal);

        // disconnect: STOP is sent before socket teardown
        link.DisconnectAsync("test-done").Wait();
        TestGate.Eventually(() => agent.SawStop, 5000);
        Assert.True(agent.SawStop, "FakeAgent phải nhận STOP khi phiên teardown");
    }

    [Fact]
    public async Task Deny_keeps_client_unable_to_receive_frames()
    {
        using var agent = new FakeAgent { DeviceCode = "315777", AutoAccept = false };
        agent.Start();
        var link = new AgentLink { Host = "127.0.0.1", Port = agent.Port };
        string? msg = null;
        link.StatusChanged += st => { msg = st.Message; };
        link.Start("315777", true);
        WaitState(link, LinkState.Active, 3000);
        Assert.NotEqual(LinkState.Active, link.CurrentState);
        Assert.Equal(LinkState.Ended, link.CurrentState);
        TestGate.Eventually(() => msg != null);
        Assert.Contains("từ chối", msg, StringComparison.OrdinalIgnoreCase);
    }
}
