// Build versioned native hooks and update the installer manifest. See docs/releases.md.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = '0.1.0';
const OUT = `${ROOT}artifacts/hooks/${VERSION}/`;
if (existsSync(`${OUT}SHA256SUMS`)) {
  throw new Error(
    `Hook artifacts for ${VERSION} already exist. Choose a new version; published artifacts must not be overwritten.`,
  );
}
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (name: string) => !only || only.includes(name);

// Toolchain versions are reviewed alongside runtime compatibility tests.
const MAVEN = 'maven:3.9.16-eclipse-temurin-21-noble';
const DOTNET = 'mcr.microsoft.com/dotnet/sdk:10.0.401';
const ERLANG = 'erlang:25.3.2.20-slim'; // the oldest supported: its .beam loads on every newer Erlang
const RUBY = 'ruby:3.4.10-slim-bookworm';
const PHP = {
  '8.2': { gnu: '8.2.33-cli-bookworm', musl: '8.2.34-cli-alpine', zts: '8.2.33-zts-bookworm' },
  '8.3': { gnu: '8.3.33-cli-bookworm', musl: '8.3.35-cli-alpine', zts: '8.3.33-zts-bookworm' },
  '8.4': { gnu: '8.4.25-cli-bookworm', musl: '8.4.26-cli-alpine', zts: '8.4.25-zts-bookworm' },
  '8.5': { gnu: '8.5.10-cli-bookworm', musl: '8.5.11-cli-alpine', zts: '8.5.10-zts-bookworm' },
};
const ARCHES = { 'linux/amd64': 'x86_64', 'linux/arm64': 'aarch64' };

mkdirSync(OUT, { recursive: true });
const docker = (args: string[], script: string) => {
  console.log(`  docker ${args.filter((a) => !a.startsWith('/')).slice(-1)[0]}`);
  execFileSync('docker', ['run', '--rm', ...args, 'sh', '-c', script], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
};
const mount = (dir: string) => ['-v', `${ROOT}${dir}:/src:ro`, '-v', `${OUT}:/out`];

if (want('java')) {
  console.log('Java agent');
  docker(
    [...mount('java'), '-v', 'vallkey-m2:/root/.m2', '--entrypoint', '', MAVEN],
    `cp -r /src /build && cd /build && mvn -q -B package && cp target/vallkey-agent.jar /out/vallkey-agent-${VERSION}.jar`,
  );
}
if (want('dotnet')) {
  console.log('.NET startup hook');
  docker(
    [...mount('dotnet'), DOTNET],
    `cp -r /src /build && dotnet publish /build/Vallkey.Auto/Vallkey.Auto.csproj -c Release -o /build/out -p:ContinuousIntegrationBuild=true >/dev/null && cp /build/out/Vallkey.Auto.dll /out/Vallkey.Auto-${VERSION}.dll`,
  );
}
if (want('elixir')) {
  console.log('Elixir/Erlang hook');
  docker(
    [...mount('elixir'), '--entrypoint', '', ERLANG],
    `erlc +deterministic -o /tmp /src/src/vallkey_auto.erl && cp /tmp/vallkey_auto.beam /out/vallkey_auto-${VERSION}.beam`,
  );
}
if (want('ruby')) {
  console.log('Ruby gem');
  docker(
    [...mount('ruby'), '-e', 'SOURCE_DATE_EPOCH=1793059200', RUBY],
    `cp -r /src /build && cd /build && gem build -q vallkey.gemspec >/dev/null && cp vallkey-${VERSION}.gem /out/`,
  );
}
if (want('php')) {
  console.log('PHP extension');
  for (const [php, flavors] of Object.entries(PHP)) {
    for (const [flavor, tag] of Object.entries(flavors)) {
      for (const [platform, arch] of Object.entries(ARCHES)) {
        const name = `vallkey-php-${VERSION}-php${php}-${flavor === 'zts' ? 'zts-gnu' : flavor}-${arch}.so`;
        const deps = flavor === 'musl' ? 'apk add --no-cache $PHPIZE_DEPS >/dev/null && ' : '';
        // Built, then loaded once to check it really is an extension for this PHP.
        docker(
          [...mount('php'), '--platform', platform, `php:${tag}`],
          `${deps}cp -r /src /build && cd /build && phpize >/dev/null && ./configure --enable-vallkey >/dev/null && make -j4 >/dev/null 2>&1 && php -d extension=/build/modules/vallkey.so -m | grep -qx vallkey && cp modules/vallkey.so /out/${name}`,
        );
      }
    }
  }
}

const sha = (file: string) =>
  createHash('sha256')
    .update(readFileSync(`${OUT}${file}`))
    .digest('hex');
const files = readdirSync(OUT)
  .filter((f) => f !== 'SHA256SUMS')
  .sort();
const sums = Object.fromEntries(files.map((f) => [f, sha(f)]));
writeFileSync(`${OUT}SHA256SUMS`, files.map((f) => `${sums[f]}  ${f}\n`).join(''));
writeFileSync(
  `${ROOT}cli/src/hooks.json`,
  `${JSON.stringify({ version: VERSION, base: `https://vallkey.com/downloads/hooks/${VERSION}/`, files: sums }, null, 2)}\n`,
);
console.log(`${files.length} files in artifacts/hooks/${VERSION}/`);
