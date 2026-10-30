import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { detect, phpFile } from '../src/commands/hook.js';

const BIN = new URL('../bin/vallkey.js', import.meta.url).pathname;
const MANIFEST = JSON.parse(await readFile(new URL('../src/hooks.json', import.meta.url), 'utf8'));
// The hook files as committed (built by scripts/build-hooks.mjs).
const FILES = new URL(`../../artifacts/hooks/${MANIFEST.version}/`, import.meta.url).pathname;

function run(args, { cwd, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { PATH: process.env.PATH, NO_COLOR: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end('');
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function project(files) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'vallkey-hook-'))); // macOS: /var is /private/var
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

describe('vallkey hook', () => {
  let server;
  let base;
  let tampered = false;
  const dirs = [];

  before(async () => {
    server = createServer(async (req, res) => {
      try {
        const body = await readFile(join(FILES, decodeURIComponent(req.url.slice(1))));
        res.end(tampered ? Buffer.concat([body, Buffer.from('x')]) : body);
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/`;
  });
  after(async () => {
    server.close();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
  const make = async (files) => {
    const d = await project(files);
    dirs.push(d);
    return d;
  };

  it('has a committed file matching every checksum it carries', async () => {
    for (const [file, sum] of Object.entries(MANIFEST.files)) {
      assert.equal(createHash('sha256').update(await readFile(join(FILES, file))).digest('hex'), sum, file);
    }
  });

  it("tells a project's language from its files, and a frontend's package.json from the app's", async () => {
    assert.deepEqual(await detect(await make({ 'package.json': '{}' })), ['node']);
    assert.deepEqual(await detect(await make({ 'package.json': '{}', 'bun.lock': '' })), ['bun']);
    assert.deepEqual(await detect(await make({ 'composer.json': '{}', 'package.json': '{}' })), ['php']);
    assert.deepEqual(await detect(await make({ Gemfile: '', 'package.json': '{}' })), ['ruby']);
    assert.deepEqual(await detect(await make({ 'pyproject.toml': '' })), ['python']);
    assert.deepEqual(await detect(await make({ 'build.gradle.kts': '' })), ['java']);
    assert.deepEqual(await detect(await make({ 'Api.csproj': '' })), ['dotnet']);
    assert.deepEqual(await detect(await make({ 'mix.exs': '' })), ['elixir']);
    assert.deepEqual(await detect(await make({ 'go.mod': '' })), ['go']);
  });

  it('downloads the Java agent, checks it, and gives the variable with its path', async () => {
    const cwd = await make({ 'pom.xml': '<project/>' });
    const r = await run(['hook'], { cwd, env: { VALLKEY_DOWNLOADS: base } });
    assert.equal(r.code, 0, r.stderr);
    const jar = join(cwd, '.vallkey', 'vallkey-agent.jar');
    assert.equal(createHash('sha256').update(await readFile(jar)).digest('hex'), MANIFEST.files[`vallkey-agent-${MANIFEST.version}.jar`]);
    assert.match(r.stdout, new RegExp(`JAVA_TOOL_OPTIONS=-javaagent:${jar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('refuses a file that does not match its checksum, and saves nothing', async () => {
    tampered = true;
    try {
      const cwd = await make({ 'App.csproj': '' });
      const r = await run(['hook'], { cwd, env: { VALLKEY_DOWNLOADS: base } });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /does not match the checksum/);
      assert.deepEqual(await readdir(join(cwd, '.vallkey')), []);
    } finally {
      tampered = false;
    }
  });

  it('gives Dockerfile lines that check what they download', async () => {
    const cwd = await make({ 'mix.exs': '', Dockerfile: 'FROM elixir:1.19\n' });
    const r = await run(['hook', '--print'], { cwd, env: { VALLKEY_DOWNLOADS: base } });
    assert.equal(r.code, 0, r.stderr);
    const beam = `vallkey_auto-${MANIFEST.version}.beam`;
    assert.ok(r.stdout.includes(`ADD --checksum=sha256:${MANIFEST.files[beam]} ${base}${beam} /opt/vallkey/vallkey_auto.beam`));
    assert.ok(r.stdout.includes('ENV ELIXIR_ERL_OPTIONS="-eval catch(code:load_abs(\\"/opt/vallkey/vallkey_auto\\")),catch(vallkey_auto:start())."'));
    assert.equal(await readdir(cwd).then((n) => n.includes('.vallkey')), false); // --print downloads nothing
  });

  it("picks the PHP build for the Dockerfile's PHP, for either processor", async () => {
    const cwd = await make({ 'composer.json': '{}', Dockerfile: 'FROM php:8.4-fpm-alpine AS app\n' });
    const r = await run(['hook', '--print'], { cwd, env: { VALLKEY_DOWNLOADS: base } });
    for (const arch of ['x86_64', 'aarch64']) {
      const file = phpFile({ version: '8.4', zts: false, musl: true, arch });
      assert.ok(MANIFEST.files[file], file);
      assert.ok(r.stdout.includes(`${MANIFEST.files[file]}  ${file}`), file);
    }
    assert.ok(r.stdout.includes(`${base}vallkey-php-${MANIFEST.version}-php8.4-musl-$(uname -m).so`));
    assert.ok(r.stdout.includes('ENV PHP_INI_SCAN_DIR=":/opt/vallkey/php"'));
  });

  it('puts the hook in the start script, since host variables also reach the build', async () => {
    const cwd = await make({ 'package.json': JSON.stringify({ scripts: { start: 'node server.js' } }) });
    const printed = await run(['hook', '--print'], { cwd });
    assert.match(printed.stdout, /"start": "node --require vallkey\/auto server.js"/);
    assert.match(printed.stdout, /Not in Railway, Render, Heroku or Vercel variables/);
    assert.equal(JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).scripts.start, 'node server.js');
    const r = await run(['hook', '--yes'], { cwd });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).scripts.start, 'node --require vallkey/auto server.js');
    assert.match((await run(['hook', '--print'], { cwd })).stdout, /already turns on auto-connect/);
  });

  it('puts the setting in front of a start script that is not plain node, and handles Bun', async () => {
    const tsx = await make({ 'package.json': JSON.stringify({ scripts: { start: 'tsx server.ts' } }) });
    assert.match((await run(['hook', '--print'], { cwd: tsx })).stdout, /"start": "NODE_OPTIONS='--require vallkey\/auto' tsx server.ts"/);
    const bun = await make({ 'package.json': JSON.stringify({ scripts: { start: 'bun run server.ts' } }), 'bun.lockb': '' });
    assert.match((await run(['hook', 'bun', '--print'], { cwd: bun })).stdout, /"start": "bun --preload vallkey\/auto server.ts"/);
  });

  it('leads with the Dockerfile for hook files, and warns against host variables', async () => {
    const cwd = await make({ 'pom.xml': '<project/>' });
    const r = await run(['hook', 'java', '--print'], { cwd });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /With Docker[\s\S]*ADD --checksum=sha256:[\s\S]*ENV JAVA_TOOL_OPTIONS="-javaagent:\/opt\/vallkey\/vallkey-agent.jar"[\s\S]*This computer or your own server/);
    assert.match(r.stdout, /Not in the Railway, Render or Heroku dashboard variables: their builds run Java too/);
    assert.match(r.stdout, /Railway without Docker[\s\S]*"include": \[".vallkey"\][\s\S]*"JAVA_TOOL_OPTIONS": "-javaagent:\/app\/.vallkey\/vallkey-agent.jar"/);
  });

  it('loads the hook on the first line of each Vercel function, for Node.js and Ruby', async () => {
    const node = await make({ 'package.json': JSON.stringify({ dependencies: {} }), 'vercel.json': '{}' });
    const n = await run(['hook', '--print'], { cwd: node });
    assert.match(n.stdout, /first line of each function[\s\S]*import 'vallkey\/auto'/);
    assert.match(n.stdout, /Not in Vercel variables/);
    assert.doesNotMatch(n.stdout, /NODE_OPTIONS=/);
    const ruby = await make({ Gemfile: "source 'https://rubygems.org'", 'vercel.json': '{}' });
    assert.match((await run(['hook', 'ruby', '--print'], { cwd: ruby })).stdout, /first line of each function[\s\S]*require "vallkey\/auto"/);
  });

  it('shows the Procfile line for a Ruby app', async () => {
    const cwd = await make({ Gemfile: "source 'https://rubygems.org'", Procfile: 'web: bundle exec puma -C config/puma.rb\n' });
    const r = await run(['hook', 'ruby', '--print'], { cwd });
    assert.match(r.stdout, /web: RUBYOPT=-rvallkey\/auto bundle exec puma -C config\/puma.rb/);
    const plain = await make({ Gemfile: "source 'https://rubygems.org'", Procfile: 'web: bundle exec ruby app.rb\n' });
    assert.match((await run(['hook', 'ruby', '--print'], { cwd: plain })).stdout, /web: bundle exec ruby -rvallkey\/auto app.rb/);
  });

  it('adds instrumentation.js to a JavaScript Next.js app, not a TypeScript file', async () => {
    const cwd = await make({ 'package.json': JSON.stringify({ dependencies: { next: '16.0.0' } }), 'app/page.js': '' });
    const r = await run(['hook', '--yes'], { cwd });
    assert.equal(r.code, 0, r.stderr);
    assert.match(await readFile(join(cwd, 'instrumentation.js'), 'utf8'), /await import\('vallkey\/auto'\)/);
    await assert.rejects(readFile(join(cwd, 'instrumentation.ts')));
  });

  it('adds instrumentation.ts to a Next.js app instead of an environment variable', async () => {
    const cwd = await make({ 'package.json': JSON.stringify({ dependencies: { next: '16.0.0' } }), 'tsconfig.json': '{}', 'src/app/page.tsx': '' });
    const r = await run(['hook', '--yes'], { cwd });
    assert.equal(r.code, 0, r.stderr);
    assert.match(await readFile(join(cwd, 'src', 'instrumentation.ts'), 'utf8'), /await import\('vallkey\/auto'\)/);
    assert.doesNotMatch(r.stdout, /NODE_OPTIONS/);
  });

  it('guards the Next.js hook by runtime and keeps the staging API setting visible', async () => {
    const cwd = await make({ 'package.json': JSON.stringify({ dependencies: { next: '16.0.0' }, devDependencies: { typescript: '5' } }) });
    const r = await run(['hook', '--yes'], { cwd, env: { VALLKEY_API: 'https://api-staging.vallkey.com' } });
    assert.equal(r.code, 0, r.stderr);
    const code = await readFile(join(cwd, 'instrumentation.ts'), 'utf8');
    assert.match(code, /if \(process.env.NEXT_RUNTIME === 'nodejs'\) \{\s+await import\('vallkey\/auto'\)/);
    assert.match(r.stdout, /VALLKEY_API=https:\/\/api-staging.vallkey.com/);
    assert.match(r.stdout, /Edge routes are not covered/);
  });

  it('says what to set for the languages installed from their own registries', async () => {
    const node = await run(['hook'], { cwd: await make({ 'package.json': '{}', 'pnpm-lock.yaml': '' }) });
    assert.match(node.stdout, /pnpm add vallkey[\s\S]*NODE_OPTIONS='--require vallkey\/auto'/);
    const python = await run(['hook'], { cwd: await make({ 'uv.lock': '', 'pyproject.toml': '' }) });
    assert.match(python.stdout, /uv add vallkey[\s\S]*VALLKEY_AUTO=1/);
    const ruby = await run(['hook'], { cwd: await make({ Gemfile: '' }) });
    assert.match(ruby.stdout, /bundle add vallkey[\s\S]*RUBYOPT=-rvallkey\/auto/);
  });

  it('says plainly when a language cannot be changed at runtime', async () => {
    const r = await run(['hook'], { cwd: await make({ 'go.mod': 'module x' }) });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Go\s+no auto-connect/);
  });
});
