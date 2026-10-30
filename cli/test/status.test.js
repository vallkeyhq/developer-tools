import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { placeName } from '../src/commands/status.js';

const BIN = new URL('../bin/vallkey.js', import.meta.url).pathname;
const NOW = Date.now();
const CLOCK = new URL('../test-support/frozen-clock.cjs', import.meta.url).pathname;
const KEY = (n) => `key${n}`.padEnd(22, 'x');
const PLACES = {
  [KEY(1)]: [
    { id: 'hook:node:vercel:production', how: 'hook', lang: 'node', runtime: '22.23.2', platform: 'vercel', env: 'production', lastAt: NOW - 12_000, today: 14203, deniedToday: 0, failedToday: 0, status: 'ok' },
    { id: 'hook:python:aws-lambda:', how: 'hook', lang: 'python', runtime: '3.13.15', platform: 'aws-lambda', lastAt: NOW - 180_000, today: 1880, deniedToday: 4, failedToday: 0, status: 'blocked' },
  ],
  [KEY(2)]: [{ id: 'sdk:curl:', how: 'direct', sdk: 'curl', lastAt: NOW - 60_000, today: 3, deniedToday: 0, failedToday: 2, lastFailed: { at: NOW - 60_000, status: 401 }, status: 'failing' }],
  [KEY(3)]: [],
};

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--require', CLOCK, BIN, ...args], { env: { PATH: process.env.PATH, NO_COLOR: '1', VALLKEY_TEST_NOW: String(NOW), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stdin.end('');
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

describe('vallkey status', () => {
  let server;
  let env;
  before(async () => {
    server = createServer((req, res) => {
      const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.headers.authorization !== 'Bearer vk_test') return send(401, { error: { message: 'no' } });
      if (req.url === '/_guard/v1/keys') return send(200, { keys: [1, 2, 3].map((n) => ({ keyId: KEY(n), provider: ['openai', 'stripe', 'resend'][n - 1], label: `key ${n}`, createdAt: 0, killedAt: null })) });
      const m = /^\/_guard\/v1\/keys\/([\w-]{22})\/places$/.exec(req.url);
      if (m) return send(200, { places: PLACES[m[1]] });
      send(404, { error: { message: 'no such endpoint' } });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    env = { VALLKEY_TOKEN: 'vk_test', VALLKEY_API: `http://127.0.0.1:${server.address().port}` };
  });
  after(() => server.close());

  it('names places by platform, language and environment, or by SDK and network', () => {
    assert.equal(placeName(PLACES[KEY(1)][0]), 'Vercel · Node.js 22.23 · production');
    assert.equal(placeName({ how: 'direct', sdk: 'OpenAI/Python', network: 'AWS' }), 'OpenAI/Python · AWS');
  });

  it('lists every place each key is used from, and fails when one is failing', async () => {
    const r = await run(['status'], env);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /● Vercel · Node\.js 22\.23 · production\s+12 s ago\s+14,203 today\s+ok/);
    assert.match(r.stdout, /! AWS Lambda · Python 3\.13\s+3 min ago\s+1,880 today\s+4 blocked by the rules today/);
    assert.match(r.stdout, /✗ curl\s+1 min ago\s+3 today\s+failing at the provider \(2 today, last 401\)/);
    assert.match(r.stdout, /No requests yet[\s\S]*key 3/);
  });

  it('shows one key, and succeeds when nothing is failing', async () => {
    const r = await run(['status', KEY(1)], env);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout, /curl/);
    const json = await run(['status', KEY(1), '--json'], env);
    assert.equal(JSON.parse(json.stdout)[0].places.length, 2);
  });
});
