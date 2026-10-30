// Reading and editing .env files without disturbing anything else in them:
// comments, order, quoting and blank lines all stay as they were.

const LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/;

// Each variable with where its value sits in the line, so it can be replaced in place.
export function parseEnv(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  lines.forEach((line, index) => {
    const m = LINE.exec(line);
    if (!m) return;
    const [, lead, name, eq, rest] = m;
    const offset = lead.length + name.length + eq.length;
    const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : '';
    if (quote) {
      const close = rest.indexOf(quote, 1);
      if (close === -1) return; // a value over several lines: leave it alone
      entries.push({ name, value: rest.slice(1, close), line: index, start: offset + 1, end: offset + close });
    } else {
      const value = rest.replace(/\s+#.*$/, '').trimEnd();
      entries.push({ name, value, line: index, start: offset, end: offset + value.length });
    }
  });
  return { lines, entries, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

// The file with some values replaced (by entry) and some variables added at the end.
export function editEnv(parsed, replace, append = []) {
  const lines = [...parsed.lines];
  for (const [entry, value] of replace) {
    const line = lines[entry.line];
    lines[entry.line] = line.slice(0, entry.start) + value + line.slice(entry.end);
  }
  if (append.length) {
    while (lines.length && lines.at(-1) === '') lines.pop();
    lines.push('', ...append, '');
  }
  return lines.join(parsed.eol);
}
