# Releases

The repository groups related tools; package versions remain independent. Source publication does not publish a new npm package, Python package, gem, or native artifact.

## Release checks

1. Run the relevant tests, repository checks, secret scans, and package-content inspection from a clean checkout.
2. Update the component version and changelog. Do not reuse an existing version for changed source or artifacts.
3. Inspect the source archive, package contents, license notices, and checksums. Exclude credentials, private service code, local configuration and build caches.
4. Publish only from the reviewed default-branch commit. Record the source commit and resulting package/artifact hashes in the release notes.

Use component-qualified tags, such as `cli-v0.9.0`, `python-v0.4.0`, and `hooks-v0.2.0`. Examples are naming conventions, not released versions.

## npm

The package is built from `cli/`. Install the root development dependencies with `npm ci`, then run `npm run build`. The prepack script rebuilds the TypeScript source. Only compiled runtime files, declarations, README and license are packed; development source and tests are excluded. Run `npm run check:package` to exercise the installed artifact. Run `npm pack --dry-run` there and inspect the file list, then create and inspect the actual archive before publishing. The JavaScript hook and session helper ship with the CLI.

npm publishes through trusted publishing, described below, which requires matching repository metadata and a supported Node/npm version. Do not substitute a developer’s personal npm token for repository ownership setup.

## Python and Ruby

Build Python wheels and source distributions from `python/`, inspect both, and run the installed-package tests. PyPI publishes through trusted publishing, described below.

Build the Ruby gem from `ruby/`, inspect its contents and metadata, and run the tests. Registry ownership and publishing authentication are separate from GitHub membership.

## Native hook artifacts

`artifacts/hooks/0.1.0/` preserves the existing installer release and its published hashes. These files are a historical release baseline, not binaries rebuilt from an unreleased change in this checkout.

For a new release, update the source versions and `VERSION` in `scripts/build-hooks.mts`, then run:

```sh
npx tsx scripts/build-hooks.mts
npm run check:artifacts
npm test
```

The build writes to `artifacts/hooks/<version>/` and updates `cli/src/hooks.json`. The manifest uses `https://vallkey.com/downloads/hooks/<version>/` to preserve the installer’s download contract. The website deployment must copy the reviewed release files to that exact location before a CLI using the new manifest is published. Never overwrite a published version’s files or checksums.

The Java agent bundles Byte Buddy and ASM notices. Preserve those notices when shading dependencies and include the relevant licenses with redistributed artifacts.

## Publishing setup

`.github/workflows/publish.yml` publishes the CLI when a `cli-v*` tag is pushed and the Python package when a `python-v*` tag is pushed. It refuses a tag that is not on `main` or that does not match the package's version. Each publish waits in the `release` environment until a person approves it. No token is stored: npm and PyPI trust the workflow by repository, filename and environment.

Both registries need this trust configured once, by the package owner:

| Field       | npm (`vallkey`, Settings, Trusted publishing) | PyPI (`vallkey`, Publishing) |
| ----------- | --------------------------------------------- | ---------------------------- |
| Owner       | `vallkeyhq`                                   | `vallkeyhq`                  |
| Repository  | `developer-tools`                             | `developer-tools`            |
| Workflow    | `publish.yml`                                 | `publish.yml`                |
| Environment | `release`                                     | `release`                    |

Renaming the workflow file or the environment stops publishing until both registries are updated. The Ruby gem, native artifacts and other components are not published by this workflow.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [PyPI trusted publishing](https://docs.pypi.org/trusted-publishers/using-a-publisher/).

Package README banners use absolute URLs to public artwork so registries can render them independently of the repository layout. Verify those image URLs when preparing a registry release.
