import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { call } from '../dist/src/api.js';

const bin = new URL('../dist/bin/vallkey.js', import.meta.url);
interface Reply {
  id: number | null;
  result?: { isError?: boolean; content?: { text: string }[] };
  error?: { code: number };
}
async function rpc(cwd: string, messages: unknown[]): Promise<Reply[]> {
  const child = spawn(process.execPath, [bin.pathname, 'mcp'], {
    cwd,
    env: { PATH: process.env.PATH, VALLKEY_CONFIG: join(cwd, 'missing-config') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`MCP exited ${code}`))));
  });
  child.stdin.end(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
  await done;
  return Buffer.concat(chunks)
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Reply)
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

test('MCP rejects invalid envelopes and empty batches while preserving subsequent requests', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'vallkey-rpc-boundary-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const replies = await rpc(cwd, [
    null,
    [],
    { id: {}, method: 'ping' },
    { jsonrpc: '2.0', id: 7, method: 'ping' },
  ]);
  assert.deepEqual(
    replies.map((reply) => reply.error?.code ?? reply.id),
    [-32600, -32600, -32600, 7],
  );
});

test('MCP rejects existing and new paths escaping through a symlink', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'vallkey-mcp-path-'));
  const outside = await mkdtemp(join(tmpdir(), 'vallkey-mcp-outside-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(cwd, 'linked'), 'dir');
  await mkdir(join(cwd, '..legitimate'));
  const replies = await rpc(cwd, [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'scan_project', arguments: { path: 'linked' } },
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_ghost_key',
        arguments: { real_key_id: 'A'.repeat(22), name: 'EXAMPLE_KEY', file: 'linked/new/.env' },
      },
    },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'scan_project', arguments: { path: '..legitimate' } },
    },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'scan_project', arguments: [] } },
  ]);
  assert.equal(replies[0].result?.isError, true);
  assert.match(replies[0].result?.content?.[0].text ?? '', /outside the project/);
  assert.equal(replies[1].result?.isError, true);
  assert.match(replies[1].result?.content?.[0].text ?? '', /outside the project/);
  assert.notEqual(replies[2].result?.isError, true);
  assert.equal(replies[3].result?.isError, true);
});

test('management calls reject invalid JSON and malformed list responses', async (t) => {
  let response = '{broken';
  const server = createServer((_req, res) => res.end(response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await assert.rejects(call({ api }, 'GET', '/keys'), /invalid JSON/);
  response = 'null';
  await assert.rejects(call({ api }, 'GET', '/keys'), /invalid response/);
  response = '{"keys":{}}';
  await assert.rejects(call({ api }, 'GET', '/keys'), /keys list/);
});
