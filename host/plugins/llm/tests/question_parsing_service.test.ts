import { describe, expect, it, vi } from 'vitest';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';
import { OpenAIAdapter, llmReplayPlugin, type ReplayScript } from '../../llm-providers/api.ts';
import { makeConfig } from './support.ts';
import { IncrementalJsonArrayParser } from '../src/question_parsing_service.ts';

describe('LLMManager question parsing', () => {
  it('preserves incremental strings/escapes and never repairs incomplete objects', () => {
    const parser = new IncrementalJsonArrayParser();
    expect(parser.feed('prefix [{"text":"a {')).toBeNull();
    expect(parser.feed(' \\"')).toBeNull();
    expect(parser.feed('b","nested":{"x":1}}, {invalid}, {"unfinished":')).toEqual([{ text: 'a { "b', nested: { x: 1 } }]);
    expect(parser.finalize()).toBeNull();
    expect(new IncrementalJsonArrayParser().feed('{"outside":true}')).toEqual([{ outside: true }]);
  });

  it('delivers objects through the published streaming service and honors caller stop', async () => {
    const scripts = { questions: { description: 'a JSON array split inside the first object, [DONE]', rounds: [
      { kind: 'sse', end: 'done', frames: [{ content: '[{"n":' }, { content: '1},{"n":2}]' }] }] } } satisfies Record<string, ReplayScript>;
    const host = await createTestHost({ plugins: [plugin, [llmReplayPlugin, { scripts }]],
      provide: { settings: {}, secrets: {}, llmAdapters: { createAdapter: () => new OpenAIAdapter() } } });
    try {
      const replay = host.ctx.llmReplay;
      const config = makeConfig({ id: 'question-model', baseUrl: replay.baseUrl('questions') });
      vi.spyOn(host.ctx.llm, 'getModel2Config').mockResolvedValue(config);
      vi.spyOn(host.ctx.llm, 'getApiConfigs').mockResolvedValue([config]);
      vi.spyOn(host.ctx.llm, 'decryptApiKey').mockResolvedValue('key');
      const delivered: unknown[] = [];
      expect(await host.ctx.llmQuestionParsing.parseStreaming('questions', null, value => { delivered.push(value); return delivered.length < 2; }))
        .toEqual([{ n: 1 }]);
      expect(delivered).toEqual([{ n: 1 }, { n: 2 }]);
      expect(await host.ctx.llmQuestionParsing.parse('questions', 'question-model')).toBe('[{"n":1},{"n":2}]');
      await expect(host.ctx.llmQuestionParsing.parse('questions', 'missing')).rejects.toMatchObject({ message: '找不到指定的模型配置: missing' });
      expect(replay.requests.map(entry => [entry.scriptId, entry.stream, entry.outcome, entry.status])).toEqual([
        ['questions', true, 'served', 200], ['questions', true, 'served', 200]]);
    } finally { await host.dispose(); vi.restoreAllMocks(); }
  });
});
