import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Flags, SavedConfig } from './types.js';
import { CliError } from './ui.js';
import { isRecord } from './validation.cjs';

export const DEFAULT_API = 'https://api.vallkey.com';

// Where `vallkey login` keeps its token: readable by you only.
export function configPath() {
  if (process.env.VALLKEY_CONFIG) return process.env.VALLKEY_CONFIG;
  if (process.platform === 'win32' && process.env.APPDATA)
    return join(process.env.APPDATA, 'vallkey', 'config.json');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'vallkey', 'config.json');
}

export async function readConfig(): Promise<SavedConfig> {
  try {
    const data: unknown = JSON.parse(await readFile(configPath(), 'utf8'));
    if (!isRecord(data)) return {};
    return Object.fromEntries(
      Object.entries(data).filter(
        ([key, value]) =>
          ['api', 'token', 'tenant', 'signed_in_at'].includes(key) && typeof value === 'string',
      ),
    ) as SavedConfig;
  } catch {
    return {};
  }
}

export async function writeConfig(config: SavedConfig) {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  return path;
}

export async function removeConfig() {
  await rm(configPath(), { force: true });
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

// The server and token to use. VALLKEY_TOKEN and VALLKEY_API win over the saved
// sign-in, so CI can run the CLI without `vallkey login`.
export async function resolveAuth(flags: Flags = {}) {
  const saved = await readConfig();
  const api = gatewayOrigin(trimSlash(flags.api || process.env.VALLKEY_API || saved.api || DEFAULT_API));
  let savedOrigin;
  try {
    savedOrigin = saved.api && gatewayOrigin(trimSlash(saved.api));
  } catch {
    /* Ignore credentials bound to invalid saved configuration. */
  }
  const token = process.env.VALLKEY_TOKEN || (savedOrigin === api ? saved.token : undefined) || null;
  return { api, token, source: process.env.VALLKEY_TOKEN ? 'VALLKEY_TOKEN' : token ? configPath() : null };
}

export function gatewayOrigin(raw = 'https://api.vallkey.com') {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError('The gateway must be an HTTPS origin.');
  }
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new CliError(
      'Use an HTTPS gateway origin without credentials, path, query or fragment. HTTP is only supported for loopback tests.',
    );
  }
  return url.origin;
}
