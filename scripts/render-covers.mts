import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const output = new URL('../assets/covers/', import.meta.url);
mkdirSync(output, { recursive: true });
const mark = readFileSync(new URL('../assets/vallkey-mark.svg', import.meta.url), 'utf8').replace(
  '<svg ',
  '<svg x="902" y="182" width="260" height="260" ',
);
const items = [
  [
    'developer-tools',
    'Developer tools',
    'The tools between your app and its API keys.',
    'npx vallkey@latest connect',
    'CLI / RUNTIME HOOKS / MCP',
  ],
  [
    'cli',
    'Command line',
    'Protect keys. Inspect activity. Verify requests.',
    'npx vallkey@latest init --dry-run',
    'NODE.JS / BUN / TYPESCRIPT',
  ],
  [
    'node',
    'Node.js & Bun',
    'Ghost-key routing for supported HTTP clients.',
    "import 'vallkey/auto'",
    'FETCH / HTTP / HTTPS',
  ],
  [
    'python',
    'Python',
    'Ghost-key routing for Python applications.',
    'VALLKEY_AUTO=1 python app.py',
    'HTTPX / REQUESTS / AIOHTTP',
  ],
  [
    'ruby',
    'Ruby',
    'Ghost-key routing through Net::HTTP.',
    'RUBYOPT=-rvallkey/auto bundle exec ruby app.rb',
    'NET::HTTP / RUBY',
  ],
  [
    'java',
    'Java',
    'A runtime agent for supported HTTP clients.',
    'java -javaagent:vallkey-agent.jar -jar app.jar',
    'JDK / OKHTTP / APACHE HTTPCLIENT',
  ],
  [
    'dotnet',
    '.NET',
    'Ghost-key routing through HttpClient.',
    'DOTNET_STARTUP_HOOKS=Vallkey.Auto.dll',
    'HTTPCLIENT / STARTUP HOOK',
  ],
  [
    'php',
    'PHP',
    'Ghost-key routing through the cURL extension.',
    'PHP_INI_SCAN_DIR=:/opt/vallkey/php php app.php',
    'CURL / GUZZLE / PHP',
  ],
  [
    'elixir',
    'Elixir & Erlang',
    'Runtime routing for supported BEAM clients.',
    'Finch / hackney / httpc',
    'BEAM / FINCH / HACKNEY / HTTPC',
  ],
  [
    'terraform',
    'Terraform provider',
    'Manage ghost keys and their rules as code.',
    'terraform plan',
    'INFRASTRUCTURE AS CODE',
  ],
  [
    'scan-action',
    'Key scan',
    'Find recognizable API keys in your checkout.',
    'uses: vallkeyhq/scan-action@v1',
    'GITHUB ACTIONS / SECRET SCANNING',
  ],
] as const;
const escape = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
for (const [name, title, description, command, category] of items) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640" role="img" aria-labelledby="title description">
  <title id="title">Vallkey — ${escape(title)}</title><desc id="description">${escape(description)}</desc>
  <defs>
    <radialGradient id="ambient" cx="82%" cy="45%" r="68%"><stop stop-color="#653de9" stop-opacity=".23"/><stop offset="1" stop-color="#0b0d12" stop-opacity="0"/></radialGradient>
    <linearGradient id="line" x1="0" x2="1"><stop stop-color="#968bff"/><stop offset="1" stop-color="#653de9" stop-opacity=".1"/></linearGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="#ffffff" stroke-opacity=".025"/></pattern>
  </defs>
  <rect width="1280" height="640" fill="#0b0d12"/><rect width="1280" height="640" fill="url(#ambient)"/>
  <path d="M832 0H1280V640H832Z" fill="url(#grid)"/>
  <path d="M64 108H1216" stroke="#ffffff" stroke-opacity=".09"/>
  <text x="64" y="73" fill="#fff" font-family="Inter, sans-serif" font-size="27" font-weight="600" letter-spacing="-.7">vallkey</text>
  <text x="1216" y="70" fill="#a8a9b3" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="13" letter-spacing="1.4">DEVELOPER PLATFORM</text>
  <text x="64" y="175" fill="#a99bff" font-family="JetBrains Mono, monospace" font-size="12" letter-spacing="1.5">${escape(category)}</text>
  <text x="60" y="265" fill="#fff" font-family="Inter, sans-serif" font-size="62" font-weight="600" letter-spacing="-2.6">${escape(title)}</text>
  <text x="64" y="312" fill="#b8b9c5" font-family="Inter, sans-serif" font-size="21" letter-spacing="-.3">${escape(description)}</text>
  <path d="M64 351H732" stroke="url(#line)"/>
  <rect x="64" y="390" width="712" height="87" rx="12" fill="#11121b" stroke="#292637"/>
  <text x="88" y="441" fill="#9988ff" font-family="JetBrains Mono, monospace" font-size="18">$</text>
  <text x="116" y="441" fill="#e0dfeb" font-family="JetBrains Mono, monospace" font-size="16">${escape(command)}</text>
  <circle cx="1032" cy="312" r="172" fill="none" stroke="#968bff" stroke-opacity=".09"/>
  <circle cx="1032" cy="312" r="146" fill="none" stroke="#968bff" stroke-opacity=".12"/>
  ${mark}
  <path d="M64 548H1216" stroke="#ffffff" stroke-opacity=".09"/>
  <text x="64" y="588" fill="#828493" font-family="Inter, sans-serif" font-size="14">Ghost keys. Scoped access. One-click revoke.</text>
  <text x="1216" y="588" fill="#a99bff" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="13">vallkey.com</text>
</svg>`;
  const source = fileURLToPath(new URL(`${name}.svg`, output));
  writeFileSync(source, svg + '\n');
  execFileSync('rsvg-convert', [
    '-w',
    '1280',
    '-h',
    '640',
    source,
    '-o',
    fileURLToPath(new URL(`${name}.png`, output)),
  ]);
  console.log(`Rendered ${name}`);
}
