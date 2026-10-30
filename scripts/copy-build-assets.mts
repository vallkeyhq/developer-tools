import { chmodSync, copyFileSync } from 'node:fs';

const root = new URL('../cli/', import.meta.url);
copyFileSync(new URL('src/hooks.json', root), new URL('dist/src/hooks.json', root));
chmodSync(new URL('dist/bin/vallkey.js', root), 0o755);
