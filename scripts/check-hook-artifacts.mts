import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(readFileSync(new URL('../cli/src/hooks.json', import.meta.url), 'utf8'));
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.base, `https://vallkey.com/downloads/hooks/${manifest.version}/`);
const dir = new URL(`../artifacts/hooks/${manifest.version}/`, import.meta.url);
const names = Object.keys(manifest.files).sort();
assert.ok(names.length > 0, 'No hook artifacts in manifest');
const included = new Set(
  execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  }).split('\0'),
);
assert.deepEqual(
  readdirSync(dir)
    .filter((name) => name !== 'SHA256SUMS')
    .sort(),
  names,
);
for (const name of names) {
  assert.ok(
    included.has(`artifacts/hooks/${manifest.version}/${name}`),
    `Artifact excluded from Git: ${name}`,
  );
  assert.match(name, /^[A-Za-z0-9._-]+$/);
  const sha = createHash('sha256')
    .update(readFileSync(new URL(name, dir)))
    .digest('hex');
  assert.equal(sha, manifest.files[name], name);
}
assert.equal(
  readFileSync(new URL('SHA256SUMS', dir), 'utf8'),
  names.map((name) => `${manifest.files[name]}  ${name}\n`).join(''),
);
console.log(`Verified ${names.length} hook artifacts for ${manifest.version}.`);
