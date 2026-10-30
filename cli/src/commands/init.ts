import { execFileSync } from 'node:child_process';
import { access, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { ApiError, call, proxyOrigin, requireToken } from '../api.js';
import { resolveAuth } from '../config.js';
import type { EnvEntry, ParsedEnv } from '../dotenv.js';
import { editEnv, parseEnv } from '../dotenv.js';
import type { KeyKind } from '../providers.js';
import { identify } from '../providers.js';
import type { CreatedKey, Flags, Provider } from '../types.js';
import {
  bad,
  CliError,
  confirm,
  cyan,
  detail,
  dim,
  green,
  heading,
  mask,
  next,
  ok,
  out,
  plural,
  table,
  warn,
} from '../ui.js';
import { errorMessage } from '../validation.cjs';
interface FoundEntry {
  file: { path: string; parsed: ParsedEnv };
  entry: EnvEntry;
  kind: KeyKind;
}

const ENV_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.production',
  '.env.production.local',
];

// Official SDKs that read their base URL from the environment, so no code change is needed.
export const BASE_URL_VARS: Record<string, { name: string; path: string }> = {
  openai: { name: 'OPENAI_BASE_URL', path: '/v1' },
  anthropic: { name: 'ANTHROPIC_BASE_URL', path: '' },
  groq: { name: 'GROQ_BASE_URL', path: '' },
};
const OPENAI_COMPATIBLE: Record<string, string> = { xai: '/v1', openrouter: '/api/v1', mistral: '/v1' };

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

export async function projectName(cwd: string) {
  try {
    const name = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).name;
    if (typeof name === 'string' && name) return name;
  } catch {
    // no package.json
  }
  return basename(cwd);
}

export async function writeKeepingMode(path: string, text: string) {
  const { mode } = await stat(path);
  const tmp = `${path}.vallkey-${process.pid}.tmp`;
  await writeFile(tmp, text, { mode: mode & 0o777 });
  await rename(tmp, path);
}

export function isIgnored(path: string) {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return e instanceof Error && 'status' in e && e.status === 128 ? null : false; // 128: not a git repository
  }
}

// What to change in the code, for SDKs that do not read a base URL from the environment.
function nextStep(provider: string, api: string, envName: string, origin?: string) {
  const url = new URL(api);
  if (provider === 'stripe') {
    const extra = url.port ? `, port: ${url.port}, protocol: '${url.protocol.slice(0, -1)}'` : '';
    return `new Stripe(process.env.${envName}, { host: '${url.hostname}'${extra} })`;
  }
  if (OPENAI_COMPATIBLE[provider])
    return `new OpenAI({ apiKey: process.env.${envName}, baseURL: '${api}${OPENAI_COMPATIBLE[provider]}' })`;
  if (provider === 'gemini')
    return `new GoogleGenAI({ apiKey: process.env.${envName}, httpOptions: { baseUrl: '${api}' } })`;
  return `send requests to ${api} instead of ${origin ?? 'the provider'}; paths stay the same`;
}

export async function init(args: string[], flags: Flags) {
  const cwd = process.cwd();
  const paths = args.length
    ? args
    : (await Promise.all(ENV_FILES.map(async (f) => ((await exists(f)) ? f : null)))).filter(
        (path): path is string => path !== null,
      );
  if (!paths.length)
    throw new CliError(
      'No .env file here. Run this in your project folder, or name the file: vallkey init path/to/.env',
    );

  const files = [];
  for (const path of paths) {
    const text = await readFile(path, 'utf8').catch(() => {
      throw new CliError(`Cannot read ${path}`);
    });
    files.push({ path, parsed: parseEnv(text) });
  }

  const found: FoundEntry[] = [];
  for (const file of files) {
    for (const entry of file.parsed.entries) {
      const kind = identify(entry.name, entry.value);
      if (kind) found.push({ file, entry, kind });
    }
  }
  const swap = found.filter((f): f is FoundEntry & { kind: KeyKind & { provider: string } } =>
    Boolean(f.kind.provider && !f.kind.manual),
  );
  const manual = found.filter((f) => f.kind.manual);
  const unsupported = found.filter((f) => !f.kind.provider);

  const where = (f: FoundEntry) => `${relative(cwd, f.file.path) || f.file.path}  ${f.entry.name}`;
  if (!found.length) {
    ok(`No API keys to protect ${dim(`in ${paths.join(', ')}`)}`);
    return 0;
  }
  if (swap.length) {
    heading('Keys to protect', plural(swap.length, 'key'));
    out();
    out(table(swap.map((f) => ['  ' + where(f), f.kind.title, dim(mask(f.entry.value))])));
  }
  if (manual.length) {
    out();
    warn('AWS keys need an endpoint and a service, so add them in the dashboard (Keys → New key → AWS):');
    out(table(manual.map((f) => ['  ' + where(f), f.kind.title])));
  }
  if (unsupported.length) {
    out();
    out(`${dim('•')} Vallkey cannot protect these yet. Keep them out of your code:`);
    out(dim(table(unsupported.map((f) => ['  ' + where(f), f.kind.title]))));
  }
  if (!swap.length) return 0;
  out();

  if (flags['dry-run']) {
    out(dim('Dry run: nothing was changed. Run it again without --dry-run to swap them.'));
    return 0;
  }
  const auth = await resolveAuth(flags);
  requireToken(auth);

  const unique = new Map<string, { kind: KeyKind & { provider: string }; items: FoundEntry[] }>();
  for (const f of swap) {
    const group = unique.get(f.entry.value) ?? { kind: f.kind, items: [] };
    group.items.push(f);
    unique.set(f.entry.value, group);
  }
  detail(
    `Your real keys will be stored encrypted in Vallkey and removed from ${files.length === 1 ? 'this file' : 'these files'}.`,
  );
  detail(
    'Vallkey never shows a real key again. If you use one anywhere else, keep a copy in your password manager.',
  );
  out();
  if (
    !(await confirm(`Swap ${unique.size} key${unique.size === 1 ? '' : 's'} for ghost keys?`, {
      yes: flags.yes,
    }))
  )
    return 1;

  const { data: catalog } = await call<{ providers: Provider[] }>(auth, 'GET', '/providers');
  const origins = new Map(catalog.providers.map((p) => [p.name, p.origin]));
  const project = await projectName(cwd);

  const created = new Map<
    string,
    { keyId: string; ghost: string; kind: KeyKind & { provider: string }; names: string[] }
  >(); // real key → { keyId, ghost, kind }
  const failures = [];
  for (const [realKey, group] of unique) {
    const names = [...new Set(group.items.map((f) => f.entry.name))];
    if (!origins.has(group.kind.provider)) {
      failures.push({ names, message: `this server does not support ${group.kind.title}` });
      continue;
    }
    try {
      const { data } = await call<CreatedKey>(auth, 'POST', '/keys', {
        provider: group.kind.provider,
        real_key: realKey,
        label: `${names[0]} · ${project}`.slice(0, 100),
      });
      created.set(realKey, { keyId: data.key_id, ghost: data.ghost_key, kind: group.kind, names });
    } catch (e) {
      failures.push({ names, message: errorMessage(e) });
      if (e instanceof ApiError && (e.status === 401 || e.status === 402 || e.status === 403)) break; // the rest would fail the same way
    }
  }

  // Ghost keys are shown once, so the files are written even if some keys failed.
  const notes = [];
  const origin = await proxyOrigin(auth);
  for (const file of files) {
    const replace: [EnvEntry, string][] = file.parsed.entries
      .filter((e) => created.has(e.value))
      .map((e) => [e, created.get(e.value)!.ghost]);
    if (!replace.length) continue;
    const defined = new Set(file.parsed.entries.map((e) => e.name));
    const providers = new Set(replace.map(([e]) => created.get(e.value)!.kind.provider));
    const append = [];
    for (const provider of providers) {
      const v = BASE_URL_VARS[provider];
      if (!v) continue;
      if (defined.has(v.name))
        notes.push(`${v.name} is already set in ${file.path}: make sure it points to ${origin}${v.path}`);
      else append.push(`${v.name}=${origin}${v.path}`);
    }
    if (append.length) append.unshift('# Sends SDK traffic through Vallkey (added by vallkey init)');
    await writeKeepingMode(file.path, editEnv(file.parsed, replace, append));
    if (isIgnored(file.path) === false)
      notes.push(
        `${file.path} is not in .gitignore. Ghost keys are safer than real ones, but keep them out of git too.`,
      );
  }

  if (created.size) {
    out();
    ok(`Swapped ${plural(created.size, 'key')} for ghost keys`);
    out();
    out(table([...created.values()].map((c) => ['  ' + c.names.join(', '), c.kind.title, dim(c.keyId)])));
    const steps = [...created.values()]
      .filter((c) => !BASE_URL_VARS[c.kind.provider])
      .map((c) => [
        c.kind.title,
        nextStep(c.kind.provider, auth.api, c.names[0], origins.get(c.kind.provider)),
      ]);
    const auto = [
      ...new Set(
        [...created.values()]
          .filter((c) => BASE_URL_VARS[c.kind.provider])
          .map((c) => BASE_URL_VARS[c.kind.provider].name),
      ),
    ];
    const lines = [];
    if (auto.length)
      lines.push(`${green('✓')} The official SDKs read ${auto.join(', ')}, so those need no code change.`);
    if (steps.length) {
      lines.push(
        `${dim('•')} For the others, ${cyan('npx vallkey hook')} turns on auto-connect, with no code changes. Or change one line:`,
      );
      for (const [title, step] of steps) lines.push(`    ${title}: ${cyan(step)}`);
    }
    lines.push(`${dim('•')} Restart your app so it reads the new values.`);
    next(lines);
    out();
    detail(`Rules, limits and activity for each key: ${auth.api.replace('//api', '//app')}/dashboard/`);
  }
  if (notes.length) out();
  for (const note of notes) warn(note);
  if (failures.length) {
    out();
    for (const f of failures) bad(`${f.names.join(', ')}: ${f.message}`);
    out(dim('  These keys were left as they were.'));
    return 1;
  }
  return 0;
}
