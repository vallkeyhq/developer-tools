export interface KeyKind {
  id: string;
  title: string;
  provider: string | null;
  manual?: boolean;
  find?: RegExp;
  value: RegExp;
  name?: RegExp;
}
export interface KeyMatch {
  kind: KeyKind;
  secret: string;
  index: number;
}

// Prefixless credentials require a matching variable name to limit false positives.
// A null provider means detection is supported without a protection integration.

const token = (source: string) => new RegExp(`(?<![A-Za-z0-9_-])(?:${source})(?![A-Za-z0-9_-])`, 'g');
const exact = (source: string) => new RegExp(`^(?:${source})$`);

const STRIPE = '(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,247}';
const JWT = 'eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export const KINDS: KeyKind[] = [
  // With a prefix. More specific prefixes come first (sk-ant- before sk-).
  { id: 'stripe', title: 'Stripe secret key', provider: 'stripe', find: token(STRIPE), value: exact(STRIPE) },
  {
    id: 'anthropic',
    title: 'Anthropic API key',
    provider: 'anthropic',
    find: token('sk-ant-[A-Za-z0-9_-]{20,300}'),
    value: exact('sk-ant-[A-Za-z0-9_-]{20,300}'),
  },
  {
    id: 'openrouter',
    title: 'OpenRouter API key',
    provider: 'openrouter',
    find: token('sk-or-v1-[a-f0-9]{64}'),
    value: exact('sk-or-v1-[a-f0-9]{64}'),
  },
  {
    id: 'openai',
    title: 'OpenAI API key',
    provider: 'openai',
    find: token('sk-(?!ant-|or-v1-)[A-Za-z0-9_-]{20,300}'),
    value: exact('sk-(?!ant-|or-v1-)[A-Za-z0-9_-]{20,300}'),
  },
  {
    id: 'gemini',
    title: 'Google API key',
    provider: 'gemini',
    find: token('AIza[0-9A-Za-z_-]{30,40}'),
    value: exact('AIza[0-9A-Za-z_-]{30,40}'),
  },
  {
    id: 'groq',
    title: 'Groq API key',
    provider: 'groq',
    find: token('gsk_[A-Za-z0-9]{40,80}'),
    value: exact('gsk_[A-Za-z0-9]{40,80}'),
  },
  {
    id: 'xai',
    title: 'xAI API key',
    provider: 'xai',
    find: token('xai-[A-Za-z0-9]{20,120}'),
    value: exact('xai-[A-Za-z0-9]{20,120}'),
  },
  {
    id: 'resend',
    title: 'Resend API key',
    provider: 'resend',
    find: token('re_[A-Za-z0-9_]{20,120}'),
    value: exact('re_[A-Za-z0-9_]{20,120}'),
  },
  {
    id: 'sendgrid',
    title: 'SendGrid API key',
    provider: 'sendgrid',
    find: token('SG\\.[A-Za-z0-9_-]{16,32}\\.[A-Za-z0-9_-]{16,64}'),
    value: exact('SG\\.[A-Za-z0-9_-]{16,32}\\.[A-Za-z0-9_-]{16,64}'),
  },
  {
    id: 'github',
    title: 'GitHub token',
    provider: 'github',
    find: token('gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255}'),
    value: exact('gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255}'),
  },
  {
    id: 'paddle',
    title: 'Paddle API key',
    provider: 'paddle',
    find: token('pdl_(?:live|sdbx)_apikey_[A-Za-z0-9_]{20,200}'),
    value: exact('pdl_(?:live|sdbx)_apikey_[A-Za-z0-9_]{20,200}'),
  },
  {
    id: 'mailgun',
    title: 'Mailgun API key',
    provider: 'mailgun',
    find: token('key-[a-f0-9]{32}'),
    value: exact('(?:key-)?[a-f0-9]{32}(?:-[a-f0-9]{8}-[a-f0-9]{8})?'),
    name: /MAILGUN.*(?:KEY|TOKEN)/,
  },
  {
    id: 'aws',
    title: 'AWS access key id',
    provider: 'aws',
    manual: true,
    find: token('(?:AKIA|ASIA)[A-Z0-9]{16}'),
    value: exact('(?:AKIA|ASIA)[A-Z0-9]{16}'),
  },
  {
    id: 'slack',
    title: 'Slack token',
    provider: null,
    find: token('xox[abposr]-[A-Za-z0-9-]{10,250}'),
    value: exact('xox[abposr]-[A-Za-z0-9-]{10,250}'),
  },
  {
    id: 'huggingface',
    title: 'Hugging Face token',
    provider: null,
    find: token('hf_[A-Za-z0-9]{34,40}'),
    value: exact('hf_[A-Za-z0-9]{34,40}'),
  },
  {
    id: 'npm',
    title: 'npm token',
    provider: null,
    find: token('npm_[A-Za-z0-9]{36}'),
    value: exact('npm_[A-Za-z0-9]{36}'),
  },
  {
    id: 'shopify',
    title: 'Shopify access token',
    provider: null,
    find: token('shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}'),
    value: exact('shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}'),
  },

  // Without a prefix: recognised by the name they are stored under.
  {
    id: 'mistral',
    title: 'Mistral API key',
    provider: 'mistral',
    name: /MISTRAL.*(?:KEY|TOKEN)/,
    value: exact('[A-Za-z0-9]{32}'),
  },
  {
    id: 'postmark',
    title: 'Postmark server token',
    provider: 'postmark',
    name: /POSTMARK.*(?:KEY|TOKEN)/,
    value: exact(UUID),
  },
  {
    id: 'twilio',
    title: 'Twilio auth token',
    provider: 'twilio',
    name: /TWILIO.*(?:AUTH_TOKEN|API_SECRET|KEY_SECRET)/,
    value: exact('[A-Za-z0-9]{32}'),
  },
  {
    id: 'cloudflare',
    title: 'Cloudflare API token',
    provider: 'cloudflare',
    name: /^(?:CLOUDFLARE|CF)_(?:API_)?TOKEN$|^CLOUDFLARE_.*TOKEN$/,
    value: exact('[A-Za-z0-9_-]{40,60}'),
  },
  {
    id: 'vercel',
    title: 'Vercel token',
    provider: 'vercel',
    name: /^VERCEL_(?:API_|ACCESS_)?TOKEN$/,
    value: exact('[A-Za-z0-9_-]{24,100}'),
  },
  {
    id: 'lemonsqueezy',
    title: 'Lemon Squeezy API key',
    provider: 'lemonsqueezy',
    name: /LEMON_?SQUEEZY.*(?:KEY|TOKEN)/,
    value: exact(JWT),
  },
  {
    id: 'aws-secret',
    title: 'AWS secret access key',
    provider: 'aws',
    manual: true,
    name: /AWS_SECRET_ACCESS_KEY|AWS_SECRET_KEY/,
    value: exact('[A-Za-z0-9/+=]{40}'),
  },
];

const PLACEHOLDER = /x{4,}|\.\.\.|…|your|example|placeholder|dummy|changeme|redacted|sample|<|>|\*\*\*/i;
const GHOST = /^gk_[a-z]{2,20}_|^gkm_/;

// Shannon entropy in bits per character: real keys are random, placeholders are not.
function entropy(s: string) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

const whole = (kind: KeyKind & { find: RegExp }) => new RegExp(`^(?:${kind.find.source})$`);

export function looksReal(value: string) {
  if (GHOST.test(value) || PLACEHOLDER.test(value)) return false;
  // Ids like re_send_welcome_email_template are words, not keys: a key has digits too.
  if (/^re_/.test(value) && !/\d/.test(value)) return false;
  return entropy(value) >= 3;
}

export function identify(name: string, value: string) {
  if (!value || !looksReal(value)) return null;
  for (const kind of KINDS) {
    if (kind.find && whole({ ...kind, find: kind.find }).test(value)) return kind;
  }
  for (const kind of KINDS) {
    if (kind.name && kind.name.test(name) && kind.value.test(value)) return kind;
  }
  return null;
}

const ASSIGNMENT = /\b([A-Z][A-Z0-9_]{2,80})["']?\s*(?:=|:|=>)\s*["'`]?([^\s"'`#,;)]{8,4096})/g;

export function findKeys(text: string) {
  const found = [];
  const taken: [number, number][] = [];
  const overlaps = (start: number, end: number) => taken.some(([s, e]) => start < e && end > s);
  for (const kind of KINDS) {
    if (!kind.find) continue;
    for (const m of text.matchAll(kind.find)) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end) || !looksReal(m[0])) continue;
      taken.push([start, end]);
      found.push({ kind, secret: m[0], index: start });
    }
  }
  for (const m of text.matchAll(ASSIGNMENT)) {
    const value = m[2];
    const start = m.index + m[0].length - value.length;
    if (overlaps(start, start + value.length)) continue;
    const kind = identify(m[1], value);
    if (!kind || (kind.find && whole({ ...kind, find: kind.find }).test(value))) continue;
    taken.push([start, start + value.length]);
    found.push({ kind, secret: value, index: start });
  }
  return found.sort((a, b) => a.index - b.index);
}
