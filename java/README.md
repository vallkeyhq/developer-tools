# Vallkey Java agent

Route recognized ghost-key requests from supported Java HTTP clients through [Vallkey](https://vallkey.com).

## Build and enable

Build with JDK 21 and Maven; the agent targets Java 11 bytecode.

```sh
mvn -B package
JAVA_TOOL_OPTIONS="-javaagent:$(pwd)/target/vallkey-agent.jar" java -jar your-app.jar
```

The agent instruments JDK `HttpClient`, `HttpURLConnection`, OkHttp, and Apache HttpClient 4/5 classic entry points. Other transports and client entry points require separate gateway configuration. The JDK, OkHttp and Apache local transport checks can be run with `node scripts/check-native-hooks.mjs java` from the repository root.

| Variable | Purpose |
| --- | --- |
| `VALLKEY_API` | Trusted gateway origin; defaults to `https://api.vallkey.com` |
| `VALLKEY_AUTO=0` | Disable installation |
| `VALLKEY_DEBUG=1` | Enable diagnostic logging |
| `VALLKEY_ENV` | Optional deployment label |

Agent initialization failures do not stop the application. Verify interception after startup rather than treating successful application boot as proof that routing is active.

Read the [transport boundaries](../docs/compatibility.md), [security policy](../SECURITY.md), and [bundled dependency notices](../THIRD_PARTY_NOTICES.md).
