import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { SegmentRequest, StreamFailure, StreamStatus, TranslationHost, TranslationRequest, TranslationEvent, TranslationResponse } from '../api.ts';
import { runTranslation } from '../src/engine.ts';

type Step = { chunks?: string[]; status?: StreamStatus; failure?: StreamFailure; advance_ms?: number };
type Scenario = {
  id: string; request: TranslationRequest; text_parts?: Array<[string, number]>;
  steps?: Step[]; cancel_checks?: number[]; open_failure?: StreamFailure;
  expected: { text?: string; failure?: string; streams: number; terminal: string;
    chars?: number; words?: number; detected?: string; partial?: string; sleeps?: number[]; opens?: number; previous_tail?: string };
};
const cases = (JSON.parse(readFileSync(new URL('../../../../contracts/translation/cases.json', import.meta.url), 'utf8')) as { cases: Scenario[] }).cases;

describe('translation core shared corpus (static expected invariants)', () => {
  for (const scenario of cases) it(scenario.id, async () => {
    const request = { ...scenario.request, text: scenario.text_parts?.map(([text, n]) => text.repeat(n)).join('') ?? scenario.request.text };
    const steps = [...(scenario.steps ?? [])];
    const streams: SegmentRequest[] = [], sleeps: number[] = [];
    const events: TranslationEvent[] = [];
    const order: string[] = [];
    let now = 0, checks = 0, opens = 0, cleanups = 0;
    const port: TranslationHost = {
      async open() { opens++; if (scenario.open_failure) throw scenario.open_failure; },
      async stream(segment, onChunk) {
        streams.push(segment);
        const step = steps.shift();
        if (!step) throw new Error('Replay fixture exhausted');
        for (const chunk of step.chunks ?? []) onChunk(chunk);
        now += step.advance_ms ?? 0;
        if (step.failure) throw step.failure;
        if (!step.status) throw new Error('Replay step requires a status');
        return step.status;
      },
      async pendingCancel() { return (scenario.cancel_checks ?? []).includes(++checks); },
      async cleanup() { cleanups++; order.push('cleanup'); },
      async sleep(ms) { sleeps.push(ms); now += ms; },
      nowMs() { return now; }, timestamp() { return '2026-11-03T00:00:00+00:00'; },
      emit(event) { events.push(event); order.push(event.type); },
    };
    const host = await createTestHost({ provide: { translationHost: port } });
    let response: TranslationResponse | null = null;
    let failure: StreamFailure | undefined;
    try {
      try { response = await runTranslation(request, host.ctx.get('translationHost') as TranslationHost); }
      catch (error) { failure = error as StreamFailure; }
      expect(steps).toHaveLength(0);
      const terminal = events.filter(event => event.type !== 'data');
      expect(terminal).toHaveLength(1);
      expect(terminal[0]!.type).toBe(scenario.expected.terminal);
      expect(failure?.code).toBe(scenario.expected.failure);
      if (scenario.expected.text !== undefined) expect(response?.translated_text).toBe(scenario.expected.text);
      expect(streams).toHaveLength(scenario.expected.streams);
      expect(cleanups).toBe(1);
      expect(sleeps).toEqual(scenario.expected.sleeps ?? []);
      expect(opens).toBe(scenario.expected.opens ?? 1);
      const data = events.filter((event): event is Extract<TranslationEvent, { type: 'data' }> => event.type === 'data');
      if (scenario.expected.chars !== undefined) expect(data.at(-1)?.char_count).toBe(scenario.expected.chars);
      if (scenario.expected.words !== undefined) expect(data.at(-1)?.word_count).toBe(scenario.expected.words);
      if (scenario.expected.partial !== undefined) expect(data.map(event => event.chunk).join('')).toBe(scenario.expected.partial);
      if (scenario.expected.detected !== undefined) expect(data[0]?.detected_lang).toBe(scenario.expected.detected);
      if (scenario.expected.previous_tail) expect(streams[1]!.user_prompt).toContain(scenario.expected.previous_tail);
      if (failure) expect(order.slice(-2)).toEqual(['cleanup', 'error']);
      else expect(order.at(-1)).toBe('cleanup');
    } finally { await host.dispose(); }
  });
});
