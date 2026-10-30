using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace Vallkey.Auto
{
    // Redirect ghost-key requests at the HttpClient diagnostic request event.
    // Disabled diagnostics, native AOT and trimming are not supported; see README.md.
    public static class Hook
    {
        private const string Listener = "HttpHandlerDiagnosticListener";
        private const string RequestEvent = "System.Net.Http.Request";
        private const string HookHeader = "x-vallkey-host";
        private const string WhoHeader = "x-vallkey-hook";

        // The platform, from variables each one sets itself. The same list, in the same
        // order, is in every Vallkey hook, so the dashboard names a place the same way in any language.
        private static readonly (string Variable, string Name)[] Platforms =
        {
            ("VERCEL", "vercel"), ("AWS_LAMBDA_FUNCTION_NAME", "aws-lambda"), ("ECS_CONTAINER_METADATA_URI_V4", "aws-ecs"),
            ("ECS_CONTAINER_METADATA_URI", "aws-ecs"), ("FUNCTION_TARGET", "cloud-functions"), ("K_SERVICE", "cloud-run"),
            ("GAE_APPLICATION", "app-engine"), ("FUNCTIONS_WORKER_RUNTIME", "azure-functions"), ("CONTAINER_APP_NAME", "azure-container-apps"),
            ("WEBSITE_SITE_NAME", "azure-app-service"), ("RAILWAY_PROJECT_ID", "railway"), ("RENDER", "render"), ("FLY_APP_NAME", "fly"),
            ("DYNO", "heroku"), ("NETLIFY", "netlify"), ("KOYEB_APP_NAME", "koyeb"), ("GITHUB_ACTIONS", "github-actions"),
            ("GITLAB_CI", "gitlab-ci"), ("KUBERNETES_SERVICE_HOST", "kubernetes"),
        };
        private static readonly Lazy<string> Who = new(() =>
        {
            var version = typeof(Hook).Assembly.GetName().Version;
            var parts = new System.Collections.Generic.List<string> { $"dotnet/{version?.Major}.{version?.Minor}.{version?.Build}", $"runtime={Environment.Version}" };
            var platform = Platforms.FirstOrDefault(p => !string.IsNullOrEmpty(Environment.GetEnvironmentVariable(p.Variable))).Name;
            if (platform is null && System.IO.File.Exists("/.dockerenv")) platform = "docker";
            if (platform is not null) parts.Add($"platform={platform}");
            var place = Environment.GetEnvironmentVariable("VALLKEY_ENV") ?? "";
            if (Regex.IsMatch(place, @"^[A-Za-z0-9._-]{1,40}$")) parts.Add($"env={place}");
            return string.Join("; ", parts);
        });
        private const int BodyScanMaxBytes = 1024 * 1024;
        private static readonly Regex Ghost = new(@"gk_[a-z]{2,20}_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly ConcurrentDictionary<Type, PropertyInfo?> RequestProperty = new();
        private static int installed;
        private static volatile bool on;

        public static void Install()
        {
            on = true;
            if (Interlocked.Exchange(ref installed, 1) == 1) return;
            DiagnosticListener.AllListeners.Subscribe(new Listeners());
        }

        public static void Uninstall() => on = false;

        private sealed class Listeners : IObserver<DiagnosticListener>
        {
            public void OnNext(DiagnosticListener listener)
            {
                // Only the one event: asking for the activity events would start tracing every request.
                if (listener.Name == Listener) listener.Subscribe(new Events(), name => name == RequestEvent);
            }

            public void OnCompleted() { }
            public void OnError(Exception error) { }
        }

        private sealed class Events : IObserver<System.Collections.Generic.KeyValuePair<string, object?>>
        {
            public void OnNext(System.Collections.Generic.KeyValuePair<string, object?> e)
            {
                if (!on || e.Key != RequestEvent || e.Value is null) return;
                try
                {
                    var property = RequestProperty.GetOrAdd(e.Value.GetType(), t => t.GetProperty("Request", BindingFlags.Public | BindingFlags.Instance));
                    if (property?.GetValue(e.Value) is HttpRequestMessage request) Redirect(request);
                }
                catch
                {
                    // anything unusual goes out as it was
                }
            }

            public void OnCompleted() { }
            public void OnError(Exception error) { }
        }

        private readonly record struct Target(string Scheme, string Host, int Port)
        {
            public string Authority => Port == (Scheme == "https" ? 443 : 80) ? Host : $"{Host}:{Port}";
        }

        private static Target Current()
        {
            var raw = Environment.GetEnvironmentVariable("VALLKEY_API");
            if (!Uri.TryCreate(string.IsNullOrEmpty(raw) ? "https://api.vallkey.com" : raw, UriKind.Absolute, out var uri)) uri = new Uri("https://api.vallkey.com");
            return new Target(uri.Scheme, uri.Host, uri.Port);
        }

        internal static void Redirect(HttpRequestMessage request)
        {
            var uri = request.RequestUri;
            if (uri is null || !uri.IsAbsoluteUri || (uri.Scheme != "https" && uri.Scheme != "http")) return;
            var t = Current();
            if (string.Equals(uri.Host, t.Host, StringComparison.OrdinalIgnoreCase) && uri.Port == t.Port) return;
            if (!HasGhost(request, uri)) return;
            var from = uri.IsDefaultPort ? uri.Host : $"{uri.Host}:{uri.Port}";
            if (Environment.GetEnvironmentVariable("VALLKEY_DEBUG") == "1") Console.Error.WriteLine($"[vallkey] {uri.Scheme}://{from} -> {t.Scheme}://{t.Authority}");
            request.Headers.Remove(HookHeader);
            request.Headers.TryAddWithoutValidation(HookHeader, from);
            request.Headers.Remove(WhoHeader);
            request.Headers.TryAddWithoutValidation(WhoHeader, Who.Value);
            request.Headers.Host = null;
            request.RequestUri = new UriBuilder(uri) { Scheme = t.Scheme, Host = t.Host, Port = t.Port }.Uri;
        }

        // A ghost key in a header value, including inside Basic credentials.
        private static bool InValue(string value)
        {
            if (Ghost.IsMatch(value)) return true;
            var basic = Regex.Match(value, @"^\s*basic\s+([A-Za-z0-9+/=]+)\s*$", RegexOptions.IgnoreCase);
            if (!basic.Success) return false;
            try
            {
                return Ghost.IsMatch(Encoding.Latin1.GetString(Convert.FromBase64String(basic.Groups[1].Value)));
            }
            catch (FormatException)
            {
                return false;
            }
        }

        private static bool HasGhost(HttpRequestMessage request, Uri uri)
        {
            if (uri.Query.Length > 1 && Ghost.IsMatch(Uri.UnescapeDataString(uri.Query.Replace('+', ' ')))) return true;
            if (request.Headers.Any(h => h.Value.Any(InValue))) return true;
            // A body already in memory (strings, forms, JSON bytes), read without changing it.
            if (request.Content is ByteArrayContent content && (content.Headers.ContentLength ?? 0) <= BodyScanMaxBytes)
            {
                var bytes = content.ReadAsByteArrayAsync().GetAwaiter().GetResult();
                return Ghost.IsMatch(Encoding.Latin1.GetString(bytes));
            }
            return false;
        }
    }
}
