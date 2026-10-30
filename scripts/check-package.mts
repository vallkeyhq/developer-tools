import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'vallkey-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  const packed: unknown = JSON.parse(
    execFileSync(npm, ['pack', './cli', '--json', '--pack-destination', directory], {
      cwd: root,
      encoding: 'utf8',
    }),
  );
  assert.ok(Array.isArray(packed) && packed.length === 1);
  const metadata = packed[0] as { filename: string; files: { path: string }[] };
  assert.ok(
    metadata.files.every(
      ({ path }) =>
        path.startsWith('dist/bin/') ||
        path.startsWith('dist/src/') ||
        ['README.md', 'LICENSE', 'package.json'].includes(path),
    ),
  );
  assert.ok(metadata.files.some(({ path }) => path === 'dist/src/session.d.cts'));
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'vallkey-package-check', private: true, type: 'module' }),
  );
  execFileSync(
    npm,
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      join(directory, metadata.filename),
    ],
    { cwd: directory, stdio: 'pipe' },
  );
  const env = { ...process.env, VALLKEY_AUTO: '0' };
  const version = execFileSync(process.execPath, ['node_modules/vallkey/dist/bin/vallkey.js', '--version'], {
    cwd: directory,
    env,
    encoding: 'utf8',
  }).trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  execFileSync(
    process.execPath,
    [
      '-e',
      "const assert=require('node:assert/strict'); require('vallkey/auto'); assert.equal(typeof require('vallkey/session').createSessionKey, 'function');",
    ],
    { cwd: directory, env, stdio: 'pipe' },
  );
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import 'vallkey/auto'; import {createSessionKey} from 'vallkey/session'; import assert from 'node:assert/strict'; assert.equal(typeof createSessionKey,'function');",
    ],
    { cwd: directory, env, stdio: 'pipe' },
  );
  writeFileSync(
    join(directory, 'consumer.cts'),
    "import {createSessionKey, type SessionKeyOptions} from 'vallkey/session';\nconst options: SessionKeyOptions = {user: 'test', ttlSeconds: 900};\nconst create: (options?: SessionKeyOptions) => Promise<{session_key: string}> = createSessionKey;\nvoid options; void create;\n",
  );
  const compiler = join(root, 'node_modules/typescript/bin/tsc');
  execFileSync(
    process.execPath,
    [
      compiler,
      '--strict',
      '--noEmit',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      '--skipLibCheck',
      '--typeRoots',
      join(root, 'node_modules/@types'),
      'consumer.cts',
    ],
    { cwd: directory, stdio: 'pipe' },
  );
  console.log(`Packed package ${version}: executable, CJS/ESM exports and consumer declarations passed.`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
