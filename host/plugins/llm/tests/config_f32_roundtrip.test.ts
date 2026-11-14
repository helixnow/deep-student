/**
 * V08-03: `ModelProfile.{temperature,minP,repetitionPenalty}` are Rust `f32`
 * (`dstu-llm/src/llm_manager/mod.rs:3660-3685`). Rust persists them with
 * `serde_json::to_string(&Vec<ModelProfile>)` (`mod.rs:6398`, snapshot `:4662`), whose
 * `serialize_f32` writes zmij's shortest f32 decimal (serde_json 1.0.149 `ser.rs:1691-1697`):
 * `0.7f32` → `0.7`, `1.0f32` → `1.0`. Reading back deserializes into `f32` again, so the IPC
 * result is the same shortest decimal. The production IPC path (`argsJson`) decodes `x-float: f32`
 * as `Math.fround`, i.e. 0.699999988079071 for 0.7; it must not reach the database or the frontend.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
// boundary-allow cross-plugin-import: install the real L01 plugin for the production command path.
import providers from '../../llm-providers/index.ts';
import llm from '../index.ts';
import type { ModelProfile } from '../api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { image } from '../../../platform/native/image/index.ts';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
import { stringifyProfileArray } from '../src/config_profiles.ts';
import { modelProfileFromDe, normalizeProfileRecord } from '../src/config_values.ts';
import { realInjectionBudget } from './host.ts';

const BASE_URL = 'http://127.0.0.1:47110/s/v08-03/v1';

let host: Awaited<ReturnType<typeof createTestHost>>;
const values = new Map<string, string>();
const settings: SettingsStore = {
  get: key => values.get(key) ?? null, save: (key, value) => { values.set(key, value); },
  delete: key => values.delete(key), listByPrefix: () => [], deleteByPrefix: () => 0,
  getSecret: async key => values.get(key) ?? null, saveSecret: async (key, value) => { values.set(key, value); },
  deleteSecret: async key => values.delete(key),
};

beforeAll(async () => {
  host = await createTestHost({ plugins: [providers, llm], provide: {
    settings, secrets: { isEncryptedFormat: () => false, openCrypto: async () => ({ migratePlaintextKey: (value: string) => value }) },
    nativeImage: image, nativeTokenizer: tokenizer, injectionBudget: realInjectionBudget, vfsDatabase: {}, vfsRepo: { essays: {} },
  } });
});
afterAll(async () => { await host?.dispose(); });
beforeEach(() => { values.clear(); });

let invokeId = 0;
/** Electron main always sends `argsJson`; `TestHost.invoke` does not (V08-02). */
async function invokeWire(cmd: string, args: unknown): Promise<string> {
  const outcome = await host.runtime.dispatchInvoke({ id: `v08-03-${++invokeId}`, cmd, args: {}, argsJson: JSON.stringify(args),
    source: { window: 'main', webview: 'main' } });
  if (outcome.kind !== 'ok') throw new Error(`${cmd} failed: ${JSON.stringify(outcome)}`);
  return outcome.json ?? JSON.stringify(outcome.value);
}

function fieldTexts(json: string, id: string): Record<string, string> {
  const start = json.indexOf(`{"id":${JSON.stringify(id)}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const record = json.slice(start, json.indexOf('}', start) + 1);
  const pick = (key: string) => /^-?[\d.e+-]+|^null/.exec(record.slice(record.indexOf(`"${key}":`) + key.length + 3))?.[0] ?? '<missing>';
  return { temperature: pick('temperature'), minP: pick('minP'), repetitionPenalty: pick('repetitionPenalty') };
}

function profile(overrides: Partial<ModelProfile>): ModelProfile {
  return { ...modelProfileFromDe({ id: 'p', vendorId: 'v', label: 'P', model: 'm' }), ...overrides };
}

describe('V08-03 model profile f32 fields are written in the Rust f32 spelling', () => {
  it('stringifyProfileArray writes the shortest f32 decimal of IPC-decoded values', () => {
    const json = stringifyProfileArray([
      profile({ id: 'a', temperature: Math.fround(0.7), minP: Math.fround(0.05), repetitionPenalty: Math.fround(1.1) }),
      profile({ id: 'b', temperature: 1, minP: 0.1234567891, repetitionPenalty: Math.fround(1e-7) }),
      profile({ id: 'c', temperature: 0, minP: null, repetitionPenalty: null }),
    ]);
    expect(fieldTexts(json, 'a')).toEqual({ temperature: '0.7', minP: '0.05', repetitionPenalty: '1.1' });
    // 0.1234567891 as f32 is 0.12345679; zmij writes f32 exponents outside [-6, 12] in scientific form.
    expect(fieldTexts(json, 'b')).toEqual({ temperature: '1.0', minP: '0.12345679', repetitionPenalty: '1e-7' });
    expect(fieldTexts(json, 'c')).toEqual({ temperature: '0.0', minP: 'null', repetitionPenalty: 'null' });
  });

  it('normalizeProfileRecord reads stored values back as f32 (shortest decimal)', () => {
    const read = normalizeProfileRecord({ id: 'p', vendorId: 'v', label: 'P', model: 'm',
      temperature: 0.699999988079071, minP: 0.1234567891, repetitionPenalty: 1.100000023841858 });
    expect([read.temperature, read.minP, read.repetitionPenalty]).toEqual([0.7, 0.12345679, 1.1]);
  });
});

describe('V08-03 real handlers over the production argsJson path', () => {
  // Without vendor_configs, get_model_profiles bootstraps an empty profile list (mod.rs bootstrap_vendor_model_config).
  const seedVendor = () => values.set('vendor_configs', JSON.stringify([{ id: 'v08-v', name: 'V08', providerType: 'openai',
    baseUrl: BASE_URL, apiKey: '' }]));

  it('save_model_profiles persists 0.7 and get_model_profiles returns 0.7', async () => {
    seedVendor();
    await invokeWire('save_model_profiles', { profiles: [{ id: 'v08-p', vendorId: 'v08-v', label: 'V08', model: 'v08-model',
      temperature: 0.7, minP: 0.05, repetitionPenalty: 1.1 }] });
    expect(fieldTexts(values.get('model_profiles')!, 'v08-p')).toEqual({ temperature: '0.7', minP: '0.05', repetitionPenalty: '1.1' });
    expect(fieldTexts(await invokeWire('get_model_profiles', {}), 'v08-p'))
      .toEqual({ temperature: '0.7', minP: '0.05', repetitionPenalty: '1.1' });
  });

  it('save_api_configurations persists 0.7 and get_api_configurations returns 0.7', async () => {
    await invokeWire('save_api_configurations', { configs: [{ id: 'v08-cfg', name: 'V08 cfg', apiKey: 'local-test-key',
      baseUrl: BASE_URL, model: 'v08-model', isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false,
      enabled: true, modelAdapter: 'general', maxOutputTokens: 1024, temperature: 0.7, minP: 0.05, repetitionPenalty: 1.1 }] });
    expect(fieldTexts(values.get('model_profiles')!, 'v08-cfg')).toEqual({ temperature: '0.7', minP: '0.05', repetitionPenalty: '1.1' });
    const listed = JSON.parse(await invokeWire('get_api_configurations', {})) as { id: string; temperature: number; minP: number | null; repetitionPenalty: number | null }[];
    const config = listed.find(item => item.id === 'v08-cfg');
    expect([config?.temperature, config?.minP, config?.repetitionPenalty]).toEqual([0.7, 0.05, 1.1]);
  });

  it('a stored widened double reads back as the f32 value and is rewritten in the Rust spelling', async () => {
    seedVendor();
    values.set('model_profiles', stringifyProfileArray([profile({ id: 'legacy', vendorId: 'v08-v', temperature: 0.7 })])
      .replace('"temperature":0.7', '"temperature":0.699999988079071'));
    expect(fieldTexts(await invokeWire('get_model_profiles', {}), 'legacy').temperature).toBe('0.7');
    const listed = JSON.parse(await invokeWire('get_model_profiles', {})) as Record<string, unknown>[];
    await invokeWire('save_model_profiles', { profiles: listed });
    expect(fieldTexts(values.get('model_profiles')!, 'legacy').temperature).toBe('0.7');
  });
});
