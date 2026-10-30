import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const required = ['README.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md'];
for (const path of required) assert.ok(files.includes(path), `Missing ${path}`);
for (const path of files) {
  assert.ok(!/^(guard|web|brand|video|lib)\//.test(path), `Private component included: ${path}`);
  assert.ok(!/(^|\/)\.env(?:\.|$)/.test(path) || path.endsWith('.env.example'), `Environment file included: ${path}`);
  assert.ok(!/\.(pem|key|p12|tfstate|tfplan)$/.test(path), `Sensitive file type included: ${path}`);
  const data = readFileSync(resolve(root, path));
  if (/\.(jar|dll|so|beam|gem)$/.test(path) || data.includes(0)) continue;
  const text = data.toString('utf8');
  assert.ok(!text.includes('\r'), `Non-LF line endings: ${path}`);
  assert.ok(!/(?:\/Users\/|\/home\/)[A-Za-z][^\s"']*\//.test(text), `Personal absolute path: ${path}`);
  assert.ok(!new RegExp('(?:generated|written) by (?:ChatGPT|Claude|Codex)|AI' + '-generated', 'i').test(text), `Generated commentary: ${path}`);
  assert.ok(!/(?:from\s*|import\s*|require\s*\()['"](?:\.\.\/)+(?:guard|web)\//.test(text), `Private source dependency: ${path}`);
  if (path.endsWith('.md')) {
    for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1];
      if (/^(?:[a-z]+:|#|\/\/)/i.test(href)) continue;
      const target = resolve(root, dirname(path), decodeURIComponent(href.split('#')[0]));
      assert.ok(!relative(root, target).startsWith('..'), `Link escapes repository: ${path}: ${href}`);
      assert.ok(existsSync(target), `Broken local link: ${path}: ${href}`);
    }
  }
}
const pkg = JSON.parse(readFileSync(resolve(root, 'cli/package.json')));
assert.equal(pkg.repository.directory, 'cli');
assert.equal(pkg.license, 'MIT');
assert.deepEqual(pkg.files, ['bin', 'src']);
console.log(`Repository checks passed (${files.length} files).`);
