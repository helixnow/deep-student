/** WP-131: routing.rs:55-90,550-565 typed u64 policy through real F4 settings into rag_extension.rs:1222-1233 cooldown. */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestHost } from '../../../kernel/testing.ts';
import storage from '../../../platform/storage/index.ts';
import secrets from '../../../platform/secrets/index.ts';
import settings from '../../../platform/settings/index.ts';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
import { image } from '../../../platform/native/image/index.ts';
// boundary-allow cross-plugin-import: installs L01's official entry, never imports its implementation.
import providers from '../../llm-providers/index.ts';
import plugin from '../index.ts';
import { makeConfig } from './support.ts';
import { embeddingService, type FailoverPolicy, type TextEmbeddingService } from '../api.ts';
import { defaultFailoverPolicy } from '../src/policy.ts';
import { keyCooldowns, keyFingerprint } from '../src/routing.ts';

let root: string;
let host: Awaited<ReturnType<typeof createTestHost>>;
let embedding: TextEmbeddingService;
let fingerprint: string;
const logs: { level: string; message: string }[] = [];
const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (message: string) => logs.push({ level, message })]));
const server = createServer(async (request, response) => {
  for await (const _ of request) { /* drain the real request body before responding */ }
  response.writeHead(401, { 'content-type': 'application/json' }); response.end('bad key');
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'wp131-policy-'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  host = await createTestHost({ app: { dataDir: root },
    plugins: [secrets, [storage, { dataLocalDir: root }], settings, providers, plugin], provide: {
      paths: { os: { home: root, data: root, dataLocal: root, config: root, temp: root } },
      log: { logger: () => logger }, nativeTokenizer: tokenizer, nativeImage: image,
      vfsDatabase: {}, vfsRepo: { essays: {} }, storageStartupSync: { resetDefaultAfterLocalPurge() {} },
    }, shell: () => null });
  await host.ctx.llm.saveApiConfigurations([makeConfig({ id: 'text', name: 'text', model: 'text-embedding-3-small',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: 'key',
    enabled: true, isEmbedding: true, isMultimodal: false, isReranker: false, modelAdapter: 'openai' })]);
  const live = (await host.ctx.llm.getApiConfigs()).find(config => config.id === 'text')!;
  fingerprint = keyFingerprint(live.vendorId ?? live.baseUrl, 'key');
  embedding = host.ctx.get(embeddingService.name) as TextEmbeddingService;
}, 120_000);
beforeEach(() => { keyCooldowns()._entries.clear(); logs.length = 0; });
afterAll(async () => {
  keyCooldowns()._entries.clear();
  await host?.dispose(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

/** Persist the raw setting exactly as stored by Rust, then observe the original 401 cooldown write. */
async function cooledSeconds(raw: string): Promise<number> {
  keyCooldowns()._entries.clear();
  host.ctx.settings.save('llm_failover_policy', raw);
  expect(host.ctx.settings.get('llm_failover_policy')).toBe(raw);
  const start = logs.length;
  const before = performance.now();
  await expect(embedding.callEmbeddingApi(['a'], 'text')).rejects.toMatchObject({ error_type: 'LLM', message: 'API 密钥无效或已过期，请检查设置' });
  const after = performance.now();
  const until = keyCooldowns()._entries.get(fingerprint)!;
  const warned = logs.slice(start).filter(entry => entry.level === 'warn' && entry.message.startsWith('[Embedding] HTTP 401'));
  expect(warned).toHaveLength(1);
  const seconds = /key cooled down for (\d+)s \(retry_after=None\)$/.exec(warned[0]!.message)![1]!;
  expect(until - before).toBeGreaterThanOrEqual(Number(seconds) * 1000);
  expect(until - after).toBeLessThanOrEqual(Number(seconds) * 1000);
  // Cooling state is the real consumer: the next call fails fast without HTTP.
  await expect(embedding.callEmbeddingApi(['a'], 'text')).rejects.toMatchObject({ message: '嵌入 API 密钥处于限速/鉴权冷却期，请稍后重试' });
  return Number(seconds);
}
const parseWarnings = () => logs.filter(entry => entry.message.startsWith('[Failover] 策略配置解析失败，回落默认值:')).map(entry => entry.message);

it('persisted u64::MAX and u64::MAX-1 keyCooldownSecs are legal and clamp to 3600s, not the 60s fallback', async () => {
  expect(await cooledSeconds('{"keyCooldownSecs":18446744073709551615}')).toBe(3600);
  expect(await cooledSeconds('{"keyCooldownSecs":18446744073709551614}')).toBe(3600);
  expect(await cooledSeconds('{"keyCooldownSecs":3601}')).toBe(3600);
  expect(parseWarnings()).toEqual([]);
});

it('normal, zero and absent cooldown keep the original clamp and serde defaults', async () => {
  expect(await cooledSeconds('{"keyCooldownSecs":9}')).toBe(9);
  expect(await cooledSeconds('{"keyCooldownSecs":3600}')).toBe(3600);
  expect(await cooledSeconds('{"keyCooldownSecs":0}')).toBe(1);
  expect(await cooledSeconds('{"enabled":false}')).toBe(60);
  expect(parseWarnings()).toEqual([]);
});

it('u64 overflow, negative, fraction and exponent are serde errors: warn and discard the whole policy (60s)', async () => {
  // Cargo.lock: serde_json 1.0.149 error.rs:471-475 uses zmij 1.0.21 lib.rs:1100-1105: positive exponents include '+'.
  const cases: [string, string][] = [
    ['{"keyCooldownSecs":18446744073709551616}', 'invalid type: floating point `1.8446744073709552e+19`, expected u64 at line 1 column 39'],
    ['{"keyCooldownSecs":-1}', 'invalid value: integer `-1`, expected u64 at line 1 column 21'],
    ['{"keyCooldownSecs":1.5}', 'invalid type: floating point `1.5`, expected u64 at line 1 column 22'],
    ['{"keyCooldownSecs":1e3}', 'invalid type: floating point `1000.0`, expected u64 at line 1 column 22'],
    ['{"keyCooldownSecs":"9"}', 'invalid type: string "9", expected u64 at line 1 column 22'],
    ['{"rateLimitBackoffMs":18446744073709551616,"keyCooldownSecs":9}', 'invalid type: floating point `1.8446744073709552e+19`, expected u64 at line 1 column 42'],
  ];
  for (const [raw, error] of cases) {
    logs.length = 0;
    expect(await cooledSeconds(raw)).toBe(60);
    expect(parseWarnings()).toEqual([`[Failover] 策略配置解析失败，回落默认值: ${error}`]);
  }
});

it('serde derive shape: unknown fields ignored, duplicate field rejected, map last-wins, seq form with defaults', async () => {
  expect(await cooledSeconds('{"other":[1,{"x":-0.5e99}],"keyCooldownSecs":18446744073709551615}')).toBe(3600);
  expect(await cooledSeconds('[true,false,[],{},{},7]')).toBe(7);
  expect(parseWarnings()).toEqual([]);
  expect(await cooledSeconds('{"keyCooldownSecs":9,"keyCooldownSecs":10}')).toBe(60);
  expect(parseWarnings()).toEqual(['[Failover] 策略配置解析失败，回落默认值: duplicate field `keyCooldownSecs` at line 1 column 38']);
  host.ctx.settings.save('llm_failover_policy', '{"purposeModels":{"compaction":"a","compaction":"b"},"taskFallbacks":{"__proto__":["x"]}}');
  const policy = await host.invoke<FailoverPolicy>('llm_get_failover_policy');
  expect(policy.purposeModels).toEqual({ compaction: 'b' });
  expect(Object.getOwnPropertyDescriptor(policy.taskFallbacks, '__proto__')?.value).toEqual(['x']);
});

it('llm_get_failover_policy accepts adjacent large u64 backoff/cooldown and projects them as JSON numbers (D3)', async () => {
  host.ctx.settings.save('llm_failover_policy', '{"keyCooldownSecs":18446744073709551615,"rateLimitBackoffMs":18446744073709551614}');
  expect(await host.invoke('llm_get_failover_policy')).toEqual({ ...defaultFailoverPolicy(),
    keyCooldownSecs: 18446744073709551615, rateLimitBackoffMs: 18446744073709551614 });
  host.ctx.settings.save('llm_failover_policy', '{"rateLimitBackoffMs":9007199254740993}');
  expect(await host.invoke('llm_get_failover_policy')).toEqual({ ...defaultFailoverPolicy(), rateLimitBackoffMs: 9007199254740993 });
  expect(parseWarnings()).toEqual([]);
});
