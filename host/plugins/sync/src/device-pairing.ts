import type { SettingsStore } from '../../../platform/settings/api.ts';

/** Host settings are synchronous; the frontend uses the same operations via IPC. */
export type PairingSettings = {
  [K in 'get' | 'save' | 'listByPrefix' | 'getSecret' | 'saveSecret']:
    (...args: Parameters<SettingsStore[K]>) => ReturnType<SettingsStore[K]> | Promise<Awaited<ReturnType<SettingsStore[K]>>>;
};

export interface CreatePairingArgs { pin: string; includeCloudConfig?: boolean; includeLlmKeys?: boolean; includeSyncPrefs?: boolean }
export interface ApplyPairingArgs { pairingCode: string; pin: string }
const CLOUD = ['cloud_storage.config.safe_v1', 'cloud_storage_credentials'];
const LLM = ['llm_providers', 'api_configs', 'vendor_configs', 'model_profiles', 'model_assignments', 'siliconflow.api_key'];
const PREFS = ['sync.include_skills', 'sync.include_plugins'];
type Payload = { version: 1; settings: Record<string, string> };
export interface PairingSummary { cloudProvider: string | null; llmProviders: number; includeSkills: boolean | null; includePlugins: boolean | null }
function summary(payload: Payload): PairingSummary {
  const settings = payload.settings;
  const cloud = JSON.parse(settings[CLOUD[0]!] ?? '{}');
  const providers = JSON.parse(settings.vendor_configs ?? settings.llm_providers ?? settings.api_configs ?? '[]');
  return { cloudProvider: cloud.provider ?? null, llmProviders: Array.isArray(providers) ? providers.length : Object.keys(providers).length,
    includeSkills: settings[PREFS[0]!] === undefined ? null : settings[PREFS[0]!] !== 'false',
    includePlugins: settings[PREFS[1]!] === undefined ? null : settings[PREFS[1]!] !== 'false' };
}
async function key(pin: string, salt: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  if (!/^\d{6}$/.test(pin)) throw new Error('请输入 6 位数字 PIN');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: new Uint8Array(salt), iterations: 100_000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, [usage]);
}
function allowed(name: string): boolean {
  return [...CLOUD, ...LLM, ...PREFS].includes(name) || /^cloud_sync\.[\w.]+$/.test(name) || /^builtin-[\w-]+\.api_key$/.test(name);
}
export async function createPairingCode(settings: PairingSettings, args: CreatePairingArgs) {
  const names = new Set<string>();
  if (args.includeCloudConfig !== false) {
    CLOUD.forEach(name => names.add(name));
    (await settings.listByPrefix('cloud_sync.')).forEach(row => names.add(row.key));
  }
  if (args.includeLlmKeys !== false) {
    LLM.forEach(name => names.add(name));
    (await settings.listByPrefix('builtin-')).filter(row => allowed(row.key)).forEach(row => names.add(row.key));
    for (const config of ['vendor_configs', 'llm_providers', 'api_configs']) {
      const vendors = JSON.parse(await settings.getSecret(config) ?? '[]');
      if (Array.isArray(vendors)) for (const vendor of vendors) if (vendor && typeof vendor.id === 'string' && vendor.id.startsWith('builtin-')) names.add(`${vendor.id}.api_key`);
    }
  }
  if (args.includeSyncPrefs !== false) PREFS.forEach(name => names.add(name));
  const payload: Payload = { version: 1, settings: {} };
  for (const name of names) {
    const value = name === CLOUD[0] ? await settings.get(name) : await settings.getSecret(name);
    if (value !== null) payload.settings[name] = value;
    else if (PREFS.includes(name)) payload.settings[name] = 'true';
  }
  const included = summary(payload);
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(args.pin, salt, 'encrypt'), new TextEncoder().encode(JSON.stringify(payload))));
  const bytes = new Uint8Array(28 + encrypted.length); bytes.set(salt); bytes.set(iv, 16); bytes.set(encrypted, 28);
  const pairingCode = `DSPAIR1:${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  return { pairingCode, summary: included };
}
export async function applyPairingCode(settings: PairingSettings, args: ApplyPairingArgs) {
  if (!args.pairingCode.startsWith('DSPAIR1:')) throw new Error('不支持的配对码格式');
  let payload: Payload;
  try {
    const bytes = Uint8Array.from(atob(args.pairingCode.slice(8).trim().replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
    const decoded = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(16, 28) }, await key(args.pin, bytes.slice(0, 16), 'decrypt'), bytes.slice(28));
    payload = JSON.parse(new TextDecoder().decode(decoded));
  } catch { throw new Error('PIN 不正确或配对码已损坏'); }
  if (payload.version !== 1 || !payload.settings || Array.isArray(payload.settings)) throw new Error('不支持的配对配置');
  for (const [name, value] of Object.entries(payload.settings)) if (!allowed(name) || typeof value !== 'string') throw new Error('配对配置包含不支持的设置');
  const restored = summary(payload);
  // Secrets first: never publish usable-looking SSOT before its credentials exist.
  for (const [name, value] of Object.entries(payload.settings)) if (name !== CLOUD[0]) await settings.saveSecret(name, value);
  if (payload.settings[CLOUD[0]!] !== undefined) await settings.save(CLOUD[0]!, payload.settings[CLOUD[0]!]!);
  return { summary: restored };
}
