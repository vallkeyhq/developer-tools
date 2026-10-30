import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../demo.ts', import.meta.url));
function run(api: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      env: { PATH: process.env.PATH, STRIPE_GHOST_KEY: 'gk_stripe_fixture', VALLKEY_API: api },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('the example makes one read request and does not print customer data', async (t) => {
  const seen: { method: string | undefined; path: string | undefined; auth: string | undefined }[] = [];
  let fail = false;
  const server = createServer((req, res) => {
    seen.push({ method: req.method, path: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (fail) {
      res
        .writeHead(403)
        .end(JSON.stringify({ error: { message: 'private-upstream-detail', type: 'permission_error' } }));
    } else {
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'cus_fixture', email: 'private-customer@example.com' }],
          has_more: false,
          url: '/v1/customers',
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const api = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const success = await run(api);
  assert.equal(success.code, 0, success.stderr);
  assert.deepEqual(seen, [
    { method: 'GET', path: '/v1/customers?limit=1', auth: 'Bearer gk_stripe_fixture' },
  ]);
  assert.match(success.stdout, /Returned 1 customer/);
  assert.doesNotMatch(success.stdout + success.stderr, /cus_fixture|private-customer|gk_stripe_fixture/);
  fail = true;
  const denied = await run(api);
  assert.equal(denied.code, 1);
  assert.doesNotMatch(denied.stdout + denied.stderr, /private-upstream-detail/);
  assert.equal(seen.length, 2);
});

test('invalid gateway configuration fails without including its value in logs', async () => {
  for (const api of [
    'http://example.com',
    'https://user:private-value@example.com',
    'invalid-private-value',
  ]) {
    const result = await run(api);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /private-value/);
  }
});
