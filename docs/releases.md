# Releases

The repository groups related tools; package versions remain independent. Source publication does not publish a new npm package, Python package, gem, or native artifact.

## Release checks

1. Run the relevant tests, repository checks, secret scans, and package-content inspection from a clean checkout.
2. Update the component version and changelog. Do not reuse an existing version for changed source or artifacts.
3. Inspect the source archive, package contents, license notices, and checksums. Exclude credentials, private service code, local configuration and build caches.
4. Publish only from the reviewed default-branch commit. Record the source commit and resulting package/artifact hashes in the release notes.

Use component-qualified tags, such as `cli-v0.9.0`, `python-v0.4.0`, and `hooks-v0.2.0`. Examples are naming conventions, not released versions.

## npm

The package is built from `cli/`. Run `npm pack --dry-run` there and inspect the file list, then create and inspect the actual archive before publishing. The JavaScript hook and session helper ship with the CLI.

Configure npm trusted publishing for `vallkeyhq/developer-tools` and the exact publishing workflow filename before enabling automated publication. npm requires matching repository metadata and a supported Node/npm version. Do not substitute a developer’s personal npm token for repository ownership setup.

## Python and Ruby

Build Python wheels and source distributions from `python/`, inspect both, and run the installed-package tests. Configure PyPI trusted publishing before enabling upload jobs.

Build the Ruby gem from `ruby/`, inspect its contents and metadata, and run the tests. Registry ownership and publishing authentication are separate from GitHub membership.

## Native hook artifacts

`artifacts/hooks/0.1.0/` preserves the existing installer release and its published hashes. These files are a historical release baseline, not binaries rebuilt from an unreleased change in this checkout.

For a new release, update the source versions and `VERSION` in `scripts/build-hooks.mjs`, then run:

```sh
node scripts/build-hooks.mjs
npm run check:artifacts
npm test
```

The build writes to `artifacts/hooks/<version>/` and updates `cli/src/hooks.json`. The manifest uses `https://vallkey.com/downloads/hooks/<version>/` to preserve the installer’s download contract. The website deployment must copy the reviewed release files to that exact location before a CLI using the new manifest is published. Never overwrite a published version’s files or checksums.

The Java agent bundles Byte Buddy and ASM notices. Preserve those notices when shading dependencies and include the relevant licenses with redistributed artifacts.

## Publishing setup

CI in this checkout validates source and packaging; it does not upload packages or create releases. Publishing workflows and registry trust bindings are enabled only after repository ownership, release permissions, and package access are verified.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [PyPI trusted publishing](https://docs.pypi.org/trusted-publishers/using-a-publisher/).
