import { readFileSync } from 'node:fs';
import { CliError } from './ui.js';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export class ApiError extends CliError {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// One call to the management API. Errors come back as { error: { message } }.
export async function call(auth, method, path, body, options = {}) {
  const headers = { 'user-agent': `vallkey-cli/${VERSION}`, accept: 'application/json' };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${auth.api}/_guard/v1${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: options.signal ?? AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new ApiError(`Could not reach ${auth.api} (${e.cause?.code ?? e.message}). Check your connection.`, 0);
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // not JSON; reported below
  }
  if (!res.ok) {
    const raw = data.error?.message;
    const message = raw ? raw[0].toUpperCase() + raw.slice(1) : (res.status >= 500 ? 'Vallkey had a problem. Try again in a moment.' : `Request failed (${res.status})`);
    throw new ApiError(message, res.status, data.error?.code);
  }
  return { status: res.status, data };
}

export function requireToken(auth) {
  if (!auth.token) throw new CliError('You are not signed in. Run: npx vallkey login');
}

// Where apps should send ghost key traffic: the account's default own API domain
// once it is active, otherwise the Vallkey server itself.
export async function proxyOrigin(auth) {
  try {
    const { data } = await call(auth, 'GET', '/domains');
    const own = data.domains?.find((d) => d.isDefault && d.status === 'active');
    return own ? `https://${own.hostname}` : auth.api;
  } catch {
    return auth.api;
  }
}
