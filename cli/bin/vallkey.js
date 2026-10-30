#!/usr/bin/env node
import { main } from '../src/cli.js';
import { red } from '../src/ui.js';

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    // The first line says what went wrong; any further lines are indented under it.
    const [first, ...rest] = String(err?.message ?? err).split('\n');
    process.stderr.write(`\n${red('✗')} ${first}\n${rest.map((l) => `  ${l}\n`).join('')}`);
    process.exit(err?.exitCode ?? 1);
  },
);
