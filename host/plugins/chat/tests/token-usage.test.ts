import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';
import { tokenSourceDisplay, type ChatSessionService, type MessageMeta } from '../api.ts';

describe('types.rs TokenUsage factories and persisted codec', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let s: ChatSessionService;
  beforeAll(async () => {
    f = databaseFixture(); host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    s = host.ctx.chatSession; s.createSession(newSession('sess_usage', 'chat'));
  });
  afterAll(async () => { await host.dispose(); f.dispose(); });
  function meta(value: MessageMeta): MessageMeta {
    const message = s.newAssistantMessage('sess_usage'); message._meta = value; s.createMessage(message);
    return s.getMessage(message.id)!._meta!;
  }
  function sources() {
    const api = s.tokenUsageFromApi(1, 1, null); const tiktoken = s.tokenUsageFromEstimate(1, 1, true);
    const heuristic = s.tokenUsageFromEstimate(1, 1, false); const mixed = s.tokenUsageFromApi(1, 1, null);
    s.accumulateTokenUsage(mixed, tiktoken);
    return [api.source, tiktoken.source, heuristic.source, mixed.source];
  }
  it('test_token_source_serialization', () => { expect(sources().map(source => JSON.stringify(source))).toEqual(['"api"', '"tiktoken"', '"heuristic"', '"mixed"']); });
  it('test_token_source_default', () => { expect(s.tokenUsageZero().source).toBe('tiktoken'); });
  it('test_token_source_display', () => { expect(sources().map(tokenSourceDisplay)).toEqual(['api', 'tiktoken', 'heuristic', 'mixed']); });
  it('test_token_usage_serialization_camel_case', () => {
    const usage = meta({ usage: s.tokenUsageFromApi(1234, 567, 200) }).usage!;
    const json = JSON.stringify(usage);
    for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'reasoningTokens']) expect(json).toContain(`"${key}":`);
    expect(json).toContain('"source":"api"'); expect(json).not.toContain('"cachedTokens":');
  });
  it('test_token_usage_from_api', () => {
    const usage = s.tokenUsageFromApi(1000, 500, 100);
    expect(usage).toMatchObject({ promptTokens: 1000, completionTokens: 500, totalTokens: 1500, source: 'api', reasoningTokens: 100 });
    expect(usage.cachedTokens).toBeUndefined();
  });
  it('test_token_usage_from_api_with_cache', () => {
    const usage = s.tokenUsageFromApiWithCache(1000, 500, null, 200);
    expect(usage).toMatchObject({ promptTokens: 1000, completionTokens: 500, totalTokens: 1500, source: 'api', cachedTokens: 200 });
    expect(usage.reasoningTokens).toBeUndefined();
  });
  it('test_token_usage_from_estimate_tiktoken', () => {
    expect(s.tokenUsageFromEstimate(800, 400, true)).toMatchObject({ promptTokens: 800, completionTokens: 400, totalTokens: 1200, source: 'tiktoken' });
  });
  it('test_token_usage_from_estimate_heuristic', () => {
    expect(s.tokenUsageFromEstimate(800, 400, false)).toMatchObject({ promptTokens: 800, completionTokens: 400, totalTokens: 1200, source: 'heuristic' });
  });
  it('test_token_usage_accumulate_same_source', () => {
    const usage = s.tokenUsageFromApi(1000, 200, null); s.accumulateTokenUsage(usage, s.tokenUsageFromApi(500, 300, 50));
    expect(usage).toMatchObject({ promptTokens: 1500, completionTokens: 500, totalTokens: 2000, source: 'api', reasoningTokens: 50 });
  });
  it('test_token_usage_accumulate_mixed_source', () => {
    const usage = s.tokenUsageFromApi(1000, 200, null); s.accumulateTokenUsage(usage, s.tokenUsageFromEstimate(500, 300, true));
    expect(usage).toMatchObject({ promptTokens: 1500, completionTokens: 500, totalTokens: 2000, source: 'mixed' });
  });
  it('test_token_usage_accumulate_reasoning_tokens', () => {
    const usage = s.tokenUsageFromApi(1000, 200, 100); s.accumulateTokenUsage(usage, s.tokenUsageFromApi(500, 300, 50));
    expect(usage.reasoningTokens).toBe(150);
  });
  it('test_token_usage_accumulate_cached_tokens', () => {
    const usage = s.tokenUsageFromApiWithCache(1000, 200, null, 100); s.accumulateTokenUsage(usage, s.tokenUsageFromApiWithCache(500, 300, null, 50));
    expect(usage.cachedTokens).toBe(150);
  });
  it('test_token_usage_has_tokens', () => {
    expect(s.tokenUsageHasTokens(s.tokenUsageZero())).toBe(false);
    expect(s.tokenUsageHasTokens(s.tokenUsageFromApi(100, 50, null))).toBe(true);
  });
  it('test_token_usage_zero', () => {
    const zero = s.tokenUsageZero();
    expect(zero).toMatchObject({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }); expect(s.tokenUsageHasTokens(zero)).toBe(false);
  });
  it('test_message_meta_with_usage', () => {
    const json = JSON.stringify(meta({ modelId: 'gpt-4', usage: s.tokenUsageFromApi(1000, 500, null) }));
    expect(json).toContain('"usage":'); expect(json).toContain('"promptTokens":');
  });
  it('test_message_meta_web_search_items_serde_key', () => {
    const loaded = meta({ openai_responses_web_search_items: [{ type: 'web_search_call', id: 'ws_1', status: 'completed' }] });
    expect(loaded.openai_responses_web_search_items).toHaveLength(1);
    expect(JSON.stringify(loaded)).toContain('"openai_responses_web_search_items"');
    expect(JSON.stringify(meta({}))).not.toContain('openai_responses_web_search_items');
  });
  it('test_message_meta_without_usage', () => { expect(JSON.stringify(meta({ modelId: 'gpt-4' }))).not.toContain('"usage":'); });
  it('test_token_usage_deserialization', () => {
    const message = s.newAssistantMessage('sess_usage'); s.createMessage(message);
    f.db.run('UPDATE chat_v2_messages SET meta_json = ? WHERE id = ?', [
      '{"usage":{"promptTokens":1234,"completionTokens":567,"totalTokens":1801,"source":"api","reasoningTokens":200}}', message.id]);
    const usage = s.getMessage(message.id)!._meta!.usage!;
    expect(usage).toMatchObject({ promptTokens: 1234, completionTokens: 567, totalTokens: 1801, source: 'api', reasoningTokens: 200 });
    expect(usage.cachedTokens).toBeUndefined();
  });
  it('u32 counters saturate while last-round values reflect only the latest nonzero round', () => {
    const max = 0xffffffff;
    const usage = s.tokenUsageFromApiWithCache(max, 10, max, max); usage.cacheWriteTokens = max;
    expect(usage.totalTokens).toBe(max); expect(usage.lastRoundPromptTokens).toBe(max);
    const next = s.tokenUsageFromApiWithCache(100, 20, 2, 3); next.cacheWriteTokens = 4;
    s.accumulateTokenUsage(usage, next);
    expect(usage).toMatchObject({ promptTokens: max, completionTokens: 30, totalTokens: max,
      reasoningTokens: max, cachedTokens: max, cacheWriteTokens: max, lastRoundPromptTokens: 120, lastRoundInputTokens: 100 });
    s.accumulateTokenUsage(usage, s.tokenUsageZero());
    expect(usage.lastRoundPromptTokens).toBe(120); expect(usage.lastRoundInputTokens).toBe(100);
  });
});
