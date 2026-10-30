# vallkey (Elixir and Erlang)

Route ghost-key requests through [Vallkey](https://vallkey.com) using the supported HTTP clients below. Requests that carry a ghost key go to Vallkey, which swaps in the real key under your rules. Every other request is left alone.

Covers Finch (Req, and SDKs built on it), hackney (HTTPoison, stripity_stripe, ExAws) and httpc (Tesla's default adapter). Works with `mix` and with releases, on Erlang/OTP 25 and later.

```sh
# vallkey_auto.beam, compiled with OTP 25 so it loads on every newer version
erlc -o /opt/vallkey/elixir src/vallkey_auto.erl

export ELIXIR_ERL_OPTIONS='-eval catch(code:load_abs("/opt/vallkey/elixir/vallkey_auto")),catch(vallkey_auto:start()).'
mix phx.server          # or: bin/my_app start
```

For a plain Erlang release, put the same `-eval` in `ERL_FLAGS`. If the file is missing, the app starts as usual without Vallkey.

A release starts auto-connect when its boot finishes, so requests made while your applications are still starting go out as they are.

| Setting | What it does |
|---|---|
| `VALLKEY_API` | The Vallkey server (default `https://api.vallkey.com`) |
| `VALLKEY_AUTO=0` | Turns it off |
| `VALLKEY_DEBUG=1` | Logs each request sent to Vallkey (never the key) |

How it works: the entry points (`Finch.request/3`, `:hackney.request/5`, `:httpc.request/4` and their siblings) are exported under another name in the module as loaded; every other function stays exactly as it was. A call to the usual name reaches Erlang's handler for undefined functions, which Vallkey wraps to change the address of a request carrying a ghost key before calling the original function.

## Compatibility and security

Read the [transport boundaries](https://github.com/vallkeyhq/developer-tools/blob/main/docs/compatibility.md) and [security policy](../SECURITY.md). Local transport tests do not certify every SDK version or cloud deployment. Use a dedicated key and verify requests from the actual application after deployment.
