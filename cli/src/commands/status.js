import { call, requireToken } from '../api.js';
import { resolveAuth } from '../config.js';
import { bold, CliError, cyan, detail, dim, green, heading, next, out, plural, red, table, yellow } from '../ui.js';

// `vallkey status [key id]`: every place each ghost key is used from, as the key's page
// in the dashboard shows it, with what is wrong. Exits with 1 when a place is failing,
// so a deploy script can stop on it.

const KEY_ID = /^[A-Za-z0-9_-]{22}$/;

export const PLATFORMS = {
  vercel: 'Vercel', 'aws-lambda': 'AWS Lambda', 'aws-ecs': 'AWS ECS', 'cloud-functions': 'Cloud Functions', 'cloud-run': 'Cloud Run',
  'app-engine': 'App Engine', 'azure-functions': 'Azure Functions', 'azure-container-apps': 'Azure Container Apps', 'azure-app-service': 'Azure App Service',
  railway: 'Railway', render: 'Render', fly: 'Fly.io', heroku: 'Heroku', netlify: 'Netlify', koyeb: 'Koyeb', 'github-actions': 'GitHub Actions',
  'gitlab-ci': 'GitLab CI', kubernetes: 'Kubernetes', docker: 'Docker',
};
export const LANGUAGES = { node: 'Node.js', bun: 'Bun', js: 'JavaScript', python: 'Python', ruby: 'Ruby', java: 'Java', dotnet: '.NET', php: 'PHP', elixir: 'Elixir', erlang: 'Erlang', cli: 'vallkey CLI' };

// "Vercel · Node.js 22 · production", or "OpenAI/Python · AWS" for requests without a hook.
export function placeName(p) {
  if (p.how === 'hook') {
    const runtime = p.runtime ? ` ${p.runtime.split('.').slice(0, 2).join('.')}` : '';
    return [PLATFORMS[p.platform] ?? p.platform ?? 'Server', `${LANGUAGES[p.lang] ?? p.lang}${runtime}`, p.env].filter(Boolean).join(' · ');
  }
  return [p.sdk ?? 'Unknown client', p.network].filter(Boolean).join(' · ');
}

export function ago(at, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function what(p) {
  if (p.status === 'failing') return red(`failing at the provider (${p.failedToday} today${p.lastFailed?.status ? `, last ${p.lastFailed.status === 0 ? 'no answer' : p.lastFailed.status}` : ''})`);
  if (p.status === 'blocked') return yellow(`${p.deniedToday} blocked by the rules today`);
  if (p.status === 'quiet') return dim('quiet');
  return green('ok');
}

const mark = (p) => (p.status === 'failing' ? red('✗') : p.status === 'blocked' ? yellow('!') : p.status === 'quiet' ? dim('○') : green('●'));

export async function status(args, flags) {
  if (args[0] && !KEY_ID.test(args[0])) throw new CliError('Usage: vallkey status [key id]. Find ids with: vallkey keys');
  const auth = await resolveAuth(flags);
  requireToken(auth);
  const { data } = await call(auth, 'GET', '/keys');
  const keys = args[0] ? data.keys.filter((k) => k.keyId === args[0]) : data.keys.filter((k) => !k.killedAt);
  if (args[0] && !keys.length) throw new CliError(`No ghost key ${args[0]} in this account`);
  const results = [];
  for (let i = 0; i < keys.length; i += 5) {
    results.push(...(await Promise.all(keys.slice(i, i + 5).map(async (k) => ({ key: k, places: (await call(auth, 'GET', `/keys/${k.keyId}/places`)).data.places })))));
  }
  const failing = results.some((r) => r.places.some((p) => p.status === 'failing'));
  if (flags.json) {
    out(JSON.stringify(results.map((r) => ({ key_id: r.key.keyId, provider: r.key.provider, label: r.key.label, places: r.places })), null, 2));
    return failing ? 1 : 0;
  }
  if (!results.length) {
    out('No ghost keys yet.');
    next([`${cyan('npx vallkey init')}  swap the keys in your .env files for ghost keys`]);
    return 0;
  }
  const used = results.filter((r) => r.places.length);
  const unused = results.filter((r) => !r.places.length).map((r) => r.key);
  const problems = used.flatMap((r) => r.places).filter((p) => p.status === 'failing' || p.status === 'blocked').length;
  heading('Where your keys are used', `${plural(used.length, 'key')} in use${problems ? ` · ${plural(problems, 'app')} ${problems === 1 ? 'needs' : 'need'} a look` : ''}`);
  for (const { key, places } of used) {
    out();
    out(`${bold(key.label || key.provider)}  ${dim(`${key.provider} · ${key.keyId}`)}`);
    out(table(places.map((p) => [`  ${mark(p)} ${placeName(p)}`, dim(ago(p.lastAt)), `${p.today.toLocaleString('en-US')} today`, what(p)])));
  }
  if (unused.length) {
    out();
    out(`${bold('No requests yet')}  ${dim(plural(unused.length, 'key'))}`);
    const shown = unused.slice(0, 8);
    out(table(shown.map((k) => [`  ${dim('○')} ${k.label || k.provider}`, dim(k.keyId)])));
    if (unused.length > shown.length) detail(`and ${unused.length - shown.length} more`);
  }
  const lines = [];
  if (failing) lines.push(`Open the key's Activity tab in the dashboard to see what the provider answered.`);
  if (unused.length) lines.push(`${cyan('npx vallkey connect')}  see how to connect your app`);
  next(lines);
  return failing ? 1 : 0;
}
