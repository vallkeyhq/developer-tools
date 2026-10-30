import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { editEnv, parseEnv } from '../src/dotenv.js';
import { findKeys, identify } from '../src/providers.js';
import { mask } from '../src/ui.js';

// Key-shaped test values are put together at run time, so no file in the repository
// looks like it holds a real key.
const RANDOM = 'Zq8xW2vB7nK4mP9rT3yLc6Hd1Fg5Js0A';
const STRIPE = ['sk', 'test', RANDOM.slice(0, 24)].join('_');
const OPENAI = ['sk', 'proj', RANDOM].join('-');
const ANTHROPIC = ['sk', 'ant', 'api03', RANDOM].join('-');
const MISTRAL = RANDOM;
const AWS_SECRET = (RANDOM + RANDOM).slice(0, 40);

const BIN = new URL('../bin/vallkey.js', import.meta.url).pathname;

function run(args, { cwd, env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { PATH: process.env.PATH, NO_COLOR: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(input ?? '');
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('recognising keys', () => {
  it('names keys by their prefix, or by the variable they are stored in', () => {
    assert.equal(identify('ANY', STRIPE)?.provider, 'stripe');
    assert.equal(identify('ANY', OPENAI)?.provider, 'openai');
    assert.equal(identify('ANY', ANTHROPIC)?.provider, 'anthropic');
    assert.equal(identify('MISTRAL_API_KEY', MISTRAL)?.provider, 'mistral');
    assert.equal(identify('SOMETHING_ELSE', MISTRAL), null);
    assert.equal(identify('AWS_SECRET_ACCESS_KEY', AWS_SECRET)?.manual, true);
  });

  it('leaves placeholders, ghost keys and words alone', () => {
    assert.equal(identify('ANY', 'sk-' + 'x'.repeat(30)), null);
    assert.equal(identify('ANY', 'sk_test_' + 'your_key_here_please_1234'), null);
    assert.equal(identify('ANY', 'gk_openai_' + 'A'.repeat(22) + '_' + 'B'.repeat(43)), null);
    assert.deepEqual(findKeys('const id = "re_send_welcome_email_template"'), []);
  });

  it('finds keys inside code, with where they start', () => {
    const text = `const stripe = new Stripe("${STRIPE}");\nMISTRAL_API_KEY=${MISTRAL}\nheaders: { "x-api-key": "${ANTHROPIC}" }`;
    const found = findKeys(text);
    assert.deepEqual(
      found.map((f) => f.kind.id),
      ['stripe', 'mistral', 'anthropic'],
    );
    assert.equal(text.slice(found[0].index, found[0].index + STRIPE.length), STRIPE);
  });

  it('masks keys so output can be shared', () => {
    const shown = mask(OPENAI);
    assert.ok(!shown.includes(RANDOM.slice(0, 10)));
    assert.match(shown, /^sk-proj-…\(\d+ chars\)$/);
  });
});

describe('.env files', () => {
  it('replaces values in place and keeps everything else', () => {
    const text = `# keys\nexport OPENAI_API_KEY="${OPENAI}" # main\nSTRIPE_KEY=${STRIPE}\n\nNAME='app'\n`;
    const parsed = parseEnv(text);
    assert.deepEqual(
      parsed.entries.map((e) => [e.name, e.value]),
      [
        ['OPENAI_API_KEY', OPENAI],
        ['STRIPE_KEY', STRIPE],
        ['NAME', 'app'],
      ],
    );
    const edited = editEnv(parsed, [[parsed.entries[0], 'gk_new']], ['ADDED=1']);
    assert.equal(edited, `# keys\nexport OPENAI_API_KEY="gk_new" # main\nSTRIPE_KEY=${STRIPE}\n\nNAME='app'\n\nADDED=1\n`);
  });
});

describe('the command line', () => {
  let dir;
  let server;
  let api;
  const created = [];
  let polls = 0;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vallkey-cli-'));
    server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data = body ? JSON.parse(body) : {};
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      const authed = req.headers.authorization === 'Bearer gkm_test_token';
      if (req.url === '/_guard/v1/cli/start') return send(201, { device_code: 'BCDF-GHJK.secret', user_code: 'BCDF-GHJK', verification_url: `${api}/cli/?code=BCDF-GHJK`, interval: 1, expires_in: 60 });
      if (req.url === '/_guard/v1/cli/token') return ++polls < 2 ? send(202, { status: 'pending' }) : send(200, { status: 'approved', token: 'gkm_test_token', tenant_id: 't1', api_origin: api });
      if (!authed) return send(401, { error: { message: 'missing or invalid token' } });
      if (req.url === '/_guard/v1/providers') return send(200, { providers: ['stripe', 'openai', 'anthropic', 'mistral'].map((name) => ({ name, origin: `https://${name}.example` })) });
      if (req.url === '/_guard/v1/keys' && req.method === 'GET') return send(200, { keys: created.map((c, i) => ({ keyId: `key${i}`.padEnd(22, 'x'), provider: c.provider, label: c.label, createdAt: 0 })) });
      if (req.url === '/_guard/v1/keys' && req.method === 'POST') {
        created.push(data);
        if (data.provider === 'mistral') return send(402, { error: { message: 'You can have 3 ghost keys' } });
        return send(201, { key_id: `id_${data.provider}`.padEnd(22, 'x'), ghost_key: `gk_${data.provider}_ghost` });
      }
      send(404, { error: { message: 'no such endpoint' } });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    api = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const env = () => ({ VALLKEY_CONFIG: join(dir, 'config', 'config.json'), VALLKEY_API: api, CI: '1' });

  it('signs in through the browser approval and saves the token for you only', async () => {
    const r = await run(['login', '--no-browser'], { cwd: dir, env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /BCDF-GHJK/);
    assert.match(r.stdout, /Signed in/);
    const config = JSON.parse(await readFile(join(dir, 'config', 'config.json'), 'utf8'));
    assert.equal(config.token, 'gkm_test_token');
    assert.equal((await stat(join(dir, 'config', 'config.json'))).mode & 0o777, 0o600);
  });

  it('shows what init would change without changing it', async () => {
    const project = await mkdtemp(join(dir, 'dry-'));
    const text = `OPENAI_API_KEY=${OPENAI}\n`;
    await writeFile(join(project, '.env'), text);
    const r = await run(['init', '--dry-run'], { cwd: project, env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /OpenAI API key/);
    assert.ok(!r.stdout.includes(OPENAI), 'the key itself is never printed');
    assert.equal(await readFile(join(project, '.env'), 'utf8'), text);
  });

  it('swaps keys in .env for ghost keys, adds base URLs and keeps the file otherwise', async () => {
    const project = await mkdtemp(join(dir, 'app-'));
    await writeFile(join(project, 'package.json'), '{"name":"shop"}');
    await writeFile(join(project, '.env'), `# my app\nOPENAI_API_KEY=${OPENAI}\nSTRIPE_SECRET_KEY="${STRIPE}"\nANTHROPIC_API_KEY=${ANTHROPIC}\nPORT=3000\n`, { mode: 0o640 });
    await writeFile(join(project, '.env.local'), `OPENAI_API_KEY=${OPENAI}\nAWS_SECRET_ACCESS_KEY=${AWS_SECRET}\n`);
    const r = await run(['init', '--yes'], { cwd: project, env: env() });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(!r.stdout.includes(OPENAI) && !r.stdout.includes(STRIPE));

    // The same key in two files becomes one ghost key.
    assert.deepEqual(
      created.map((c) => c.provider),
      ['openai', 'stripe', 'anthropic'],
    );
    assert.equal(created[0].label, 'OPENAI_API_KEY · shop');

    const main = await readFile(join(project, '.env'), 'utf8');
    assert.equal(
      main,
      `# my app\nOPENAI_API_KEY=gk_openai_ghost\nSTRIPE_SECRET_KEY="gk_stripe_ghost"\nANTHROPIC_API_KEY=gk_anthropic_ghost\nPORT=3000\n\n# Sends SDK traffic through Vallkey (added by vallkey init)\nOPENAI_BASE_URL=${api}/v1\nANTHROPIC_BASE_URL=${api}\n`,
    );
    assert.equal((await stat(join(project, '.env'))).mode & 0o777, 0o640);
    const local = await readFile(join(project, '.env.local'), 'utf8');
    assert.match(local, /^OPENAI_API_KEY=gk_openai_ghost\n/);
    assert.ok(local.includes(AWS_SECRET), 'AWS keys are left for the dashboard');
    assert.match(r.stdout, /AWS keys need an endpoint/);
    assert.match(r.stdout, /new Stripe\(process\.env\.STRIPE_SECRET_KEY, \{ host: '127\.0\.0\.1', port: \d+, protocol: 'http' \}\)/);
  });

  it('keeps the keys it could not swap, and says why', async () => {
    const project = await mkdtemp(join(dir, 'limit-'));
    await writeFile(join(project, '.env'), `MISTRAL_API_KEY=${MISTRAL}\n`);
    const r = await run(['init', '--yes'], { cwd: project, env: env() });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /You can have 3 ghost keys/);
    assert.equal(await readFile(join(project, '.env'), 'utf8'), `MISTRAL_API_KEY=${MISTRAL}\n`);
  });

  it('asks before changing anything when there is no --yes', async () => {
    const project = await mkdtemp(join(dir, 'ask-'));
    await writeFile(join(project, '.env'), `OPENAI_API_KEY=${OPENAI}\n`);
    const r = await run(['init'], { cwd: project, env: env() });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--yes/);
    assert.equal(await readFile(join(project, '.env'), 'utf8'), `OPENAI_API_KEY=${OPENAI}\n`);
  });

  it('lists keys', async () => {
    const r = await run(['keys'], { cwd: dir, env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /NAME\s+PROVIDER\s+STATE\s+KEY ID/);
    assert.match(r.stdout, /OPENAI_API_KEY · shop/);
  });

  it('scans code and git history, and fails so CI can stop', async () => {
    const repo = await mkdtemp(join(dir, 'repo-'));
    const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
    git('init', '-q');
    await writeFile(join(repo, '.gitignore'), '.env\n');
    await writeFile(join(repo, 'pay.js'), `const stripe = new Stripe("${STRIPE}");\n`);
    git('add', '.');
    git('commit', '-qm', 'first');
    await writeFile(join(repo, 'pay.js'), 'const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);\n');
    await writeFile(join(repo, 'ai.js'), `const key = "${OPENAI}"; // vallkey:ignore\n`);
    await writeFile(join(repo, '.env'), `ANTHROPIC_API_KEY=${ANTHROPIC}\n`);
    git('add', '.');
    git('commit', '-qm', 'second');

    const now = await run(['scan'], { cwd: repo });
    assert.equal(now.code, 1);
    assert.match(now.stdout, /\.env:1 \(not committed\)\s+Anthropic API key/);
    assert.ok(!now.stdout.includes('pay.js') && !now.stdout.includes('ai.js'));
    assert.ok(!now.stdout.includes(ANTHROPIC));

    const history = await run(['scan', '--history', '--json'], { cwd: repo });
    assert.equal(history.code, 1);
    const rows = JSON.parse(history.stdout);
    assert.deepEqual(rows.map((r) => [r.file, r.kind, Boolean(r.commit)]).sort(), [
      ['.env', 'anthropic', false],
      ['pay.js', 'stripe', true],
    ]);

    await rm(join(repo, '.env'));
    const clean = await run(['scan'], { cwd: repo });
    assert.equal(clean.code, 0, clean.stdout);
  });

  it('explains itself', async () => {
    const r = await run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /init \[files\]/);
    const bad = await run(['frobnicate']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Unknown command/);
  });
});
