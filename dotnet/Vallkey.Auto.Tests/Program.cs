// dotnet run --project Vallkey.Auto.Tests: checks the hook against two local servers,
// "vallkey" and "provider", which say who answered. Exits 1 if anything is wrong.
using System.Net;
using System.Text;
using System.Text.Json;

var ghost = string.Join("_", "gk", "openai", "A1b2C3d4E5f6G7h8I9j0Kl", "M1n2O3p4Q5r6S7t8U9v0Wx1Y2z3A4b5C6d7E8f9G0hI");
var seen = new List<(string Server, string Method, string Path, string? From, string? Host, string Body, string? Hook)>();
(HttpListener, int) Serve(string name)
{
    for (var port = 18300 + Random.Shared.Next(1000); ; port++)
    {
        var l = new HttpListener();
        l.Prefixes.Add($"http://127.0.0.1:{port}/");
        try { l.Start(); } catch (HttpListenerException) { continue; }
        _ = Task.Run(async () =>
        {
            while (l.IsListening)
            {
                var c = await l.GetContextAsync();
                var body = await new StreamReader(c.Request.InputStream).ReadToEndAsync();
                lock (seen) seen.Add((name, c.Request.HttpMethod, c.Request.RawUrl!, c.Request.Headers["x-vallkey-host"], c.Request.Headers["Host"], body, c.Request.Headers["x-vallkey-hook"]));
                var answer = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { from = name }));
                c.Response.ContentType = "application/json";
                await c.Response.OutputStream.WriteAsync(answer);
                c.Response.Close();
            }
        });
        return (l, port);
    }
}
var (vallkey, vport) = Serve("vallkey");
var (provider, pport) = Serve("provider");
Environment.SetEnvironmentVariable("VALLKEY_API", $"http://127.0.0.1:{vport}");
Environment.SetEnvironmentVariable("K_SERVICE", "api");
Environment.SetEnvironmentVariable("VALLKEY_ENV", "production");
Vallkey.Auto.Hook.Install();

var failures = 0;
void Check(string what, bool ok)
{
    Console.WriteLine($"{(ok ? "ok  " : "FAIL")} {what}");
    if (!ok) failures++;
}
async Task<string> From(HttpResponseMessage r) => JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement.GetProperty("from").GetString()!;

using var http = new HttpClient();

var chat = new HttpRequestMessage(HttpMethod.Post, "https://api.openai.com/v1/chat/completions?x=1") { Content = new StringContent("{\"model\":\"m\"}", Encoding.UTF8, "application/json") };
chat.Headers.Authorization = new("Bearer", ghost);
Check("a ghost key in Authorization goes to Vallkey", await From(await http.SendAsync(chat)) == "vallkey");
var last = seen[^1];
Check("path, query, body and the address it was for are kept", last is { Method: "POST", Path: "/v1/chat/completions?x=1", Body: "{\"model\":\"m\"}", From: "api.openai.com" } && last.Host == $"127.0.0.1:{vport}");

Check("it says what sent the request", last.Hook == $"dotnet/0.1.0; runtime={Environment.Version}; platform=cloud-run; env=production");

var plain = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{pport}/plain");
plain.Headers.Authorization = new("Bearer", "sk-real");
Check("a request without a ghost key is left alone", await From(await http.SendAsync(plain)) == "provider");

var basic = new HttpRequestMessage(HttpMethod.Get, "https://api.twilio.com/2010-04-01/Accounts.json");
basic.Headers.Authorization = new("Basic", Convert.ToBase64String(Encoding.ASCII.GetBytes("AC1:" + ghost)));
Check("a ghost key in Basic credentials goes to Vallkey", await From(await http.SendAsync(basic)) == "vallkey");

Check("a ghost key in the query goes to Vallkey", await From(await http.GetAsync($"https://generativelanguage.googleapis.com/v1beta/models?key={ghost}")) == "vallkey");

var form = new FormUrlEncodedContent(new Dictionary<string, string> { ["api_key"] = ghost, ["q"] = "1" });
Check("a ghost key in a form body goes to Vallkey", await From(await http.PostAsync("https://api.example.com/search", form)) == "vallkey");

var custom = new HttpClient(new KeyHandler(ghost) { InnerHandler = new SocketsHttpHandler() });
Check("a key added by the SDK's own handler is seen", await From(await custom.GetAsync("https://api.anthropic.com/v1/models")) == "vallkey");

var originalError = Console.Error;
using var debugLog = new StringWriter();
Environment.SetEnvironmentVariable("VALLKEY_DEBUG", "1");
try
{
    Console.SetError(debugLog);
    var debugRequest = new HttpRequestMessage(HttpMethod.Get, "https://api.openai.com/sensitive-path-value?token=private-query");
    debugRequest.Headers.Authorization = new("Bearer", ghost);
    Check("debug requests still route", await From(await http.SendAsync(debugRequest)) == "vallkey");
}
finally
{
    Console.SetError(originalError);
    Environment.SetEnvironmentVariable("VALLKEY_DEBUG", null);
}
var debugText = debugLog.ToString();
Check("debug logs omit paths, queries and credentials", debugText.Contains("https://api.openai.com ->") && !debugText.Contains("sensitive-path-value") && !debugText.Contains("private-query") && !debugText.Contains(ghost));

Vallkey.Auto.Hook.Uninstall();
var off = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{pport}/off");
off.Headers.Authorization = new("Bearer", ghost);
Check("it can be turned off", await From(await http.SendAsync(off)) == "provider");

vallkey.Stop();
provider.Stop();
return failures == 0 ? 0 : 1;

sealed class KeyHandler(string key) : DelegatingHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        request.Headers.TryAddWithoutValidation("x-api-key", key);
        return base.SendAsync(request, token);
    }
}
