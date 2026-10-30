![Vallkey cli](https://raw.githubusercontent.com/vallkeyhq/developer-tools/main/assets/covers/cli.png)

# vallkey

Swap the API keys in your project for ghost keys: stand-in keys that only work within your rules, and that you can kill in one click.

Needs Node.js 18 or newer. No dependencies.

```sh
npx vallkey login   # approve this computer in your browser, once
npx vallkey init    # swap the keys in your .env files for ghost keys
```

## Commands

| Command                             | What it does                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`                             | Opens your browser to approve this computer. The tool gets its own API token, which you can revoke in Settings → API tokens.                                                                                                                                                                                              |
| `init [files]`                      | Finds API keys in your `.env` files, creates a ghost key for each one, and writes the ghost keys back in place of the real ones. Adds `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` or `GROQ_BASE_URL` so those SDKs need no code change, and prints the one line to change for the others. `--dry-run` shows what it would do. |
| `scan [paths]`                      | Looks for API keys in your code and `.env` files; `--history` also looks through every commit. Keys are shown masked. Exits with 1 if it finds any.                                                                                                                                                                       |
| `keys`                              | Lists your ghost keys.                                                                                                                                                                                                                                                                                                    |
| `keys add --from <id>`              | Makes another ghost key for a real key shared by several ghost keys, inside its outer rules.                                                                                                                                                                                                                              |
| `real-keys`                         | Lists the real keys shared by several ghost keys.                                                                                                                                                                                                                                                                         |
| `domains`                           | Lists your own API domains, such as api.yourcompany.com; `domains check <domain>` checks one. `init` uses your default domain for the address it writes.                                                                                                                                                                  |
| `kill <key id>`                     | Stops a ghost key everywhere, right away.                                                                                                                                                                                                                                                                                 |
| `mcp`                               | Runs the MCP server for AI coding agents (see below).                                                                                                                                                                                                                                                                     |
| `connect [language]`                | Detects the project and prints how to connect it: the SDK address setting, or auto-connect. Read-only; does not install packages or change settings.                                                                                                                                                                      |
| `doctor`                            | Checks local gateway configuration and Node/Bun package readiness. `--json` returns structured checks. It does not inspect a deployed process.                                                                                                                                                                            |
| `verify <key id> --request-id <id>` | Checks the exact recent application request in Activity. `--expect denied` verifies a blocked request; no provider calls are generated.                                                                                                                                                                                   |
| `hook [language]`                   | Turns on auto-connect, so supported SDKs go through Vallkey with no code changes (see below).                                                                                                                                                                                                                             |
| `status [key id]`                   | Shows every app each ghost key is used from (Vercel, AWS Lambda, a laptop…), with today's requests and anything wrong. Exits with 1 if one is failing, so a deploy script can stop on it.                                                                                                                                 |
| `whoami`, `logout`                  | Shows or removes the saved sign-in.                                                                                                                                                                                                                                                                                       |

Your real keys are stored encrypted and removed from the files, and Vallkey never shows a real key again. If you use one anywhere else, keep a copy in your password manager.

A line that only looks like a key can be skipped with a `vallkey:ignore` comment on it.
Historical false positives can use `scan --history --allowlist <file>`. The JSON
file contains entries with `path`, `sha256` (the complete matched value's digest),
and a required `reason`. Exceptions match only that exact value in that exact
relative file path; review them like changes to the scanner itself.

## Supported SDKs without changing their calls

Start with `npx vallkey connect`: it detects known Node/Bun SDK dependencies and recommends an address setting where available, otherwise prints auto-connect setup. Its recommendation only covers detected clients; review other clients separately. `--method address` or `--method hook` chooses explicitly. The command does not edit files or install dependencies.

`npx vallkey hook` turns on auto-connect: requests that carry a ghost key go to Vallkey through the usual HTTP clients, with no code changes. It detects the language, downloads any file it needs (checksum verified), and prints the one setting to add, with Docker lines where needed. If that setting already has a value, add to it instead of replacing it. On Next.js it adds a small setup file (`instrumentation.ts`); Edge routes need the SDK address setting. Use `--print` for a preview, and check one request from your deployed app.

| Language            | What it sets                                                                       |
| ------------------- | ---------------------------------------------------------------------------------- |
| Node.js             | `NODE_OPTIONS='--require vallkey/auto'` (Next.js: an `instrumentation.ts` instead) |
| Bun                 | `BUN_OPTIONS='--preload vallkey/auto'`                                             |
| Python              | `VALLKEY_AUTO=1` (with `pip install vallkey`)                                      |
| Ruby                | `RUBYOPT=-rvallkey/auto` (with `bundle add vallkey`)                               |
| Java, Kotlin, Scala | `JAVA_TOOL_OPTIONS=-javaagent:/path/vallkey-agent.jar`                             |
| .NET                | `DOTNET_STARTUP_HOOKS=/path/Vallkey.Auto.dll`                                      |
| PHP                 | `PHP_INI_SCAN_DIR=:/path/to/its/ini/folder`                                        |
| Elixir, Erlang      | `ELIXIR_ERL_OPTIONS` / `ERL_FLAGS` with an `-eval` that loads it                   |

Set `VALLKEY_ENV=production` (or staging, eu-workers…) in each app to tell them apart in the dashboard and in `vallkey status`.

In Node.js load it before SDK imports: `require('vallkey/auto')` or `import 'vallkey/auto'`. It covers global `fetch` and exported Node `http`/`https` functions. Direct Undici APIs, HTTP/2, native networking and previously captured functions are not covered. `VALLKEY_DEBUG=1` logs source/destination origins only; `VALLKEY_AUTO=0` disables interception.

Auto-connect for Node.js and Bun checks `VALLKEY_API` when the app starts: HTTPS origin only, with HTTP allowed for loopback tests. Restart after changing it. It detects header/query credentials, Basic authentication, string bodies, URLSearchParams and byte buffers. Request-object body inspection uses a clone and is limited to 64 KiB and 200 ms. Streaming/body-only authentication outside that window, multipart FormData-only credentials, and credentials added with http.request write/end need an explicit gateway address. Header-authenticated uploads stream normally. Recognized protected requests never fall back directly when rewriting fails; unrelated traffic is left alone. Auto-connect cannot protect an app that still uses a real provider key directly.

### Verify the actual app

1. Run `vallkey doctor` in the project. Warnings are local readiness information, not proof of connection.
2. Restart/redeploy and make a safe request through your application's actual SDK/client.
3. Obtain `x-guard-request-id` from that response (use the SDK's response-header accessor if available).
4. Run `vallkey verify <key-id> --request-id <response-id>`. It requires an exact request from the last five minutes with a successful settled response. Use `--json` in CI; failures exit 1. `--timeout` is 1–60 seconds.
5. With a dedicated test key, call a harmless endpoint explicitly denied by its rules. Verify that response ID with `--expect denied`. Never test using a destructive operation or rely on a paid call for setup verification.

Verification proves only that particular request. A cached success is reported as cached and does not prove a new provider call. Missing, stale, unsettled and provider-error responses do not pass. These commands require vallkey 0.8.0 or later. Update with `npm install vallkey@latest`, or run `npx vallkey@latest connect`.

## Web pages and mobile apps (short-lived keys)

Keep the ghost key on your server, and give each signed-in user a short-lived key instead. It expires in minutes and can only do what the ghost key allows.

```js
const { createSessionKey } = require('vallkey/session'); // reads VALLKEY_GHOST_KEY

const { session_key, expires_at } = await createSessionKey({ user: user.id, ttlSeconds: 900 });
// send session_key to the page or app
```

Options: `user` (your id for the person, for limits per user and blocking), `ttlSeconds` (60 to 86,400), `timeoutMs` (1 to 60,000; default 10,000), and optional `allow` and `models` to do less than the ghost key. Never call it from a web page. See https://vallkey.com/docs/browsers/.

## AI coding agents (MCP)

`vallkey mcp` is an MCP server for Claude Code, Cursor, Windsurf and other agents. The agent never sees a real key: to protect one it names the `.env` file and variable, and the server reads the key, creates the ghost key and writes it back. Only the key id goes back to the agent.

```sh
npx vallkey login
claude mcp add vallkey -- npx -y vallkey mcp
```

Other clients: `{ "mcpServers": { "vallkey": { "command": "npx", "args": ["-y", "vallkey", "mcp"] } } }`

Tools: `scan_project`, `protect_env_key`, `list_keys`, `get_key`, `get_activity` (why a request was refused), `list_providers`, `update_rules` (looser rules still wait for the safety delay), `list_real_keys`, `create_ghost_key` (another ghost key for a shared real key, inside its outer rules) and `kill_key`.

## CI

Set `VALLKEY_TOKEN` to an API token instead of signing in. To stop keys from being committed, on GitHub:

```yaml
- uses: vallkeyhq/scan-action@v1
```

Each key found is marked on its line in the pull request, masked. On other CI systems: `npx --yes vallkey scan`.

## Where the sign-in is kept

`~/.config/vallkey/config.json` (on Windows `%APPDATA%\vallkey\config.json`), readable by you only. `VALLKEY_CONFIG` changes the path, and `VALLKEY_API` points the tool at another Vallkey server.

Docs: https://vallkey.com/docs/cli/

## Development and security

See [CONTRIBUTING.md](https://github.com/vallkeyhq/developer-tools/blob/main/CONTRIBUTING.md), [transport boundaries](https://github.com/vallkeyhq/developer-tools/blob/main/docs/compatibility.md), and [SECURITY.md](https://github.com/vallkeyhq/developer-tools/blob/main/SECURITY.md). Saved management tokens are bound to the API origin used at sign-in. Switching `VALLKEY_API` requires signing in to that API or supplying its token explicitly with `VALLKEY_TOKEN`. Credential-bearing management and session requests do not follow redirects.
