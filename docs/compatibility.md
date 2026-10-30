# Compatibility and security boundaries

Runtime hooks recognize Vallkey ghost credentials and redirect requests made through supported HTTP clients. The hosted gateway performs credential replacement and policy enforcement. A hook is not a sandbox or a firewall: it does not stop an application from bypassing the gateway or using a real provider credential.

| Runtime | Covered entry points | Boundaries |
| --- | --- | --- |
| Node.js / Bun | Global `fetch`; exported Node `http` and `https` functions | Load before client imports. Direct Undici APIs, HTTP/2, native transports, captured functions and Edge runtimes need separate setup. Request-body inspection is bounded; see the CLI README. |
| Python | httpx, httpx2, requests, urllib3, botocore, aiohttp, urllib | Other transports, custom native clients, and streaming body-only credentials require explicit gateway configuration. |
| Ruby | `Net::HTTP`, including libraries configured to use it | Other Faraday adapters, native HTTP clients, and stream-only body credentials are outside this hook. |
| Java | JDK `HttpClient`, `HttpURLConnection`, OkHttp, Apache HttpClient 4/5 classic entry points | Custom/native transports, uninstrumented async clients, and credentials present only in request bodies are outside this agent. |
| .NET | `HttpClient` diagnostic request event | Native AOT, trimming, disabled diagnostics, and custom transports are outside this hook. In-memory body inspection is bounded to 1 MiB. |
| PHP | `curl_exec` and `curl_multi_add_handle` | PHP streams and clients not using cURL are outside this extension. Body inspection is limited to supported in-memory values up to 1 MiB. Build against the matching PHP ABI, thread mode, architecture and libc. |
| Elixir / Erlang | Supported Finch, hackney and httpc functions | Runtime module instrumentation can fail to install. Requests before release boot completes are not intercepted. Custom adapters and body-only credentials require separate setup. |

The supported entry points are not a guarantee that every version or configuration of an SDK works. Hooks can be disabled, fail to load, or miss unsupported request shapes. Native hooks do not all provide the Node hook’s failure behavior; applications requiring a strict routing guarantee should configure the gateway address explicitly and enforce network egress policy where appropriate.

## Configuration and diagnostics

Use an HTTPS origin you control for `VALLKEY_API`. Plain HTTP is intended only for loopback tests. Treat this environment variable as trusted configuration: it controls where protected requests are sent. Restart the application after changing runtime configuration.

`x-vallkey-host` records the original destination, and `x-vallkey-hook` records runtime version, a platform label inferred from environment variables, and the optional `VALLKEY_ENV` label. These values support diagnostics; platform labels are not authenticated proof of a cloud identity. Do not put secrets or customer identifiers in environment labels.

Debug logs are optional. Review logs before sharing them. Never log or paste real API keys, account tokens, ghost keys, or session keys.

## What tests establish

Public unit and transport tests use synthetic credentials and local mock servers. They check the exercised interception and installer behavior without provider accounts. They do not certify live provider access, deployed cloud routing, billing behavior, every SDK version, or end-to-end gateway enforcement.

Gateway-dependent provider verification remains in the private service repository. It is a separate test layer, not a prerequisite for contributors to run these public tests.

After deployment, use `vallkey doctor`, make a safe request through the actual application, and use `vallkey verify <key-id> --request-id <response-id>` to inspect that exact request. Test a deliberately denied read request with a dedicated key as well. One verified request establishes that request’s result, not universal application coverage.
