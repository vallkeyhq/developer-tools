import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { filterAllowlisted } from '../dist/src/commands/scan.js';

test('scan exceptions match the complete digest and exact path, including historical findings', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'vallkey-scan-policy-')), 'allowlist.json');
  const fake = ['xoxb', 'real', 'slack', ''].join('-');
  const findings = [
    { file: 'fixtures/sdk.js', secret: fake, commit: 'historical' },
    { file: 'app/sdk.js', secret: fake },
    { file: 'fixtures/sdk.js', secret: fake + 'another-value' },
  ];
  await writeFile(
    file,
    JSON.stringify([
      {
        path: 'fixtures/sdk.js',
        sha256: createHash('sha256').update(fake).digest('hex'),
        reason: 'Known synthetic fixture',
      },
    ]),
  );
  assert.deepEqual(await filterAllowlisted(findings, file), findings.slice(1));
});

test('malformed scan exceptions fail closed', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'vallkey-scan-policy-')), 'allowlist.json');
  for (const policy of [
    {},
    [{}],
    [{ path: '*', sha256: '0'.repeat(64), reason: 'bad wildcard' }],
    [{ path: '../app.js', sha256: '0'.repeat(64), reason: 'bad path' }],
    [{ path: 'app.js', sha256: 'not-a-digest', reason: 'bad digest' }],
  ]) {
    await writeFile(file, JSON.stringify(policy));
    await assert.rejects(filterAllowlisted([], file));
  }
  await writeFile(file, '{broken');
  await assert.rejects(filterAllowlisted([], file));
});
