import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import secrets from '../../secrets/index.ts';
import storage from '../index.ts';
import {
  USAGE_BATCH_SIZE_THRESHOLD,
  clearPendingUsageQueue,
  enqueuePending,
  newUsageRecord,
  pendingUsageQueue,
  type UsageRecord,
} from '../llm-usage.ts';

let base: string;
let host: Awaited<ReturnType<typeof createTestHost>> | undefined;
let logs: Array<{ level: string; target: string; message: string }> = [];

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-f3-owner-services-'));
  logs = [];
  clearPendingUsageQueue();
});
afterEach(async () => {
  await host?.dispose();
  host = undefined;
  clearPendingUsageQueue();
  fs.rmSync(base, { recursive: true, force: true });
});

async function start(osData = base, temp = base) {
  const logger = (target: string) => ({
    debug(message: string) { logs.push({ level: 'debug', target, message }); },
    info(message: string) { logs.push({ level: 'info', target, message }); },
    warn(message: string) { logs.push({ level: 'warn', target, message }); },
    error(message: string) { logs.push({ level: 'error', target, message }); },
  });
  host = await createTestHost({
    app: { dataDir: base },
    plugins: [secrets, [storage, { dataLocalDir: base }]],
    provide: {
      paths: { os: { home: base, data: osData, dataLocal: base, config: base, temp } },
      log: { logger },
      storageStartupSync: { resetDefaultAfterLocalPurge() {} },
    },
    shell: () => null,
  });
  return host;
}

const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

it('storage takes dataLocalDir from ctx.paths when the profile does not override it', async () => {
  const pathsLocal = path.join(base, 'paths-local');
  host = await createTestHost({
    app: { dataDir: base },
    plugins: [secrets, storage],
    provide: {
      paths: { os: { home: base, data: base, dataLocal: pathsLocal, config: base, temp: base } },
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
      storageStartupSync: { resetDefaultAfterLocalPurge() {} },
    },
    shell: () => null,
  });
  expect(host.ctx.storage.locations.dataLocalDir).toBe(pathsLocal);
  expect(host.ctx.storage.pathOf('sync_state')).toBe(path.join(pathsLocal, 'deep-student', 'sync', 'sync_state.db'));
});

type Call = Parameters<Awaited<ReturnType<typeof start>>['ctx']['llmUsage']['recordLlmUsageCacheExtWithIdentity']>[0];
function call(overrides: Partial<Call> = {}): Call {
  return {
    callerType: 'chat_v2', model: 'claude-sonnet', promptTokens: 100, completionTokens: 20,
    reasoningTokens: null, cachedTokens: null, cacheWriteTokens: null,
    sessionId: null, variantId: null, runId: null, durationMs: null,
    success: true, errorMessage: null, adapter: null, tokenSource: null, ...overrides,
  };
}

it('llmUsage.recordLlmUsageCacheExtWithIdentity persists identity columns and Option NULLs (mod.rs:252)', async () => {
  const h = await start();
  h.ctx.llmUsage.recordLlmUsageCacheExtWithIdentity(call({
    model: 'deepseek-chat', reasoningTokens: 7, cachedTokens: 0, cacheWriteTokens: 12,
    sessionId: 'sess_1', variantId: 'var_a', runId: 'run_9', durationMs: 345,
    adapter: 'openai_chat_completions', tokenSource: 'api',
  }));
  // success=false without a message → "Unknown error" (mod.rs:322).
  h.ctx.llmUsage.recordLlmUsageCacheExtWithIdentity(call({ model: 'gpt-4o', success: false, callerType: { other: 'tool' } }));
  for (let i = 2; i < USAGE_BATCH_SIZE_THRESHOLD; i += 1) h.ctx.llmUsage.recordLlmUsageCacheExtWithIdentity(call({ model: `filler-${i}` }));
  await flushMicrotasks();

  const rows = await h.invoke<UsageRecord[]>('llm_usage_recent', { limit: 100 });
  expect(rows).toHaveLength(USAGE_BATCH_SIZE_THRESHOLD);
  const full = rows.find((r) => r.modelId === 'deepseek-chat')!;
  expect(full).toMatchObject({
    callerType: 'chat_v2', callerId: 'sess_1', variantId: 'var_a', runId: 'run_9', providerId: 'deepseek',
    adapter: 'openai_chat_completions', tokenSource: 'api', promptTokens: 100, completionTokens: 20, totalTokens: 120,
    reasoningTokens: 7, cachedTokens: 0, cacheWriteTokens: 12, durationMs: 345, success: true,
  });
  const failed = rows.find((r) => r.modelId === 'gpt-4o')!;
  expect(failed).toMatchObject({ callerType: { other: 'tool' }, success: false, errorMessage: 'Unknown error', providerId: 'openai' });
  expect(failed.cacheWriteTokens).toBeUndefined();
  expect(failed.variantId).toBeUndefined();
  expect(failed.runId).toBeUndefined();
  expect(failed.callerId).toBeUndefined();
});

it('llmUsage.recordLlmUsage / Ext / CacheExt leave the omitted Options NULL (mod.rs:126/160/195)', async () => {
  const h = await start();
  h.ctx.llmUsage.recordLlmUsage({ callerType: 'translation', model: 'qwen-max', promptTokens: 1, completionTokens: 2,
    reasoningTokens: null, cachedTokens: 3, sessionId: 's', durationMs: 5, success: false, errorMessage: 'boom' });
  h.ctx.llmUsage.recordLlmUsageExt({ callerType: 'anki', model: 'gemini-pro', promptTokens: 1, completionTokens: 1,
    reasoningTokens: null, cachedTokens: null, sessionId: null, durationMs: null, success: true, errorMessage: null,
    adapter: 'google_generate_content', tokenSource: 'heuristic' });
  h.ctx.llmUsage.recordLlmUsageCacheExt({ callerType: 'memory', model: 'claude-3', promptTokens: 1, completionTokens: 1,
    reasoningTokens: null, cachedTokens: null, cacheWriteTokens: 4, sessionId: 'sx', durationMs: null, success: true,
    errorMessage: null, adapter: null, tokenSource: null });
  await h.dispose();
  host = undefined;

  const again = await start();
  const rows = await again.invoke<UsageRecord[]>('llm_usage_recent', { limit: 10 });
  const byModel = Object.fromEntries(rows.map((r) => [r.modelId, r]));
  expect(byModel['qwen-max']).toMatchObject({ callerType: 'translation', callerId: 's', cachedTokens: 3, success: false, errorMessage: 'boom' });
  expect(byModel['qwen-max']!.adapter).toBeUndefined();
  // token_source None is written as "api" (collector.rs insert_records unwrap_or("api")).
  expect(byModel['qwen-max']!.tokenSource).toBe('api');
  expect(byModel['gemini-pro']).toMatchObject({ adapter: 'google_generate_content', tokenSource: 'heuristic' });
  expect(byModel['gemini-pro']!.callerId).toBeUndefined();
  expect(byModel['gemini-pro']!.cacheWriteTokens).toBeUndefined();
  expect(byModel['claude-3']).toMatchObject({ callerId: 'sx', cacheWriteTokens: 4 });
  expect(byModel['claude-3']!.variantId).toBeUndefined();
});

it('records queued before the collector existed are flushed ahead of the next record (mod.rs:78)', async () => {
  const pending = newUsageRecord('embedding', 'early-model', 3, 4).build();
  enqueuePending(pending);
  const h = await start();
  h.ctx.llmUsage.recordUsageRecord(newUsageRecord('reranker', 'late-model', 1, 1).build());
  expect(pendingUsageQueue()).toHaveLength(0);
  expect(logs.some((l) => l.level === 'info' && l.message === '[LLM Usage] Flushed 1 pending usage records before writing current record')).toBe(true);
  await h.dispose();
  host = undefined;
  const again = await start();
  const rows = await again.invoke<UsageRecord[]>('llm_usage_recent', { limit: 10 });
  expect(rows.map((r) => r.modelId).sort()).toEqual(['early-model', 'late-model']);
  expect(rows.find((r) => r.modelId === 'early-model')!.id).toBe(pending.id);
});

it('llmUsage.cacheDebugEnabled follows CHAT_V2_CACHE_DEBUG === "1" (mod.rs:32)', async () => {
  const h = await start();
  const previous = process.env.CHAT_V2_CACHE_DEBUG;
  try {
    process.env.CHAT_V2_CACHE_DEBUG = '1';
    expect(h.ctx.llmUsage.cacheDebugEnabled()).toBe(true);
    process.env.CHAT_V2_CACHE_DEBUG = 'true';
    expect(h.ctx.llmUsage.cacheDebugEnabled()).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.CHAT_V2_CACHE_DEBUG; else process.env.CHAT_V2_CACHE_DEBUG = previous;
  }
});

it('fileManagerPaths.resolveImagePath resolves under <active slot>/images with traversal guards (file_manager.rs:237)', async () => {
  const h = await start();
  const active = h.ctx.storage.locations.activeDir;
  const images = path.join(active, 'images');
  fs.mkdirSync(path.join(images, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(images, 'sub', 'a.png'), 'x');
  const realImages = fs.realpathSync.native(images);
  const paths = h.ctx.fileManagerPaths;

  // Absolute paths are returned untouched.
  expect(paths.resolveImagePath('/abs/elsewhere.png')).toBe('/abs/elsewhere.png');
  // Existing file: canonical path inside images_dir; `images/` prefix and leading '/' are stripped.
  expect(paths.resolveImagePath('images/sub/a.png')).toBe(path.join(realImages, 'sub', 'a.png'));
  expect(paths.resolveImagePath('images//sub/a.png')).toBe(path.join(realImages, 'sub', 'a.png'));
  // Non-existent file: joined (un-normalised) candidate.
  expect(paths.resolveImagePath('new/b.png')).toBe(`${images}/new/b.png`);
  // Non-existent with '..' component → images_dir + warn.
  expect(paths.resolveImagePath('../../escape/x.png')).toBe(images);
  expect(logs.some((l) => l.level === 'warn' && l.message === "路径遍历拦截: 检测到 '..' 组件 in ../../escape/x.png")).toBe(true);
  // Existing target outside images_dir (via '..') → images_dir + warn.
  fs.writeFileSync(path.join(active, 'outside.png'), 'y');
  expect(paths.resolveImagePath('../outside.png')).toBe(images);
  expect(logs.some((l) => l.level === 'warn' && l.message.startsWith('路径遍历拦截: ') && l.message.endsWith(` 不在 ${realImages} 内`))).toBe(true);
  // Symlink escaping images_dir is caught by canonicalize + starts_with.
  fs.symlinkSync(path.join(active, 'outside.png'), path.join(images, 'link.png'));
  expect(paths.resolveImagePath('link.png')).toBe(images);
});

it('fileManagerPaths.getWritableAppDataDir falls back slot → data_dir/DeepStudent → temp/deep_student_data (file_manager.rs:169)', async () => {
  const osData = path.join(base, 'os-data');
  const temp = path.join(base, 'os-temp');
  const h = await start(osData, temp);
  const active = h.ctx.storage.locations.activeDir;
  const paths = h.ctx.fileManagerPaths;

  expect(paths.getWritableAppDataDir()).toBe(active);
  expect(fs.existsSync(path.join(active, '.write_test'))).toBe(false);

  if (process.getuid?.() === 0) return; // root ignores permission bits
  fs.chmodSync(active, 0o555);
  try {
    expect(paths.getWritableAppDataDir()).toBe(path.join(osData, 'DeepStudent'));
    expect(logs.some((l) => l.level === 'error' && l.message.startsWith(`⚠️ [文件系统] 目录不可写 ${active}: `))).toBe(true);

    fs.mkdirSync(osData, { recursive: true });
    fs.rmSync(path.join(osData, 'DeepStudent'), { recursive: true, force: true });
    fs.writeFileSync(path.join(osData, 'DeepStudent'), 'not a directory');
    expect(paths.getWritableAppDataDir()).toBe(path.join(temp, 'deep_student_data'));
    expect(logs.some((l) => l.level === 'error' && l.message.startsWith(`⚠️ [文件系统] 创建目录失败 ${path.join(osData, 'DeepStudent')}: `))).toBe(true);
    expect(fs.statSync(path.join(temp, 'deep_student_data')).isDirectory()).toBe(true);

    fs.rmSync(temp, { recursive: true, force: true });
    fs.writeFileSync(temp, 'blocks mkdir');
    expect(paths.getWritableAppDataDir()).toBe(path.join(temp, 'deep_student_data'));
    expect(logs.some((l) => l.level === 'warn' && l.message === `⚠️ [文件系统] 无法获取稳定的持久目录，临时使用 ${path.join(temp, 'deep_student_data')}`)).toBe(true);
  } finally {
    fs.chmodSync(active, 0o755);
  }
});
