export interface Flags {
  yes?: boolean;
  'dry-run'?: boolean;
  history?: boolean;
  json?: boolean;
  'no-browser'?: boolean;
  help?: boolean;
  version?: boolean;
  print?: boolean;
  embedded?: boolean;
  api?: string;
  reason?: string;
  from?: string;
  label?: string;
  rules?: string;
  dir?: string;
  allowlist?: string;
  method?: string;
  'request-id'?: string;
  expect?: string;
  timeout?: string;
}
export interface Auth {
  api: string;
  token?: string | null;
  source?: string | null;
}
export interface SavedConfig {
  api?: string;
  token?: string;
  tenant?: string;
  signed_in_at?: string;
}
export interface ProjectPackage {
  name?: string;
  version?: string;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
export type Rules = Record<string, unknown>;
export interface KeySummary {
  keyId: string;
  provider: string;
  label: string;
  createdAt: number;
  killedAt?: number | null;
  realKeyId?: string;
}
export interface AgentKey {
  key_id: string;
  service: string;
  label: string;
  environment?: string;
  usable: boolean;
  rules: Rules;
}
export interface Activity {
  requestId: string;
  at: number;
  outcome: string;
  status: number | null;
  cached?: boolean;
  method: string;
  path: string;
  reason?: string;
  country?: string;
  ip?: string;
}
export interface Place {
  how: string;
  lang?: string;
  runtime?: string;
  platform?: string;
  env?: string;
  sdk?: string;
  network?: string;
  lastAt: number;
  today: number;
  deniedToday: number;
  failedToday: number;
  status: string;
  lastFailed?: { status: number };
}
export interface RealKey {
  real_key_id: string;
  provider: string;
  label: string;
  hint?: string;
  ghost_keys: string[];
  hidden_ghost_keys: number;
  outer_rules?: Rules;
}
export interface Domain {
  hostname: string;
  status: string;
  isDefault?: boolean;
}
export interface DomainCheck extends Domain {
  records: { ok: boolean; type: string; name: string; value: string }[];
  problems: { message: string }[];
}
export interface CreatedKey {
  key_id: string;
  ghost_key: string;
  rules?: Rules;
}
export interface Provider {
  name: string;
  title: string;
  origin: string;
  default_rules: Rules;
}
export interface KeyDetail {
  rules: Rules;
  pending?: { rules: Rules };
}
export interface ChangeResult {
  applied: string;
  activatesAt: number;
}
export interface Task {
  key_id: string;
  [key: string]: unknown;
}
export interface AgentInfo {
  agent: unknown;
  plan: unknown;
  tasks: unknown;
  keys: AgentKey[];
  how: string[];
}
export interface CreatedTask extends CreatedKey {
  api_origin: string;
  provider: string;
  ends_at: string;
}
export interface LoginStart {
  user_code: string;
  device_code: string;
  verification_url: string;
  interval?: number;
  expires_in?: number;
}
export interface LoginToken {
  api_origin?: string;
  token: string;
  tenant_id: string;
}
