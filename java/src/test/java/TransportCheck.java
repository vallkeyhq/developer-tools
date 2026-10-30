import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/** Exercises the agent against its supported third-party HTTP client entry points. */
public final class TransportCheck {
    private static int failures;
    private static final List<String> sources = new ArrayList<>();

    private static HttpServer serve(String name, int port) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.createContext("/", exchange -> {
            synchronized (sources) {
                sources.add(exchange.getRequestHeaders().getFirst("x-vallkey-host"));
            }
            byte[] body = name.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try (var out = exchange.getResponseBody()) { out.write(body); }
        });
        server.start();
        return server;
    }

    private static void check(String name, boolean passed) {
        System.out.println((passed ? "ok   " : "FAIL ") + name);
        if (!passed) failures++;
    }

    public static void main(String[] args) throws Exception {
        String ghost = String.join("_", "gk", "openai", "A1b2C3d4E5f6G7h8I9j0Kl", "M1n2O3p4Q5r6S7t8U9v0Wx1Y2z3A4b5C6d7E8f9G0hI");
        HttpServer gateway = serve("gateway", URI.create(System.getenv("VALLKEY_API")).getPort());
        HttpServer provider = serve("provider", 0);
        String plain = "http://127.0.0.1:" + provider.getAddress().getPort() + "/plain";
        try {
            okhttp3.OkHttpClient okhttp = new okhttp3.OkHttpClient.Builder().callTimeout(Duration.ofSeconds(5)).build();
            try (okhttp3.Response response = okhttp.newCall(new okhttp3.Request.Builder().url("http://provider.example.invalid/okhttp").header("Authorization", "Bearer " + ghost).build()).execute()) {
                check("OkHttp routes ghost credentials", response.body().string().equals("gateway"));
            }
            try (okhttp3.Response response = okhttp.newCall(new okhttp3.Request.Builder().url(plain).build()).execute()) {
                check("OkHttp preserves unrelated traffic", response.body().string().equals("provider"));
            }
            try (org.apache.http.impl.client.CloseableHttpClient client = org.apache.http.impl.client.HttpClients.custom().setDefaultRequestConfig(org.apache.http.client.config.RequestConfig.custom().setConnectTimeout(5000).setSocketTimeout(5000).build()).build()) {
                var protectedRequest = new org.apache.http.client.methods.HttpGet("http://provider.example.invalid/apache4");
                protectedRequest.setHeader("Authorization", "Bearer " + ghost);
                try (var response = client.execute(protectedRequest)) {
                    check("Apache HttpClient 4 routes ghost credentials", org.apache.http.util.EntityUtils.toString(response.getEntity()).equals("gateway"));
                }
                try (var response = client.execute(new org.apache.http.client.methods.HttpGet(plain))) {
                    check("Apache HttpClient 4 preserves unrelated traffic", org.apache.http.util.EntityUtils.toString(response.getEntity()).equals("provider"));
                }
            }
            try (var client = org.apache.hc.client5.http.impl.classic.HttpClients.custom().setDefaultRequestConfig(org.apache.hc.client5.http.config.RequestConfig.custom().setResponseTimeout(org.apache.hc.core5.util.Timeout.ofSeconds(5)).build()).build()) {
                var protectedRequest = new org.apache.hc.client5.http.classic.methods.HttpGet("http://provider.example.invalid/apache5");
                protectedRequest.setHeader("Authorization", "Bearer " + ghost);
                String protectedBody = client.execute(protectedRequest, response -> org.apache.hc.core5.http.io.entity.EntityUtils.toString(response.getEntity()));
                check("Apache HttpClient 5 routes ghost credentials", protectedBody.equals("gateway"));
                String plainBody = client.execute(new org.apache.hc.client5.http.classic.methods.HttpGet(plain), response -> org.apache.hc.core5.http.io.entity.EntityUtils.toString(response.getEntity()));
                check("Apache HttpClient 5 preserves unrelated traffic", plainBody.equals("provider"));
            }
            check("third-party clients retain original destinations", sources.stream().filter("provider.example.invalid"::equals).count() == 3);
        } finally {
            gateway.stop(0);
            provider.stop(0);
        }
        System.exit(failures == 0 ? 0 : 1);
    }
}
