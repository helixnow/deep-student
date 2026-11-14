import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PluginHost } from '../../../src/plugin-runtime/host';
import { translationContract } from '../../../src/plugin-runtime/contracts/validation';
import type { TranslationHost } from '../../../src/plugin-runtime/contracts/translationHost';
import type { TranslationRequest, StreamFailure, StreamStatus, SegmentRequest, TranslationEvent } from '../../../src/plugin-runtime/contracts/translation';
import translationPlugin from '../../../src/plugins/translation/index';
import { buildSegments, detectSourceLang, buildSystemPrompt, buildUserPrompt } from '../../../src/plugins/translation/policy';

type Step = { chunks?: string[]; status?: StreamStatus; failure?: StreamFailure; advance_ms?: number };
type Scenario = {
  id: string; request: TranslationRequest; text_parts?: Array<[string, number]>;
  steps?: Step[]; cancel_checks?: number[]; open_failure?: StreamFailure;
  expected: { text?: string; failure?: string; streams: number; terminal: string;
    chars?: number; words?: number; detected?: string; partial?: string; sleeps?: number[]; opens?: number; previous_tail?: string };
};
const cases = (JSON.parse(readFileSync(new URL('../../../contracts/translation/cases.json', import.meta.url), 'utf8')).cases as Scenario[])
  .map((item) => ({ ...item, request: { ...item.request, text: item.text_parts?.map(([text, n]) => text.repeat(n)).join('') ?? item.request.text } }));

// Recorded once from the original reference implementation; the plugin must keep reproducing it.
const REFERENCE = JSON.parse(readFileSync(new URL('../../../contracts/translation/reference.json', import.meta.url), 'utf8')) as {
  scenarios: Record<string, unknown>; policy: unknown[];
};

class ReplayHost implements TranslationHost {
  trace: Array<Record<string, any>> = [];
  steps: Step[];
  now = 0;
  checks = 0;
  constructor(private scenario: Scenario, private emitEvent: (event: unknown) => void) { this.steps = [...(scenario.steps ?? [])]; }
  async open() { this.trace.push({ effect: 'open' }); if (this.scenario.open_failure) throw this.scenario.open_failure; }
  async stream(request: SegmentRequest, onChunk: (chunk: string) => void): Promise<StreamStatus> {
    this.trace.push({ effect: 'stream', request });
    const step = this.steps.shift();
    if (!step) throw new Error('Replay fixture exhausted');
    for (const chunk of step.chunks ?? []) onChunk(chunk);
    this.now += step.advance_ms ?? 0;
    if (step.failure) throw step.failure;
    if (!step.status) throw new Error('Replay step requires a status');
    return step.status;
  }
  async pendingCancel() { return (this.scenario.cancel_checks ?? []).includes(++this.checks); }
  async cleanup() { this.trace.push({ effect: 'cleanup' }); }
  async sleep(ms: number) { this.trace.push({ effect: 'sleep', ms }); this.now += ms; }
  nowMs() { return this.now; }
  timestamp() { return '2026-11-03T00:00:00+00:00'; }
  emit(event: TranslationEvent) { this.emitEvent(event); }
}

describe('recorded reference ↔ TS plugin behavior', () => {
  it('matches every observable effect and preserves independent expected invariants', async () => {
    expect(Object.keys(REFERENCE.scenarios).sort()).toEqual(cases.map((item) => item.id).sort());
    for (const scenario of cases) {
      const host = new PluginHost({ 'translation@1': { translate: translationContract } });
      let replay!: ReplayHost;
      await host.install({
        manifest: { id: 'test.platform', apiVersion: 1, provides: ['platform.translation@1'], requires: [] },
        activate: (ctx) => ctx.provideValue('platform.translation@1', {
          create: (_request: TranslationRequest, invocation: { emit: (event: unknown) => void }) => {
            replay = new ReplayHost(scenario, invocation.emit);
            return replay;
          },
        }),
      });
      await host.install(translationPlugin);
      let response: unknown = null;
      let failure: StreamFailure | null = null;
      try {
        response = await host.call('translation@1', 'translate', scenario.request, {
          onEvent: (event) => replay.trace.push({ effect: 'event', event }),
        });
      } catch (error) {
        const f = error as StreamFailure;
        failure = { message: f.message, code: f.code, retriable: f.retriable };
      }
      const actual = { result: response, failure, trace: replay.trace, remaining_steps: replay.steps.length };
      // Structural comparison: no hashing/serialization equality of map-bearing objects.
      expect(actual, scenario.id).toEqual(REFERENCE.scenarios[scenario.id]);
      expect(replay.steps, scenario.id).toHaveLength(0);
      const events = replay.trace.filter((x) => x.effect === 'event').map((x) => x.event);
      const terminal = events.filter((x) => x.type !== 'data');
      expect(terminal, scenario.id).toHaveLength(1);
      expect(terminal[0].type, scenario.id).toBe(scenario.expected.terminal);
      expect(failure?.code, scenario.id).toBe(scenario.expected.failure);
      if (scenario.expected.text !== undefined) expect((response as any)?.translated_text, scenario.id).toBe(scenario.expected.text);
      const streams = replay.trace.filter((x) => x.effect === 'stream');
      expect(streams, scenario.id).toHaveLength(scenario.expected.streams);
      expect(replay.trace.filter((x) => x.effect === 'cleanup'), scenario.id).toHaveLength(1);
      expect(replay.trace.filter((x) => x.effect === 'sleep').map((x) => x.ms), scenario.id).toEqual(scenario.expected.sleeps ?? []);
      expect(replay.trace.filter((x) => x.effect === 'open'), scenario.id).toHaveLength(scenario.expected.opens ?? 1);
      const data = events.filter((x) => x.type === 'data');
      if (scenario.expected.chars !== undefined) expect(data.at(-1)?.char_count, scenario.id).toBe(scenario.expected.chars);
      if (scenario.expected.words !== undefined) expect(data.at(-1)?.word_count, scenario.id).toBe(scenario.expected.words);
      if (scenario.expected.partial !== undefined) expect(data.map((x) => x.chunk).join(''), scenario.id).toBe(scenario.expected.partial);
      if (scenario.expected.detected !== undefined) expect(data[0]?.detected_lang, scenario.id).toBe(scenario.expected.detected);
      if (scenario.expected.previous_tail) expect(streams[1].request.user_prompt).toContain(scenario.expected.previous_tail);
      await host.dispose();
    }
  });

  it('preserves legacy language/segmentation cases and prompt bytes over a shared corpus', () => {
    const request: TranslationRequest = { text: '', src_lang: 'auto', tgt_lang: 'en', session_id: 'policy' };
    const texts = [
      '東京の天気はとても良いです', '今天天气很好，我们去公园散步吧。', '오늘 날씨가 정말 좋아요',
      'The quick brown fox jumps over the lazy dog', "Être à côté de la plaque, c'est embêtant", '   ',
      '第一段内容。\n\n第二段内容，稍微长一点。\n\n\n第三段。', '这是一句话。'.repeat(50),
      'This is a sentence. '.repeat(30).trimEnd(), '中'.repeat(500),
      '\r\n\r\nA\u0085B\u00a0😀\ufeff\n \nC\n\n',
    ];
    const inputs = texts.flatMap((text) => [1, 8, 60, 2000].map((target) => ({ operation: 'policy', request: { ...request, text }, target })));
    for (const domain of ['general', 'academic', 'technical', 'literary', 'legal', 'medical', 'casual', 'conversation', 'unknown']) {
      for (const formality of ['formal', 'casual', 'auto', null]) {
        inputs.push({ operation: 'policy', target: 2000, request: { ...request, text: 'Formula $x^2$ 😀', domain, formality,
          glossary: [[' quote"\n ', ' target\\ '], [' ', 'discard']] } } as any);
      }
    }
    inputs.push({ operation: 'policy', target: 2000, request: { ...request, text: 'hello', src_lang: 'en', tgt_lang: 'pt-BR', prompt_override: 'Custom\nPrompt' } } as any);
    const outputs = REFERENCE.policy;
    expect(outputs).toHaveLength(inputs.length);
    inputs.forEach((input, i) => {
      expect({ segments: buildSegments(input.request.text, input.target), detected: detectSourceLang(input.request.text) ?? null,
        system: buildSystemPrompt(input.request), user: buildUserPrompt(input.request, input.request.text) }).toEqual(outputs[i]);
    });
    expect(texts.slice(0, 6).map(detectSourceLang)).toEqual(['ja', 'zh-CN', 'ko', 'en', undefined, undefined]);
    for (const text of texts.slice(6, 10)) {
      expect(buildSegments(text, 60).map((s) => s.content + s.separator).join('')).toBe(text);
    }
  });
});
