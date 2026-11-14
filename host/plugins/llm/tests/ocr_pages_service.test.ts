/** llmOcrPages production entry: exam_engine.rs:685–843 / :876–1067 and mod.rs:7394. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';
import { makeConfig } from './support.ts';
import { makePng } from './png_fixture.ts';
import type { ApiConfig, LlmUsageRecorder } from '../api.ts';
import { OCR_CIRCUIT_BREAKER } from '../src/ocr_circuit_breaker.ts';
import { resolveImagePath } from '../src/ocr_pages_service.ts';

type UsageRecord = Parameters<LlmUsageRecorder['recordLlmUsageCacheExtWithIdentity']>[0];
const originalFetch = globalThis.fetch;
const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
beforeEach(() => OCR_CIRCUIT_BREAKER.recordSuccess());
afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.dispose();
  OCR_CIRCUIT_BREAKER.recordSuccess();
});

function engineModel(id: string, engineType: string, priority: number) {
  return { configId: id, model: id, engineType, name: id, priority };
}

async function ocrHost(configs: ApiConfig[], models: object[], extra: Record<string, string> = {}) {
  const values = new Map<string, string>([['ocr.available_models', JSON.stringify(models)], ...Object.entries(extra)]);
  const usage: UsageRecord[] = [];
  const host = await createTestHost({ plugins: [plugin], provide: {
    settings: { get: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => values.set(key, value) },
    secrets: { isEncryptedFormat: () => false },
    llmUsage: { cacheDebugEnabled: () => false, recordLlmUsageCacheExtWithIdentity: (record: UsageRecord) => { usage.push(record); } },
  } });
  hosts.push(host);
  vi.spyOn(host.ctx.llm, 'getApiConfigs').mockResolvedValue(configs);
  return { host, usage };
}

function vision(id: string, overrides: Partial<ApiConfig> = {}): ApiConfig {
  return makeConfig({ id, model: id, name: id, isMultimodal: true, enabled: true, apiKey: `key-${id}`,
    baseUrl: `https://${id}.example/v1`, apiProtocol: 'openai_chat_completions', ...overrides });
}

function sse(content: string): Response {
  const chunk = { choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

interface Seen { url: string; body: Record<string, unknown> }
function captureFetch(respond: (url: string, index: number) => Response): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return respond(url, seen.length);
  }) as typeof fetch;
  return seen;
}

function pageImage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'l02-ocr-page-'));
  const path = join(dir, 'page.png');
  writeFileSync(path, makePng(40, 20));
  return path;
}

const TEXT = '第一题：求函数 f(x)=x^2 在 x=1 处的导数。';

describe('llmOcrPages.callOcrPageWithFallback (call_ocr_page_with_fallback)', () => {
  it('reports the configuration error before touching the breaker when no engine is enabled', async () => {
    const { host } = await ocrHost([], []);
    await expect(host.ctx.llmOcrPages.callOcrPageWithFallback(pageImage(), 0, 'FreeText'))
      .rejects.toMatchObject({ error_type: 'Configuration', message: '没有已启用的 OCR 引擎，请在设置中配置' });
  });

  it('sends the grounding page request through the real adapter and records exam_sheet usage', async () => {
    const { host, usage } = await ocrHost([vision('vlm-a')], [engineModel('vlm-a', 'generic_vlm', 0)]);
    const seen = captureFetch(() => sse(TEXT));
    const cards = await host.ctx.llmOcrPages.callOcrPageWithFallback(pageImage(), 3, 'FreeText');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://vlm-a.example/v1/chat/completions');
    const content = (seen[0]!.body.messages as { content: { type: string; image_url?: { url: string } }[] }[])[0]!.content;
    expect(content[0]!.type).toBe('image_url');
    expect(content[0]!.image_url!.url.startsWith('data:image/png;base64,')).toBe(true);
    expect(content[1]!.type).toBe('text');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ ocr_text: TEXT, card_id: 'fp_p3_r0' });
    expect(usage).toEqual([expect.objectContaining({ callerType: 'exam_sheet', model: 'vlm-a', promptTokens: 11,
      completionTokens: 7, tokenSource: 'api', success: true, sessionId: null })]);
    expect(OCR_CIRCUIT_BREAKER.currentState()).toBe('Closed');
  });

  it('4xx stops the whole fallback chain and keeps HTTP details (status / retry_after_*)', async () => {
    const { host } = await ocrHost([vision('vlm-a'), vision('vlm-b')],
      [engineModel('vlm-a', 'generic_vlm', 0), engineModel('vlm-b', 'generic_vlm', 1)]);
    const seen = captureFetch(() => new Response('{"error":"slow down"}', { status: 429, headers: { 'retry-after': '1' } }));
    const error = await host.ctx.llmOcrPages.callOcrPageWithFallback(pageImage(), 0, 'Structured').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ error_type: 'LLM', details: { status: 429, retry_after_seconds: 1, retry_after_ms: 1000 } });
    expect(new Set(seen.map(item => item.url))).toEqual(new Set(['https://vlm-a.example/v1/chat/completions']));
  }, 30_000);

  it('two consecutive 5xx on one engine switch to the next engine', async () => {
    const { host } = await ocrHost([vision('vlm-a'), vision('vlm-b')],
      [engineModel('vlm-a', 'generic_vlm', 0), engineModel('vlm-b', 'generic_vlm', 1)]);
    const seen = captureFetch((url) => url.includes('vlm-a') ? new Response('bad gateway', { status: 502 }) : sse(TEXT));
    const cards = await host.ctx.llmOcrPages.callOcrPageWithFallback(pageImage(), 1, 'Structured');
    expect(cards[0]).toMatchObject({ ocr_text: TEXT });
    expect(seen.some(item => item.url.includes('vlm-b'))).toBe(true);
  }, 30_000);

  it('fails fast while the global OCR breaker is open', async () => {
    const { host } = await ocrHost([vision('vlm-a')], [engineModel('vlm-a', 'generic_vlm', 0)]);
    for (let i = 0; i < 3; i++) OCR_CIRCUIT_BREAKER.recordFailure();
    const seen = captureFetch(() => sse(TEXT));
    await expect(host.ctx.llmOcrPages.callOcrPageWithFallback(pageImage(), 0, 'FreeText'))
      .rejects.toMatchObject({ error_type: 'LLM', message: 'OCR 服务暂时不可用（连续失败触发熔断），请稍后重试' });
    expect(seen).toHaveLength(0);
  });
});

describe('llmOcrPages.testOcrWithEngine (mod.rs:7394)', () => {
  it('uses the exact config id and returns joined region text', async () => {
    const { host } = await ocrHost([vision('vlm-a')], []);
    const seen = captureFetch(() => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: TEXT } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await host.ctx.llmOcrPages.testOcrWithEngine(pageImage(), 'generic_vlm', 'vlm-a');
    expect(seen[0]!.body).toMatchObject({ model: 'vlm-a', stream: false });
    expect(result.text).toContain('求函数');
    expect(result.regions.length).toBeGreaterThan(0);
    await expect(host.ctx.llmOcrPages.testOcrWithEngine(pageImage(), 'generic_vlm', 'missing'))
      .rejects.toMatchObject({ error_type: 'Configuration', message: '找不到配置 ID: missing' });
  });

  it('maps non-2xx to the engine-named LLM error', async () => {
    const { host } = await ocrHost([vision('vlm-a')], []);
    captureFetch(() => new Response('denied', { status: 403 }));
    await expect(host.ctx.llmOcrPages.testOcrWithEngine(pageImage(), 'generic_vlm', 'vlm-a'))
      .rejects.toMatchObject({ error_type: 'LLM', message: expect.stringMatching(/API 返回错误 \(403 Forbidden\): denied$/) });
  });
});

describe('llmOcrPages free-text hedging (call_ocr_free_text_with_fallback_filtered)', () => {
  it('returns the hedged winner text through the file-based entry', async () => {
    const { host } = await ocrHost([vision('vlm-a')], [engineModel('vlm-a', 'generic_vlm', 0)]);
    captureFetch(() => sse(TEXT));
    expect(await host.ctx.llmOcrPages.callOcrFreeTextWithFallback(pageImage())).toBe(TEXT);
  });

  it('dedicated-only filter excludes generic VLM engines and releases the probe', async () => {
    const { host } = await ocrHost([vision('vlm-a')], [engineModel('vlm-a', 'generic_vlm', 0)]);
    const seen = captureFetch(() => sse(TEXT));
    await expect(host.ctx.llmOcrPages.callDedicatedOcrFreeTextWithFallback(pageImage(), new AbortController().signal))
      .rejects.toMatchObject({ error_type: 'Configuration', message: '没有已启用的 OCR 引擎，请在设置中配置' });
    expect(seen).toHaveLength(0);
    expect(OCR_CIRCUIT_BREAKER.allowRequest()).toBe(true);
  });

  it('image preparation failures are file-system errors and do not count as engine failures', async () => {
    const { host } = await ocrHost([vision('vlm-a')], [engineModel('vlm-a', 'generic_vlm', 0)]);
    await expect(host.ctx.llmOcrPages.callOcrFreeTextWithFallback('/nonexistent/l02/page.png'))
      .rejects.toMatchObject({ error_type: 'FileSystem', message: expect.stringContaining('读取试卷图片失败') });
    expect(OCR_CIRCUIT_BREAKER.currentState()).toBe('Closed');
  });
});

describe('FileManager::resolve_image_path port', () => {
  it('keeps absolute paths, strips images/ and blocks traversal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'l02-images-'));
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', 'x.png'), 'x');
    expect(resolveImagePath(dir, '/abs/file.png')).toBe('/abs/file.png');
    expect(resolveImagePath(dir, 'images/a/x.png').endsWith(join('a', 'x.png'))).toBe(true);
    expect(resolveImagePath(dir, '../escape.png')).toBe(dir);
  });
});
