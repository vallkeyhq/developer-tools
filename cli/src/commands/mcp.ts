import { readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { call, proxyOrigin, VERSION } from '../api.js';
import { resolveAuth } from '../config.js';
import { editEnv, parseEnv } from '../dotenv.js';
import { identify, looksReal } from '../providers.js';
import type {
  Activity,
  AgentInfo,
  ChangeResult,
  CreatedKey,
  CreatedTask,
  KeyDetail,
  KeySummary,
  Provider,
  RealKey,
  Rules,
  Task,
} from '../types.js';
import { mask } from '../ui.js';
import { errorCode, errorMessage, hasStatus, isRecord } from '../validation.cjs';
import { BASE_URL_VARS, projectName, writeKeepingMode } from './init.js';
import { collect, scanFiles } from './scan.js';
type ToolHandler = (args: Record<string, unknown>, root: string) => Promise<unknown>;
interface RpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// JSON-RPC over stdio. Read provider credentials locally; return key IDs to MCP clients.

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const ENV_FILE = /^\.env(\..+)?$/;
const KEY_ID = { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$', description: 'The key id, from list_keys' };

const INSTRUCTIONS = `Vallkey replaces real API keys with ghost keys: stand-in keys that only work within rules the user sets, and that can be killed in one click. Requests go through Vallkey, which checks the rules and swaps in the real key.

Rules for you:
- Never ask the user to paste a real API key into the chat, and do not read .env files to look at keys. To protect a key, call protect_env_key with the file and variable name: it reads the key itself and returns only the key id.
- Ghost keys stay in the same environment variable. For OpenAI, Anthropic and Groq, the base URL variable is added for you. For other SDKs in Node.js, start the app with node -r vallkey/auto (npm install vallkey); in Python, pip install vallkey and set VALLKEY_AUTO=1. Or set the SDK's base URL to the Vallkey API address.
- When a request with a ghost key is refused, call get_activity with outcome "denied" to see the reason.
- Tighter rules apply at once. Looser rules apply only after a safety delay, on purpose; do not try to work around it.
- Kill a key only when the user asks, or when a leak is clear (for example a ghost key committed to a public repository).
- One real key can have many ghost keys (one per app, person, customer or agent). list_real_keys shows the shared ones; create_ghost_key makes another one inside the real key's outer rules and writes it into a .env file.
- For an AI agent that should call APIs on its own, the owner makes an agent token (Settings, API tokens, Agent) and picks the keys it may use. With that token as VALLKEY_TOKEN, this server offers task keys instead: short-lived ghost keys for one task.`;

const TOOLS = [
  {
    name: 'scan_project',
    title: 'Find API keys in the project',
    description:
      'Looks for API keys in the project files and .env files. Keys are shown masked, never in full. Says which ones protect_env_key can turn into ghost keys.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A folder inside the project (default: the project root)' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'protect_env_key',
    title: 'Swap a key in a .env file for a ghost key',
    description:
      "Reads the real API key from a variable in a .env file, stores it encrypted in Vallkey, and writes a ghost key back in its place (in every .env file in the project root that holds the same key). Uses the provider's safe default rules. Returns the key id, never a key.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The variable, such as OPENAI_API_KEY' },
        file: { type: 'string', description: 'The .env file, relative to the project root (default .env)' },
        provider: {
          type: 'string',
          description: 'Only if the key has no recognisable prefix: the provider name from list_providers',
        },
      },
      required: ['name'],
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'list_keys',
    title: 'List ghost keys',
    description: 'Lists the ghost keys in the Vallkey account: id, provider, label and creation date.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'get_key',
    title: 'Show a ghost key',
    description:
      "A ghost key's rules, pending rule changes, status (active, killed, expired) and today's usage.",
    inputSchema: { type: 'object', properties: { key_id: KEY_ID }, required: ['key_id'] },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'get_activity',
    title: 'Show recent requests',
    description:
      'Recent requests made with a ghost key, newest first, with the reason for each refused one. Use it when a request through Vallkey fails.',
    inputSchema: {
      type: 'object',
      properties: {
        key_id: KEY_ID,
        outcome: { type: 'string', enum: ['allowed', 'denied'] },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['key_id'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'list_providers',
    title: 'List providers',
    description: 'The providers Vallkey supports, with their API address and default rules.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'update_rules',
    title: "Change a ghost key's rules",
    description:
      'Changes some of the rules of a ghost key; the others stay as they are. Fields: allow (list of { method, path }), ratePerMinute, dailyRequests, maxAmount and dailyAmount ({ currency: amount in minor units }), allowedModels, dailyTokens, allowedIps, allowedCountries, expiresAt (ms since 1970), autoKill. null removes a limit. Tighter rules apply at once; looser rules apply after a safety delay.',
    inputSchema: {
      type: 'object',
      properties: { key_id: KEY_ID, changes: { type: 'object', description: 'Only the rules to change' } },
      required: ['key_id', 'changes'],
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'list_real_keys',
    title: 'List shared real keys',
    description:
      'Real keys shared by several ghost keys: id, provider, name, a hint of the real key (prefix and last four characters), how many ghost keys use it, and its outer rules, which new ghost keys must stay inside.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'create_ghost_key',
    title: 'Make another ghost key for a shared real key',
    description:
      "Makes a new ghost key for a real key from list_real_keys, for example one per app, customer or agent, and writes it into a variable of a .env file. Its rules must stay inside the real key's outer rules (needs the Team plan). Returns the key id, never a key.",
    inputSchema: {
      type: 'object',
      properties: {
        real_key_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$', description: 'From list_real_keys' },
        name: { type: 'string', description: 'The variable to write it to, such as OPENAI_API_KEY' },
        file: { type: 'string', description: 'The .env file, relative to the project root (default .env)' },
        label: { type: 'string', description: 'A name for the new ghost key, such as "Support agent"' },
        rules: { type: 'object', description: 'Its rules (default: the outer rules themselves)' },
      },
      required: ['real_key_id', 'name'],
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'kill_key',
    title: 'Kill a ghost key',
    description:
      'Stops a ghost key everywhere, right away. Every request with it is refused until a person revives it in the dashboard. Use only when the user asks or a leak is clear.',
    inputSchema: {
      type: 'object',
      properties: { key_id: KEY_ID, reason: { type: 'string', minLength: 3, maxLength: 200 } },
      required: ['key_id', 'reason'],
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
];

// Agent sessions retain task credentials in memory unless explicit disclosure is requested.
const AGENT_INSTRUCTIONS = `You are connected to Vallkey with an agent token. Vallkey lets you use the owner's API keys (Stripe, OpenAI, GitHub and others) without ever seeing them.

How to work:
1. Call what_can_i_do first: it lists the ghost keys you may start tasks from, what each one allows, and how long a task may run.
2. Call start_task with one of those keys, a short purpose ("refund order 1042") and the minutes you need. Ask only for what the task needs: fewer endpoints and lower limits are fine, more than the key allows is refused.
3. Call call_api with the task_id to send requests: the provider's own paths, query, headers and body, exactly as its API documentation says. The key is added for you.
4. If a request is refused, the answer says why; task_activity shows every request and its reason. Do not try to get around a refusal: the owner set those rules.
5. Call end_task when you are done. Task keys also stop on their own when their minutes are up.

Only ask start_task for reveal_key when code you run must hold the key (an SDK or a script): it is still a short-lived ghost key, never the real key. Never put it in files, commits, chat or logs.`;

const TASK_ID = {
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{22}$',
  description: 'The task_id start_task returned',
};

const AGENT_TOOLS = [
  {
    name: 'what_can_i_do',
    title: 'What this agent may do',
    description:
      "Lists the ghost keys this agent may start tasks from, with each one's service and rules, the task limits, and how to work. Call this first.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'start_task',
    title: 'Start a task key',
    description:
      'Makes a short-lived ghost key for one task, from a key what_can_i_do lists. It works only for the minutes asked and never allows more than that key. Returns a task_id to use with call_api; the ghost key itself only with reveal_key.',
    inputSchema: {
      type: 'object',
      properties: {
        key_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$', description: 'A key from what_can_i_do' },
        purpose: {
          type: 'string',
          minLength: 3,
          maxLength: 120,
          description:
            'What the task is for, in a few words, such as "refund order 1042". The owner sees it.',
        },
        minutes: {
          type: 'integer',
          minimum: 1,
          description: 'How long the task key works (default 30, at most what what_can_i_do says)',
        },
        rules: {
          type: 'object',
          description:
            "Optional, tighter rules than the key's own, such as fewer endpoints or a lower maxAmount. Same shape as the rules what_can_i_do shows.",
        },
        reveal_key: {
          type: 'boolean',
          description: 'Also return the ghost key, for code you run. Default false: use call_api instead.',
        },
      },
      required: ['key_id', 'purpose'],
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'call_api',
    title: 'Call an API with a task key',
    description:
      "Sends one request to the provider through Vallkey with the task's key, and returns the provider's answer. Use the provider's own path, query, headers and body. Requests outside the task's rules are refused with the reason.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: TASK_ID,
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          description: 'Default GET',
        },
        path: { type: 'string', description: "The provider's path, such as /v1/payment_intents" },
        query: {
          type: 'object',
          description: 'Query parameters, as name: value',
          additionalProperties: { type: ['string', 'number', 'boolean'] },
        },
        headers: {
          type: 'object',
          description:
            'Extra headers. The key goes in "Authorization: Bearer" unless a header value contains {{ghost_key}}, for APIs that want it elsewhere.',
          additionalProperties: { type: 'string' },
        },
        body: {
          description:
            'A JSON object (sent as JSON) or a string (sent as is, for example form-encoded for Stripe with a content-type header)',
        },
      },
      required: ['task_id', 'path'],
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'task_activity',
    title: 'Requests made with a task key',
    description:
      'Shows the latest requests made with a task key, allowed and refused, with the reason for each refusal.',
    inputSchema: { type: 'object', properties: { task_id: TASK_ID }, required: ['task_id'] },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'list_tasks',
    title: "List this agent's tasks",
    description:
      'Lists the task keys this agent started that still exist: purpose, end time and whether each still works.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'end_task',
    title: 'End a task',
    description: 'Ends a task: its key stops working at once and is deleted. Call it when the task is done.',
    inputSchema: { type: 'object', properties: { task_id: TASK_ID }, required: ['task_id'] },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
];

class ToolError extends Error {}

// A path the agent names must stay inside the project.
async function inside(root: string, path: unknown): Promise<string> {
  if (typeof path !== 'string') throw new ToolError('path must be a string');
  const full = resolve(root, path);
  const canonicalRoot = await realpath(root);
  const lexical = relative(root, full);
  if (
    lexical === '..' ||
    lexical.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(lexical)
  ) {
    throw new ToolError(`${path} is outside the project folder.`);
  }
  // Resolve existing ancestors too: a new file can otherwise escape through a symlinked directory.
  let ancestor = full;
  const missing: string[] = [];
  for (;;) {
    try {
      const canonical = resolve(await realpath(ancestor), ...missing);
      const rel = relative(canonicalRoot, canonical);
      if (
        rel === '..' ||
        rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        isAbsolute(rel)
      ) {
        throw new ToolError(`${path} is outside the project folder.`);
      }
      return canonical;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

async function authed() {
  const auth = await resolveAuth({});
  if (!auth.token)
    throw new ToolError(
      'Not signed in to Vallkey. Ask the user to run this in their own terminal: npx vallkey login',
    );
  return auth;
}

const keyPath = (id: unknown) => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(id))
    throw new ToolError('key_id must be a key id from list_keys');
  return `/keys/${id}`;
};

const handlers: Record<string, ToolHandler> = {
  async scan_project({ path = '.' }, root) {
    const dir = await inside(root, path);
    const files = await collect([dir]);
    const findings = await scanFiles(files, root);
    return {
      files_checked: files.length,
      keys: findings.map((f) => ({
        file: f.file,
        line: f.line,
        variable: f.env
          ? ((/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(f.lineText ?? '') ?? [])[1] ?? null)
          : null,
        kind: f.kind.title,
        key: mask(f.secret),
        committed: f.committed,
        can_protect: Boolean(f.env && f.kind.provider && !f.kind.manual),
      })),
      note: 'Keys in committed code are already exposed: the user should create a new key at the provider and revoke the old one. Keys in .env files can be swapped with protect_env_key.',
    };
  },

  async protect_env_key({ name, file = '.env', provider }, root) {
    if (typeof name !== 'string' || !name) throw new ToolError('name is required, such as OPENAI_API_KEY');
    const path = await inside(root, file);
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      throw new ToolError(`Cannot read ${file}.`);
    }
    const entry = parseEnv(text).entries.find((e) => e.name === name);
    if (!entry || !entry.value) throw new ToolError(`${name} is not set in ${file}.`);
    if (/^gk_[a-z]+_/.test(entry.value))
      return { done: false, message: `${name} in ${file} already holds a ghost key.` };
    const kind = identify(name, entry.value);
    if (kind?.manual)
      throw new ToolError(
        'AWS keys need an endpoint and a service. Ask the user to add this one in the Vallkey dashboard (Keys → New key → AWS).',
      );
    const chosen = provider ?? kind?.provider;
    if (typeof chosen !== 'string' || !chosen) {
      throw new ToolError(
        looksReal(entry.value)
          ? `Could not tell which provider ${name} is for. Call again with provider set (see list_providers).`
          : `${name} does not look like a real API key.`,
      );
    }
    if (kind && provider && kind.provider && kind.provider !== provider)
      throw new ToolError(`${name} looks like a ${kind.title}, not a ${provider} key.`);

    const auth = await authed();
    const { data: catalog } = await call<{ providers: Provider[] }>(auth, 'GET', '/providers');
    if (!catalog.providers.some((p) => p.name === chosen))
      throw new ToolError(`Vallkey does not support "${chosen}". See list_providers.`);
    const { data: created } = await call<CreatedKey>(auth, 'POST', '/keys', {
      provider: chosen,
      real_key: entry.value,
      label: `${name} · ${await projectName(root)}`.slice(0, 100),
    });

    // Apps call the account's default own API domain when it has one.
    const origin = await proxyOrigin(auth);
    // The same real key in other .env files at the root is swapped too, so it is gone everywhere.
    const targets = new Set([path]);
    for (const e of await readdir(root, { withFileTypes: true }))
      if (e.isFile() && ENV_FILE.test(e.name)) targets.add(join(root, e.name));
    const changed = [];
    const added = [];
    for (const target of targets) {
      const parsed = parseEnv(await readFile(target, 'utf8'));
      const replace = parsed.entries
        .filter((e) => e.value === entry.value)
        .map((e) => [e, created.ghost_key] as const);
      if (!replace.length) continue;
      const base = BASE_URL_VARS[chosen];
      const append =
        base && !parsed.entries.some((e) => e.name === base.name)
          ? ['# Sends SDK traffic through Vallkey (added by vallkey)', `${base.name}=${origin}${base.path}`]
          : [];
      await writeKeepingMode(target, editEnv(parsed, replace, append));
      changed.push(relative(root, target));
      if (append.length) added.push(`${base.name} in ${relative(root, target)}`);
    }
    return {
      done: true,
      key_id: created.key_id,
      provider: chosen,
      files_changed: changed,
      added,
      message: `${name} now holds a ghost key. The real key is stored encrypted in Vallkey and is no longer in ${changed.join(', ')}. Restart the app so it reads the new value.`,
      next: BASE_URL_VARS[chosen]
        ? 'The official SDK reads the base URL variable that was added, so no code change is needed.'
        : 'Point the SDK at Vallkey: in Node.js start the app with node -r vallkey/auto (after npm install vallkey), in Python set VALLKEY_AUTO=1 (after pip install vallkey), or set the SDK base URL to ' +
          auth.api,
    };
  },

  async list_keys() {
    const { data } = await call<{ keys: KeySummary[] }>(await authed(), 'GET', '/keys');
    return {
      keys: data.keys.map((k) => ({
        key_id: k.keyId,
        provider: k.provider,
        label: k.label,
        created: new Date(k.createdAt).toISOString(),
      })),
    };
  },

  async get_key({ key_id }) {
    const { data } = await call<KeyDetail>(await authed(), 'GET', keyPath(key_id));
    return data;
  },

  async get_activity({ key_id, outcome, limit = 20 }) {
    const params = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, Number(limit) || 20))) });
    if (outcome === 'allowed' || outcome === 'denied') params.set('outcome', outcome);
    const { data } = await call<{ activity: Activity[] }>(
      await authed(),
      'GET',
      `${keyPath(key_id)}/activity?${params}`,
    );
    return {
      requests: data.activity.map((a) => ({
        at: new Date(a.at).toISOString(),
        method: a.method,
        path: a.path,
        outcome: a.outcome,
        reason: a.reason,
        status: a.status,
        country: a.country,
        ip: a.ip,
      })),
    };
  },

  async list_providers() {
    const { data } = await call<{ providers: Provider[] }>(await authed(), 'GET', '/providers');
    return {
      providers: data.providers.map((p) => ({
        name: p.name,
        title: p.title,
        origin: p.origin,
        default_rules: p.default_rules,
      })),
    };
  },

  async update_rules({ key_id, changes }) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes))
      throw new ToolError('changes must be an object with the rules to change');
    const auth = await authed();
    const { data: key } = await call<KeyDetail>(auth, 'GET', keyPath(key_id));
    const base = key.pending?.rules ?? key.rules;
    const { data } = await call<ChangeResult>(auth, 'PUT', `${keyPath(key_id)}/rules`, {
      rules: { ...base, ...changes },
    });
    return data.applied === 'now'
      ? { applied: 'now', message: 'The new rules apply now.' }
      : {
          applied: 'scheduled',
          activates_at: new Date(data.activatesAt).toISOString(),
          message:
            'These rules are looser, so they apply after the safety delay. The account owner was alerted.',
        };
  },

  async list_real_keys() {
    const { data } = await call<{ real_keys: RealKey[] }>(await authed(), 'GET', '/real-keys');
    return {
      real_keys: data.real_keys.map((r) => ({
        real_key_id: r.real_key_id,
        provider: r.provider,
        name: r.label,
        hint: r.hint,
        ghost_keys: r.ghost_keys.length + r.hidden_ghost_keys,
        outer_rules: r.outer_rules,
      })),
    };
  },

  async create_ghost_key({ real_key_id, name, file = '.env', label, rules }, root) {
    if (typeof real_key_id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(real_key_id))
      throw new ToolError('real_key_id must be an id from list_real_keys');
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name))
      throw new ToolError('name must be a variable name, such as OPENAI_API_KEY');
    const path = await inside(root, file);
    let text = '';
    try {
      text = await readFile(path, 'utf8');
    } catch {
      // A new .env file is made below.
    }
    const parsed = parseEnv(text);
    const existing = parsed.entries.find((e) => e.name === name);
    // Never write over a real key: that one should be protected instead.
    if (existing?.value && !/^gk_[a-z0-9-]+_/.test(existing.value))
      throw new ToolError(
        `${name} in ${file} holds a real key. Protect it with protect_env_key instead, or choose another variable.`,
      );
    const auth = await authed();
    const body: { label: string; rules?: Rules } = {
      label:
        typeof label === 'string'
          ? label.slice(0, 100)
          : `${name} · ${await projectName(root)}`.slice(0, 100),
    };
    if (rules && typeof rules === 'object' && !Array.isArray(rules)) body.rules = rules as Rules;
    else {
      // By default it may do exactly what the outer rules allow.
      const { data: shared } = await call<{ real_keys: RealKey[] }>(auth, 'GET', '/real-keys');
      const real = shared.real_keys.find((r) => r.real_key_id === real_key_id);
      if (!real) throw new ToolError('No such shared real key. See list_real_keys.');
      if (!real.outer_rules)
        throw new ToolError(
          'This real key has no outer rules yet, so ghost keys cannot be made from code. Ask the user to set them on the real key in the dashboard.',
        );
      body.rules = real.outer_rules;
    }
    const { data: created } = await call<CreatedKey>(
      auth,
      'POST',
      `/real-keys/${real_key_id}/ghost-keys`,
      body,
    );
    const next = existing
      ? editEnv(parsed, [[existing, created.ghost_key]])
      : editEnv(
          parsed,
          [],
          [`# A ghost key for a shared real key (added by vallkey)`, `${name}=${created.ghost_key}`],
        );
    if (text) await writeKeepingMode(path, next);
    else await writeFile(path, next.replace(/^\n+/, ''), { mode: 0o600 });
    return {
      done: true,
      key_id: created.key_id,
      file: relative(root, path),
      variable: name,
      message: `${name} in ${relative(root, path)} now holds a new ghost key for the shared real key. Restart the app so it reads it.`,
    };
  },

  async kill_key({ key_id, reason }) {
    if (typeof reason !== 'string' || reason.trim().length < 3)
      throw new ToolError('Give a reason, for the audit log.');
    await call(await authed(), 'POST', `${keyPath(key_id)}/kill`, {
      reason: `${reason.trim()} (by an AI agent)`.slice(0, 200),
    });
    return { killed: true, message: 'The key is killed. A person can revive it from the dashboard.' };
  },
};

// Task keys started in this session: the ghost key never leaves this process unless asked for.
const tasks = new Map<string, { ghost: string; origin: string; provider: string }>();
const MAX_ANSWER = 20_000;

const taskOf = (task_id: unknown) => {
  const t = typeof task_id === 'string' ? tasks.get(task_id) : undefined;
  if (!t)
    throw new ToolError(
      'No task with that task_id in this session. Start one with start_task (tasks from an earlier session cannot be used here; end them with end_task).',
    );
  return t;
};

const agentHandlers: Record<string, ToolHandler> = {
  async what_can_i_do() {
    const { data } = await call<AgentInfo>(await authed(), 'GET', '/agent');
    return {
      agent: data.agent,
      plan: data.plan,
      tasks: data.tasks,
      keys: data.keys.map((k) => ({
        key_id: k.key_id,
        service: k.service,
        label: k.label,
        environment: k.environment,
        usable: k.usable,
        rules: k.rules,
      })),
      how: data.how
        .slice(0, 1)
        .concat(
          'Then use call_api with the task_id instead of sending requests yourself, and end_task when done.',
        ),
    };
  },

  async start_task({ key_id, purpose, minutes, rules, reveal_key = false }) {
    const body: Record<string, unknown> = { key_id, purpose };
    if (minutes !== undefined) body.minutes = minutes;
    if (rules !== undefined) body.rules = rules as Rules;
    const { data } = await call<CreatedTask>(await authed(), 'POST', '/agent/tasks', body);
    tasks.set(data.key_id, { ghost: data.ghost_key, origin: data.api_origin, provider: data.provider });
    return {
      task_id: data.key_id,
      provider: data.provider,
      ends_at: data.ends_at,
      rules: data.rules,
      ...(reveal_key
        ? {
            ghost_key: data.ghost_key,
            api_origin: data.api_origin,
            use: 'Put ghost_key where the real key goes and send requests to api_origin. It stops at ends_at.',
          }
        : {}),
      next: 'Send requests with call_api and this task_id. Call end_task when you are done.',
    };
  },

  async call_api({ task_id, method = 'GET', path, query, headers = {}, body }) {
    const t = taskOf(task_id);
    const verb = String(method).toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(verb))
      throw new ToolError('method must be GET, POST, PUT, PATCH or DELETE');
    // Resolve against the gateway and reject origin changes before attaching credentials.
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//'))
      throw new ToolError("path must be the provider's path, starting with /, such as /v1/payment_intents");
    const url = new URL(path, t.origin);
    if (url.origin !== new URL(t.origin).origin) throw new ToolError('path must stay on the Vallkey address');
    if (query && typeof query === 'object')
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const sent: Record<string, string> = {};
    let placed = false;
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v !== 'string') continue;
        if (v.includes('{{ghost_key}}')) placed = true;
        sent[k.toLowerCase()] = v.replaceAll('{{ghost_key}}', t.ghost);
      }
    }
    if (!placed) sent.authorization = `Bearer ${t.ghost}`;
    let payload;
    if (body !== undefined && body !== null) {
      if (typeof body === 'string') payload = body;
      else {
        payload = JSON.stringify(body);
        sent['content-type'] ??= 'application/json';
      }
    }
    let res;
    try {
      // A provider that never answers must not hold the agent forever.
      res = await fetch(url, {
        redirect: 'error',
        method: verb,
        headers: { 'user-agent': `vallkey-mcp/${VERSION}`, ...sent },
        body: payload,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new ToolError(
        e instanceof Error && e.name === 'TimeoutError'
          ? 'The provider did not answer within 2 minutes.'
          : `Could not reach Vallkey (${errorCode(e) ?? errorMessage(e)}).`,
      );
    }
    // Whatever comes back, the ghost key is never repeated to the agent.
    const text = (await res.text()).replaceAll(t.ghost, '[task key]');
    const type = res.headers.get('content-type') ?? '';
    let answer: unknown =
      text.length > MAX_ANSWER
        ? `${text.slice(0, MAX_ANSWER)}… (${text.length - MAX_ANSWER} more characters)`
        : text;
    if (type.includes('json') && text.length <= MAX_ANSWER) {
      try {
        answer = JSON.parse(text);
      } catch {
        // kept as text
      }
    }
    const refusal =
      res.status >= 400 &&
      isRecord(answer) &&
      isRecord(answer.error) &&
      answer.error.type === 'guard_error' &&
      typeof answer.error.message === 'string'
        ? answer.error.message
        : undefined;
    return {
      status: res.status,
      ok: res.ok,
      content_type: type || null,
      body: answer,
      ...(refusal
        ? {
            refused_by_vallkey: refusal,
            next: "This is outside the task's rules. task_activity shows each request and its reason; do not try to get around it.",
          }
        : {}),
    };
  },

  async task_activity({ task_id }) {
    if (typeof task_id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(task_id))
      throw new ToolError('task_id must be one start_task returned');
    const { data } = await call<{ requests: Activity[] }>(
      await authed(),
      'GET',
      `/agent/tasks/${task_id}/activity`,
    );
    return { requests: data.requests };
  },

  async list_tasks() {
    const { data } = await call<{ tasks: Task[] }>(await authed(), 'GET', '/agent/tasks');
    return { tasks: data.tasks.map((t) => ({ ...t, task_id: t.key_id, usable_here: tasks.has(t.key_id) })) };
  },

  async end_task({ task_id }) {
    if (typeof task_id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(task_id))
      throw new ToolError('task_id must be one start_task returned');
    await call(await authed(), 'POST', `/agent/tasks/${task_id}/end`);
    tasks.delete(task_id);
    return { ended: true, message: 'The task key stopped working and was deleted.' };
  },
};

// Agent mode when the token is an agent token: its own tools and instructions.
let mode: 'owner' | 'agent' | null = null;
async function detectMode() {
  if (mode) return mode;
  try {
    const auth = await resolveAuth({});
    if (auth.token) {
      await call<AgentInfo>(auth, 'GET', '/agent');
      mode = 'agent';
      return mode;
    }
  } catch {
    // not an agent token, offline, or not signed in: the owner tools explain what to do
  }
  mode = 'owner';
  return mode;
}

async function callTool(name: unknown, args: unknown, root: string) {
  const set = (await detectMode()) === 'agent' ? agentHandlers : handlers;
  const handler = typeof name === 'string' && Object.hasOwn(set, name) ? set[name] : null;
  if (!handler) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  try {
    if (args !== undefined && !isRecord(args)) throw new ToolError('Tool arguments must be an object');
    const result = await handler(args ?? {}, root);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
  } catch (e) {
    const known = e instanceof ToolError || hasStatus(e);
    return {
      isError: true,
      content: [{ type: 'text', text: known ? errorMessage(e) : `Something went wrong: ${errorMessage(e)}` }],
    };
  }
}

export async function handle(message: unknown, root: string): Promise<RpcResponse | null> {
  if (
    !isRecord(message) ||
    typeof message.method !== 'string' ||
    (message.id !== undefined &&
      message.id !== null &&
      typeof message.id !== 'string' &&
      typeof message.id !== 'number')
  )
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  const { id, method } = message;
  const params = isRecord(message.params) ? message.params : undefined;
  const reply = (result: unknown): RpcResponse | null =>
    id === undefined ? null : { jsonrpc: '2.0', id, result };
  const fail = (code: number, text: string): RpcResponse | null =>
    id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message: text } };
  switch (method) {
    case 'initialize': {
      const agent = (await detectMode()) === 'agent';
      return reply({
        protocolVersion:
          typeof params?.protocolVersion === 'string' && PROTOCOLS.includes(params.protocolVersion)
            ? params.protocolVersion
            : PROTOCOLS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'vallkey', title: 'Vallkey', version: VERSION },
        instructions: agent ? AGENT_INSTRUCTIONS : INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: (await detectMode()) === 'agent' ? AGENT_TOOLS : TOOLS });
    case 'tools/call':
      return reply(await callTool(params?.name, params?.arguments, root));
    default:
      return method?.startsWith('notifications/') ? null : fail(-32601, `Method not found: ${method}`);
  }
}

export async function mcp() {
  const root = process.cwd();
  const send = (msg: unknown) => msg && process.stdout.write(`${JSON.stringify(msg)}\n`);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    if (Array.isArray(message) && message.length === 0) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
      continue;
    }
    const batch: unknown[] = Array.isArray(message) ? message : [message];
    const job: Promise<void> = Promise.all(
      batch.map((m) =>
        handle(m, root).catch((e) => ({
          jsonrpc: '2.0',
          id: isRecord(m) && (typeof m.id === 'string' || typeof m.id === 'number') ? m.id : null,
          error: { code: -32603, message: errorMessage(e) },
        })),
      ),
    ).then((replies) => {
      const out = replies.filter(Boolean);
      if (Array.isArray(message)) {
        if (out.length) send(out);
      } else send(out[0]);
    });
    pending.add(job);
    job.finally(() => pending.delete(job));
  }
  await Promise.all(pending);
  return 0;
}
