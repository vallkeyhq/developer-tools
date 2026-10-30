'use strict';

// require('vallkey/auto'), or start the app with: node -r vallkey/auto app.js
//
// Routes recognized ghost credentials in supported HTTP transports to Vallkey.
// Unrelated requests retain their destination. Covers global fetch and exported
// Node http/https functions; see README.md for body and transport limits.
//
// Each request it sends to Vallkey says in x-vallkey-host which address it was for
// (Vallkey reads it for S3 buckets named in the address), and in x-vallkey-hook what
// sent it: this hook, the runtime, the platform and VALLKEY_ENV, so the dashboard can
// show each place a key is used. Never app names or secrets.
//
// VALLKEY_ENV      a name for this place (production, staging…), shown in the dashboard
// VALLKEY_API      the Vallkey server (default https://api.vallkey.com)
// VALLKEY_AUTO=0   turns it off
// VALLKEY_DEBUG=1  logs each request it sends to Vallkey

const GHOST = /gk_[a-z]{2,20}_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}/;
const INSTALLED = Symbol.for('vallkey.auto');

const env = (name) => (typeof process !== 'undefined' && process.env ? process.env[name] : undefined);

let configuredTarget;
function target() {
  if (configuredTarget) return configuredTarget;
  let url;
  try { url = new URL(env('VALLKEY_API') || 'https://api.vallkey.com'); } catch { throw new Error('Vallkey: VALLKEY_API must be an HTTPS origin.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Vallkey: VALLKEY_API must be an HTTPS origin without credentials, path, query or fragment (HTTP is allowed for loopback tests).');
  }
  configuredTarget = { protocol: url.protocol, hostname: url.hostname, port: url.port, host: url.host };
  return configuredTarget;
}

// The platform, from variables each one sets itself. The same list, in the same order,
// is in every Vallkey hook, so the dashboard names a place the same way in any language.
const PLATFORMS = [
  ['VERCEL', 'vercel'],
  ['AWS_LAMBDA_FUNCTION_NAME', 'aws-lambda'],
  ['ECS_CONTAINER_METADATA_URI_V4', 'aws-ecs'],
  ['ECS_CONTAINER_METADATA_URI', 'aws-ecs'],
  ['FUNCTION_TARGET', 'cloud-functions'],
  ['K_SERVICE', 'cloud-run'],
  ['GAE_APPLICATION', 'app-engine'],
  ['FUNCTIONS_WORKER_RUNTIME', 'azure-functions'],
  ['CONTAINER_APP_NAME', 'azure-container-apps'],
  ['WEBSITE_SITE_NAME', 'azure-app-service'],
  ['RAILWAY_PROJECT_ID', 'railway'],
  ['RENDER', 'render'],
  ['FLY_APP_NAME', 'fly'],
  ['DYNO', 'heroku'],
  ['NETLIFY', 'netlify'],
  ['KOYEB_APP_NAME', 'koyeb'],
  ['GITHUB_ACTIONS', 'github-actions'],
  ['GITLAB_CI', 'gitlab-ci'],
  ['KUBERNETES_SERVICE_HOST', 'kubernetes'],
];

let hookHeader;
function hookValue() {
  if (hookHeader !== undefined) return hookHeader;
  const bun = typeof process !== 'undefined' && process.versions && process.versions.bun;
  const node = typeof process !== 'undefined' && process.versions && process.versions.node;
  let version = '0';
  try {
    version = require('../package.json').version;
  } catch {
    // bundled without its package.json
  }
  const parts = [`${bun ? 'bun' : node ? 'node' : 'js'}/${version}`];
  if (bun || node) parts.push(`runtime=${bun || node}`);
  let platform = (PLATFORMS.find(([name]) => env(name)) || [])[1];
  if (!platform && node) {
    try {
      if (require('node:fs').existsSync('/.dockerenv')) platform = 'docker';
    } catch {
      // no file system (edge runtimes)
    }
  }
  if (platform) parts.push(`platform=${platform}`);
  const place = env('VALLKEY_ENV');
  if (place && /^[A-Za-z0-9._-]{1,40}$/.test(place)) parts.push(`env=${place}`);
  hookHeader = parts.join('; ');
  return hookHeader;
}

function log(from, to) {
  if (env('VALLKEY_DEBUG') === '1') console.error(`[vallkey] ${new URL(from).origin} → ${to}`);
}

// A ghost key in a header value, including inside Basic credentials.
function inValue(value) {
  if (value === undefined || value === null) return false;
  const text = Array.isArray(value) ? value.join(',') : String(value);
  if (GHOST.test(text)) return true;
  const basic = /^\s*basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(text);
  if (!basic) return false;
  try {
    return GHOST.test(typeof atob === 'function' ? atob(basic[1]) : Buffer.from(basic[1], 'base64').toString('latin1'));
  } catch {
    return false;
  }
}

function hasGhost(url, headers, body) {
  if (headers) {
    if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
      let found = false;
      headers.forEach((v) => (found = found || inValue(v)));
      if (found) return true;
    } else if (Array.isArray(headers)) {
      // [[name, value], ...] or Node's raw [name, value, name, value]
      if (headers.some((h) => (Array.isArray(h) ? inValue(h[1]) : inValue(h)))) return true;
    } else {
      for (const k of Object.keys(headers)) if (inValue(headers[k])) return true;
    }
  }
  // URLSearchParams tolerates malformed percent escapes; one bad query value must
  // never prevent inspection of another credential or the headers above.
  if (url && (GHOST.test(url.search) || [...new URLSearchParams(url.search).values()].some((v) => GHOST.test(v)))) return true;
  if (typeof body === 'string') return GHOST.test(body);
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return [...body.values()].some((v) => GHOST.test(v));
  if (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) {
    const bytes = ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : new Uint8Array(body);
    // Inspect existing bytes without a second unbounded allocation.
    let tail = '';
    for (let i = 0; i < bytes.length; i += 4096) {
      const part = tail + new TextDecoder().decode(bytes.subarray(i, i + 4096));
      if (GHOST.test(part)) return true;
      tail = part.slice(-100);
    }
  }
  return false;
}

const isVallkey = (hostname, port, protocol) => {
  const t = target();
  return protocol === t.protocol && hostname === t.hostname && String(port || (protocol === 'https:' ? 443 : 80)) === String(t.port || (t.protocol === 'https:' ? 443 : 80));
};

function decodeCredential(value) {
  try { return decodeURIComponent(value); }
  catch { return value.replace(/%([a-f0-9]{2})/gi, (_, byte) => String.fromCharCode(parseInt(byte, 16))); }
}

// Inspect a clone, never consume the caller's Request. Bound both memory and
// latency: streaming/body-only credentials beyond this window need an explicit
// gateway address. Header/query credentials never need body inspection.
async function requestHasGhost(request) {
  if (!request.body || request.bodyUsed || request.signal.aborted) return false;
  const length = request.headers.get('content-length');
  if (length && Number(length) > 65536) return false;
  const reader = request.clone().body.getReader();
  let timer;
  const expired = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 200); });
  let size = 0;
  let tail = '';
  try {
    while (size <= 65536) {
      const chunk = await Promise.race([reader.read(), expired]);
      if (!chunk || chunk.done) return false;
      size += chunk.value.byteLength;
      if (size > 65536) return false;
      const text = tail + new TextDecoder().decode(chunk.value);
      if (GHOST.test(text)) return true;
      tail = text.slice(-100);
    }
    return false;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

// ---- fetch ----

function patchFetch() {
  const original = globalThis.fetch;
  if (typeof original !== 'function') return;
  const patched = async function fetch(input, init) {
    let protectedRequest = false;
    try {
      const isRequest = typeof Request !== 'undefined' && input instanceof Request;
      const url = new URL(isRequest ? input.url : String(input instanceof URL ? input.href : input));
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !isVallkey(url.hostname, url.port, url.protocol)) {
        const headers = init && init.headers !== undefined ? init.headers : isRequest ? input.headers : undefined;
        // init.headers replaces Request headers; discarded headers must not cause routing.
        if (hasGhost(url, headers, init && init.body) || (isRequest && init?.body == null && await requestHasGhost(input))) {
          protectedRequest = true;
          const t = target();
          const from = url.origin;
          const host = url.host;
          url.protocol = t.protocol;
          url.host = t.host;
          log(`${from}${url.pathname}`, url.origin);
          if (init && init.headers !== undefined) {
            const headers = new Headers(init.headers);
            headers.set('x-vallkey-host', host);
            headers.set('x-vallkey-hook', hookValue());
            return original.call(this, isRequest ? new Request(url, input) : url, { ...init, headers });
          }
          if (isRequest) {
            const moved = new Request(url, input);
            moved.headers.set('x-vallkey-host', host);
            moved.headers.set('x-vallkey-hook', hookValue());
            return original.call(this, moved, init);
          }
          return original.call(this, url, { ...init, headers: { 'x-vallkey-host': host, 'x-vallkey-hook': hookValue() } });
        }
      }
    } catch {
      if (protectedRequest) return Promise.reject(new Error('Vallkey: could not route a protected request. Nothing was sent directly to the provider.'));
    }
    return original.call(this, input, init);
  };
  globalThis.fetch = patched;
}

// ---- http and https ----

function patchNode() {
  if (typeof process === 'undefined' || !process.versions || !process.versions.node || typeof require !== 'function') return;
  let http;
  let https;
  try {
    http = require('node:http');
    https = require('node:https');
  } catch {
    return;
  }
  const originals = { 'http:': { request: http.request, mod: http }, 'https:': { request: https.request, mod: https } };

  // (url, options, cb) | (url, cb) | (options, cb), as http.request takes them.
  function split(args) {
    let url = null;
    let options = {};
    let cb;
    let i = 0;
    if (typeof args[0] === 'string' || args[0] instanceof URL) url = new URL(String(args[i++]));
    if (args[i] && typeof args[i] === 'object') options = args[i++];
    if (typeof args[i] === 'function') cb = args[i];
    return { url, options, cb };
  }

  function make(defaultProtocol) {
    return function request(...args) {
      let protectedRequest = false;
      try {
        const { url, options, cb } = split(args);
        const protocol = options.protocol || (url && url.protocol) || defaultProtocol;
        const hostname = options.hostname || (url && url.hostname) || (options.host ? String(options.host).replace(/:\d+$/, '') : 'localhost');
        const port = options.port ?? (url && url.port) ?? (options.host && /:(\d+)$/.exec(String(options.host))?.[1]) ?? '';
        const path = options.path ?? (url ? url.pathname + url.search : '/');
        const search = path.includes('?') ? new URL(path, 'http://x').search : '';
        // Basic credentials can also come as Node's auth option ("user:pass", as axios and
        // superagent send them) or inside the address.
        const credentials = options.auth || (url && (url.username || url.password) ? `${decodeCredential(url.username)}:${decodeCredential(url.password)}` : '');
        if (!isVallkey(hostname, port, protocol) && (hasGhost({ search }, options.headers) || GHOST.test(String(credentials)))) {
          protectedRequest = true;
          const t = target();
          const raw = options.headers || {};
          const pairs = Array.isArray(raw) ? raw.reduce((list, v, n) => (n % 2 ? list : [...list, [v, raw[n + 1]]]), []) : Object.entries(raw);
          const headers = {};
          for (const [k, v] of pairs) if (String(k).toLowerCase() !== 'host') headers[k] = v;
          headers.host = t.host;
          headers['x-vallkey-host'] = `${hostname}${port && String(port) !== (protocol === 'https:' ? '443' : '80') ? `:${port}` : ''}`;
          headers['x-vallkey-hook'] = hookValue();
          const next = { ...options, protocol: t.protocol, hostname: t.hostname, port: t.port || undefined, path, headers, servername: t.hostname };
          delete next.host;
          if (t.protocol !== protocol) delete next.agent; // an https agent cannot carry http, and the other way round
          if (url) {
            if (url.username || url.password) next.auth = next.auth || `${decodeCredential(url.username)}:${decodeCredential(url.password)}`;
          }
          log(`${protocol}//${hostname}${port && String(port) !== (protocol === 'https:' ? '443' : '80') ? `:${port}` : ''}${path.split('?')[0]}`, `${t.protocol}//${t.host}`);
          const o = originals[t.protocol] || originals['https:'];
          return cb ? o.request.call(o.mod, next, cb) : o.request.call(o.mod, next);
        }
      } catch {
        if (protectedRequest) throw new Error('Vallkey: could not route a protected request. Nothing was sent directly to the provider.');
      }
      return originals[defaultProtocol].request.apply(originals[defaultProtocol].mod, args);
    };
  }

  for (const [protocol, mod] of [
    ['http:', http],
    ['https:', https],
  ]) {
    const request = make(protocol);
    mod.request = request;
    // get() calls the module's own request, not the exported one, so it is replaced too.
    mod.get = function get(...args) {
      const req = request(...args);
      req.end();
      return req;
    };
  }
  try {
    require('node:module').syncBuiltinESMExports(); // so `import { request } from 'node:https'` sees it too
  } catch {
    // older runtimes
  }
}

if (!globalThis[INSTALLED] && env('VALLKEY_AUTO') !== '0') {
  target(); // Invalid configuration must fail at startup, never silently disable routing.
  globalThis[INSTALLED] = true;
  patchFetch();
  patchNode();
}
