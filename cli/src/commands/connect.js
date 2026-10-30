import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { detect, hook } from './hook.js';
import { bad, bold, CliError, cyan, detail, dim, fields, heading, next, ok, out, tidyPath, warn } from '../ui.js';
import { LANGUAGES as LANGUAGE_NAMES } from './status.js';
import { resolveAuth, gatewayOrigin as gateway } from '../config.js';

const ADDRESS = {
  openai: ['OPENAI_BASE_URL', '/v1'],
  '@anthropic-ai/sdk': ['ANTHROPIC_BASE_URL', ''],
  'groq-sdk': ['GROQ_BASE_URL', ''],
};
const OTHER_SDKS = ['stripe', '@google/genai', '@mistralai/mistralai', 'twilio', 'resend', '@sendgrid/mail', 'postmark', 'mailgun.js', '@octokit/rest', '@slack/web-api', 'cloudflare', '@aws-sdk/client-s3'];


async function inspect(cwd) {
  let pkg = {};
  try { pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')); } catch { /* Other languages need no package.json. */ }
  const deps = { ...pkg.devDependencies, ...pkg.dependencies };
  const languages = await detect(cwd);
  return { languages, next: Boolean(deps.next), addressSDKs: Object.keys(ADDRESS).filter((s) => deps[s]), otherSDKs: OTHER_SDKS.filter((s) => deps[s]) };
}

export async function connect(args, flags) {
  if (args.length > 1) throw new CliError('Usage: vallkey connect [language] [--method auto|address|hook]');
  const method = flags.method ?? 'auto';
  if (!['auto', 'address', 'hook'].includes(method)) throw new CliError('--method must be auto, address or hook');
  const api = gateway((await resolveAuth(flags)).api);
  const project = await inspect(process.cwd());
  const node = !args.length && project.languages.some((l) => ['node', 'bun'].includes(l));
  const chosen = args.length ? args : project.languages;
  const compiled = chosen.length > 0 && chosen.every((l) => ['go', 'golang', 'rust'].includes(l));
  const address = method === 'address' || (method === 'auto' && (compiled || (node && project.addressSDKs.length > 0 && project.otherSDKs.length === 0)));
  heading('Connect this project');
  out();
  fields([
    ['Project', `${chosen.map((l) => LANGUAGE_NAMES[l] ?? { go: 'Go', golang: 'Go', rust: 'Rust' }[l] ?? l).join(', ') || 'language not found'}${project.next && !args.length ? ' · Next.js' : ''}`],
    ['Best way', address ? 'SDK address setting' : 'Auto-connect (no code changes)'],
  ]);
  if (address) {
    out();
    heading('SDK address setting');
    detail("Put the ghost key where the SDK reads its key, and point the SDK at Vallkey:");
    out();
    if (node && project.addressSDKs.length) {
      for (const sdk of project.addressSDKs) {
        const [name, path] = ADDRESS[sdk];
        out(`  ${cyan(`${name}=${api}${path}`)}  ${dim(sdk)}`);
      }
    } else {
      out(`  ${cyan(api)}`);
      detail("Add the provider's base path if it has one. Each key's Connect tab has the exact line.");
    }
    out();
    detail('This covers the SDKs listed. An address set in your code wins over these settings.');
  } else {
    out();
    const status = await hook(args, { ...flags, api, print: true, embedded: true });
    if (status) {
      out();
      warn("This setup is not complete yet. Finish the step above, or use the SDK's API address setting instead.");
      return status;
    }
  }
  out();
  heading('Then check it');
  out('  1. Restart or redeploy your app.');
  out(`  2. Make one safe request and copy the ${cyan('x-guard-request-id')} header from its response.`);
  out(`  3. ${cyan('npx vallkey verify <key id> --request-id <x-guard-request-id>')}`);
  detail('On a test key, also check a request your rules block: add --expect denied.');
  out();
  out(dim('Nothing in your project was changed.'));
  return 0;
}

export async function doctor(args, flags) {
  if (args.length) throw new CliError('Usage: vallkey doctor [--json]');
  const cwd = process.cwd();
  const project = await inspect(cwd);
  const checks = [];
  try { gateway((await resolveAuth(flags)).api); checks.push({ check: 'gateway', status: 'ok', message: 'The Vallkey server address is valid' }); }
  catch { checks.push({ check: 'gateway', status: 'error', message: 'The Vallkey server address must be https:// and a host only, with no path, query or password' }); }
  if (process.env.VALLKEY_AUTO === '0') checks.push({ check: 'hook', status: 'warning', message: 'VALLKEY_AUTO=0 is set here, so auto-connect is turned off. SDK address settings still work' });
  if (project.languages.some((l) => ['node', 'bun'].includes(l))) {
    const require = createRequire(join(cwd, 'package.json'));
    try {
      require.resolve('vallkey/auto');
      checks.push({ check: 'package', status: 'ok', message: 'The vallkey package is installed in this project' });
    } catch {
      checks.push({ check: 'package', status: 'warning', message: 'The vallkey package is not installed. No-code mode needs it: npm install vallkey' });
    }
    if (project.next) {
      const candidates = ['instrumentation.ts', 'instrumentation.js', 'src/instrumentation.ts', 'src/instrumentation.js'];
      let found = null;
      for (const file of candidates) { try { found = { file, code: await readFile(join(cwd, file), 'utf8') }; break; } catch { /* absent */ } }
      // Read the file: say whether it loads the hook, and only on the Node.js runtime.
      const loads = found && /['"]vallkey\/auto['"]/.test(found.code);
      const guarded = found && /NEXT_RUNTIME\s*===?\s*['"]nodejs['"]/.test(found.code);
      checks.push(
        !found
          ? { check: 'startup', status: 'warning', message: 'No Next.js setup file (instrumentation.ts) yet. Run vallkey hook to add one' }
          : !loads
            ? { check: 'startup', status: 'warning', message: `${found.file} does not load vallkey/auto yet. Run vallkey hook to see the line to add` }
            : !guarded
              ? { check: 'startup', status: 'warning', message: `${found.file} loads vallkey/auto on Edge too. Load it only when NEXT_RUNTIME is 'nodejs'` }
              : { check: 'startup', status: 'ok', message: `${found.file} turns on auto-connect on Node.js (Edge routes need the SDK address setting)` },
      );
    } else {
      checks.push({ check: 'startup', status: 'info', message: 'Make sure your app loads vallkey/auto before its SDKs (NODE_OPTIONS or an import at the top). This can only be checked by verify' });
    }
  } else {
    checks.push({ check: 'runtime', status: 'info', message: 'Local checks cover Node.js and Bun projects. For other languages, run vallkey connect' });
  }
  const result = { ready: !checks.some((c) => c.status === 'error'), connection: 'unverified', coverage: 'unknown', languages: project.languages, checks };
  if (flags.json) {
    out(JSON.stringify(result, null, 2));
    return result.ready ? 0 : 1;
  }
  const warnings = checks.filter((c) => c.status === 'warning').length;
  heading('Local checks', tidyPath(cwd));
  out();
  for (const c of checks) {
    if (c.status === 'ok') ok(c.message);
    else if (c.status === 'warning') warn(c.message);
    else if (c.status === 'error') bad(c.message);
    else out(`${dim('•')} ${c.message}`);
  }
  out();
  out(!result.ready ? `${bold('Not ready.')} Fix the item marked ✗ first.` : warnings ? `${bold('Almost ready.')} Look at the ${warnings === 1 ? 'item' : 'items'} marked !.` : `${bold('Ready on this computer.')}`);
  detail('These checks run here. Only verify proves your deployed app is connected.');
  next([
    '1. Deploy or restart your app, and make one safe request with a ghost key.',
    `2. ${cyan('npx vallkey verify <key id> --request-id <x-guard-request-id>')}`,
  ]);
  return result.ready ? 0 : 1;
}
