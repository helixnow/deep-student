import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PreferenceStore, SessionObservation } from '../api.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

const observation = (extra_requirements: string): SessionObservation => ({
  extra_requirements, edits: [], deletions: [], generated_count: 0, template_used: null,
});
const camelObservation = {
  extraRequirements: '请用中文回答', edits: [], deletions: [], generatedCount: 0, templateUsed: null,
};

describe('anki_preference_memory.rs signed i64 owner surface', () => {
  let env: AnkiTestEnv;
  beforeAll(async () => { env = await createAnkiTestEnv(); }, 120_000);
  afterAll(async () => { await env.dispose(); }, 120_000);

  it('consolidate_observation_runs_extract_and_add preserves i64 endpoints and reinforcement time', () => {
    const memory = env.host.ctx.anki.preferenceMemory;
    const store = memory.emptyStore();
    const first = -(1n << 63n);
    const last = (1n << 63n) - 1n;
    expect(memory.consolidateObservation(store, camelObservation, first).added)
      .toEqual(['卡片正文与答案使用中文书写']);
    expect(store.entries[0]).toMatchObject({ first_seen_ms: first, last_seen_ms: first });
    expect(memory.consolidateObservation(store, camelObservation, last).reinforced)
      .toEqual(['卡片正文与答案使用中文书写']);
    expect(store.entries[0]).toMatchObject({ first_seen_ms: first, last_seen_ms: last, evidence_count: 2 });
  });

  it('consolidate_adds_new_entries retains legacy number epoch calls alongside bigint', () => {
    const anki = env.host.ctx.anki;
    const store = anki.preferenceMemory.emptyStore();
    anki.consolidatePreferenceObservation(store, observation('请用中文回答'), 1_730_678_400_000);
    expect(store.entries[0]).toMatchObject({
      first_seen_ms: 1_730_678_400_000, last_seen_ms: 1_730_678_400_000,
    });
    anki.consolidatePreferenceObservation(store, observation('请用中文回答'), 9_007_199_254_740_993n);
    expect(store.entries[0]).toMatchObject({
      first_seen_ms: 1_730_678_400_000, last_seen_ms: 9_007_199_254_740_993n,
    });
    // D3: do not reject an integer number just because it exceeds MAX_SAFE_INTEGER.
    anki.consolidatePreferenceObservation(store, observation('请用中文回答'), 2 ** 53);
    expect(store.entries[0]?.last_seen_ms).toBe(2 ** 53);
  });

  it('retrieve_picks_one_per_kind_and_filters_unavailable_templates compares adjacent 2^53+ timestamps exactly', () => {
    const anki = env.host.ctx.anki;
    const store = anki.preferenceMemory.emptyStore();
    anki.consolidatePreferenceObservation(store, observation('请用中文回答'), 9_007_199_254_740_992n);
    anki.consolidatePreferenceObservation(store, observation('请用英文回答'), 9_007_199_254_740_993n);
    const prompt = anki.retrievePreferencePrompt(store, '', [], 200);
    expect(prompt).toContain('英文');
    expect(prompt).not.toContain('中文书写');
    store.entries.reverse();
    expect(anki.retrievePreferencePrompt(store, '', [], 200)).toBe(prompt);
    // Legacy numbers may coexist with exact bigint values in a loaded store.
    store.entries[1]!.last_seen_ms = 2 ** 53;
    expect(anki.retrievePreferencePrompt(store, '', [], 200)).toBe(prompt);
  });

  it('consolidate_evicts_lowest_score_beyond_capacity uses exact last_seen tie break even without candidates', () => {
    const anki = env.host.ctx.anki;
    const store = anki.preferenceMemory.emptyStore();
    for (let i = 0; i < 65; i++) {
      anki.consolidatePreferenceObservation(store, observation(`请用模板${i}模板`), 9_007_199_254_740_994n);
    }
    // Refill the evicted first row to test the empty-observation maintenance path.
    const newer = structuredClone(store.entries[0]!);
    const older = structuredClone(newer);
    newer.statement = '较新';
    newer.last_seen_ms = 9_007_199_254_740_993n;
    older.statement = '较旧';
    older.last_seen_ms = 9_007_199_254_740_992n;
    const overCapacity: PreferenceStore = { entries: [newer, older, ...store.entries.slice(1)] };
    expect(overCapacity.entries).toHaveLength(65);
    const outcome = anki.consolidatePreferenceObservation(overCapacity, observation(''), 0n);
    expect(outcome).toEqual({ added: [], reinforced: [], evicted: ['较旧'] });
    expect(overCapacity.entries).toHaveLength(64);
    expect(overCapacity.entries[0]).toEqual(newer);
  });
});
