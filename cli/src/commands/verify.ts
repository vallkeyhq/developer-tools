import { readFile } from 'node:fs/promises';
import { ApiError, call, requireToken } from '../api.js';
import { gatewayOrigin, resolveAuth } from '../config.js';
import { parseEnv } from '../dotenv.js';
import type { Activity, Flags } from '../types.js';
import { bad, CliError, cyan, detail, dim, fields, heading, ok, out, sleep, warn } from '../ui.js';
import { ENV_FILES } from './init.js';

const GHOST = /^gk_[a-z]{2,20}_([A-Za-z0-9_-]{22})_[A-Za-z0-9_-]{43}$/;
const succeeded = (e: Activity) =>
  e.outcome === 'allowed' &&
  typeof e.status === 'number' &&
  ((e.status >= 200 && e.status < 300) || e.status === 101);

// The ghost keys in this project's .env files: key id -> variable names.
async function projectKeys() {
  const keys = new Map<string, string[]>();
  for (const file of ENV_FILES) {
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;
    for (const { name, value } of parseEnv(text).entries) {
      const id = GHOST.exec(value)?.[1];
      if (id) keys.set(id, [...new Set([...(keys.get(id) ?? []), name])]);
    }
  }
  return keys;
}

// With no arguments: wait for the app's next requests with this project's ghost keys, so
// nobody has to dig a request id out of a response. No provider traffic is generated.
async function watch(flags: Flags) {
  const timeout = Number(flags.timeout ?? 120);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600)
    throw new CliError('--timeout must be 1 to 600 seconds');
  const keys = await projectKeys();
  if (!keys.size)
    throw new CliError(
      'No ghost keys in the .env files here. Run vallkey init first, or check one request: vallkey verify <key id> --request-id <id>',
    );
  const auth = await resolveAuth(flags);
  auth.api = gatewayOrigin(auth.api);
  requireToken(auth);
  // A request made just before running this counts too.
  const from = Date.now() - 2 * 60_000;
  const deadline = Date.now() + timeout * 1000;
  const seen = new Map<string, Activity>();
  if (!flags.json) {
    heading('Waiting for your app', `${keys.size === 1 ? '1 ghost key' : `${keys.size} ghost keys`} in .env`);
    detail(
      `Start or restart your app and make one safe request with each key. Up to ${timeout} s; Ctrl+C stops.`,
    );
    out();
  }
  while (seen.size < keys.size && Date.now() < deadline) {
    for (const id of keys.keys()) {
      if (seen.has(id)) continue;
      const { data } = await call<{ activity: Activity[] }>(
        auth,
        'GET',
        `/keys/${id}/activity?${new URLSearchParams({ from: String(from), limit: '10' })}`,
      ).catch((error) => {
        // A signed-out token or another account's key will never succeed, so say so now.
        // A brief network or server problem should not stop the wait.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429)
          throw error;
        return { data: { activity: [] as Activity[] } };
      });
      // A settled success wins; otherwise the latest settled request says what went wrong.
      const settled = (data.activity ?? []).filter(
        (e) => e.at >= from && (e.outcome === 'denied' || (e.status !== null && e.status !== undefined)),
      );
      const event = settled.find(succeeded) ?? settled[0];
      if (!event) continue;
      seen.set(id, event);
      if (flags.json) continue;
      const names = keys.get(id)!.join(', ');
      const what = `${event.method} ${event.path}`;
      if (succeeded(event)) ok(`${names}  ${dim(what)}  ${event.status}${event.cached ? ' (cached)' : ''}`);
      else if (event.outcome === 'denied')
        bad(`${names}  ${dim(what)}  blocked by its rules${event.reason ? `: ${event.reason}` : ''}`);
      else bad(`${names}  ${dim(what)}  the provider answered ${event.status}`);
    }
    if (seen.size < keys.size) await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
  }
  const results = [...keys].map(([id, names]) => {
    const e = seen.get(id);
    return {
      keyId: id,
      names,
      connected: Boolean(e),
      verified: Boolean(e && succeeded(e)),
      ...(e
        ? { requestId: e.requestId, outcome: e.outcome, status: e.status, method: e.method, path: e.path }
        : {}),
    };
  });
  const failed = results.some((r) => r.connected && !r.verified);
  const verified = results.some((r) => r.verified) && !failed;
  if (flags.json) {
    out(JSON.stringify({ verified, keys: results }, null, 2));
    return verified ? 0 : 1;
  }
  for (const r of results.filter((r) => !r.connected)) warn(`${r.names.join(', ')}  no request yet`);
  out();
  if (verified) {
    ok(
      results.every((r) => r.verified)
        ? 'Your app is connected'
        : 'Your app is connected for the keys marked ✓',
    );
    detail('These requests went through Vallkey. Keys without a request may be unused in what you tried.');
  } else if (failed) {
    bad('Requests reached Vallkey but did not succeed');
    detail('Open Activity in the dashboard for the reason, or run vallkey status.');
  } else {
    bad('No request reached Vallkey');
    detail('If the provider answered with an error about an invalid key starting with gk_, the request went');
    detail(`straight to the provider: run ${cyan('npx vallkey connect')}, then restart the app.`);
  }
  return verified ? 0 : 1;
}

// Verify the exact response obtained from the app. No provider traffic is generated.
export async function verify(args: string[], flags: Flags) {
  if (!args.length && !flags['request-id'] && !flags.expect) return watch(flags);
  const [key] = args;
  const request = flags['request-id'];
  const expect = flags.expect ?? 'allowed';
  const timeout = Number(flags.timeout ?? 20);
  if (
    args.length !== 1 ||
    !/^[A-Za-z0-9_-]{22}$/.test(key ?? '') ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(request ?? '')
  ) {
    throw new CliError(
      'Usage: vallkey verify <key id> --request-id <x-guard-request-id from your app response> [--expect allowed|denied]',
    );
  }
  if (!['allowed', 'denied'].includes(expect)) throw new CliError('--expect must be allowed or denied');
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60)
    throw new CliError('--timeout must be 1 to 60 seconds');
  if (!request) throw new CliError('--request-id is required');
  const auth = await resolveAuth(flags);
  auth.api = gatewayOrigin(auth.api);
  requireToken(auth);
  const started = Date.now();
  const deadline = started + timeout * 1000;
  const from = started - 5 * 60_000;
  let result: {
    verified: boolean;
    reason: string;
    outcome?: string;
    status?: number | null;
    cached?: boolean;
  } = {
    verified: false,
    reason:
      'No matching request from the last five minutes. Make a fresh request from your app and copy its x-guard-request-id response header.',
  };
  while (Date.now() < deadline) {
    let data;
    try {
      ({ data } = await call<{ activity: Activity[] }>(
        auth,
        'GET',
        `/keys/${key}/activity?${new URLSearchParams({ request, from: String(from), limit: '10' })}`,
        undefined,
        { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) },
      ));
    } catch (error) {
      if (Date.now() >= deadline) break;
      throw error;
    }
    const event = data.activity?.find(
      (e) => e.requestId === request && e.at >= from && e.at <= Date.now() + 30_000,
    );
    if (event) {
      if (event.outcome !== expect) {
        result = {
          verified: false,
          reason: `The request outcome was ${event.outcome === 'denied' ? 'denied' : 'allowed'}, not ${expect}.`,
        };
        break;
      }
      if (
        expect === 'denied' ||
        (typeof event.status === 'number' &&
          Number.isInteger(event.status) &&
          ((event.status >= 200 && event.status < 300) || event.status === 101))
      ) {
        result = {
          verified: true,
          outcome: expect,
          status: event.status,
          cached: Boolean(event.cached),
          reason:
            expect === 'denied'
              ? 'This exact request was blocked by Vallkey.'
              : 'This exact request went through Vallkey and got a successful answer.',
        };
        break;
      }
      if (event.status !== null && event.status !== undefined) {
        result = {
          verified: false,
          reason:
            'Vallkey received the request, but its response was not successful. Review Activity for the provider error.',
        };
        break;
      }
      result = {
        verified: false,
        reason: 'Vallkey received the request, but its response has not settled yet. Try verification again.',
      };
    }
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  const answer = {
    ...result,
    keyId: key,
    requestId: request,
    scope: 'One application request; not proof of every SDK operation or deployment.',
  };
  if (flags.json) {
    out(JSON.stringify(answer, null, 2));
    return answer.verified ? 0 : 1;
  }
  (answer.verified ? ok : bad)(
    answer.verified ? (expect === 'denied' ? 'Verified: blocked as expected' : 'Verified') : 'Not verified',
  );
  detail(answer.reason);
  out();
  fields([
    ['Key', key],
    ['Request', request],
    ['Expected', expect],
    [
      'Status',
      answer.status !== undefined && answer.status !== null
        ? `${answer.status}${answer.cached ? ' (from the answer cache)' : ''}`
        : undefined,
    ],
  ]);
  out();
  detail('This checks one request. It does not prove every SDK call or deployment.');
  return answer.verified ? 0 : 1;
}
