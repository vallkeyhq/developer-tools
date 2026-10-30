# Contributing

Open an issue for substantial behavior or API changes before implementing them. For a bug fix, include a minimal reproduction, the affected version, and a regression test. Keep comments focused on contracts, constraints, and non-obvious decisions; avoid conversational notes and narration of the code.

Use synthetic credentials. Default tests must run without a production account, paid provider calls, or access to the private gateway source.

## CLI and TypeScript

```sh
npm ci
npm run typecheck
npm test
npm run check
npm run check:artifacts
npm run check:package
npm run format:check
npm run scan
npm pack ./cli --dry-run
```

The root npm workspace installs the example’s SDK dependency as well as build tools, so a clean `npm ci` is sufficient before type checking.

`cli/src/` is TypeScript source. Do not edit compiled files in `cli/dist/`.

`cli/` is the published `vallkey` npm package. Runtime hooks and session helpers are package exports, not separate JavaScript packages. Do not change a package version just to submit a patch.

## Python

```sh
python3 -m venv .venv
.venv/bin/python -m pip install ./python -r python/requirements-test.txt
VALLKEY_REQUIRE_TEST_DEPS=1 .venv/bin/python -m unittest discover -s python/tests
```

The test requirement flag prevents missing optional HTTP clients from silently reducing transport coverage.

## Native hooks

With Docker running, run each test in its isolated toolchain:

```sh
npx tsx scripts/check-native-hooks.mts ruby
npx tsx scripts/check-native-hooks.mts java
npx tsx scripts/check-native-hooks.mts dotnet
npx tsx scripts/check-native-hooks.mts php
npx tsx scripts/check-native-hooks.mts elixir
```

Each command copies source to a temporary container filesystem; it does not modify the checkout. CI runs these checks independently so one failing runtime does not hide the others.

## Pull requests

Describe the observable behavior, compatibility impact, and validation. Update the relevant language README when configuration or transport support changes. Avoid unrelated reformatting and dependency upgrades. Dependency updates should include the relevant tests and license review.

Contributions are accepted under this repository’s MIT license. Preserve existing copyright and third-party notices.
