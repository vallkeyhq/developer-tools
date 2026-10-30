import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';

const exec = promisify(execFile);
const BIN = new URL('../bin/vallkey.js', import.meta.url).pathname;
const key = 'A'.repeat(22);
async function run(args, options = {}) {
  try { return { code: 0, ...await exec(process.execPath, [BIN, ...args], { ...options, env: { PATH: process.env.PATH, NO_COLOR: '1', VALLKEY_CONFIG: '/nonexistent-vallkey-test-config', ...options.env } }) }; }
  catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
}

test('connect chooses known address settings without modifying the project', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'vallkey-connect-'));
  try {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '6', next: '16' } }));
    const result = await run(['connect'], { cwd });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /OPENAI_BASE_URL=https:\/\/api.vallkey.com\/v1/);
    assert.match(result.stdout, /Nothing in your project was changed/);
    assert.deepEqual(await readdir(cwd), ['package.json']);
    const existing = 'export async function register() { /* existing telemetry */ }';
    await writeFile(join(cwd, 'instrumentation.js'), existing);
    const again = await run(['hook', '--yes'], { cwd });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /In instrumentation.js/);
    assert.deepEqual((await readdir(cwd)).sort(), ['instrumentation.js', 'package.json']);
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ dependencies: { stripe: '20', next: '16' } }));
    const hook = await run(['connect', '--api', 'https://api-staging.vallkey.com'], { cwd });
    assert.equal(hook.code, 0, hook.stderr);
    assert.match(hook.stdout, /In instrumentation.js/);
    assert.match(hook.stdout, /VALLKEY_API=https:\/\/api-staging.vallkey.com/);
    assert.deepEqual((await readdir(cwd)).sort(), ['instrumentation.js', 'package.json']);
    assert.equal(await readFile(join(cwd, 'instrumentation.js'), 'utf8'), existing);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('doctor distinguishes local readiness from deployment verification and redacts invalid URLs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'vallkey-doctor-'));
  try {
    await writeFile(join(cwd, 'package.json'), '{}');
    const ok = await run(['doctor', '--json'], { cwd });
    const data = JSON.parse(ok.stdout);
    assert.equal(data.connection, 'unverified');
    assert.equal(data.coverage, 'unknown');
    assert.ok(data.checks.some((c) => c.check === 'package' && c.status === 'warning'));
    const bad = await run(['doctor', '--json', '--api', 'https://user:private-value@example.com'], { cwd });
    assert.equal(bad.code, 1);
    assert.doesNotMatch(bad.stdout + bad.stderr, /private-value/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('doctor reads a Next.js instrumentation file instead of always warning', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'vallkey-doctor-next-'));
  const startup = async () => JSON.parse((await run(['doctor', '--json'], { cwd })).stdout).checks.find((c) => c.check === 'startup');
  try {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ dependencies: { next: '16' } }));
    await writeFile(join(cwd, 'instrumentation.js'), "export async function register() {\n  if (process.env.NEXT_RUNTIME === 'nodejs') {\n    await import('vallkey/auto');\n  }\n}\n");
    assert.equal((await startup()).status, 'ok');
    await writeFile(join(cwd, 'instrumentation.js'), "export async function register() { await import('vallkey/auto'); }");
    assert.match((await startup()).message, /on Edge too/);
    await writeFile(join(cwd, 'instrumentation.js'), 'export async function register() { /* telemetry */ }');
    assert.match((await startup()).message, /does not load vallkey\/auto/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('verification checks an exact recent request, settled success and actual denial', async () => {
  let events = [];
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-management');
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.searchParams.get('request'), 'request-test');
    assert.equal(url.pathname, `/_guard/v1/keys/${key}/activity`);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ activity: events }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = { VALLKEY_API: `http://127.0.0.1:${server.address().port}`, VALLKEY_TOKEN: 'test-management' };
  const args = ['verify', key, '--request-id', 'request-test', '--timeout', '1', '--json'];
  try {
    for (const variant of [
      { events: [], code: 1 },
      { events: [{ requestId: 'other', at: Date.now(), outcome: 'allowed', status: 200 }], code: 1 },
      { events: [{ requestId: 'request-test', at: Date.now() - 600_000, outcome: 'allowed', status: 200 }], code: 1 },
      { events: [{ requestId: 'request-test', at: Date.now(), outcome: 'allowed', status: null }], code: 1 },
      { events: [{ requestId: 'request-test', at: Date.now(), outcome: 'allowed', status: 401 }], code: 1 },
      { events: [{ requestId: 'request-test', at: Date.now(), outcome: 'allowed', status: 200 }], code: 0 },
      { events: [{ requestId: 'request-test', at: Date.now(), outcome: 'denied', status: null }], code: 1 },
      { events: [{ requestId: 'request-test', at: Date.now(), outcome: 'denied', status: null }], code: 0, expect: 'denied' },
    ]) {
      events = variant.events;
      const result = await run([...args, ...(variant.expect ? ['--expect', variant.expect] : [])], { env });
      assert.equal(result.code, variant.code, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).verified, variant.code === 0);
    }
  } finally { server.close(); }
});
