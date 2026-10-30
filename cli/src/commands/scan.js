import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, open, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { findKeys } from '../providers.js';
import { bad, CliError, cyan, detail, dim, mask, next, ok, out, plural, red, table, yellow } from '../ui.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', '.svelte-kit', 'dist', 'build', 'out', '.turbo', '.vercel', '.wrangler', 'coverage', 'vendor', '.venv', 'venv', '__pycache__', 'target', '.gradle', 'Pods']);
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|icns|svg|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|wasm|so|dylib|dll|exe|bin|class|pyc|map|lockb)$/i;
const MAX_BYTES = 1024 * 1024;
const ENV_FILE = /^\.env(\..+)?$/;
const IGNORE_LINE = /vallkey:ignore/;

// Explicit exceptions for known false positives, including historical fixtures.
// Both the complete value's digest and its exact path must match. No regexes,
// wildcard directories or provider-wide exclusions can suppress other secrets.
export async function filterAllowlisted(findings, path) {
  let entries;
  try { entries = JSON.parse(await readFile(path, 'utf8')); } catch { throw new CliError('Cannot read the scan allowlist as JSON'); }
  if (!Array.isArray(entries) || entries.some((e) => !e || typeof e.path !== 'string' || !e.path || e.path.startsWith('/') || e.path.includes('\\') || e.path.split('/').some((p) => p === '..' || p === '.') || /[*?]/.test(e.path) || !/^[a-f0-9]{64}$/.test(e.sha256 ?? '') || typeof e.reason !== 'string' || !e.reason.trim())) {
    throw new CliError('Invalid scan allowlist: each entry needs an exact relative path, SHA-256 digest and reason');
  }
  const allowed = new Set(entries.map((e) => `${e.path}\0${e.sha256}`));
  return findings.filter((f) => !allowed.has(`${f.file.replaceAll('\\', '/')}\0${createHash('sha256').update(f.secret).digest('hex')}`));
}

async function walk(dir, files) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(path, files);
    } else if (entry.isFile() && !SKIP_EXT.test(entry.name)) {
      files.push(path);
    }
  }
}

function gitFiles(dir) {
  try {
    const listed = execFileSync('git', ['-C', dir, 'ls-files', '-z', '-co', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
    return listed.split('\0').filter((p) => p && !SKIP_EXT.test(p)).map((p) => join(dir, p));
  } catch {
    return null; // not a git repository, or no git
  }
}

// The files to look at: what git would commit, plus .env files it ignores (they are
// where keys usually are, and what `vallkey init` fixes).
export async function collect(roots) {
  const files = new Map();
  for (const root of roots) {
    const info = await stat(root).catch(() => null);
    if (!info) throw new CliError(`No such file or folder: ${root}`);
    if (info.isFile()) {
      files.set(root, { path: root, committed: true });
      continue;
    }
    const tracked = gitFiles(root);
    const list = tracked ?? [];
    if (!tracked) await walk(root, list);
    for (const path of list) files.set(path, { path, committed: true });
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isFile() && ENV_FILE.test(entry.name) && !files.has(path)) files.set(path, { path, committed: false });
    }
  }
  return [...files.values()];
}

async function readText(path) {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const { size } = await handle.stat();
    if (size > MAX_BYTES || size === 0) return null;
    const buf = Buffer.alloc(size);
    await handle.read(buf, 0, size, 0);
    if (buf.subarray(0, 8000).includes(0)) return null; // binary
    return buf.toString('utf8');
  } finally {
    await handle.close();
  }
}

function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export async function scanFiles(files, cwd) {
  const findings = [];
  for (const file of files) {
    const text = await readText(file.path);
    if (!text) continue;
    const found = findKeys(text);
    if (!found.length) continue;
    const starts = lineStarts(text);
    const lines = text.split('\n');
    for (const f of found) {
      const line = lineOf(starts, f.index);
      if (IGNORE_LINE.test(lines[line] ?? '')) continue;
      findings.push({ file: relative(cwd, file.path) || file.path, line: line + 1, lineText: lines[line], committed: file.committed, env: ENV_FILE.test(basename(file.path)), ...f });
    }
  }
  return findings;
}

// Keys added in any commit on any branch. Each key is reported once, at the oldest
// commit it appears in.
async function scanHistory(root, cwd) {
  if (!gitFiles(root)) throw new CliError('--history needs a git repository.');
  const git = spawn('git', ['-C', root, 'log', '-p', '--all', '--no-color', '--no-ext-diff', '-U0', '--format=%x00%H'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = createInterface({ input: git.stdout, crlfDelay: Infinity });
  const bySecret = new Map();
  let commit = '';
  let file = '';
  let lineNo = 0;
  for await (const line of lines) {
    if (line.startsWith('\0')) commit = line.slice(1, 13);
    else if (line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice(6) : '';
    else if (line.startsWith('@@')) lineNo = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    else if (line.startsWith('+') && file) {
      if (!IGNORE_LINE.test(line)) {
        for (const f of findKeys(line.slice(1))) {
          bySecret.set(f.secret, { file: relative(cwd, join(root, file)) || file, line: lineNo, commit, committed: true, env: ENV_FILE.test(basename(file)), ...f });
        }
      }
      lineNo += 1;
    }
  }
  await new Promise((resolve) => (git.exitCode !== null ? resolve() : git.on('close', resolve)));
  return [...bySecret.values()];
}

// In GitHub Actions: each key becomes an annotation on its line, and the run gets a
// summary. Keys are masked there too.
const escapeData = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

async function reportToGitHub(findings, files, history) {
  for (const f of findings) {
    const level = f.committed ? 'error' : 'warning';
    const where = f.commit ? ` (added in commit ${f.commit})` : '';
    const advice = f.committed ? 'Treat it as leaked: create a new key at the provider, revoke this one, and keep keys out of the code.' : 'Run npx vallkey init to swap it for a ghost key.';
    out(`::${level} file=${escapeProperty(f.file)},line=${f.line},title=${escapeProperty(`${f.kind.title} found`)}::${escapeData(`${f.kind.title} ${mask(f.secret)}${where}. ${advice}`)}`);
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const cell = (s) => String(s).replace(/\|/g, '\\|');
  const lines = findings.length
    ? [
        `### ${findings.length} API key${findings.length === 1 ? '' : 's'} found`,
        '',
        '| Where | Kind | Key |',
        '| --- | --- | --- |',
        ...findings.map((f) => `| \`${cell(f.file)}:${f.line}\`${f.commit ? ` (commit ${f.commit})` : ''} | ${cell(f.kind.title)} | \`${cell(mask(f.secret))}\` |`),
        '',
        'Keys in code or history should be treated as leaked: create a new key at the provider and revoke the old one. [Vallkey](https://vallkey.com/docs/cli/) keeps real keys out of your code.',
      ]
    : [`### No API keys found`, '', `Checked ${files} file${files === 1 ? '' : 's'}${history ? ' and the git history' : ''}.`];
  await appendFile(summary, `${lines.join('\n')}\n`).catch(() => undefined);
}

export async function scan(args, flags) {
  const cwd = process.cwd();
  const roots = args.length ? args : ['.'];
  const files = await collect(roots);
  let findings = await scanFiles(files, cwd);
  if (flags.history) {
    const seen = new Set(findings.map((f) => f.secret));
    for (const root of roots) {
      for (const f of await scanHistory(root, cwd)) {
        if (!seen.has(f.secret)) {
          seen.add(f.secret);
          findings.push(f);
        }
      }
    }
  }
  if (flags.allowlist) findings = await filterAllowlisted(findings, flags.allowlist);
  findings = findings.sort((a, b) => Number(a.committed) - Number(b.committed) || a.file.localeCompare(b.file) || a.line - b.line);

  if (process.env.GITHUB_ACTIONS === 'true' && !flags.json) await reportToGitHub(findings, files.length, Boolean(flags.history));

  if (flags.json) {
    const rows = findings.map((f) => ({ file: f.file, line: f.line, commit: f.commit ?? null, kind: f.kind.id, title: f.kind.title, vallkey: Boolean(f.kind.provider), committed: f.committed, key: mask(f.secret) }));
    out(JSON.stringify(rows, null, 2));
    return findings.length ? 1 : 0;
  }

  if (!findings.length) {
    ok(`No API keys found ${dim(`in ${plural(files.length, 'file')}${flags.history ? ' and in git history' : ''}`)}`);
    return 0;
  }

  const where = (f) => `${f.file}:${f.line}${f.commit ? dim(` (commit ${f.commit})`) : f.committed ? '' : dim(' (not committed)')}`;
  const committed = findings.filter((f) => f.committed);
  const swappable = findings.filter((f) => f.env && !f.committed && f.kind.provider && !f.kind.manual);
  bad(`Found ${plural(findings.length, 'API key')} ${dim(`in ${plural(files.length, 'file')}${flags.history ? ' and git history' : ''}`)}`);
  out();
  out(table(findings.map((f) => [`  ${f.committed ? red('●') : yellow('●')}`, where(f), f.kind.title, dim(mask(f.secret))])));
  const lines = [];
  if (committed.length) lines.push(`${red('●')} ${plural(committed.length, 'key')} in code${flags.history ? ' or git history' : ''} ${committed.length === 1 ? 'is' : 'are'} already exposed. Make a new key at the provider,
    revoke the old one, and keep the new one in a .env file.`);
  if (swappable.length) lines.push(`${yellow('●')} ${plural(swappable.length, 'key')} in .env files: ${cyan('npx vallkey init')} swaps them for ghost keys.`);
  next(lines);
  out();
  detail('Not a real key? Add the comment vallkey:ignore on its line.');
  return 1;
}
