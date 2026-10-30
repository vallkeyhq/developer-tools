import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { resolveAuth } from '../src/config.js';
import { call } from '../src/api.js';
import session from '../src/session.cjs';

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('saved credentials remain bound to the saved API origin', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vallkey-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const names = ['VALLKEY_CONFIG', 'VALLKEY_API', 'VALLKEY_TOKEN'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => { for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });
  process.env.VALLKEY_CONFIG = join(dir, 'config.json');
  delete process.env.VALLKEY_API;
  delete process.env.VALLKEY_TOKEN;
  await writeFile(process.env.VALLKEY_CONFIG, JSON.stringify({ api: 'https://api.vallkey.com', token: 'saved-token' }));
  assert.equal((await resolveAuth()).token, 'saved-token');
  assert.equal((await resolveAuth({ api: 'https://api.vallkey.com/' })).token, 'saved-token');
  process.env.VALLKEY_API = 'https://api-staging.vallkey.com';
  assert.equal((await resolveAuth()).token, null);
  assert.equal((await resolveAuth({ api: 'https://other.example.com' })).token, null);
  process.env.VALLKEY_TOKEN = 'explicit-token';
  assert.equal((await resolveAuth()).token, 'explicit-token');
  for (const api of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path']) {
    await assert.rejects(resolveAuth({ api }), /HTTPS|gateway/);
  }
});

test('management calls and session creation refuse redirects without forwarding credentials or bodies', async (t) => {
  let forwarded = 0;
  const target = await serve(t, (_req, res) => { forwarded++; res.end('{}'); });
  const api = await serve(t, (_req, res) => res.writeHead(307, { location: target }).end());
  await assert.rejects(call({ api, token: 'management-fixture' }, 'POST', '/keys', { real_key: 'synthetic-fixture' }), /Could not reach/);
  await assert.rejects(session.createSessionKey({ api, ghostKey: 'ghost-fixture' }));
  assert.equal(forwarded, 0);
});

test('session creation validates the origin before sending a ghost key', async () => {
  for (const api of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?key=x', 'invalid']) {
    await assert.rejects(session.createSessionKey({ api, ghostKey: 'fixture' }), /origin/);
  }
});

test('session creation sends scoped options and bounds slow requests', async (t) => {
  let body;
  let authorization;
  const api = await serve(t, async (req, res) => {
    authorization = req.headers.authorization;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ session_key: 'session-fixture' }));
  });
  const result = await session.createSessionKey({ api, ghostKey: 'ghost-fixture', user: 123, ttlSeconds: 900, allow: [], models: ['example-model'] });
  assert.equal(result.session_key, 'session-fixture');
  assert.equal(authorization, 'Bearer ghost-fixture');
  assert.deepEqual(body, { user: '123', ttl_seconds: 900, allow: [], models: ['example-model'] });
  const slow = await serve(t, () => {});
  await assert.rejects(session.createSessionKey({ api: slow, ghostKey: 'fixture', timeoutMs: 20 }), { name: 'TimeoutError' });
  await assert.rejects(session.createSessionKey({ api, ghostKey: 'fixture', timeoutMs: 0 }), /timeoutMs/);
});
