// Each package is built and checked in a clean runtime. Source mounts are read-only.
// Run one: node scripts/check-native-hooks.mjs ruby
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const checks: Record<string, [string, string, string]> = {
  ruby: [
    'ruby:3.4.10-slim-bookworm',
    'ruby',
    'gem install minitest --version 5.25.5 --no-document && ruby -Ilib test/auto_test.rb',
  ],
  java: [
    'maven:3.9.16-eclipse-temurin-21-noble',
    'java',
    'mvn -q -B package dependency:build-classpath -Dmdep.outputFile=target/test-classpath.txt && RAILWAY_PROJECT_ID=x VALLKEY_ENV=staging VALLKEY_API=http://127.0.0.1:18471 java -javaagent:target/vallkey-agent.jar src/test/java/AgentCheck.java && RAILWAY_PROJECT_ID=x VALLKEY_ENV=staging VALLKEY_API=http://127.0.0.1:18471 java -javaagent:target/vallkey-agent.jar -cp "target/test-classes:$(cat target/test-classpath.txt)" TransportCheck',
  ],
  dotnet: [
    'mcr.microsoft.com/dotnet/sdk:10.0.401',
    'dotnet',
    'dotnet run --project Vallkey.Auto.Tests -c Release',
  ],
  php: [
    'php:8.4.25-cli-bookworm',
    'php',
    'phpize >/dev/null && ./configure --enable-vallkey >/dev/null && make -j2 >/dev/null && NETLIFY=true VALLKEY_ENV=preview php -d extension=modules/vallkey.so tests/check.php',
  ],
  elixir: [
    'erlang:25.3.2.20-slim',
    'elixir',
    'erlc -o . src/vallkey_auto.erl test/vallkey_auto_check.erl && GITLAB_CI=true VALLKEY_ENV=ci erl -noshell -pa . -s vallkey_auto_check run',
  ],
};
const selected = process.argv[2];
if (!Object.hasOwn(checks, selected ?? ''))
  throw new Error(`Choose one of: ${Object.keys(checks).join(', ')}`);
const [image, dir, command] = checks[selected];
execFileSync(
  'docker',
  [
    'run',
    '--rm',
    '-v',
    `${root}:/repo:ro`,
    '--tmpfs',
    '/work:exec',
    '--entrypoint',
    'sh',
    image,
    '-ec',
    `cp -R /repo/${dir}/. /work/ && cd /work && ${command}`,
  ],
  { stdio: 'inherit', timeout: 1_200_000 },
);
