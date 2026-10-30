import { VERSION } from './api.js';
import { hook } from './commands/hook.js';
import { init } from './commands/init.js';
import { domains, keys, kill, realKeys } from './commands/keys.js';
import { login, logout, whoami } from './commands/login.js';
import { mcp } from './commands/mcp.js';
import { scan } from './commands/scan.js';
import { status } from './commands/status.js';
import { verify } from './commands/verify.js';
import { connect, doctor } from './commands/connect.js';
import { bold, CliError, dim, out } from './ui.js';

// The help screen, in groups, with every column lined up.
const COLUMN = 27;
const section = (name, rows) => `${bold(name)}\n${rows.map(([a, b]) => `  ${a.padEnd(COLUMN)}${b}`.trimEnd()).join('\n')}`;
const HELP = [
  `${bold('vallkey')} ${dim(VERSION)}\nGhost keys for the API keys in your project: your app never holds the real key.`,
  section('Usage', [['npx vallkey <command> [options]', '']]),
  section('Get started', [
    ['login', 'Sign in from your browser, once per computer'],
    ['init [files]', 'Swap the API keys in your .env files for ghost keys'],
    ['scan [paths]', 'Find API keys in your code (exits with 1 if it finds any)'],
  ]),
  section('Connect your app', [
    ['connect', 'Show the best way to connect this project. Changes nothing'],
    ['hook [language]', 'Turn on auto-connect, no code changes: Node.js, Bun, Python, Ruby, Java, .NET, PHP, Elixir'],
    ['doctor', 'Check this project is ready on this computer'],
    ['verify <key id>', 'Confirm one request from your deployed app went through Vallkey'],
    ['status [key id]', 'Where each key is used, and what is wrong (exits with 1 if failing)'],
  ]),
  section('Keys', [
    ['keys', 'List your ghost keys'],
    ['keys add --from <id>', 'Make another ghost key for a shared real key'],
    ['real-keys', 'List the real keys shared by several ghost keys'],
    ['kill <key id>', 'Stop a ghost key everywhere, right away'],
    ['domains [check <domain>]', 'List your own API domains, or check one'],
  ]),
  section('Account and agents', [
    ['whoami', 'Show where you are signed in'],
    ['logout', 'Remove the sign-in from this computer'],
    ['mcp', 'Run the MCP server for AI agents (Claude Code, Cursor and others)'],
  ]),
  section('Options', [
    ['-y, --yes', 'Do not ask for confirmation'],
    ['--json', 'Print JSON (scan, keys, status, doctor, verify)'],
    ['--api <url>', 'Use another Vallkey server'],
    ['init --dry-run', 'Show what would change, change nothing'],
    ['hook --print', 'Only show what to do, download nothing'],
    ['hook --dir <folder>', 'Where to put the auto-connect file (default .vallkey)'],
    ['connect --method <name>', 'auto (default), address or hook'],
    ['verify --request-id <id>', "The x-guard-request-id header from your app's response"],
    ['verify --expect <name>', 'allowed (default) or denied'],
    ['verify --timeout <sec>', 'Wait up to 1 to 60 seconds (default 20)'],
    ['scan --history', 'Also look through every commit in git history'],
    ['scan --allowlist <file>', 'Exact path and SHA-256 exceptions for known false positives'],
    ['kill --reason "..."', 'Why, for the audit log'],
    ['keys add --label "..."', 'A name for the new ghost key'],
    ["keys add --rules '{…}'", 'Its rules as JSON, inside the outer rules'],
    ['login --no-browser', 'Print the link instead of opening a browser'],
  ]),
  section('Environment', [
    ['VALLKEY_TOKEN', 'An API token to use instead of the saved sign-in (for CI)'],
    ['VALLKEY_API', 'The Vallkey server, if not https://api.vallkey.com'],
  ]),
  `${bold('Docs')}  https://vallkey.com/docs/cli/`,
].join('\n\n');

const BOOLEAN = new Set(['yes', 'dry-run', 'history', 'json', 'no-browser', 'help', 'version', 'print']);
const VALUE = new Set(['api', 'reason', 'from', 'label', 'rules', 'dir', 'allowlist', 'method', 'request-id', 'expect', 'timeout']);
const SHORT = { y: 'yes', h: 'help', v: 'version' };

export function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [name, inline] = a.slice(2).split(/=(.*)/s);
      if (BOOLEAN.has(name)) flags[name] = true;
      else if (VALUE.has(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined) throw new CliError(`--${name} needs a value`);
        flags[name] = value;
      } else throw new CliError(`Unknown option --${name}. See: vallkey --help`);
    } else if (/^-[a-z]$/.test(a)) {
      if (!SHORT[a[1]]) throw new CliError(`Unknown option ${a}. See: vallkey --help`);
      flags[SHORT[a[1]]] = true;
    } else args.push(a);
  }
  return { args, flags };
}

export async function main(argv) {
  const { args, flags } = parseArgs(argv);
  const [command, ...rest] = args;
  if (flags.version) {
    out(VERSION);
    return 0;
  }
  if (!command || flags.help || command === 'help') {
    out(HELP);
    return command || flags.help ? 0 : 1;
  }
  switch (command) {
    case 'login':
      return login(flags);
    case 'logout':
      return logout(flags);
    case 'whoami':
      return whoami(flags);
    case 'init':
      return init(rest, flags);
    case 'hook':
      return hook(rest, flags);
    case 'connect':
      return connect(rest, flags);
    case 'doctor':
      return doctor(rest, flags);
    case 'verify':
      return verify(rest, flags);
    case 'scan':
      return scan(rest, flags);
    case 'keys':
      return keys(rest, flags);
    case 'status':
      return status(rest, flags);
    case 'real-keys':
      return realKeys(flags);
    case 'domains':
      return domains(rest, flags);
    case 'kill':
      return kill(rest, flags);
    case 'mcp':
      return mcp();
    default:
      throw new CliError(`Unknown command "${command}". See: vallkey --help`);
  }
}
