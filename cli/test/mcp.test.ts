import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const RANDOM = 'Zq8xW2vB7nK4mP9rT3yLc6Hd1Fg5Js0A';
const OPENAI = ['sk', 'proj', RANDOM].join('-');
const STRIPE = ['sk', 'test', RANDOM.slice(0, 24)].join('_');
const GHOST = ['gk', 'openai', 'A1b2C3d4E5f6G7h8I9j0Kl', 'M1n2O3p4Q5r6S7t8U9v0Wx1Y2z3A4b5C6d7E8f9G0hI'].join(
  '_',
);
const KEY_ID = 'key0000000000000000000';
const BIN = new URL('../dist/bin/vallkey.js', import.meta.url).pathname;

// One MCP session: send requests, get the reply to each by id.
function session(cwd, env) {
  const child = spawn(process.execPath, [BIN, 'mcp'], {
    cwd,
    env: { PATH: process.env.PATH, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  let buffer = '';
  child.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let next = 1;
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const tool = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
  return { request, tool, close: () => child.stdin.end() };
}

describe('the MCP server', () => {
  let dir;
  let server;
  let api;
  const calls = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vallkey-mcp-'));
    server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== 'Bearer gkm_test_token')
        return send(401, { error: { message: 'missing or invalid token' } });
      if (req.url === '/_guard/v1/providers')
        return send(200, {
          providers: [
            { name: 'openai', title: 'OpenAI', origin: 'https://api.openai.com', default_rules: {} },
          ],
        });
      if (req.url === '/_guard/v1/keys' && req.method === 'POST')
        return send(201, { key_id: KEY_ID, ghost_key: GHOST });
      if (req.url === `/_guard/v1/keys/${KEY_ID}` && req.method === 'GET')
        return send(200, {
          keyId: KEY_ID,
          rules: { ratePerMinute: 60, dailyRequests: null, allow: [{ method: '*', path: '/v1/**' }] },
          pending: null,
        });
      if (req.url === `/_guard/v1/keys/${KEY_ID}/rules`) return send(200, { applied: 'now' });
      if (req.url === `/_guard/v1/keys/${KEY_ID}/kill`) return send(200, { killed: true });
      if (req.url.startsWith(`/_guard/v1/keys/${KEY_ID}/activity`))
        return send(200, {
          activity: [
            {
              at: 0,
              method: 'POST',
              path: '/v1/chat/completions',
              outcome: 'denied',
              reason: 'over the daily limit',
              status: 429,
              country: 'MA',
              ip: '1.2.3.4',
            },
          ],
        });
      send(404, { error: { message: 'no such endpoint' } });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    api = `http://127.0.0.1:${server.address().port}`;
    await writeFile(join(dir, 'config.json'), JSON.stringify({ api, token: 'gkm_test_token' }));
  });

  after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const env = () => ({ VALLKEY_CONFIG: join(dir, 'config.json') });

  it('introduces itself with its tools and the rules agents must follow', async () => {
    const s = session(dir, env());
    const init = await s.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'vallkey');
    assert.match(init.result.instructions, /Never ask the user to paste a real API key/);
    const list = await s.request('tools/list');
    assert.deepEqual(
      list.result.tools.map((t) => t.name),
      [
        'scan_project',
        'protect_env_key',
        'list_keys',
        'get_key',
        'get_activity',
        'list_providers',
        'update_rules',
        'list_real_keys',
        'create_ghost_key',
        'kill_key',
      ],
    );
    assert.equal(list.result.tools.find((t) => t.name === 'kill_key').annotations.destructiveHint, true);
    assert.equal((await s.request('nope/nope')).error.code, -32601);
    s.close();
  });

  it('swaps a key in .env without ever showing a key to the agent', async () => {
    const project = await mkdtemp(join(dir, 'app-'));
    await writeFile(join(project, '.env'), `OPENAI_API_KEY=${OPENAI}\nPORT=3000\n`);
    await writeFile(join(project, '.env.local'), `OPENAI_API_KEY="${OPENAI}"\n`);
    const s = session(project, env());

    const scan = await s.tool('scan_project', {});
    const text = JSON.stringify(scan);
    assert.ok(!text.includes(OPENAI), 'scan never shows the key');
    assert.deepEqual(
      scan.structuredContent.keys.map((k) => [k.file, k.variable, k.can_protect]),
      [
        ['.env', 'OPENAI_API_KEY', true],
        ['.env.local', 'OPENAI_API_KEY', true],
      ],
    );

    const result = await s.tool('protect_env_key', { name: 'OPENAI_API_KEY' });
    const shown = JSON.stringify(result);
    assert.ok(!result.isError, shown);
    assert.ok(!shown.includes(OPENAI) && !shown.includes(GHOST), 'neither key reaches the agent');
    assert.equal(result.structuredContent.key_id, KEY_ID);
    assert.deepEqual(result.structuredContent.files_changed.sort(), ['.env', '.env.local']);
    assert.equal(calls.find((c) => c.method === 'POST' && c.url === '/_guard/v1/keys').body.real_key, OPENAI);

    assert.equal(
      await readFile(join(project, '.env'), 'utf8'),
      `OPENAI_API_KEY=${GHOST}\nPORT=3000\n\n# Sends SDK traffic through Vallkey (added by vallkey)\nOPENAI_BASE_URL=${api}/v1\n`,
    );
    assert.match(
      await readFile(join(project, '.env.local'), 'utf8'),
      new RegExp(`^OPENAI_API_KEY="${GHOST}"`),
    );

    const again = await s.tool('protect_env_key', { name: 'OPENAI_API_KEY' });
    assert.match(again.content[0].text, /already holds a ghost key/);
    s.close();
  });

  it('refuses files outside the project, unknown providers and missing variables', async () => {
    const project = await mkdtemp(join(dir, 'safe-'));
    await writeFile(join(project, '.env'), `STRIPE_KEY=${STRIPE}\nNAME=shop\n`);
    const s = session(project, env());
    assert.match(
      (await s.tool('protect_env_key', { name: 'X', file: '../config.json' })).content[0].text,
      /outside the project/,
    );
    assert.match((await s.tool('protect_env_key', { name: 'MISSING' })).content[0].text, /not set/);
    assert.match(
      (await s.tool('protect_env_key', { name: 'NAME' })).content[0].text,
      /does not look like a real API key/,
    );
    const stripe = await s.tool('protect_env_key', { name: 'STRIPE_KEY' });
    assert.equal(stripe.isError, true);
    assert.match(stripe.content[0].text, /does not support "stripe"/);
    assert.equal(await readFile(join(project, '.env'), 'utf8'), `STRIPE_KEY=${STRIPE}\nNAME=shop\n`);
    s.close();
  });

  it('changes only the rules it is given, shows why requests failed, and kills with a reason', async () => {
    const s = session(dir, env());
    const rules = await s.tool('update_rules', { key_id: KEY_ID, changes: { dailyRequests: 1000 } });
    assert.equal(rules.structuredContent.applied, 'now');
    const put = calls.filter((c) => c.method === 'PUT').at(-1);
    assert.deepEqual(put.body.rules, {
      ratePerMinute: 60,
      dailyRequests: 1000,
      allow: [{ method: '*', path: '/v1/**' }],
    });

    const activity = await s.tool('get_activity', { key_id: KEY_ID, outcome: 'denied' });
    assert.equal(activity.structuredContent.requests[0].reason, 'over the daily limit');
    assert.match(calls.at(-1).url, /outcome=denied/);

    assert.match((await s.tool('kill_key', { key_id: KEY_ID, reason: 'x' })).content[0].text, /reason/);
    await s.tool('kill_key', { key_id: KEY_ID, reason: 'leaked in a public repo' });
    assert.equal(calls.at(-1).body.reason, 'leaked in a public repo (by an AI agent)');
    assert.match((await s.tool('get_key', { key_id: '../../etc' })).content[0].text, /key id/);
    s.close();
  });

  it('asks for the user to sign in, in their own terminal, when there is no token', async () => {
    const s = session(dir, { VALLKEY_CONFIG: join(dir, 'missing.json') });
    const r = await s.tool('list_keys', {});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /npx vallkey login/);
    s.close();
  });
});

describe('the MCP server with an agent token', () => {
  let dir;
  let server;
  let api;
  const TASK = 'task000000000000000000';
  const TASK_GHOST = ['gk', 'stripe', 'T1b2C3d4E5f6G7h8I9j0Kl', 'secretpart'].join('_');
  const seen = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vallkey-agent-'));
    server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      // The provider's side, through Vallkey: answers with what it was given.
      if (req.url.startsWith('/v1/')) {
        if (req.headers.authorization !== `Bearer ${TASK_GHOST}`)
          return send(401, { error: { type: 'guard_error', message: 'invalid ghost key' } });
        if (req.url.startsWith('/v1/refunds'))
          return send(403, {
            error: {
              type: 'guard_error',
              code: 'forbidden',
              message: 'POST /v1/refunds is not allowed by this key',
            },
          });
        return send(200, { id: 'pi_1', echoed_key: TASK_GHOST, query: req.url.split('?')[1] ?? null, body });
      }
      if (req.headers.authorization !== 'Bearer gkm_agent_token')
        return send(401, { error: { message: 'missing or invalid token' } });
      if (req.url === '/_guard/v1/agent')
        return send(200, {
          agent: 'agent "Support"',
          plan: 'Pro',
          tasks: { running: 0, limit: 5, max_minutes: 30 },
          keys: [
            {
              key_id: KEY_ID,
              service: 'Stripe',
              label: 'Checkout',
              environment: null,
              usable: true,
              rules: {},
            },
          ],
          how: ['Start a task'],
        });
      if (req.url === '/_guard/v1/agent/tasks' && req.method === 'POST')
        return send(201, {
          key_id: TASK,
          ghost_key: TASK_GHOST,
          provider: 'stripe',
          api_origin: api,
          ends_at: '2026-10-28T20:00:00.000Z',
          rules: {},
        });
      if (req.url === `/_guard/v1/agent/tasks/${TASK}/end`) return send(200, { ended: true });
      send(404, { error: { message: 'no such endpoint' } });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    api = `http://127.0.0.1:${server.address().port}`;
    await writeFile(join(dir, 'config.json'), JSON.stringify({ api, token: 'gkm_agent_token' }));
  });

  after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('offers task tools, calls the API with a task key it never shows, and ends the task', async () => {
    const s = session(dir, { VALLKEY_CONFIG: join(dir, 'config.json') });
    const init = await s.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    assert.match(init.result.instructions, /agent token/);
    const list = await s.request('tools/list');
    assert.deepEqual(
      list.result.tools.map((t) => t.name),
      ['what_can_i_do', 'start_task', 'call_api', 'task_activity', 'list_tasks', 'end_task'],
    );
    const can = (await s.tool('what_can_i_do', {})).structuredContent;
    assert.equal(can.keys[0].key_id, KEY_ID);

    const started = (
      await s.tool('start_task', { key_id: KEY_ID, purpose: 'charge order 1042', minutes: 10 })
    ).structuredContent;
    assert.equal(started.task_id, TASK);
    assert.equal(started.ghost_key, undefined); // only with reveal_key

    const ok = (
      await s.tool('call_api', {
        task_id: TASK,
        method: 'POST',
        path: '/v1/payment_intents',
        query: { expand: 'customer' },
        body: 'amount=500&currency=usd',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
    ).structuredContent;
    assert.equal(ok.status, 200);
    assert.equal(ok.body.echoed_key, '[task key]'); // the answer never repeats the key
    assert.equal(ok.body.query, 'expand=customer');
    assert.equal(ok.body.body, 'amount=500&currency=usd');

    const refused = (await s.tool('call_api', { task_id: TASK, method: 'POST', path: '/v1/refunds' }))
      .structuredContent;
    assert.equal(refused.status, 403);
    assert.match(refused.refused_by_vallkey, /not allowed/);

    // The key goes only to the Vallkey address.
    assert.equal(
      (await s.tool('call_api', { task_id: TASK, path: 'https://evil.example/v1/x' })).isError,
      true,
    );
    assert.equal((await s.tool('call_api', { task_id: TASK, path: '/\\evil.example/v1/x' })).isError, true);
    assert.equal(
      seen.some((c) => c.url.includes('evil')),
      false,
    );

    assert.equal((await s.tool('end_task', { task_id: TASK })).structuredContent.ended, true);
    assert.equal((await s.tool('call_api', { task_id: TASK, path: '/v1/payment_intents' })).isError, true); // gone from this session
    const revealed = (
      await s.tool('start_task', { key_id: KEY_ID, purpose: 'run a script', reveal_key: true })
    ).structuredContent;
    assert.equal(revealed.ghost_key, TASK_GHOST);
    s.close();
  });
});
