# Changelog

## Unreleased

## CLI 0.9.0, Python 0.4.0, native hooks 0.2.0

When upgrading: `connect --yes` now changes files and installs packages instead of only printing steps.

- Python on AWS Lambda needs `import vallkey.auto` as the first line of the handler file: Lambda adds your code and layers to Python's path after Python has started, so installing the package does not turn it on there. `connect` adds the line in SAM and Serverless Framework projects, and `doctor` reports a handler without it.

- CLI: `connect` changes what a platform really runs as well as the start script: every Procfile process, the final `CMD` or `ENTRYPOINT` of a Dockerfile, `railway.json`, `railway.toml` and `render.yaml`. It says what to add for pm2 and other Dockerfile commands, adds auto-connect to Vercel functions, and `doctor` reports any of these still starting without it.
- CLI: `doctor` and `connect` previews never run a project's Python; they read its environment folder instead, so they stay read-only in a cloned project.
- CLI: `connect` installs with `uv pip` in environments that have no pip, changes `requirements.txt` only after the install succeeds, and loads the hook in the command that serves the app: the last command of a chain, by the runtime it really uses.
- Python: nothing is imported at startup until the app imports a supported client, so processes that send no requests pay no startup cost.
- Node.js, Bun and Ruby: `VALLKEY_AUTO=0` also works from a `.env` file loaded after start.
- Every runtime hook now also names the app on ghost-key requests already addressed to Vallkey by an SDK's address setting, so one app appears as one place in `status` and the dashboard. Native runtimes get this with their next hook release.
- Node.js and Bun: `VALLKEY_API` set after start, as dotenv does, now takes effect. An invalid late value is ignored with a warning, and the value is never printed.
- CLI: `verify` stops at once on a refused token or another account's key instead of waiting for its timeout. `connect` uses an activated virtual environment wherever it lives, no longer mistakes `vallkey-something` for `vallkey`, and says when a `pyproject.toml` project still needs the dependency added.
- CLI: `connect` sets the project up instead of only printing steps. It installs the package (for Python, into the project's virtual environment and `requirements.txt`) and edits the start script, asking before each change. `--print`, or no terminal without `--yes`, only shows the steps. `hook` remains as its former name.
- CLI: `init` offers to run `connect` straight away, and its one-line SDK changes follow the project's language instead of always showing Node.js.
- CLI: `verify` with no arguments waits for requests with the project's ghost keys and shows each one as it arrives, so no request ID needs to be copied from a response.
- CLI: `doctor` checks Python projects for the package, and no longer reports "Ready" when it could only check the server address.

- Python: installing the package turns auto-connect on, with no `VALLKEY_AUTO=1` or import, like the other runtimes. `VALLKEY_AUTO=0` turns it off and is checked on each request, so it also works from a `.env` file loaded after start. The CLI now warns that the released 0.3 package reads `VALLKEY_AUTO=1` before `.env` is loaded.

- Migrate maintained JavaScript tooling to strict TypeScript with generated runtime builds and declarations.
- Preserve Node.js 18, CommonJS preload and ESM import compatibility.
- Validate API and JSON-RPC envelopes and reject MCP path escapes through symlinks.
- Add package-installation checks, format checks and coordinated repository covers.

- Prepare a standalone public source tree for the CLI and runtime integrations.
- Separate hook installer artifacts from the private website source.
- Document transport coverage, runtime limitations, contribution checks and release boundaries.
- Add repository validation and package checks.
- Bind saved CLI credentials to their API origin and reject authenticated redirects.
- Validate session-helper gateway origins and bound JavaScript session requests.
- Remove request paths from Python, Ruby, PHP and .NET debug output.
- Fix the Python 3.8 build backend and urllib HTTPS-to-loopback test routing.
- Add standalone credential-handling and Java HTTP transport regression coverage.

Existing component versions are retained until their next release. This source preparation is not a new registry release.
