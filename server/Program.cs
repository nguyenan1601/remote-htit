using System.Security.Cryptography;
using System.Text.Json;
using HTITRemote;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    WebRootPath = ResolveWebRoot()
});
builder.Logging.SetMinimumLevel(LogLevel.Information);
builder.WebHost.UseUrls("http://0.0.0.0:8362");

static string ResolveWebRoot()
{
    // Prefer the copied-to-output wwwroot; else walk up the folder tree to the project dir.
    string webRoot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
    if (!File.Exists(Path.Combine(webRoot, "index.html")))
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 4 && dir != null; i++)
        {
            dir = dir.Parent;
            if (dir == null) break;
            string? candidate = Path.Combine(dir.FullName, "wwwroot");
            if (File.Exists(Path.Combine(candidate, "index.html"))) return candidate;
        }
    }
    return webRoot;
}

var app = builder.Build();
LinkHub.Instance.Init(app.Lifetime);

app.UseDefaultFiles();
app.UseStaticFiles();

app.UseWebSockets();

// ---- token guard for the API surface ----
app.Use(async (ctx, next) =>
{
    string path = ctx.Request.Path.Value ?? "";
    if (path.StartsWith("/api/") && path != "/api/token")
    {
        string? token = ctx.Request.Query["t"].FirstOrDefault()
                        ?? ctx.Request.Headers["X-Htit-Token"].FirstOrDefault();
        if (!LinkHub.Instance.TokenOk(token))
        {
            ctx.Response.StatusCode = 401;
            await ctx.Response.WriteAsync("{\"error\":\"token\"}");
            return;
        }
    }
    await next(ctx);
});

app.MapGet("/api/state", async (HttpContext ctx) =>
{
    ctx.Response.ContentType = "application/json; charset=utf-8";
    await ctx.Response.WriteAsync(JsonSerializer.Serialize(LinkHub.Instance.StateSnapshot()));
});

app.MapPost("/api/connect", async (HttpContext ctx) =>
{
    JsonDocument doc;
    try
    {
        doc = await JsonDocument.ParseAsync(ctx.Request.Body);
    }
    catch (JsonException)
    {
        ctx.Response.StatusCode = 400;
        await ctx.Response.WriteAsync("{\"error\":\"Dữ liệu kết nối không hợp lệ\"}");
        return;
    }
    using (doc)
    {
        var root = doc.RootElement;
        string host = root.TryGetProperty("host", out var h) ? h.GetString() ?? "" : "";
        int port = root.TryGetProperty("port", out var p) && p.ValueKind == JsonValueKind.Number ? p.GetInt32() : 0;
        string? code = root.TryGetProperty("code", out var c) ? c.GetString() : null;
        host = host.Trim();
        // basic validation: IPv4 or hostname, no wild weirdness; port 1..65535
        if (host.Length is 0 or > 253 || host.Any(ch => char.IsWhiteSpace(ch) || char.IsControl(ch))
            || port is <= 0 or > 65535)
        {
            ctx.Response.StatusCode = 400;
            await ctx.Response.WriteAsync("{\"error\":\"Tham số IP/cổng không hợp lệ\"}");
            return;
        }
        await LinkHub.Instance.ConnectAsync(host, port, code);
        ctx.Response.ContentType = "application/json; charset=utf-8";
        await ctx.Response.WriteAsync("{\"ok\":true}");
    }
});

app.MapPost("/api/disconnect", async (HttpContext ctx) =>
{
    await LinkHub.Instance.DisconnectAsync("Nhấn «Ngắt kết nối» từ trình duyệt");
    ctx.Response.ContentType = "application/json; charset=utf-8";
    await ctx.Response.WriteAsync("{\"ok\":true}");
});

app.MapPost("/api/paired/{deviceId}/forget", (string deviceId, HttpContext ctx) =>
{
    if (string.IsNullOrWhiteSpace(deviceId) || deviceId.Length > 128)
        return Results.BadRequest(new { error = "deviceId không hợp lệ" });
    if (PairingStore.Get(deviceId) == null)
        return Results.NotFound(new { error = "Không tìm thấy thiết bị đã ghép đôi" });
    PairingStore.Forget(deviceId);
    return Results.Json(new { ok = true });
});

app.MapGet("/api/ws", async (HttpContext ctx) =>
{
    if (!ctx.WebSockets.IsWebSocketRequest)
    {
        ctx.Response.StatusCode = 400;
        return;
    }
    using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
    await LinkHub.Instance.AddViewer(ws);
});

app.Run();

public partial class Program { }

