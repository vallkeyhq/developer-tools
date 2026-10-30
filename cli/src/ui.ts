import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';

// Terminal output: colours only on a real terminal, and never when NO_COLOR is set.
const useColor = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const paint = (code: string) => (text: unknown) =>
  useColor() ? `\x1b[${code}m${text}\x1b[0m` : String(text);

export const bold = paint('1');
export const dim = paint('2');
export const red = paint('31');
export const green = paint('32');
export const yellow = paint('33');
export const cyan = paint('36');

export const out = (line = '') => process.stdout.write(`${line}\n`);
export const err = (line = '') => process.stderr.write(`${line}\n`);

export const heading = (text: string, detail?: string) =>
  out(detail ? `${bold(text)}  ${dim(detail)}` : bold(text));
export const ok = (text: string) => out(`${green('✓')} ${text}`);
export const warn = (text: string) => out(`${yellow('!')} ${text}`);
export const bad = (text: string) => out(`${red('✗')} ${text}`);
export const detail = (text: string) => out(`  ${dim(text)}`);
export function fields(rows: unknown[][]) {
  out(
    table(
      rows.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [`  ${dim(k)}`, v]),
    ),
  );
}
export function next(lines: string[]) {
  if (!lines.length) return;
  out();
  out(bold('Next'));
  for (const line of lines) out(`  ${line}`);
}
export const tidyPath = (path: string) =>
  homedir() && String(path).startsWith(homedir()) ? `~${String(path).slice(homedir().length)}` : String(path);
export const plural = (n: number, word: string, many = `${word}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;

// Show a bounded prefix; never print the full credential.
export function mask(secret: string) {
  const visible = Math.min(8, Math.floor(secret.length / 4));
  return `${secret.slice(0, visible)}…(${secret.length} chars)`;
}

export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export async function confirm(question: string, { yes = false } = {}) {
  if (yes) return true;
  if (!process.stdin.isTTY)
    throw new CliError(`${question}\nNo terminal to ask in: run again with --yes to confirm.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} ${dim('[y/N]')} `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export function table(rows: unknown[][]) {
  if (!rows.length) return '';
  // Widths without colour codes, so coloured cells still line up.
  const width = (c: unknown) => String(c ?? '').replace(/\x1b\[[0-9;]*m/g, '').length;
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => width(r[i]))));
  return rows
    .map((r) =>
      r
        .map((c, i) =>
          i === r.length - 1 ? String(c ?? '') : String(c ?? '') + ' '.repeat(widths[i] - width(c)),
        )
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
