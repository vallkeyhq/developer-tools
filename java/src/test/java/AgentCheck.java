// RAILWAY_PROJECT_ID=x VALLKEY_ENV=staging VALLKEY_API=http://127.0.0.1:18471 java -javaagent:target/vallkey-agent.jar src/test/java/AgentCheck.java
// Checks the agent with the JDK's own HTTP clients against two local servers, "vallkey"
// and "provider", which say who answered. Exits 1 if anything is wrong. The SDKs' own
// libraries require their own integration checks; this test covers the JDK transports.
import com.sun.net.httpserver.HttpServer;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

public class AgentCheck {
    static final List<String[]> seen = new ArrayList<>();
    static int failures = 0;

    static HttpServer serve(String name, int port) throws Exception {
        HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        s.createContext("/", x -> {
            String body = new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            synchronized (seen) {
                seen.add(new String[] {name, x.getRequestMethod(), x.getRequestURI().toString(), x.getRequestHeaders().getFirst("x-vallkey-host"), x.getRequestHeaders().getFirst("Host"), body, x.getRequestHeaders().getFirst("x-vallkey-hook")});
            }
            byte[] answer = name.getBytes(StandardCharsets.UTF_8);
            x.sendResponseHeaders(200, answer.length);
            try (OutputStream o = x.getResponseBody()) {
                o.write(answer);
            }
        });
        s.start();
        return s;
    }

    static void check(String what, boolean ok) {
        System.out.println((ok ? "ok   " : "FAIL ") + what);
        if (!ok) failures++;
    }

    static String huc(String url, String header, String value, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) URI.create(url).toURL().openConnection();
        c.setRequestProperty(header, value);
        if (body != null) {
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
        }
        return new String(c.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    }

    public static void main(String[] args) throws Exception {
        String ghost = String.join("_", "gk", "openai", "A1b2C3d4E5f6G7h8I9j0Kl", "M1n2O3p4Q5r6S7t8U9v0Wx1Y2z3A4b5C6d7E8f9G0hI");
        int vport = URI.create(System.getenv("VALLKEY_API")).getPort();
        HttpServer vallkey = serve("vallkey", vport);
        HttpServer provider = serve("provider", 0);
        String providerUrl = "http://127.0.0.1:" + provider.getAddress().getPort();
        HttpClient client = HttpClient.newHttpClient();

        HttpRequest chat = HttpRequest.newBuilder(URI.create("http://api.openai.com/v1/chat/completions?x=1"))
                .header("Authorization", "Bearer " + ghost).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{\"model\":\"m\"}")).build();
        check("HttpClient: a ghost key in Authorization goes to Vallkey", client.send(chat, HttpResponse.BodyHandlers.ofString()).body().equals("vallkey"));
        String[] last = seen.get(seen.size() - 1);
        check("HttpClient: path, query, body and the address it was for are kept", last[1].equals("POST") && last[2].equals("/v1/chat/completions?x=1") && "api.openai.com".equals(last[3]) && last[5].equals("{\"model\":\"m\"}") && ("127.0.0.1:" + vport).equals(last[4]));
        check("HttpClient: it says what sent the request", ("java/0.1.0; runtime=" + System.getProperty("java.version") + "; platform=railway; env=staging").equals(last[6]));
        check("HttpClient: sendAsync too", client.sendAsync(HttpRequest.newBuilder(URI.create("http://api.anthropic.com/v1/models")).header("x-api-key", ghost).build(), HttpResponse.BodyHandlers.ofString()).get().body().equals("vallkey"));
        check("HttpClient: a ghost key in the query", client.send(HttpRequest.newBuilder(URI.create("http://generativelanguage.googleapis.com/v1beta/models?key=" + ghost)).build(), HttpResponse.BodyHandlers.ofString()).body().equals("vallkey"));
        check("HttpClient: a request without a ghost key is left alone", client.send(HttpRequest.newBuilder(URI.create(providerUrl + "/plain")).header("Authorization", "Bearer sk-real").build(), HttpResponse.BodyHandlers.ofString()).body().equals("provider"));

        String basic = "Basic " + Base64.getEncoder().encodeToString(("AC1:" + ghost).getBytes(StandardCharsets.UTF_8));
        check("HttpURLConnection: a ghost key in Basic credentials goes to Vallkey", huc("http://api.twilio.com/2010-04-01/Accounts.json", "Authorization", basic, null).equals("vallkey"));
        check("HttpURLConnection: a POST body arrives", huc("http://api.stripe.com/v1/customers", "Authorization", "Bearer " + ghost, "email=a%40b.c").equals("vallkey"));
        last = seen.get(seen.size() - 1);
        check("HttpURLConnection: path, body and the address it was for are kept", last[2].equals("/v1/customers") && last[5].equals("email=a%40b.c") && "api.stripe.com".equals(last[3]));
        check("HttpURLConnection: it says what sent the request", last[6] != null && last[6].startsWith("java/0.1.0; "));
        check("HttpURLConnection: a request without a ghost key is left alone", huc(providerUrl + "/plain", "Authorization", "Bearer sk-real", null).equals("provider"));

        vallkey.stop(0);
        provider.stop(0);
        System.exit(failures == 0 ? 0 : 1);
    }
}
