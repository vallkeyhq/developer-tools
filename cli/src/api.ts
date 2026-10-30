import { readFileSync } from 'node:fs';
import type { Auth, Domain } from './types.js';
import { CliError } from './ui.js';
import { errorCode, errorMessage, isRecord } from './validation.cjs';

const metadata: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
if (!isRecord(metadata) || typeof metadata.version !== 'string')
  throw new Error('Invalid Vallkey package metadata');
export const VERSION = metadata.version;

export class ApiError extends CliError {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

function validateResponse(path: string, data: unknown): asserts data is Record<string, unknown> {
  if (!isRecord(data)) throw new ApiError('The API returned an invalid response object.', 502);
  const route = path.split('?')[0];
  const arrayField =
    route === '/keys'
      ? 'keys'
      : route === '/providers'
        ? 'providers'
        : route === '/real-keys'
          ? 'real_keys'
          : route === '/domains'
            ? 'domains'
            : route.endsWith('/places')
              ? 'places'
              : route.endsWith('/activity')
                ? route.startsWith('/agent/')
                  ? 'requests'
                  : 'activity'
                : null;
  // POST /keys and POST /agent/tasks return a single created key, rather than a list.
  if (arrayField && !('key_id' in data) && !Array.isArray(data[arrayField])) {
    throw new ApiError(`The API response is missing its ${arrayField} list.`, 502);
  }
}

export async function call<T = Record<string, unknown>>(
  auth: Auth,
  method: string,
  path: string,
  body?: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {
    'user-agent': `vallkey-cli/${VERSION}`,
    accept: 'application/json',
  };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${auth.api}/_guard/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: options.signal ?? AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new ApiError(
      `Could not reach ${auth.api} (${errorCode(error) ?? errorMessage(error)}). Check your connection.`,
      0,
    );
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError('The API returned an invalid JSON response.', res.status);
  }
  if (!res.ok) {
    const error = isRecord(data) && isRecord(data.error) ? data.error : {};
    const raw = typeof error.message === 'string' ? error.message : '';
    const message = raw
      ? raw[0].toUpperCase() + raw.slice(1)
      : res.status >= 500
        ? 'Vallkey had a problem. Try again in a moment.'
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, typeof error.code === 'string' ? error.code : undefined);
  }
  validateResponse(path, data);
  return { status: res.status, data: data as T };
}

export function requireToken(auth: Auth): asserts auth is Auth & { token: string } {
  if (!auth.token) throw new CliError('You are not signed in. Run: npx vallkey login');
}

export async function proxyOrigin(auth: Auth): Promise<string> {
  try {
    const { data } = await call<{ domains: Domain[] }>(auth, 'GET', '/domains');
    const own = data.domains.find((domain) => domain.isDefault && domain.status === 'active');
    return own ? `https://${own.hostname}` : auth.api;
  } catch {
    return auth.api;
  }
}
