import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

const AUTO = new URL('../src/auto.cjs', import.meta.url).pathname;
// Shaped like a ghost key, put together at run time.
const GHOST = ['gk', 'openai', 'A1b2C3d4E5f6G7h8I9j0Kl', 'M1n2O3p4Q5r6S7t8U9v0Wx1Y2z3A4b5C6d7E8f9G0hI'].join('_');

function serve(name, seen) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ server: name, method: req.method, path: req.url, host: req.headers.host, auth: req.headers.authorization ?? null, from: req.headers['x-vallkey-host'] ?? null, hook: req.headers['x-vallkey-hook'] ?? null, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ from: name }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function node(script, env, { esm = false } = {}) {
  return new Promise((resolve) => {
    const args = ['-r', AUTO, ...(esm ? ['--input-type=module'] : []), '-e', script];
    const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out: out.trim(), err }));
  });
}

describe('vallkey/auto', () => {
  const seen = [];
  let vallkey;
  let provider;
  let env;
  let providerUrl;

  before(async () => {
    vallkey = await serve('vallkey', seen);
    provider = await serve('provider', seen);
    env = { VALLKEY_API: `http://127.0.0.1:${vallkey.address().port}`, GHOST };
    providerUrl = `http://127.0.0.1:${provider.address().port}`;
  });
  after(() => {
    vallkey.close();
    provider.close();
  });

  const last = () => seen.at(-1);

  it('sends fetch requests with a ghost key to Vallkey, keeping path and query', async () => {
    const r = await node(`fetch('https://api.openai.com/v1/models?limit=2', { headers: { authorization: 'Bearer ' + process.env.GHOST } }).then(r => r.json()).then(j => console.log(j.from))`, env);
    assert.equal(r.out, 'vallkey', r.err);
    assert.deepEqual([last().path, last().host, last().auth, last().from], ['/v1/models?limit=2', `127.0.0.1:${vallkey.address().port}`, `Bearer ${GHOST}`, 'api.openai.com']);
  });

  it('says what sent the request: the hook, the runtime, the platform and VALLKEY_ENV', async () => {
    const r = await node(`fetch('https://api.openai.com/v1/models', { headers: { authorization: 'Bearer ' + process.env.GHOST } }).then(r => r.json()).then(j => console.log(j.from))`, { ...env, RENDER: 'true', VALLKEY_ENV: 'staging' });
    assert.equal(r.out, 'vallkey', r.err);
    const version = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
    assert.equal(last().hook, `node/${version}; runtime=${process.versions.node}; platform=render; env=staging`);
    // A name that is not a plain word is left out.
    await node(`fetch('https://api.openai.com/v1/models', { headers: { authorization: 'Bearer ' + process.env.GHOST } }).then(r => r.text())`, { ...env, VALLKEY_ENV: 'a b' });
    assert.doesNotMatch(last().hook, /env=/);
  });

  it('leaves requests without a ghost key alone', async () => {
    const r = await node(`fetch('${providerUrl}/v1/x', { headers: { authorization: 'Bearer sk-real' } }).then(r => r.json()).then(j => console.log(j.from))`, env);
    assert.equal(r.out, 'provider', r.err);
  });

  it('handles Request objects with a body, keys in x-api-key and keys in the query', async () => {
    const r = await node(
      `(async () => {
        const a = await fetch(new Request('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': process.env.GHOST, 'content-type': 'application/json' }, body: '{"model":"m"}' }));
        const b = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + process.env.GHOST);
        console.log((await a.json()).from, (await b.json()).from);
      })()`,
      env,
    );
    assert.equal(r.out, 'vallkey vallkey', r.err);
    const [a, b] = seen.slice(-2);
    assert.deepEqual([a.method, a.path, a.body, a.from], ['POST', '/v1/messages', '{"model":"m"}', 'api.anthropic.com']);
    assert.equal(b.from, 'generativelanguage.googleapis.com');
    assert.ok(b.path.startsWith('/v1beta/models?key=gk_'));
  });

  it('sends https.request and https.get with a ghost key to Vallkey, even in Basic credentials', async () => {
    const r = await node(
      `const https = require('https');
      const done = (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => console.log(JSON.parse(d).from)); };
      const req = https.request({ hostname: 'api.stripe.com', path: '/v1/customers', method: 'POST', headers: { Authorization: 'Bearer ' + process.env.GHOST, Host: 'api.stripe.com' } }, done);
      req.end('email=a%40b.c');
      https.get('https://api.twilio.com/2010-04-01/Accounts.json', { auth: 'AC1:' + process.env.GHOST, headers: { authorization: 'Basic ' + Buffer.from('AC1:' + process.env.GHOST).toString('base64') } }, done);`,
      env,
    );
    assert.equal(r.out, 'vallkey\nvallkey', r.err);
    const stripe = seen.find((s) => s.path === '/v1/customers');
    assert.deepEqual([stripe.method, stripe.host, stripe.body, stripe.from], ['POST', `127.0.0.1:${vallkey.address().port}`, 'email=a%40b.c', 'api.stripe.com']);
    assert.ok(seen.some((s) => s.path === '/2010-04-01/Accounts.json'));
  });

  it('sends Basic credentials given only as the auth option to Vallkey (axios, superagent)', async () => {
    const r = await node(
      `require('https').get('https://api.razorpay.com/v1/payments', { auth: 'rzp_live_1:' + process.env.GHOST }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => console.log(JSON.parse(d).from)); });`,
      env,
    );
    assert.equal(r.out, 'vallkey', r.err);
    const sent = seen.find((s) => s.path === '/v1/payments');
    assert.equal(sent.auth, 'Basic ' + Buffer.from('rzp_live_1:' + GHOST).toString('base64'));
  });

  it('leaves http requests without a ghost key alone', async () => {
    const r = await node(`require('http').get('${providerUrl}/plain', (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => console.log(JSON.parse(d).from)); })`, env);
    assert.equal(r.out, 'provider', r.err);
  });

  it('works for ES module imports of node:https', async () => {
    const r = await node(
      `import { request } from 'node:https';
      const req = request('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.GHOST } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => console.log(JSON.parse(d).from)); });
      req.end('{}');`,
      env,
      { esm: true },
    );
    assert.equal(r.out, 'vallkey', r.err);
  });

  it('can be turned off, and says what it does when asked', async () => {
    const off = await node(`fetch('${providerUrl}/x', { headers: { authorization: 'Bearer ' + process.env.GHOST } }).then(r => r.json()).then(j => console.log(j.from))`, { ...env, VALLKEY_AUTO: '0' });
    assert.equal(off.out, 'provider', off.err);
    const loud = await node(`fetch('https://api.openai.com/v1/models', { headers: { authorization: 'Bearer ' + process.env.GHOST } }).then(r => r.json()).then(j => console.log(j.from))`, { ...env, VALLKEY_DEBUG: '1' });
    assert.match(loud.err, /\[vallkey\] https:\/\/api\.openai\.com → http:\/\/127\.0\.0\.1:\d+/);
    assert.ok(!loud.err.includes(GHOST), 'never logs the key');
  });

  it('routes malformed queries with header credentials and encoded query credentials', async () => {
    const r = await node(`(async () => {
      for (const url of ['${providerUrl}/bad?q=%ZZ', '${providerUrl}/bad?q=%ZZ&key=' + process.env.GHOST.replace('g', '%67')]) {
        const r = await fetch(url, {headers: {authorization: 'Bearer ' + process.env.GHOST}}); console.log((await r.json()).from);
      }
      require('http').get('${providerUrl}/bad?q=%ZZ', {headers: {authorization: 'Bearer ' + process.env.GHOST}}, r => {let s='';r.on('data', c=>s+=c);r.on('end',()=>console.log(JSON.parse(s).from));});
    })()`, env);
    assert.equal(r.out, 'vallkey\nvallkey\nvallkey', r.err);
  });

  it('routes form, byte and small Request body credentials without consuming the body', async () => {
    const r = await node(`(async () => {
      const bodies = [new URLSearchParams({key:process.env.GHOST}), Buffer.from(JSON.stringify({key:process.env.GHOST}))];
      for (const body of bodies) console.log((await (await fetch('${providerUrl}/body', {method:'POST',body})).json()).from);
      const req = new Request('${providerUrl}/body', {method:'POST',body:JSON.stringify({key:process.env.GHOST})});
      console.log((await (await fetch(req)).json()).from);
    })()`, env);
    assert.equal(r.out, 'vallkey\nvallkey\nvallkey', r.err);
    assert.ok(seen.slice(-3).every((s) => s.body.includes(GHOST)));
  });

  it('uses effective replacement headers and leaves unrelated Request bodies intact', async () => {
    const r = await node(`(async () => {
      const req = new Request('${providerUrl}/plain', {method:'POST',headers:{authorization:'Bearer '+process.env.GHOST},body:'ordinary payload'});
      console.log((await (await fetch(req, {headers:{'content-type':'text/plain'}})).json()).from);
    })()`, env);
    assert.equal(r.out, 'provider', r.err);
    assert.equal(last().body, 'ordinary payload');
    assert.equal(last().auth, null);
  });

  it('rejects invalid gateway configuration at startup without printing it', async () => {
    for (const api of ['ftp://example.com', 'https://user:private-value@example.com', 'https://example.com/path', 'http://example.com']) {
      const r = await node(`console.log('started')`, {...env,VALLKEY_API:api});
      assert.notEqual(r.code, 0);
      assert.match(r.err, /VALLKEY_API must be/);
      assert.doesNotMatch(r.err, /private-value/);
      assert.equal(r.out, '');
    }
  });

  it('never falls back to the provider after a recognized request fails during dispatch', async () => {
    const r = await node(`
      let calls=0;
      globalThis.fetch=()=>{calls++;throw new Error('private transport detail');};
      delete globalThis[Symbol.for('vallkey.auto')];
      delete require.cache[${JSON.stringify(AUTO)}];
      require(${JSON.stringify(AUTO)});
      fetch('${providerUrl}/x',{headers:{authorization:'Bearer '+process.env.GHOST}}).catch(e=>console.log(calls,e.message));
    `, env);
    assert.match(r.out, /^1 Vallkey: could not route a protected request/);
    assert.doesNotMatch(r.out + r.err, /private transport detail/);
  });

  it('does not log credential-shaped paths', async () => {
    const r = await node(`fetch('${providerUrl}/' + process.env.GHOST, {headers:{authorization:'Bearer '+process.env.GHOST}}).then(r=>r.text())`, {...env,VALLKEY_DEBUG:'1'});
    assert.equal(r.code, 0, r.err);
    assert.ok(!r.err.includes(GHOST));
  });

  it('preserves http.request option overrides and avoids rewriting existing gateway requests', async () => {
    const r = await node(`(async () => {
      await new Promise(resolve=>{
        require('http').get('${providerUrl}/original',{path:'/overridden?x=1',headers:{authorization:'Bearer '+process.env.GHOST}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>{console.log(JSON.parse(s).from);resolve();});});
      });
      console.log((await (await fetch(process.env.VALLKEY_API+'/direct',{headers:{authorization:'Bearer '+process.env.GHOST}})).json()).from);
    })()`, env);
    assert.equal(r.out, 'vallkey\nvallkey', r.err);
    assert.equal(seen.at(-2).path, '/overridden?x=1');
    assert.equal(last().from, null);
  });

  it('preserves cancellation and streaming request bodies when headers identify the credential', async () => {
    const r = await node(`(async () => {
      const stream = new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('stream payload'));c.close();}});
      console.log((await (await fetch('${providerUrl}/stream', {method:'POST',headers:{authorization:'Bearer '+process.env.GHOST},body:stream,duplex:'half'})).json()).from);
      const controller=new AbortController();controller.abort();
      try {await fetch('${providerUrl}/aborted',{headers:{authorization:'Bearer '+process.env.GHOST},signal:controller.signal});} catch(e) {console.log(e.name);}
    })()`, env);
    assert.equal(r.out, 'vallkey\nAbortError', r.err);
    assert.equal(last().body, 'stream payload');
  });
});
