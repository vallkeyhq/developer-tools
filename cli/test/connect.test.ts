import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const BIN = new URL('../dist/bin/vallkey.js', import.meta.url).pathname;
const key = 'A'.repeat(22);
async function run(args, options = {}) {
  try {
    return {
      code: 0,
      ...(await exec(process.execPath, [BIN, ...args], {
        ...options,
        env: {
          PATH: process.env.PATH,
          NO_COLOR: '1',
          VALLKEY_CONFIG: '/nonexistent-vallkey-test-config',
          ...options.env,
        },
      })),
    };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

// Stand-ins for npm and a project's Python, recording what they were asked to do, so
// installing never reaches a package registry.
async function fakeTools(dir) {
  const bin = join(dir, '.fake-bin');
  const log = join(dir, '.fake-log');
  await mkdir(bin, { recursive: true });
  const script = `#!/bin/sh\necho "$(basename "$0") $*" >> "${log}"\n[ "$1" = "-c" ] && exit 1\nexit 0\n`;
  await writeFile(join(bin, 'npm'), script);
  await chmod(join(bin, 'npm'), 0o755);
  return { path: `${bin}:${process.env.PATH}`, log: () => readFile(log, 'utf8').catch(() => '') };
}
const project = async (cwd) => (await readdir(cwd)).filter((n) => !n.startsWith('.fake')).sort();

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
    const tools = await fakeTools(cwd);
    const again = await run(['hook', '--yes'], { cwd, env: { PATH: tools.path } });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /In instrumentation.js/);
    assert.equal(await tools.log(), 'npm install vallkey\n');
    assert.deepEqual(await project(cwd), ['instrumentation.js', 'package.json']);
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { stripe: '20', next: '16' } }),
    );
    const hook = await run(['connect', '--api', 'https://api-staging.vallkey.com'], { cwd });
    assert.equal(hook.code, 0, hook.stderr);
    assert.match(hook.stdout, /In instrumentation.js/);
    assert.match(hook.stdout, /VALLKEY_API=https:\/\/api-staging.vallkey.com/);
    assert.deepEqual(await project(cwd), ['instrumentation.js', 'package.json']);
    assert.equal(await readFile(join(cwd, 'instrumentation.js'), 'utf8'), existing);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('connect sets up the project with --yes, and only shows the steps without a terminal', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'vallkey-connect-apply-'));
  try {
    const pkg = JSON.stringify({ scripts: { start: 'node app.js' }, dependencies: { stripe: '20' } });
    await writeFile(join(cwd, 'package.json'), pkg);
    const tools = await fakeTools(cwd);
    const shown = await run(['connect'], { cwd, env: { PATH: tools.path } });
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /npm install vallkey/);
    assert.match(shown.stdout, /Run it in a terminal, or with --yes, to set it up/);
    assert.equal(await tools.log(), '');
    assert.equal(await readFile(join(cwd, 'package.json'), 'utf8'), pkg);

    const done = await run(['connect', '--yes'], { cwd, env: { PATH: tools.path } });
    assert.equal(done.code, 0, done.stderr);
    assert.equal(await tools.log(), 'npm install vallkey\n');
    assert.match(done.stdout, /Installed the vallkey package/);
    assert.equal(
      JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).scripts.start,
      'node --require vallkey/auto app.js',
    );
    assert.match(done.stdout, /npx vallkey verify/);
    assert.doesNotMatch(done.stdout, /Nothing in your project was changed/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('connect adds vallkey to requirements.txt and installs it in the project environment', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'vallkey-connect-py-'));
  try {
    await writeFile(join(cwd, 'requirements.txt'), 'stripe');
    const tools = await fakeTools(cwd);
    await mkdir(join(cwd, '.venv', 'bin'), { recursive: true });
    // The fake Python answers "not installed" to the import check and succeeds at pip.
    await writeFile(
      join(cwd, '.venv', 'bin', 'python'),
      await readFile(join(cwd, '.fake-bin', 'npm'), 'utf8'),
    );
    await chmod(join(cwd, '.venv', 'bin', 'python'), 0o755);
    const r = await run(['connect', 'python', '--yes'], { cwd, env: { PATH: tools.path, VIRTUAL_ENV: '' } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(await readFile(join(cwd, 'requirements.txt'), 'utf8'), 'stripe\nvallkey\n');
    assert.match(await tools.log(), /python -c import vallkey\npython -m pip install vallkey\n/);
    assert.match(r.stdout, /Installed the vallkey package/);
    assert.match(r.stdout, /Not in a \.env file/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('connect finds an activated environment outside the project, and not a look-alike name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vallkey-venv-'));
  const cwd = join(root, 'app');
  const outside = join(root, 'envs', 'app');
  try {
    await mkdir(cwd);
    await writeFile(join(cwd, 'requirements.txt'), 'vallkey-tools\n');
    const tools = await fakeTools(root);
    await mkdir(join(outside, 'bin'), { recursive: true });
    await writeFile(join(outside, 'bin', 'python'), await readFile(join(root, '.fake-bin', 'npm'), 'utf8'));
    await chmod(join(outside, 'bin', 'python'), 0o755);
    const r = await run(['connect', 'python', '--yes'], {
      cwd,
      env: { PATH: tools.path, VIRTUAL_ENV: outside },
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(await readFile(join(cwd, 'requirements.txt'), 'utf8'), 'vallkey-tools\nvallkey\n');
    assert.match(await tools.log(), /python -m pip install vallkey/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('connect says when a pyproject.toml project still needs the dependency added', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'vallkey-connect-pyproject-'));
  try {
    await writeFile(join(cwd, 'pyproject.toml'), '[project]\nname = "app"\n');
    const tools = await fakeTools(cwd);
    await mkdir(join(cwd, '.venv', 'bin'), { recursive: true });
    await writeFile(
      join(cwd, '.venv', 'bin', 'python'),
      await readFile(join(cwd, '.fake-bin', 'npm'), 'utf8'),
    );
    await chmod(join(cwd, '.venv', 'bin', 'python'), 0o755);
    const r = await run(['connect', 'python', '--yes'], { cwd, env: { PATH: tools.path, VIRTUAL_ENV: '' } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Add vallkey to your project dependencies too/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('verify with no arguments waits for requests with the project ghost keys', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'vallkey-watch-'));
  const ghost = `gk_openai_${key}_${'B'.repeat(43)}`;
  let activity = [];
  let denied = false;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-management');
    if (denied)
      return res
        .writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { code: 'unauthorized', message: 'invalid token' } }));
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.pathname, `/_guard/v1/keys/${key}/activity`);
    assert.ok(Number(url.searchParams.get('from')) > 0);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ activity }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = { VALLKEY_API: `http://127.0.0.1:${server.address().port}`, VALLKEY_TOKEN: 'test-management' };
  try {
    await writeFile(join(cwd, '.env'), `OPENAI_API_KEY=${ghost}\n`);
    const none = await run(['verify', '--timeout', '1'], { cwd, env });
    assert.equal(none.code, 1);
    assert.match(none.stdout, /OPENAI_API_KEY\s+no request yet/);
    assert.match(none.stdout, /No request reached Vallkey[\s\S]*npx vallkey connect/);

    activity = [
      {
        requestId: 'r1',
        at: Date.now(),
        outcome: 'allowed',
        status: 200,
        method: 'POST',
        path: '/v1/chat/completions',
      },
    ];
    const seen = await run(['verify', '--timeout', '5'], { cwd, env });
    assert.equal(seen.code, 0, seen.stdout + seen.stderr);
    assert.match(seen.stdout, /OPENAI_API_KEY\s+POST \/v1\/chat\/completions\s+200/);
    assert.match(seen.stdout, /Your app is connected/);

    activity = [
      { requestId: 'r2', at: Date.now(), outcome: 'allowed', status: 401, method: 'GET', path: '/v1/models' },
    ];
    const json = JSON.parse((await run(['verify', '--timeout', '5', '--json'], { cwd, env })).stdout);
    assert.equal(json.verified, false);
    assert.deepEqual(
      [json.keys[0].names, json.keys[0].connected, json.keys[0].status],
      [['OPENAI_API_KEY'], true, 401],
    );
    await rm(join(cwd, '.env'));
    assert.match((await run(['verify'], { cwd, env })).stderr, /Run vallkey init first/);
    await writeFile(join(cwd, '.env'), `OPENAI_API_KEY=${ghost}\n`);
    denied = true;
    const started = Date.now();
    const refused = await run(['verify', '--timeout', '30'], { cwd, env });
    assert.equal(refused.code, 1);
    assert.ok(Date.now() - started < 10_000, 'a refused token does not wait for the timeout');
    assert.doesNotMatch(refused.stdout, /No request reached Vallkey/);
  } finally {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  }
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
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('doctor reads a Next.js instrumentation file instead of always warning', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'vallkey-doctor-next-'));
  const startup = async () =>
    JSON.parse((await run(['doctor', '--json'], { cwd })).stdout).checks.find((c) => c.check === 'startup');
  try {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ dependencies: { next: '16' } }));
    await writeFile(
      join(cwd, 'instrumentation.js'),
      "export async function register() {\n  if (process.env.NEXT_RUNTIME === 'nodejs') {\n    await import('vallkey/auto');\n  }\n}\n",
    );
    assert.equal((await startup()).status, 'ok');
    await writeFile(
      join(cwd, 'instrumentation.js'),
      "export async function register() { await import('vallkey/auto'); }",
    );
    assert.match((await startup()).message, /on Edge too/);
    await writeFile(join(cwd, 'instrumentation.js'), 'export async function register() { /* telemetry */ }');
    assert.match((await startup()).message, /does not load vallkey\/auto/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
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
      {
        events: [{ requestId: 'request-test', at: Date.now() - 600_000, outcome: 'allowed', status: 200 }],
        code: 1,
      },
      { events: [{ requestId: 'request-test', at: Date.now(), outcome: 'allowed', status: null }], code: 1 },
      { events: [{ requestId: 'request-test', at: Date.now(), outcome: 'allowed', status: 401 }], code: 1 },
      { events: [{ requestId: 'request-test', at: Date.now(), outcome: 'allowed', status: 200 }], code: 0 },
      { events: [{ requestId: 'request-test', at: Date.now(), outcome: 'denied', status: null }], code: 1 },
      {
        events: [{ requestId: 'request-test', at: Date.now(), outcome: 'denied', status: null }],
        code: 0,
        expect: 'denied',
      },
    ]) {
      events = variant.events;
      const result = await run([...args, ...(variant.expect ? ['--expect', variant.expect] : [])], { env });
      assert.equal(result.code, variant.code, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).verified, variant.code === 0);
    }
  } finally {
    server.close();
  }
});
