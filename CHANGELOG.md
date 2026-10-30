# Changelog

## Unreleased

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
