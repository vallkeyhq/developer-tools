import { call, requireToken } from '../api.js';
import { resolveAuth } from '../config.js';
import { bold, CliError, confirm, cyan, detail, dim, fields, green, heading, next, ok, out, plural, red, table, yellow } from '../ui.js';

const KEY_ID = /^[A-Za-z0-9_-]{22}$/;

export async function keys(args, flags) {
  if (args[0] === 'add') return addGhostKey(args.slice(1), flags);
  if (args.length) throw new CliError(`Unknown keys command "${args[0]}". See: vallkey --help`);
  const auth = await resolveAuth(flags);
  requireToken(auth);
  const { data } = await call(auth, 'GET', '/keys');
  if (flags.json) {
    out(JSON.stringify(data.keys, null, 2));
    return 0;
  }
  if (!data.keys.length) {
    out('No ghost keys yet.');
    next([`${cyan('npx vallkey init')}  swap the keys in your .env files for ghost keys`]);
    return 0;
  }
  const shared = new Map();
  for (const k of data.keys) if (k.realKeyId) shared.set(k.realKeyId, (shared.get(k.realKeyId) ?? 0) + 1);
  const state = (k) => (k.killedAt ? red('killed') : green('active'));
  const rows = data.keys.map((k) => [k.label || dim('(no name)'), k.provider, state(k), dim(k.keyId), k.realKeyId && shared.get(k.realKeyId) > 1 ? `shared ${dim(`×${shared.get(k.realKeyId)}`)}` : dim('-'), dim(new Date(k.createdAt).toISOString().slice(0, 10))]);
  heading('Ghost keys', plural(data.keys.length, 'key'));
  out();
  out(table([['NAME', 'PROVIDER', 'STATE', 'KEY ID', 'REAL KEY', 'CREATED'].map((h) => dim(h)), ...rows]));
  next([`${cyan('npx vallkey status')}  where each key is used, and what is wrong`]);
  return 0;
}

// Real keys shared by several ghost keys: each is replaced, killed and limited once for all of them.
export async function realKeys(flags) {
  const auth = await resolveAuth(flags);
  requireToken(auth);
  const { data } = await call(auth, 'GET', '/real-keys');
  if (flags.json) {
    out(JSON.stringify(data.real_keys, null, 2));
    return 0;
  }
  if (!data.real_keys.length) {
    out('No shared real keys yet.');
    detail('A real key is shared once it has more than one ghost key.');
    next([`${cyan('npx vallkey keys add --from <key id>')}  make another ghost key for one`]);
    return 0;
  }
  const rows = data.real_keys.map((r) => [r.label, r.provider, r.hint ?? dim('-'), String(r.ghost_keys.length + r.hidden_ghost_keys), r.outer_rules ? 'yes' : dim('no'), dim(r.real_key_id)]);
  heading('Shared real keys', plural(data.real_keys.length, 'key'));
  out();
  out(table([['NAME', 'PROVIDER', 'ENDS IN', 'GHOST KEYS', 'OUTER RULES', 'REAL KEY ID'].map((h) => dim(h)), ...rows]));
  return 0;
}

// Another ghost key for a real key already in Vallkey. From code this needs outer
// rules on the real key (Team plan), and the new key must stay inside them.
async function addGhostKey(args, flags) {
  const from = flags.from ?? args[0];
  if (!from || !KEY_ID.test(from)) throw new CliError('Usage: vallkey keys add --from <real key id or key id> [--label "..."] [--rules \'{"allow":[…]}\']\nFind ids with: vallkey real-keys');
  let rules;
  if (typeof flags.rules === 'string') {
    try {
      rules = JSON.parse(flags.rules);
    } catch {
      throw new CliError('--rules must be JSON, such as \'{"allow":[{"method":"GET","path":"/v1/**"}]}\'');
    }
  }
  const auth = await resolveAuth(flags);
  requireToken(auth);
  // A real key id, or a key whose real key is shared.
  const { data: shared } = await call(auth, 'GET', '/real-keys');
  const real = shared.real_keys.find((r) => r.real_key_id === from || r.ghost_keys.includes(from));
  if (!real) throw new CliError(`${from} is not a shared real key. Share it from the key's page in the dashboard first, and set its outer rules.`);
  const body = { label: typeof flags.label === 'string' ? flags.label : '', ...(rules ? { rules } : {}) };
  const { data } = await call(auth, 'POST', `/real-keys/${real.real_key_id}/ghost-keys`, body);
  if (flags.json) {
    out(JSON.stringify(data, null, 2));
    return 0;
  }
  ok(`New ghost key for "${real.label}"`);
  fields([['Key ID', data.key_id]]);
  out();
  out(`  ${bold(data.ghost_key)}`);
  out();
  detail("Shown here only once. Put it where your app reads its API key. An admin can see it again on the key's page in the");
  detail('dashboard, unless your account has turned that off.');
  return 0;
}

// Stops a ghost key everywhere at once. The real key is untouched, and the ghost key
// can be revived from the dashboard.
export async function kill(args, flags) {
  const keyId = args[0];
  if (!keyId || !KEY_ID.test(keyId)) throw new CliError('Usage: vallkey kill <key id> [--reason "..."]\nFind key ids with: vallkey keys');
  const auth = await resolveAuth(flags);
  requireToken(auth);
  if (!(await confirm(`Kill ${keyId}? Every request with it will be refused right away.`, { yes: flags.yes }))) return 1;
  const reason = typeof flags.reason === 'string' ? flags.reason : 'killed from the vallkey CLI';
  await call(auth, 'POST', `/keys/${keyId}/kill`, { reason });
  ok(`Killed ${keyId}`);
  detail('Every request with it is refused now. The real key is untouched.');
  detail('Revive it from the dashboard when it is safe.');
  return 0;
}

// The account's own API domains and how far each one's setup is.
export async function domains(args, flags) {
  const auth = await resolveAuth(flags);
  requireToken(auth);
  if (args[0] === 'check') {
    const host = args[1];
    if (!host) throw new CliError('Usage: vallkey domains check <domain>');
    const { data } = await call(auth, 'POST', `/domains/${encodeURIComponent(host.toLowerCase())}/check`);
    heading(data.hostname, data.status);
    out();
    for (const r of data.records) out(`  ${r.ok ? green('✓') : red('✗')} ${r.type.padEnd(5)} ${r.name} ${dim('→')} ${r.value}`);
    for (const p of data.problems) out(`  ${yellow('!')} ${p.message}`);
    return data.status === 'active' ? 0 : 1;
  }
  if (args.length) throw new CliError(`Unknown domains command "${args[0]}". See: vallkey --help`);
  const { data } = await call(auth, 'GET', '/domains');
  if (flags.json) {
    out(JSON.stringify(data.domains, null, 2));
    return 0;
  }
  if (!data.domains.length) {
    out(data.limit ? 'No API domains yet.' : 'Your own API domains come with the Pro, Team and Business plans.');
    if (data.limit) detail('Add one in the dashboard: Settings → API domains.');
    return 0;
  }
  const rows = data.domains.map((d) => [d.hostname, d.status === 'active' ? green(d.status) : yellow(d.status), d.isDefault ? 'yes' : dim('-')]);
  heading('API domains', plural(data.domains.length, 'domain'));
  out();
  out(table([['DOMAIN', 'STATUS', 'DEFAULT'].map((h) => dim(h)), ...rows]));
  return 0;
}
