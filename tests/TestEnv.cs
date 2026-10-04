using System.Runtime.CompilerServices;
using Xunit;

namespace HTITRemote.Tests;

/// <summary>Runs once per test assembly load: keeps test writes out of real user data.</summary>
public static class TestEnv
{
    [ModuleInitializer]
    internal static void Init()
    {
        string dir = Path.Combine(Path.GetTempPath(), "htit-remote-tests", Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        Environment.SetEnvironmentVariable("HTIT_PAIR_FILE", Path.Combine(dir, "paired.json"));
    }
}

public sealed class PairingStoreTests
{
    [Fact]
    public void Save_get_forget_roundtrip()
    {
        string id = "id-" + Guid.NewGuid().ToString("N")[..8];
        PairingStore.Save(id, "TA-Open", new byte[32].Concat(new byte[32]).ToArray(), "10.0.0.5");
        var d = PairingStore.Get(id);
        Assert.NotNull(d);
        Assert.Equal("TA-Open", d!.DeviceName);
        PairingStore.Forget(id);
        Assert.Null(PairingStore.Get(id));
    }
}
