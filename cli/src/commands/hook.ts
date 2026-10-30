import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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
      out(`  1. ${cyan(installCommand(lang, names))}`);
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
      out(`  1. ${cyan(installCommand(lang, names) ?? 'npm install vallkey')}`);
      out(
        `  2. Make this the first line of each function${lang === 'ruby' ? ' (api/*.rb)' : ' (api/*.js, api/*.ts)'}:`,
      );
      out(`       ${cyan(line)}`);
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
      const runner = lang === 'bun' ? /^bun\s+(?:run\s+)?/ : /^node\s+/;
      const updated = loaded
        ? start
        : runner.test(start)
          ? start.replace(runner, `${lang} ${flag} `)
          : `${lang === 'bun' ? 'BUN_OPTIONS' : 'NODE_OPTIONS'}='${flag}' ${start}`;
      out(`  1. ${cyan(installCommand(lang, names))}`);
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
      out(`  3. Restart or redeploy the app.`);
      out();
      detail(
        `Using Docker or your own server? Setting ${lang === 'bun' ? 'BUN_OPTIONS' : 'NODE_OPTIONS'}='${flag}' where the app runs works too.`,
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
      const updated = web.includes('vallkey/auto')
        ? web
        : /\bruby\s/.test(web)
          ? web.replace(/\bruby\s/, 'ruby -rvallkey/auto ')
          : `RUBYOPT=-rvallkey/auto ${web}`;
      out(`  1. ${cyan(installCommand(lang, names))}`);
      if (web === updated) out(`  2. ${green('✓')} Your Procfile already turns on auto-connect.`);
      else {
        out('  2. Load it when your app starts. In your Procfile:');
        out(`       ${cyan(`web: ${updated}`)}`);
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
    const steps = [];
    const install = installCommand(lang, names);
    if (install) steps.push(install);
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
    for (const step of steps) out(`  ${n++}. ${cyan(step)}`);
    if (lang === 'python')
      out(
        dim(
          '     Add vallkey to your project dependencies and install it in the virtual environment used by the app.',
        ),
      );
    if (env) {
      out(`  ${n++}. Set this in your app's environment (hosting dashboard, process manager or shell):`);
      for (const line of envLines(env)) out(`       ${cyan(line)}`);
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
    if (api) out(`       ${cyan(`VALLKEY_API=${api}`)}`);
    out(`  ${n}. Restart the app.`);
    out();
    if (lang === 'ruby' || lang === 'node' || lang === 'bun') {
      detail(
        'Not in Railway, Render, Heroku or Vercel variables: they also apply to the build, which then fails.',
      );
      detail('Put it in your start command there instead, or on Vercel, on the first line of each function.');
    }
    detail('Optional: VALLKEY_ENV=production names this app in vallkey status and the dashboard.');
    detail('VALLKEY_DEBUG=1 logs each request sent to Vallkey. VALLKEY_AUTO=0 turns auto-connect off.');
  }
  // vallkey connect prints its own "Then check it".
  if (!flags.embedded && !status) {
    next([
      `After a request from your app: ${cyan('npx vallkey verify <key id> --request-id <x-guard-request-id>')}`,
    ]);
  }
  return status;
}
