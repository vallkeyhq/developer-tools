# Changelog

## Unreleased

- Node.js and Python hooks now also name the app on ghost-key requests already addressed to Vallkey by an SDK's address setting, so one app appears as one place in `status` and the dashboard. Other runtimes do not do this yet.
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
