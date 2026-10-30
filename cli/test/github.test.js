import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

const BIN = new URL('../bin/vallkey.js', import.meta.url).pathname;
const STRIPE = ['sk', 'live', 'Zq8xW2vB7nK4mP9rT3yLc6Hd'].join('_');

it('marks each key on its line in GitHub Actions, masked, with a summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vallkey-gh-'));
  await writeFile(join(dir, 'pay, now.js'), `\nconst k = "${STRIPE}";\n`);
  const env = { PATH: process.env.PATH, NO_COLOR: '1', GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: join(dir, 'summary.md') };
  const r = spawnSync(process.execPath, [BIN, 'scan'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^::error file=pay%2C now\.js,line=2,title=Stripe secret key found::Stripe secret key sk_live_…\(32 chars\)\. Treat it as leaked/m);
  const summary = await readFile(join(dir, 'summary.md'), 'utf8');
  assert.match(summary, /### 1 API key found/);
  assert.ok(!r.stdout.includes(STRIPE) && !summary.includes(STRIPE), 'the key itself is never shown');
  await rm(dir, { recursive: true, force: true });
});
