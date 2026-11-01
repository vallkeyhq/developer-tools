import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { gatewayOrigin } from '../config.js';
import type { Flags, ProjectPackage } from '../types.js';
import { bold, CliError, confirm, cyan, detail, dim, green, heading, next, out, yellow } from '../ui.js';
import { errorMessage } from '../validation.cjs';
interface LanguageSetup {
  title: string;
  install?: string[];
  file?: () => string;
  as?: string;
  env: (path: string) => Record<string, string>;
}

// Native artifacts are accepted only when their digest matches the bundled manifest.

const MANIFEST: { version: string; base: string; files: Record<string, string> } = JSON.parse(
  readFileSync(new URL('../hooks.json', import.meta.url), 'utf8'),
);
// Only for testing a local copy of the files; the checksums above still apply.
const downloads = () => (process.env.VALLKEY_DOWNLOADS || MANIFEST.base).replace(/\/?$/, '/');

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const elixirEval = (path: string) =>
  `-eval catch(code:load_abs("${path.replace(/\.beam$/, '')}")),catch(vallkey_auto:start()).`;

export const LANGUAGES: Record<string, LanguageSetup> = {
  node: { title: 'Node.js', env: () => ({ NODE_OPTIONS: '--require vallkey/auto' }) },
  bun: { title: 'Bun', env: () => ({ BUN_OPTIONS: '--preload vallkey/auto' }) },
  python: { title: 'Python', env: () => ({ VALLKEY_AUTO: '1' }) },
  ruby: { title: 'Ruby', install: ['bundle add vallkey'], env: () => ({ RUBYOPT: '-rvallkey/auto' }) },
  java: {
    title: 'Java (and Kotlin, Scala)',
    file: () => `vallkey-agent-${MANIFEST.version}.jar`,
    as: 'vallkey-agent.jar',
    env: (p: string) => ({ JAVA_TOOL_OPTIONS: `-javaagent:${p}` }),
  },
  dotnet: {
    title: '.NET',
    file: () => `Vallkey.Auto-${MANIFEST.version}.dll`,
    as: 'Vallkey.Auto.dll',
    env: (p: string) => ({ DOTNET_STARTUP_HOOKS: p }),
  },
  php: { title: 'PHP', env: (dir: string) => ({ PHP_INI_SCAN_DIR: `:${dir}` }) },
  elixir: {
    title: 'Elixir',
    file: () => `vallkey_auto-${MANIFEST.version}.beam`,
    as: 'vallkey_auto.beam',
    env: (p: string) => ({ ELIXIR_ERL_OPTIONS: elixirEval(p) }),
  },
  erlang: {
    title: 'Erlang',
    file: () => `vallkey_auto-${MANIFEST.version}.beam`,
    as: 'vallkey_auto.beam',
    env: (p: string) => ({ ERL_FLAGS: elixirEval(p) }),
  },
};
// Compiled languages: nothing is left to change once the app is built.
const COMPILED: Record<string, string> = { go: 'Go', rust: 'Rust' };

export async function detect(cwd: string) {
  const names = new Set(await readdir(cwd).catch(() => []));
  const has = (...files: string[]) => files.some((f) => names.has(f));
  const found = [];
  if (has('mix.exs')) found.push('elixir');
  else if (has('rebar.config')) found.push('erlang');
  if (has('composer.json')) found.push('php');
  if (has('Gemfile')) found.push('ruby');
  if (has('pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py', 'uv.lock', 'poetry.lock'))
    found.push('python');
  if (
    has('pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'build.sbt')
  )
    found.push('java');
  if ([...names].some((n) => /\.(csproj|fsproj|vbproj|sln)$/.test(n))) found.push('dotnet');
  if (has('go.mod')) found.push('go');
  if (has('Cargo.toml')) found.push('rust');
  // package.json alone means Node.js; next to another server language it is usually the
  // frontend's (Laravel, Rails and Django projects keep one for their assets).
  if (has('bun.lock', 'bun.lockb', 'bunfig.toml')) found.push('bun');
  else if (has('package.json') && !found.length) found.push('node');
  return found;
}

// A start script that loads the hook in the process that serves the app: the last command
// of a chain ("npm run build && node app.js"), and by the runtime that command really uses
// (a Bun project can start with node, which ignores BUN_OPTIONS).
export function withHook(start: string, lang: string) {
  const at = Math.max(start.lastIndexOf('&&') + 1, start.lastIndexOf(';'));
  const head = at > 0 ? start.slice(0, at + 1).trimEnd() + ' ' : '';
  const last = start.slice(head.length).trimStart();
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?start\b/.test(last)) return start; // the start script has it
  if (/^node\s/.test(last)) return `${head}${last.replace(/^node\s+/, 'node --require vallkey/auto ')}`;
  if (/^bun\s/.test(last))
    return `${head}${last.replace(/^bun\s+(?:run\s+)?/, 'bun --preload vallkey/auto ')}`;
  return `${head}${lang === 'bun' ? "BUN_OPTIONS='--preload vallkey/auto'" : "NODE_OPTIONS='--require vallkey/auto'"} ${last}`;
}

const hookedCommand = (command: string, lang: string) => {
  if (command.includes('vallkey/auto')) return command;
  if (lang !== 'ruby') return withHook(command, lang);
  return /\bruby\s/.test(command)
    ? command.replace(/\bruby\s/, 'ruby -rvallkey/auto ')
    : `RUBYOPT=-rvallkey/auto ${command}`;
};

interface StartEdit {
  file: string;
  before: string;
  after: string;
}

// Lambda adds your code and layers to Python's path after Python has started, so the
// package's own startup never runs there and the ghost key goes straight to the provider.
// The handler has to import it. Comes after any docstring and __future__ import, which
// must stay first to mean anything.
const LAMBDA_FILES = ['template.yaml', 'template.yml', 'serverless.yml', 'serverless.yaml'];
const PYTHON_HOOK = /^\s*(?:import\s+vallkey\.auto|from\s+vallkey\s+import\s+auto)\b/m;

export function pythonHead(text: string) {
  return (
    /^(?:[ \t]*(?:#.*)?\r?\n)*(?:[rRuU]?(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"[^"\n]*"|'[^'\n]*')[ \t]*\r?\n)?(?:[ \t]*(?:#.*)?\r?\n|from __future__ import .*\r?\n)*/.exec(
      text,
    )?.[0] ?? ''
  );
}

async function lambdaEdits(cwd: string, names: Set<string>) {
  const edits: StartEdit[] = [];
  const warnings: string[] = [];
  for (const template of LAMBDA_FILES) {
    if (!names.has(template)) continue;
    const text = await readFile(join(cwd, template), 'utf8');
    if (!/^\s*runtime:\s*['"]?python/im.test(text)) continue;
    const roots = [
      '.',
      ...[...text.matchAll(/^\s*CodeUri:\s*['"]?([\w./-]+)/gim)]
        .map((m) => m[1])
        .filter((dir) => !dir.startsWith('/') && !dir.split('/').includes('..')),
    ];
    const handlers = [...text.matchAll(/^\s*handler:\s*['"]?([\w./-]+)\.\w+['"]?\s*$/gim)].map((m) =>
      m[1].replace(/\./g, '/').replace(/^\/+/, ''),
    );
    const files = new Set<string>();
    for (const handler of handlers)
      for (const root of roots) {
        const file = join(root, `${handler}.py`);
        const source = await readFile(join(cwd, file), 'utf8').catch(() => null);
        if (source === null) continue;
        files.add(file);
        if (!PYTHON_HOOK.test(source) && !edits.some((e) => e.file === file)) {
          const before = pythonHead(source);
          edits.push({ file, before, after: `${before}import vallkey.auto\n` });
        }
        break;
      }
    if (!files.size)
      warnings.push(
        `${template} runs Python on AWS Lambda. Add this as the first line of your handler file: import vallkey.auto`,
      );
  }
  return { edits, warnings };
}

// Platforms often ignore package.json: a Procfile, a Dockerfile or the platform's own file
// says what really runs. A hook added only to the start script would then never load, while
// everything looks connected, so each of these is found and changed too.
export async function startEdits(cwd: string, names: Set<string>, lang: string) {
  if (lang === 'python') return lambdaEdits(cwd, names);
  const edits: StartEdit[] = [];
  const warnings: string[] = [];
  const read = (file: string) => (names.has(file) ? readFile(join(cwd, file), 'utf8') : '');
  const flag = lang === 'bun' ? ['--preload', 'vallkey/auto'] : ['--require', 'vallkey/auto'];

  // Every process, not only web: a worker holds keys too. release runs once, at deploy.
  for (const m of (await read('Procfile')).matchAll(/^(?!release:)([\w-]+):[ \t]*(.+?)[ \t]*$/gm)) {
    const after = hookedCommand(m[2], lang);
    if (after !== m[2]) edits.push({ file: 'Procfile', before: m[0], after: `${m[1]}: ${after}` });
  }
  if (lang !== 'ruby') {
    const quoted = /("startCommand"\s*:\s*)("(?:[^"\\]|\\.)*")/.exec(await read('railway.json'));
    if (quoted) {
      const command: string = JSON.parse(quoted[2]);
      const after = hookedCommand(command, lang);
      if (after !== command)
        edits.push({ file: 'railway.json', before: quoted[0], after: quoted[1] + JSON.stringify(after) });
    }
    const toml = /^([ \t]*startCommand[ \t]*=[ \t]*)(["'])(.+?)\2[ \t]*$/m.exec(await read('railway.toml'));
    if (toml) {
      const after = hookedCommand(toml[3], lang);
      if (after !== toml[3])
        edits.push({
          file: 'railway.toml',
          before: toml[0],
          after: `${toml[1]}${toml[2]}${after}${toml[2]}`,
        });
    }
    for (const m of (await read('render.yaml')).matchAll(
      /^([ \t]*(?:- )?startCommand:[ \t]*)(["']?)(.+?)\2[ \t]*$/gm,
    )) {
      const after = hookedCommand(m[3], lang);
      if (after !== m[3])
        edits.push({ file: 'render.yaml', before: m[0], after: `${m[1]}${m[2]}${after}${m[2]}` });
    }
    // What runs is the last ENTRYPOINT, or else the last CMD, of the final stage.
    const docker = (await read('Dockerfile')).split(/^(?=\s*FROM\s)/im).pop() ?? '';
    const runs = [...docker.matchAll(/^[ \t]*(ENTRYPOINT|CMD)[ \t]+(.+?)[ \t]*$/gim)];
    const run = runs.filter((m) => /entrypoint/i.test(m[1])).pop() ?? runs.pop();
    if (run && !run[2].includes('vallkey/auto')) {
      let list: unknown = null;
      try {
        list = JSON.parse(run[2]);
      } catch {
        /* shell form */
      }
      if (Array.isArray(list)) {
        if (list[0] === 'node' || list[0] === 'bun') {
          const runtime = list[0] === 'bun' ? ['--preload', 'vallkey/auto'] : ['--require', 'vallkey/auto'];
          const rest = list[0] === 'bun' && list[1] === 'run' ? list.slice(2) : list.slice(1);
          const after = run[0].replace(run[2], JSON.stringify([list[0], ...runtime, ...rest]));
          edits.push({ file: 'Dockerfile', before: run[0], after });
        } else if (!(list.length > 1 && /^(npm|pnpm|yarn|bun)$/.test(list[0]) && /start$/.test(list.at(-1))))
          warnings.push(
            `Your Dockerfile runs ${list[0]}. Add this before it: ENV ${lang === 'bun' ? 'BUN_OPTIONS' : 'NODE_OPTIONS'}="${flag.join(' ')}"`,
          );
      } else {
        const after = hookedCommand(run[2], lang);
        if (after !== run[2])
          edits.push({ file: 'Dockerfile', before: run[0], after: run[0].replace(run[2], after) });
      }
    }
    for (const file of ['ecosystem.config.js', 'ecosystem.config.cjs'])
      if (names.has(file) && !(await read(file)).includes('vallkey/auto'))
        warnings.push(`In ${file}, add to each app: node_args: '${flag.join(' ')}'`);
  }
  return { edits, warnings };
}

// Shows each change, or with consent makes it. False when one is still to do.
async function applyStartEdits(cwd: string, names: Set<string>, lang: string, flags: Flags) {
  const preview = Boolean(flags.print) || (!flags.yes && !process.stdin.isTTY);
  const { edits, warnings } = await startEdits(cwd, names, lang);
  let done = true;
  for (const edit of edits) {
    if (preview) {
      out(`     In ${edit.file}:`);
      out(`       ${cyan(edit.after.trim())}`);
    } else if (await confirm(`  Change ${edit.file} to: ${edit.after.trim()}`, { yes: flags.yes })) {
      const text = await readFile(join(cwd, edit.file), 'utf8');
      await writeFile(
        join(cwd, edit.file),
        text.replace(edit.before, () => edit.after),
      );
      out(`  ${green('✓')} Updated ${edit.file}`);
    } else done = false;
  }
  for (const warning of warnings) out(`  ${yellow('!')} ${warning}`);
  return done && !warnings.length;
}

// Vercel functions have no start command, so the hook is a line in each one. A line that
// goes after a shebang and any directive, which must stay first to mean anything.
const FUNCTION = /\.(?:js|mjs|cjs|ts|mts|cts|rb)$/;
async function functionFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries
      .filter((e) => !e.name.startsWith('_') && !e.name.startsWith('.') && !/\.d\.ts$/.test(e.name))
      .map(async (e) => {
        if (e.isDirectory()) return functionFiles(join(dir, e.name));
        return FUNCTION.test(e.name) ? [join(dir, e.name)] : [];
      }),
  );
  return files.flat();
}

export function withHookLine(file: string, text: string) {
  const esm = /\.(?:mjs|ts|mts)$/.test(file) || /^\s*(?:import|export)\s/m.test(text);
  const line = file.endsWith('.rb')
    ? 'require "vallkey/auto"'
    : esm
      ? "import 'vallkey/auto';"
      : "require('vallkey/auto');";
  const head = /^(?:#!.*\n)?(?:(['"])use \w+\1;?[ \t]*\r?\n)*/.exec(text)?.[0] ?? '';
  return `${head}${line}\n${text.slice(head.length)}`;
}

async function packageJson(cwd: string): Promise<ProjectPackage | null> {
  try {
    return JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function installCommand(lang: string, names: Set<string>) {
  if (lang === 'node') {
    if (names.has('pnpm-lock.yaml')) return 'pnpm add vallkey';
    if (names.has('yarn.lock')) return 'yarn add vallkey';
    return 'npm install vallkey';
  }
  if (lang === 'bun') return 'bun add vallkey';
  if (lang === 'python') {
    if (names.has('uv.lock')) return 'uv add vallkey';
    if (names.has('poetry.lock')) return 'poetry add vallkey';
    return 'pip install vallkey';
  }
  return LANGUAGES[lang].install?.[0] ?? null;
}

// vallkey on a line of requirements.txt, and not vallkey-something.
const LISTED = /^\s*vallkey(?![\w-])/im;

// The project's own virtual environment, where pip has to install for the app to see it.
async function venvPython(cwd: string) {
  // An activated environment is the one the person is using, wherever it lives.
  const dirs = [process.env.VIRTUAL_ENV, ...['.venv', 'venv', 'env'].map((d) => join(cwd, d))];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const bin of [join(dir, 'bin', 'python'), join(dir, 'Scripts', 'python.exe')])
      if (await exists(bin)) return bin;
  }
  return null;
}

// Looks in the environment's folders and never runs its Python: doctor and previews are
// read-only, and in a cloned project that interpreter could be anything.
async function inEnvironment(py: string, name: RegExp) {
  const root = resolve(py, '..', '..');
  const versions = await readdir(join(root, 'lib')).catch(() => [] as string[]);
  for (const site of [
    join(root, 'Lib', 'site-packages'),
    ...versions.map((v) => join(root, 'lib', v, 'site-packages')),
  ])
    if ((await readdir(site).catch(() => [] as string[])).some((entry) => name.test(entry))) return true;
  return false;
}

// Whether the app can already load the package, so nothing needs installing.
export async function installed(lang: string, cwd: string, names: Set<string>) {
  if (lang === 'node' || lang === 'bun') {
    try {
      createRequire(join(cwd, 'package.json')).resolve('vallkey/auto');
      return true;
    } catch {
      return false;
    }
  }
  if (lang === 'python') {
    // Listed for deploys, and present in the local environment when there is one.
    const listed = names.has('requirements.txt')
      ? LISTED.test(await readFile(join(cwd, 'requirements.txt'), 'utf8'))
      : names.has('pyproject.toml') &&
        /["']vallkey(?![\w-])/.test(await readFile(join(cwd, 'pyproject.toml'), 'utf8'));
    const py = await venvPython(cwd);
    return listed && (!py || (await inEnvironment(py, /^vallkey-.*\.dist-info$/)));
  }
  if (lang === 'ruby' && names.has('Gemfile.lock'))
    return /^ {4}vallkey \(/m.test(await readFile(join(cwd, 'Gemfile.lock'), 'utf8'));
  return false;
}

function runCommand(command: string, cwd: string) {
  const [file, ...args] = command.split(' ');
  // Fixed commands only (no user input), so a shell on Windows is safe and finds npm.cmd.
  execFileSync(file, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

// Step 1 of most setups: show the install command, or with consent run it.
async function installStep(lang: string, cwd: string, names: Set<string>, flags: Flags) {
  const command = installCommand(lang, names) ?? 'npm install vallkey';
  if (await installed(lang, cwd, names)) {
    out(`  1. ${green('✓')} The vallkey package is installed`);
    return true;
  }
  // pip without a project environment: installing would go to the wrong Python.
  const pip = lang === 'python' && command === 'pip install vallkey';
  const py = pip ? await venvPython(cwd) : null;
  // No terminal to ask in and no --yes (CI, scripts): show it, as before, and change nothing.
  const preview = Boolean(flags.print) || (!flags.yes && !process.stdin.isTTY);
  if (preview || (pip && !py && !names.has('requirements.txt'))) {
    out(`  1. ${cyan(command)}`);
    if (lang === 'python')
      out(
        dim(
          '     Add vallkey to your project dependencies and install it in the virtual environment used by the app.',
        ),
      );
    // A preview is complete as shown; otherwise this step is still to do.
    return preview;
  }
  const doing = pip
    ? [
        names.has('requirements.txt') && 'add vallkey to requirements.txt',
        py && `run pip install vallkey in ${relative(cwd, resolve(py, '../..'))}`,
      ]
        .filter(Boolean)
        .join(' and ')
    : `run ${command}`;
  if (!(await confirm(`  Install the vallkey package: ${doing}?`, { yes: flags.yes }))) {
    out(`  1. ${cyan(command)}`);
    return false;
  }
  try {
    if (pip) {
      // Installed first: a failure leaves the project as it was.
      if (py && (await inEnvironment(py, /^pip$/)))
        execFileSync(py, ['-m', 'pip', 'install', 'vallkey'], { cwd, stdio: 'inherit' });
      // Environments made by uv have no pip of their own.
      else if (py)
        execFileSync('uv', ['pip', 'install', '--python', py, 'vallkey'], { cwd, stdio: 'inherit' });
      if (names.has('requirements.txt')) {
        const text = await readFile(join(cwd, 'requirements.txt'), 'utf8');
        if (!LISTED.test(text))
          await appendFile(
            join(cwd, 'requirements.txt'),
            `${text && !text.endsWith('\n') ? '\n' : ''}vallkey\n`,
          );
      }
    } else runCommand(command, cwd);
  } catch {
    throw new CliError(`Installing the vallkey package failed. Run it yourself: ${command}`);
  }
  out(`  1. ${green('✓')} Installed the vallkey package`);
  // pip cannot edit pyproject.toml, and a deploy would not have the package without it.
  if (pip && !names.has('requirements.txt'))
    out(`     ${yellow('!')} Add vallkey to your project dependencies too, so deployed apps get it.`);
  if (pip && !py && names.has('requirements.txt'))
    out(
      dim('     Added to requirements.txt. Install it where the app runs: pip install -r requirements.txt'),
    );
  return true;
}

export function phpFile({
  version,
  zts,
  musl,
  arch,
}: {
  version: string;
  zts: boolean;
  musl: boolean;
  arch?: string;
}) {
  const flavor = zts ? 'zts-gnu' : musl ? 'musl' : 'gnu';
  return `vallkey-php-${MANIFEST.version}-php${version}-${flavor}-${arch}.so`;
}

// PHP as installed here, when it is a Linux one the files were built for.
function localPhp() {
  try {
    const [version, zts, machine, os] = execFileSync(
      'php',
      [
        '-r',
        'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION."|".(PHP_ZTS ? 1 : 0)."|".php_uname("m")."|".PHP_OS_FAMILY;',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).split('|');
    if (os !== 'Linux') return { unsupported: `PHP on ${os}` };
    const arch = (
      { x86_64: 'x86_64', amd64: 'x86_64', aarch64: 'aarch64', arm64: 'aarch64' } as Record<string, string>
    )[machine];
    let musl = false;
    try {
      musl = /musl/i.test(
        execFileSync('ldd', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      );
    } catch (e) {
      musl = /musl/i.test(String(e instanceof Error && 'stderr' in e ? e.stderr : '')); // musl's ldd prints its version on stderr and fails
    }
    return { version, zts: zts === '1', musl, arch };
  } catch {
    return null;
  }
}

// PHP as the project's Dockerfile builds it (FROM php:8.4-fpm-alpine…).
function dockerPhp(dockerfile: string | null) {
  const m = /^\s*FROM\s+(?:--platform=\S+\s+)?(?:docker\.io\/)?(?:library\/)?php:(\d+\.\d+)(\S*)/im.exec(
    dockerfile ?? '',
  );
  if (!m) return null;
  return { version: m[1], zts: /zts|frankenphp/i.test(m[2]), musl: /alpine/i.test(m[2]) };
}

async function download(file: string, to: string) {
  const sum = MANIFEST.files[file];
  if (!sum) throw new CliError(`This version of vallkey has no ${file}. Update it: npx vallkey@latest hook`);
  const res = await fetch(`${downloads()}${file}`, { signal: AbortSignal.timeout(30_000) }).catch((e) => {
    throw new CliError(`Could not download ${file}: ${errorMessage(e)}`);
  });
  if (!res.ok) throw new CliError(`Could not download ${file} (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sum)
    throw new CliError(
      `${file} does not match the checksum this version of vallkey expects; it was not saved`,
    );
  await writeFile(to, bytes);
}

const envLines = (env: Record<string, string>) =>
  Object.entries(env).map(
    ([k, v]) => `${k}=${/^[A-Za-z0-9_./:=+-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`}`,
  );
const dockerEnv = (env: Record<string, string>) =>
  Object.entries(env).map(([k, v]) => `ENV ${k}=${JSON.stringify(v)}`);

export async function hook(args: string[], flags: Flags) {
  const cwd = process.cwd();
  const names = new Set(await readdir(cwd).catch(() => []));
  const asked = args[0]?.toLowerCase();
  const aliases: Record<string, string> = {
    js: 'node',
    nodejs: 'node',
    typescript: 'node',
    ts: 'node',
    py: 'python',
    rb: 'ruby',
    kotlin: 'java',
    scala: 'java',
    jvm: 'java',
    csharp: 'dotnet',
    'c#': 'dotnet',
    fsharp: 'dotnet',
    net: 'dotnet',
    '.net': 'dotnet',
    ex: 'elixir',
    erl: 'erlang',
    golang: 'go',
  };
  const langs = asked ? [aliases[asked] ?? asked] : await detect(cwd);
  if (!langs.length)
    throw new CliError(
      'Could not tell which language this project is. Name it: vallkey hook node|bun|python|ruby|java|dotnet|php|elixir|erlang',
    );
  for (const lang of langs)
    if (!LANGUAGES[lang] && !COMPILED[lang])
      throw new CliError(`Unknown language "${lang}". Choose one of: ${Object.keys(LANGUAGES).join(', ')}`);

  const dockerfile = names.has('Dockerfile') ? await readFile(join(cwd, 'Dockerfile'), 'utf8') : null;
  const dir = resolve(cwd, flags.dir ?? '.vallkey');
  const gateway = gatewayOrigin(flags.api || process.env.VALLKEY_API);
  const api = gateway === 'https://api.vallkey.com' ? null : gateway;
  let status = 0;

  for (const [i, lang] of langs.entries()) {
    if (i > 0) out();
    if (COMPILED[lang]) {
      heading(COMPILED[lang], 'no auto-connect');
      detail(
        `A compiled ${COMPILED[lang]} app cannot be changed once it is built. Set each SDK's API address instead, one line per SDK:`,
      );
      out(`  ${cyan(api ?? 'https://api.vallkey.com')}`);
      detail("Each key's Connect tab in the dashboard has the exact line for its SDK.");
      continue;
    }
    const L = LANGUAGES[lang];
    heading(L.title, 'auto-connect');
    detail('Requests that carry a ghost key go to Vallkey. Every other request is left alone.');
    out();

    // Next.js runs instrumentation.ts itself, on servers and on Vercel, where NODE_OPTIONS
    // cannot load a package the build did not bundle.
    const pkg = lang === 'node' || lang === 'bun' ? await packageJson(cwd) : null;
    if (pkg && (pkg.dependencies?.next || pkg.devDependencies?.next)) {
      // TypeScript only where the project uses it: a .ts file in a JavaScript project is out of place.
      const ext =
        (await exists(join(cwd, 'tsconfig.json'))) ||
        pkg.dependencies?.typescript ||
        pkg.devDependencies?.typescript
          ? 'ts'
          : 'js';
      let file =
        (await exists(join(cwd, 'src', 'app'))) || (await exists(join(cwd, 'src', 'pages')))
          ? join('src', `instrumentation.${ext}`)
          : `instrumentation.${ext}`;
      // Do not create a competing .ts file when the project already uses .js.
      for (const candidate of [
        file,
        file.replace(/\.[jt]s$/, ext === 'ts' ? '.js' : '.ts'),
        'instrumentation.ts',
        'instrumentation.js',
        'src/instrumentation.ts',
        'src/instrumentation.js',
      ]) {
        if (await exists(join(cwd, candidate))) {
          file = candidate;
          break;
        }
      }
      const code =
        "export async function register() {\n  // Sends server requests that carry a ghost key to Vallkey.\n  if (process.env.NEXT_RUNTIME === 'nodejs') {\n    await import('vallkey/auto');\n  }\n}\n";
      if (!(await installStep(lang, cwd, names, flags))) status = 1;
      if (await exists(join(cwd, file))) {
        out(`  2. In ${file}, inside register(), when NEXT_RUNTIME is 'nodejs':`);
        out(`       ${cyan("await import('vallkey/auto');")}`);
      } else if (flags.print) {
        out(`  2. Create ${file}:`);
        for (const line of code.trimEnd().split('\n')) out(`       ${cyan(line)}`);
      } else if (await confirm(`  Create ${file}, which Next.js runs when it starts?`, { yes: flags.yes })) {
        await writeFile(join(cwd, file), code);
        out(`  ${green('✓')} Created ${file}`);
      } else {
        status = 1;
      }
      out();
      detail('Next.js runs this file when it starts, on your own servers and on Vercel.');
      detail("Edge routes are not covered: use the SDK's API address setting there.");
      if (api) out(`  Set ${cyan(`VALLKEY_API=${api}`)} in the app's environment before starting it.`);
      continue;
    }

    // With a start script, the hook goes in it. A startup option in the host's variables
    // (NODE_OPTIONS) also reaches the build on Railway, Render and Heroku, which then
    // fails before vallkey is installed.
    // Vercel functions have no start command: the hook is the first line of each function.
    const vercel = names.has('vercel.json') || names.has('.vercel');
    if (
      vercel &&
      (lang === 'node' || lang === 'bun' || lang === 'ruby') &&
      !(lang !== 'ruby' && pkg?.scripts?.start)
    ) {
      const line =
        lang === 'ruby'
          ? 'require "vallkey/auto"'
          : `import 'vallkey/auto'   ${dim("// or require('vallkey/auto')")}`;
      if (!(await installStep(lang, cwd, names, flags))) status = 1;
      const functions = (await functionFiles(join(cwd, 'api'))).filter((f) =>
        lang === 'ruby' ? f.endsWith('.rb') : !f.endsWith('.rb'),
      );
      const missing = [];
      for (const file of functions)
        if (!(await readFile(file, 'utf8')).includes('vallkey/auto')) missing.push(file);
      const preview = Boolean(flags.print) || (!flags.yes && !process.stdin.isTTY);
      if (functions.length && !missing.length) out(`  2. ${green('✓')} Each function loads auto-connect.`);
      else if (
        !preview &&
        missing.length &&
        (await confirm(`  Add auto-connect to the top of ${missing.length} function file(s) in api/?`, {
          yes: flags.yes,
        }))
      ) {
        for (const file of missing) await writeFile(file, withHookLine(file, await readFile(file, 'utf8')));
        out(`  2. ${green('✓')} Added auto-connect to ${missing.length} function file(s)`);
      } else {
        if (!preview && missing.length) status = 1;
        out(
          `  2. Make this the first line of each function${lang === 'ruby' ? ' (api/*.rb)' : ' (api/*.js, api/*.ts)'}:`,
        );
        out(`       ${cyan(line)}`);
      }
      out('  3. Redeploy.');
      out();
      detail('Not in Vercel variables: they also apply to the build, which then fails.');
      if (api) detail(`Also set VALLKEY_API=${api} in the project's variables.`);
      detail('Optional: VALLKEY_ENV=production names this app in vallkey status and the dashboard.');
      continue;
    }

    const start = pkg?.scripts?.start;
    if (start && (lang === 'node' || lang === 'bun')) {
      const flag = lang === 'bun' ? '--preload vallkey/auto' : '--require vallkey/auto';
      const loaded = start.includes('vallkey/auto');
      const updated = loaded ? start : withHook(start, lang);
      if (!(await installStep(lang, cwd, names, flags))) status = 1;
      if (loaded) {
        out(`  2. ${green('✓')} Your start script already turns on auto-connect.`);
      } else if (flags.print) {
        out('  2. Load it when your app starts. In package.json:');
        out(`       ${cyan(`"start": ${JSON.stringify(updated)}`)}`);
      } else if (
        await confirm(`  Change the start script in package.json to: ${updated}`, { yes: flags.yes })
      ) {
        const text = await readFile(join(cwd, 'package.json'), 'utf8');
        // Only the start script's value changes; the rest of the file keeps its formatting.
        const edited = text.replace(
          /("start"\s*:\s*)"(?:[^"\\]|\\.)*"/,
          (_, key) => key + JSON.stringify(updated),
        );
        let ok = false;
        try {
          ok = JSON.parse(edited).scripts?.start === updated;
        } catch {
          /* left as it was */
        }
        if (!ok)
          throw new CliError(
            'Could not find the start script in package.json. Change it by hand, as shown above.',
          );
        await writeFile(join(cwd, 'package.json'), edited);
        out(`  2. ${green('✓')} Updated the start script in package.json`);
      } else {
        status = 1;
      }
      if (!(await applyStartEdits(cwd, names, lang, flags))) status = 1;
      out(`  3. Restart or redeploy the app.`);
      out();
      detail(
        `Does your host run another command, from its dashboard for example? That one needs ${flag} too, or set ${lang === 'bun' ? 'BUN_OPTIONS' : 'NODE_OPTIONS'}='${flag}' where the app runs. vallkey verify shows if it worked.`,
      );
      detail(
        'Not in Railway, Render, Heroku or Vercel variables: they also apply to the build, which then fails.',
      );
      if (api) detail(`Also set VALLKEY_API=${api} in the app's environment.`);
      detail('Optional: VALLKEY_ENV=production names this app in vallkey status and the dashboard.');
      continue;
    }

    // Ruby apps on Railway, Render and Heroku start from a Procfile: the hook goes on its web line.
    const web =
      lang === 'ruby' && names.has('Procfile')
        ? /^web:\s*(.+)$/m.exec(await readFile(join(cwd, 'Procfile'), 'utf8'))?.[1]?.trim()
        : null;
    if (web) {
      if (!(await installStep(lang, cwd, names, flags))) status = 1;
      if (web.includes('vallkey/auto'))
        out(`  2. ${green('✓')} Your Procfile already turns on auto-connect.`);
      else {
        out('  2. Load it when your app starts:');
        if (!(await applyStartEdits(cwd, names, lang, flags))) status = 1;
      }
      out('  3. Restart or redeploy the app.');
      out();
      detail('Using Docker or your own server? Setting RUBYOPT=-rvallkey/auto where the app runs works too.');
      detail(
        'Not in Railway, Render, Heroku or Vercel variables: they also apply to the build, which then fails.',
      );
      if (api) detail(`Also set VALLKEY_API=${api} in the app's environment.`);
      detail('Optional: VALLKEY_ENV=production names this app in vallkey status and the dashboard.');
      continue;
    }

    let env: Record<string, string> = {};
    const install = installCommand(lang, names);
    let docker: string[] = [];

    if (lang === 'php') {
      const local = localPhp();
      const built = dockerPhp(dockerfile);
      if (built) {
        const sums = ['x86_64', 'aarch64']
          .map((arch) => phpFile({ ...built, arch }))
          .map((f) => `${MANIFEST.files[f]}  ${f}`);
        const file = phpFile({ ...built, arch: '$(uname -m)' });
        docker = [
          `RUN mkdir -p /opt/vallkey/php && cd /opt/vallkey/php \\`,
          ` && curl -fsSL -o vallkey.so ${downloads()}${file} \\`,
          ` && printf '${sums.join('\\n')}\\n' | grep -- "-$(uname -m).so$" | sed "s/  .*/  vallkey.so/" | sha256sum -c - \\`,
          ` && echo "extension=/opt/vallkey/php/vallkey.so" > vallkey.ini`,
          ...dockerEnv(L.env('/opt/vallkey/php')),
        ];
      }
      if (local && !local.unsupported && local.arch) {
        const file = phpFile(local);
        if (!flags.print) {
          await mkdir(join(dir, 'php'), { recursive: true });
          await download(file, join(dir, 'php', 'vallkey.so'));
          await writeFile(join(dir, 'php', 'vallkey.ini'), `extension=${join(dir, 'php', 'vallkey.so')}\n`);
          out(
            `  ${green('✓')} Downloaded the extension for PHP ${local.version}${local.zts ? ' (thread safe)' : ''} to ${relative(cwd, join(dir, 'php'))}`,
          );
        }
        env = L.env(join(dir, 'php'));
      } else if (!built) {
        out(
          `  ${yellow('!')} ${local?.unsupported ? `Built for Linux; ${local.unsupported} is not one of them.` : 'No PHP found here.'} In your Linux image or server, run this there,`,
        );
        out(
          '    or download the file for its PHP from https://vallkey.com/docs/ and load it with an .ini file.',
        );
        status = 1;
        continue;
      }
    } else if (L.file) {
      const file = L.file();
      if (!L.as) throw new CliError(`Missing hook filename for ${lang}`);
      const path = join(dir, L.as);
      docker = [
        `ADD --checksum=sha256:${MANIFEST.files[file]} ${downloads()}${file} /opt/vallkey/${L.as}`,
        ...dockerEnv(L.env(`/opt/vallkey/${L.as}`)),
      ];
      if (!flags.print) {
        await mkdir(dir, { recursive: true });
        await download(file, path);
        out(
          `  ${green('✓')} Downloaded ${L.as} to ${relative(cwd, dir) || '.'} ${dim('(checksum verified)')}`,
        );
      }
      env = L.env(path);
    } else {
      env = L.env('');
    }

    // A hook file has to be inside the deployed app. A Dockerfile puts it there; host
    // variables cannot, and on Railway, Render or Heroku they also reach the build,
    // which runs Java or .NET itself before the file exists, and fails.
    if (docker.length && L.file) {
      out(`  ${bold('With Docker')} ${dim('(Render, Fly.io, Heroku, or Railway with a Dockerfile)')}`);
      out(
        `  In ${dockerfile ? 'your' : 'a'} Dockerfile, in the final stage ${dim('(the first line must be # syntax=docker/dockerfile:1)')}:`,
      );
      for (const line of docker) out(`       ${cyan(line)}`);
      out();
      // Railway builds without Docker through Railpack: railpack.json copies the file into the
      // deployed app and sets the variable for the running app only, never for the build.
      if (lang === 'java' || lang === 'dotnet') {
        if (!L.as) throw new CliError(`Missing hook filename for ${lang}`);
        const folder = relative(cwd, dir) || '.vallkey';
        const [name, value] = Object.entries(L.env(`/app/${relative(cwd, join(dir, L.as))}`))[0];
        const railpack = [
          '{',
          '  "deploy": {',
          `    "inputs": ["...", { "local": true, "include": [${JSON.stringify(folder)}] }],`,
          `    "variables": { ${JSON.stringify(name)}: ${JSON.stringify(value)} }`,
          '  }',
          '}',
        ].join('\n');
        out(`  ${bold('Railway without Docker')}`);
        out(
          `  Commit the ${folder} folder, and ${names.has('railpack.json') ? 'add this to your' : 'add a'} railpack.json:`,
        );
        for (const line of railpack.split('\n')) out(`       ${cyan(line)}`);
        out(
          `     ${dim('It copies the file into the deployed app, and sets the variable for the running app only.')}`,
        );
        out();
      }
      out(`  ${bold('This computer or your own server')}`);
      out('  Set this where the app starts:');
      for (const line of envLines(env)) out(`       ${cyan(line)}`);
      out(`     ${dim('Already set? Add this to the value you have, rather than replacing it.')}`);
      if (api) out(`       ${cyan(`VALLKEY_API=${api}`)}`);
      out();
      out('  Then restart or redeploy the app.');
      out();
      detail(
        lang === 'java' || lang === 'dotnet'
          ? `Not in the Railway, Render or Heroku dashboard variables: their builds run ${L.title.split(' ')[0]} too, before the file exists, and fail.`
          : 'A host variable alone does not work on Railway, Render or Heroku: the file is not in the deployed app.',
      );
      detail('Optional: VALLKEY_ENV=production names this app in vallkey status and the dashboard.');
      detail('VALLKEY_DEBUG=1 logs each request sent to Vallkey. VALLKEY_AUTO=0 turns auto-connect off.');
      continue;
    }

    let n = 1;
    if (install) {
      if (!(await installStep(lang, cwd, names, flags))) status = 1;
      n++;
    }
    if (
      (lang === 'node' || lang === 'bun' || lang === 'python') &&
      !(await applyStartEdits(cwd, names, lang, flags))
    )
      status = 1;
    if (env) {
      out(`  ${n++}. Set this in your app's environment (hosting dashboard, process manager or shell):`);
      for (const line of envLines(env)) out(`       ${cyan(line)}`);
      if (api && lang === 'python') out(`       ${cyan(`VALLKEY_API=${api}`)}`);
      // The installed vallkey 0.3 reads it when Python starts, before python-dotenv and
      // similar load .env, so a value there is never seen.
      if (lang === 'python')
        out(dim('     Not in a .env file: Python reads it when it starts, before your app loads .env.'));
      // Variables that often hold other options already: add to them, do not replace them.
      if (
        Object.keys(env).some((k) =>
          [
            'NODE_OPTIONS',
            'BUN_OPTIONS',
            'RUBYOPT',
            'JAVA_TOOL_OPTIONS',
            'DOTNET_STARTUP_HOOKS',
            'ELIXIR_ERL_OPTIONS',
            'ERL_FLAGS',
            'PHP_INI_SCAN_DIR',
          ].includes(k),
        )
      ) {
        out(`     ${dim('Already set? Add this to the value you have, rather than replacing it.')}`);
      }
    }
    if (docker.length) {
      out(
        `     Or, in ${dockerfile ? 'your' : 'a'} Dockerfile${lang === 'php' ? '' : ` ${dim('(its first line must be # syntax=docker/dockerfile:1)')}`}:`,
      );
      for (const line of docker) out(`       ${cyan(line)}`);
    } else if (dockerfile && env) {
      out('     Or, in your Dockerfile:');
      for (const line of dockerEnv(env)) out(`       ${cyan(line)}`);
    }
    if (api && lang !== 'python') out(`       ${cyan(`VALLKEY_API=${api}`)}`);
    out(`  ${n}. Restart the app.`);
    out();
    if (lang === 'ruby' || lang === 'node' || lang === 'bun') {
      detail(
        'Not in Railway, Render, Heroku or Vercel variables: they also apply to the build, which then fails.',
      );
      detail('Put it in your start command there instead, or on Vercel, on the first line of each function.');
    }
    if (lang === 'python')
      detail(
        'On AWS Lambda, Python starts before it can see your packages: make import vallkey.auto the first line of your handler file.',
      );
    detail('Optional: VALLKEY_ENV=production names this app in vallkey status and the dashboard.');
    detail('VALLKEY_DEBUG=1 logs each request sent to Vallkey. VALLKEY_AUTO=0 turns auto-connect off.');
  }
  // vallkey connect prints its own "Then check it".
  if (!flags.embedded && !status) {
    next([`Restart your app, then ${cyan('npx vallkey verify')} and make one safe request`]);
  }
  return status;
}
