import { call, requireToken } from '../api.js';
import { gatewayOrigin, resolveAuth } from '../config.js';
import type { Activity, Flags } from '../types.js';
import { bad, CliError, detail, fields, ok, out, sleep } from '../ui.js';

// Verify the exact response obtained from the app. No provider traffic is generated.
export async function verify(args: string[], flags: Flags) {
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
