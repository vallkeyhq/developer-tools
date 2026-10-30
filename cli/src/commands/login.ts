import { execFileSync, spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { ApiError, call } from '../api.js';
import { configPath, readConfig, removeConfig, resolveAuth, writeConfig } from '../config.js';
import type { Flags, KeySummary, LoginStart, LoginToken } from '../types.js';
import {
  bad,
  bold,
  CliError,
  cyan,
  detail,
  dim,
  fields,
  heading,
  next,
  ok,
  out,
  plural,
  sleep,
  tidyPath,
  warn,
} from '../ui.js';

function openBrowser(url: string) {
  if (
    process.env.CI ||
    (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
  )
    return false;
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// Use a recognizable label for token revocation in the dashboard.
function computerName() {
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('scutil', ['--get', 'ComputerName'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (name) return name.slice(0, 60);
    } catch {
      // fall back to the host name
    }
  }
  const host = hostname().replace(/\.(local|lan|home)$/, '');
  return host && !/^[\d.:]+$/.test(host) ? host.slice(0, 60) : 'this computer';
}

export async function login(flags: Flags) {
  const { api } = await resolveAuth(flags);
  const client = computerName();
  const { data: start } = await call<LoginStart>({ api }, 'POST', '/cli/start', { client });

  out();
  heading('Sign in to Vallkey');
  out();
  out(`  Your code   ${bold(start.user_code)}`);
  out();
  const opened = !flags['no-browser'] && openBrowser(start.verification_url);
  out(
    `  ${opened ? 'Your browser should open. If it does not, open this page' : 'Open this page'} and check the code matches:`,
  );
  out(`  ${cyan(start.verification_url)}`);
  out();
  out(dim('  Waiting for you to approve…'));

  let interval = Math.max(1, start.interval ?? 3) * 1000;
  const deadline = Date.now() + (start.expires_in ?? 600) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    let result;
    try {
      result = await call<LoginToken>({ api }, 'POST', '/cli/token', { device_code: start.device_code });
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        interval += 2000;
        continue;
      }
      if (e instanceof ApiError && e.status === 0) continue; // a network blip: try again
      if (e instanceof ApiError && e.status === 403)
        throw new CliError('The sign-in was refused in the browser.');
      if (e instanceof ApiError && e.status === 401)
        throw new CliError('The sign-in expired. Run vallkey login again.');
      throw e;
    }
    if (result.status === 202) continue;
    const path = await writeConfig({
      api: result.data.api_origin || api,
      token: result.data.token,
      tenant: result.data.tenant_id,
      signed_in_at: new Date().toISOString(),
    });
    out();
    ok('Signed in');
    fields([
      ['Server', result.data.api_origin || api],
      ['Token', `${tidyPath(path)} ${dim('(readable by you only)')}`],
      ['Shown as', `"${client}" in Settings → API tokens`],
    ]);
    if (process.env.VALLKEY_TOKEN)
      warn('VALLKEY_TOKEN is set in this shell, so it is used instead of this sign-in.');
    next([
      `${cyan('npx vallkey init')}     protect the keys in this project`,
      `${cyan('npx vallkey connect')}  see how to connect your app`,
    ]);
    return 0;
  }
  throw new CliError('The sign-in expired. Run vallkey login again.');
}

export async function logout() {
  const saved = await readConfig();
  await removeConfig();
  if (!saved.token) {
    out('You were not signed in on this computer.');
    return 0;
  }
  ok('Signed out');
  detail(`Removed ${tidyPath(configPath())}`);
  detail('The token still works until you revoke it in Settings → API tokens.');
  return 0;
}

export async function whoami(flags: Flags) {
  const auth = await resolveAuth(flags);
  if (!auth.token) {
    bad('Not signed in');
    next([`${cyan('npx vallkey login')}  sign in from your browser`]);
    return 1;
  }
  const { data } = await call<{ keys: KeySummary[] }>(auth, 'GET', '/keys');
  ok('Signed in');
  fields([
    ['Server', auth.api],
    [
      'Token',
      auth.source === 'VALLKEY_TOKEN'
        ? 'VALLKEY_TOKEN (from the environment)'
        : tidyPath(auth.source ?? 'unknown'),
    ],
    ['Account', plural(data.keys.length, 'ghost key')],
  ]);
  return 0;
}
