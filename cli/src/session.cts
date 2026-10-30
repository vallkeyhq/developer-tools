import { isRecord } from './validation.cjs';

export interface SessionKeyOptions {
  ghostKey?: string;
  api?: string;
  timeoutMs?: number;
  user?: string | number;
  ttlSeconds?: number;
  allow?: { method: string; path: string }[];
  models?: string[];
}
export interface SessionKey {
  session_key: string;
  expires_at?: string | number;
  expires_in?: number;
  user?: string;
}
export class SessionKeyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SessionKeyError';
  }
}

/** Create a short-lived key on a trusted server. Never bundle the parent ghost key into a client. */
export async function createSessionKey(options: SessionKeyOptions = {}): Promise<SessionKey> {
  const { user, ttlSeconds, allow, models } = options;
  const ghostKey = options.ghostKey || process.env.VALLKEY_GHOST_KEY;
  if (!ghostKey)
    throw new Error('vallkey: set VALLKEY_GHOST_KEY, or pass ghostKey, to make short-lived keys');
  const api = (options.api || process.env.VALLKEY_API || 'https://api.vallkey.com').replace(/\/+$/, '');
  let target;
  try {
    target = new URL(api);
  } catch {
    throw new Error('vallkey: invalid gateway origin');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (
    (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) ||
    target.username ||
    target.password ||
    target.pathname !== '/' ||
    target.search ||
    target.hash
  ) {
    throw new Error('vallkey: use an HTTPS gateway origin; HTTP is allowed only for loopback tests');
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('vallkey: timeoutMs must be an integer between 1 and 60000');
  }
  const body: { user?: string; ttl_seconds?: number; allow?: SessionKeyOptions['allow']; models?: string[] } =
    {};
  if (user !== undefined) body.user = String(user);
  if (ttlSeconds !== undefined) body.ttl_seconds = ttlSeconds;
  if (allow !== undefined) body.allow = allow;
  if (models !== undefined) body.models = models;
  const res = await fetch(`${target.origin}/_vallkey/v1/session-keys`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ghostKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      isRecord(data) && isRecord(data.error) && typeof data.error.message === 'string'
        ? data.error.message
        : `could not make a short-lived key (${res.status})`;
    throw new SessionKeyError(`vallkey: ${detail}`, res.status);
  }
  if (!isRecord(data) || typeof data.session_key !== 'string') {
    throw new SessionKeyError('vallkey: invalid session key response', res.status);
  }
  return {
    session_key: data.session_key,
    ...(typeof data.expires_at === 'string' || typeof data.expires_at === 'number'
      ? { expires_at: data.expires_at }
      : {}),
    ...(typeof data.expires_in === 'number' ? { expires_in: data.expires_in } : {}),
    ...(typeof data.user === 'string' ? { user: data.user } : {}),
  };
}
