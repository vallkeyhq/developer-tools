import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http';
import type { RequestOptions as HttpsOptions } from 'node:https';
type Protocol = 'http:' | 'https:';
type Target = { protocol: string; hostname: string; port: string; host: string };
type NodeCallback = (response: IncomingMessage) => void;
type NodeArguments = [string | URL | RequestOptions, (RequestOptions | NodeCallback)?, NodeCallback?];
type RuntimeGlobal = typeof globalThis & { [key: symbol]: boolean | undefined };

const GHOST = /gk_[a-z]{2,20}_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}/;
const INSTALLED = Symbol.for('vallkey.auto');

const env = (name: string) => (typeof process !== 'undefined' && process.env ? process.env[name] : undefined);

let configuredTarget: Target | undefined;
function target() {
  if (configuredTarget) return configuredTarget;
  let url;
  try {
    url = new URL(env('VALLKEY_API') || 'https://api.vallkey.com');
  } catch {
    throw new Error('Vallkey: VALLKEY_API must be an HTTPS origin.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Vallkey: VALLKEY_API must be an HTTPS origin without credentials, path, query or fragment (HTTP is allowed for loopback tests).',
    );
  }
  configuredTarget = { protocol: url.protocol, hostname: url.hostname, port: url.port, host: url.host };
  return configuredTarget;
}

// Keep platform precedence consistent across runtime hooks.
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

let hookHeader: string | undefined;
function hookValue() {
  if (hookHeader !== undefined) return hookHeader;
  const bun = typeof process !== 'undefined' && process.versions && process.versions.bun;
  const node = typeof process !== 'undefined' && process.versions && process.versions.node;
  let version = '0';
  try {
    version = require('../../package.json').version;
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

function log(from: string, to: string) {
  if (env('VALLKEY_DEBUG') === '1') console.error(`[vallkey] ${new URL(from).origin} → ${to}`);
}

// A ghost key in a header value, including inside Basic credentials.
function inValue(value: unknown) {
  if (value === undefined || value === null) return false;
  const text = Array.isArray(value) ? value.join(',') : String(value);
  if (GHOST.test(text)) return true;
  const basic = /^\s*basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(text);
  if (!basic) return false;
  try {
    return GHOST.test(
      typeof atob === 'function' ? atob(basic[1]) : Buffer.from(basic[1], 'base64').toString('latin1'),
    );
  } catch {
    return false;
  }
}

function hasGhost(url: { search: string } | null, headers?: unknown, body?: unknown) {
  if (headers) {
    if (headers instanceof Headers) {
      let found = false;
      headers.forEach((v) => (found = found || inValue(v)));
      if (found) return true;
    } else if (Array.isArray(headers)) {
      // [[name, value], ...] or Node's raw [name, value, name, value]
      if (headers.some((h) => (Array.isArray(h) ? inValue(h[1]) : inValue(h)))) return true;
    } else {
      for (const k of Object.keys(headers)) if (inValue((headers as Record<string, unknown>)[k])) return true;
    }
  }
  // URLSearchParams tolerates malformed percent escapes; one bad query value must
  // never prevent inspection of another credential or the headers above.
  if (
    url &&
    (GHOST.test(url.search) || [...new URLSearchParams(url.search).values()].some((v) => GHOST.test(v)))
  )
    return true;
  if (typeof body === 'string') return GHOST.test(body);
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams)
    return [...body.values()].some((v) => GHOST.test(v));
  if (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) {
    const bytes = ArrayBuffer.isView(body)
      ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
      : new Uint8Array(body);
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

const isVallkey = (hostname: string, port: string | number | null, protocol: string) => {
  const t = target();
  return (
    protocol === t.protocol &&
    hostname === t.hostname &&
    String(port || (protocol === 'https:' ? 443 : 80)) ===
      String(t.port || (t.protocol === 'https:' ? 443 : 80))
  );
};

function decodeCredential(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/%([a-f0-9]{2})/gi, (_match: string, byte: string) =>
      String.fromCharCode(parseInt(byte, 16)),
    );
  }
}

// Inspect a clone, never consume the caller's Request. Bound both memory and
// latency: streaming/body-only credentials beyond this window need an explicit
// gateway address. Header/query credentials never need body inspection.
async function requestHasGhost(request: Request) {
  if (!request.body || request.bodyUsed || request.signal.aborted) return false;
  const length = request.headers.get('content-length');
  if (length && Number(length) > 65536) return false;
  const reader = request.clone().body!.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), 200);
  });
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

function patchFetch() {
  const original = globalThis.fetch;
  if (typeof original !== 'function') return;
  const patched = async function fetch(
    this: typeof globalThis,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) {
    let protectedRequest = false;
    try {
      const isRequest = typeof Request !== 'undefined' && input instanceof Request;
      const url = new URL(isRequest ? input.url : String(input instanceof URL ? input.href : input));
      if (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        !isVallkey(url.hostname, url.port, url.protocol)
      ) {
        const headers =
          init && init.headers !== undefined ? init.headers : isRequest ? input.headers : undefined;
        // init.headers replaces Request headers; discarded headers must not cause routing.
        if (
          hasGhost(url, headers, init && init.body) ||
          (isRequest && init?.body == null && (await requestHasGhost(input)))
        ) {
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
          return original.call(this, url, {
            ...init,
            headers: { 'x-vallkey-host': host, 'x-vallkey-hook': hookValue() },
          });
        }
      }
    } catch {
      if (protectedRequest)
        return Promise.reject(
          new Error(
            'Vallkey: could not route a protected request. Nothing was sent directly to the provider.',
          ),
        );
    }
    return original.call(this, input, init);
  };
  globalThis.fetch = patched;
}

function patchNode() {
  if (
    typeof process === 'undefined' ||
    !process.versions ||
    !process.versions.node ||
    typeof require !== 'function'
  )
    return;
  let http: typeof import('node:http');
  let https: typeof import('node:https');
  try {
    http = require('node:http');
    https = require('node:https');
  } catch {
    return;
  }
  const originals = {
    'http:': { request: http.request, mod: http },
    'https:': { request: https.request, mod: https },
  };

  // (url, options, cb) | (url, cb) | (options, cb), as http.request takes them.
  function split(args: NodeArguments) {
    let url: URL | null = null;
    let options: RequestOptions = {};
    let cb: NodeCallback | undefined;
    let i = 0;
    if (typeof args[0] === 'string' || args[0] instanceof URL) url = new URL(String(args[i++]));
    if (args[i] && typeof args[i] === 'object') options = args[i++] as RequestOptions;
    if (typeof args[i] === 'function') cb = args[i] as NodeCallback;
    return { url, options, cb };
  }

  function make(defaultProtocol: Protocol) {
    return function request(...args: NodeArguments): ClientRequest {
      let protectedRequest = false;
      try {
        const { url, options, cb } = split(args);
        const protocol = options.protocol || (url && url.protocol) || defaultProtocol;
        const hostname =
          options.hostname ||
          (url && url.hostname) ||
          (options.host ? String(options.host).replace(/:\d+$/, '') : 'localhost');
        const port =
          options.port ??
          (url && url.port) ??
          (options.host && /:(\d+)$/.exec(String(options.host))?.[1]) ??
          '';
        const path = options.path ?? (url ? url.pathname + url.search : '/');
        const search = path.includes('?') ? new URL(path, 'http://x').search : '';
        // Basic credentials can also come as Node's auth option ("user:pass", as axios and
        // superagent send them) or inside the address.
        const credentials =
          options.auth ||
          (url && (url.username || url.password)
            ? `${decodeCredential(url.username)}:${decodeCredential(url.password)}`
            : '');
        if (
          !isVallkey(hostname, port, protocol) &&
          (hasGhost({ search }, options.headers) || GHOST.test(String(credentials)))
        ) {
          protectedRequest = true;
          const t = target();
          const raw = options.headers || {};
          const pairs = Array.isArray(raw)
            ? raw.reduce((list, v, n) => (n % 2 ? list : [...list, [v, raw[n + 1]]]), [])
            : Object.entries(raw);
          const headers: IncomingHttpHeaders = {};
          for (const [k, v] of pairs) if (String(k).toLowerCase() !== 'host') headers[k] = v;
          headers.host = t.host;
          headers['x-vallkey-host'] =
            `${hostname}${port && String(port) !== (protocol === 'https:' ? '443' : '80') ? `:${port}` : ''}`;
          headers['x-vallkey-hook'] = hookValue();
          const next: HttpsOptions = {
            ...options,
            protocol: t.protocol,
            hostname: t.hostname,
            port: t.port || undefined,
            path,
            headers,
            servername: t.hostname,
          };
          delete next.host;
          if (t.protocol !== protocol) delete next.agent; // an https agent cannot carry http, and the other way round
          if (url) {
            if (url.username || url.password)
              next.auth = next.auth || `${decodeCredential(url.username)}:${decodeCredential(url.password)}`;
          }
          log(
            `${protocol}//${hostname}${port && String(port) !== (protocol === 'https:' ? '443' : '80') ? `:${port}` : ''}${path.split('?')[0]}`,
            `${t.protocol}//${t.host}`,
          );
          const o = originals[t.protocol === 'http:' ? 'http:' : 'https:'];
          const send = o.request as (options: RequestOptions, callback?: NodeCallback) => ClientRequest;
          return send.call(o.mod, next, cb);
        }
      } catch {
        if (protectedRequest)
          throw new Error(
            'Vallkey: could not route a protected request. Nothing was sent directly to the provider.',
          );
      }
      const original = originals[defaultProtocol].request as (...args: NodeArguments) => ClientRequest;
      return original.apply(originals[defaultProtocol].mod, args);
    };
  }

  for (const [protocol, mod] of [
    ['http:', http],
    ['https:', https],
  ] as const) {
    const request = make(protocol);
    mod.request = request;
    // get() calls the module's own request, not the exported one, so it is replaced too.
    mod.get = function get(...args: NodeArguments) {
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

if (!(globalThis as RuntimeGlobal)[INSTALLED] && env('VALLKEY_AUTO') !== '0') {
  target(); // Invalid configuration must fail at startup, never silently disable routing.
  (globalThis as RuntimeGlobal)[INSTALLED] = true;
  patchFetch();
  patchNode();
}
