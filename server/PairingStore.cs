using System.Text.Json;

namespace HTITRemote;

internal record PairedDevice(string DeviceId, string DeviceName, string Secret, string LastIp, DateTime PairedAt);

/// <summary>
/// Persisted pairing records keyed by Android deviceId.
/// Each record holds the derived device secret (base64) established on the first
/// successful code-based pairing; later sessions reuse it instead of the code.
/// </summary>
internal static class PairingStore
{
    private static readonly object Gate = new();
    private static readonly string StorageFile;
    private static Dictionary<string, PairedDevice> _devices;
    private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true };

    static PairingStore()
    {
        string dir;
        string? envFile = Environment.GetEnvironmentVariable("HTIT_PAIR_FILE");
        try
        {
            if (!string.IsNullOrEmpty(envFile))
            {
                StorageFile = envFile;
                Directory.CreateDirectory(Path.GetDirectoryName(envFile)!);
            }
            else
            {
                dir = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData) != "" ?
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "HTITRemote")
                    : Path.Combine(Path.GetTempPath(), "HTITRemote");
                Directory.CreateDirectory(dir);
                StorageFile = Path.Combine(dir, "paired.json");
            }
        }
        catch
        {
            dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "HTITRemote");
            Directory.CreateDirectory(dir);
            StorageFile = Path.Combine(dir, "paired.json");
        }
        _devices = Load();
    }

    private static Dictionary<string, PairedDevice> Load()
    {
        try
        {
            if (!File.Exists(StorageFile)) return new();
            return JsonSerializer.Deserialize<Dictionary<string, PairedDevice>>(File.ReadAllText(StorageFile)) ?? new();
        }
        catch
        {
            return new();
        }
    }

    private static void Persist()
    {
        File.WriteAllText(StorageFile, JsonSerializer.Serialize(_devices, Pretty));
    }

    public static void Save(string deviceId, string deviceName, byte[] secret, string ip)
    {
        lock (Gate)
        {
            _devices[deviceId] = new PairedDevice(deviceId, deviceName, Convert.ToBase64String(secret), ip, DateTime.UtcNow);
            Persist();
        }
    }

    public static PairedDevice? Get(string deviceId)
    {
        lock (Gate)
        {
            return _devices.TryGetValue(deviceId, out var d) ? d : null;
        }
    }

    public static void Forget(string deviceId)
    {
        lock (Gate)
        {
            if (_devices.Remove(deviceId)) Persist();
        }
    }

    public static List<PairedDevice> All()
    {
        lock (Gate)
        {
            return _devices.Values.OrderByDescending(v => v.PairedAt).ToList();
        }
    }
}
