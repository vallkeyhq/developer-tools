'use strict';

// Short-lived keys for web pages and mobile apps, made on your server:
//
//   const { createSessionKey } = require('vallkey/session');
//   const { session_key } = await createSessionKey({ user: user.id });
//
// VALLKEY_GHOST_KEY  the ghost key to make them from (or pass ghostKey)
// VALLKEY_API        the Vallkey server (default https://api.vallkey.com)
//
// Never call this from a web page: the ghost key would be in it, and Vallkey refuses.

async function createSessionKey(options = {}) {
  const { user, ttlSeconds, allow, models } = options;
  const ghostKey = options.ghostKey || process.env.VALLKEY_GHOST_KEY;
  if (!ghostKey) throw new Error('vallkey: set VALLKEY_GHOST_KEY, or pass ghostKey, to make short-lived keys');
  const api = (options.api || process.env.VALLKEY_API || 'https://api.vallkey.com').replace(/\/+$/, '');
  let target;
  try { target = new URL(api); } catch { throw new Error('vallkey: invalid gateway origin'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if ((target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) ||
      target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('vallkey: use an HTTPS gateway origin; HTTP is allowed only for loopback tests');
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('vallkey: timeoutMs must be an integer between 1 and 60000');
  }
  const body = {};
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(`vallkey: ${(data.error && data.error.message) || `could not make a short-lived key (${res.status})`}`);
    error.status = res.status;
    throw error;
  }
  return data; // { session_key, expires_at, expires_in, user }
}

module.exports = { createSessionKey };
