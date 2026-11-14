// v2 §1.3/§1.7 regressions: serde-strict PreferenceStore decoding through the
// production persistence path, and Rust's microsecond stateRevision clock.
import { expect, it } from 'vitest';
import type { ChatAnkiSessionObservation } from '../api.ts';
import {
  CHATANKI_PREFERENCE_MEMORY_SETTING_KEY, persistPreferenceObservationBestEffort,
} from '../src/preference-memory.ts';
import { parseChatAnkiRunArgs } from '../src/run-args.ts';
import { nextChatankiStateRevision } from '../src/workflow-status.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';
import { PreferenceMemoryDouble } from './preference-memory-double.ts';

const observation: ChatAnkiSessionObservation = {
  extraRequirements: '请用中文回答', edits: [], deletions: [], generatedCount: 0, templateUsed: null,
};

// Each value is valid JSON with a top-level `entries` array, which the old
// `Array.isArray(entries)` check accepted; Rust serde rejects every one
// (anki_preference_memory.rs:96–142) and the corrupt value must be preserved.
const SERDE_REJECTED: Array<[string, string]> = [
  ['{}', 'missing field `entries`'],
  ['{"entries":[{"kind":"bogus","statement":"s","subject":null,"confidence":0.5,"evidence_count":1,"last_evidence":"e","first_seen_ms":1,"last_seen_ms":1}]}', 'unknown variant `bogus`'],
  ['{"entries":[{"kind":"language","statement":"s","subject":1,"confidence":0.5,"evidence_count":1,"last_evidence":"e","first_seen_ms":1,"last_seen_ms":1}]}', 'invalid type: integer `1`, expected a string'],
  ['{"entries":[{"kind":"language","statement":"s","subject":null,"confidence":0.5,"evidence_count":-1,"last_evidence":"e","first_seen_ms":1,"last_seen_ms":1}]}', 'invalid value: integer `-1`, expected u32'],
  ['{"entries":[1]}', 'expected struct PreferenceEntry'],
];

for (const [raw, detail] of SERDE_REJECTED) {
  it(`test_preference_persist_failure_is_best_effort_and_preserves_corrupt_value (serde: ${detail})`, () => {
    const repo = new CardStoreDouble();
    repo.saveSetting(CHATANKI_PREFERENCE_MEMORY_SETTING_KEY, raw);
    const warnings: string[] = [];
    persistPreferenceObservationBestEffort(
      repo, new PreferenceMemoryDouble(), observation, 'v2_decoder', 1_000,
      (message) => warnings.push(message),
    );
    expect(repo.getSetting(CHATANKI_PREFERENCE_MEMORY_SETTING_KEY)).toBe(raw);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      '[ChatAnkiToolExecutor] preference observation ignored after persistence failure: source=v2_decoder, error=parse local preference store:',
    );
    expect(warnings[0]).toContain(detail);
  });
}

it('valid PreferenceStore with unknown extra keys still decodes (no deny_unknown_fields)', () => {
  const repo = new CardStoreDouble();
  repo.saveSetting(CHATANKI_PREFERENCE_MEMORY_SETTING_KEY, JSON.stringify({
    extra: true,
    entries: [{
      kind: 'language', statement: '卡片正文与答案使用中文书写', subject: 'zh', confidence: 0.9,
      evidence_count: 1, last_evidence: 'e', first_seen_ms: 1, last_seen_ms: 1, extra: 'ignored',
    }],
  }));
  const warnings: string[] = [];
  persistPreferenceObservationBestEffort(
    repo, new PreferenceMemoryDouble(), observation, 'v2_decoder', 2_000,
    (message) => warnings.push(message),
  );
  expect(warnings).toEqual([]);
  const stored = JSON.parse(repo.getSetting(CHATANKI_PREFERENCE_MEMORY_SETTING_KEY)!) as {
    entries: Array<{ evidence_count: number; last_seen_ms: number }>;
  };
  expect(stored.entries).toHaveLength(1);
  expect(stored.entries[0]!.evidence_count).toBe(2);
});

it('next_chatanki_state_revision uses microseconds and stays strictly increasing (rs:95-104)', () => {
  const wallMicros = Date.now() * 1000;
  const first = nextChatankiStateRevision();
  // Microsecond clock: within one second of wall time, not a ms×1000 multiple by construction.
  expect(Math.abs(first - wallMicros)).toBeLessThan(1_000_000);
  // Clock going backwards still yields prev + 1.
  expect(nextChatankiStateRevision(first - 5_000)).toBe(first + 1);
  expect(nextChatankiStateRevision(first + 10)).toBe(first + 10);
});

it('flexible maxCards string uses Rust str::trim (chatanki_executor.rs:420-425)', () => {
  // Rust trim strips U+0085 but keeps U+FEFF, so "\u{FEFF}12".parse::<i32>() fails.
  expect(parseChatAnkiRunArgs({ goal: 'g', templateMode: 'all', maxCards: '\u008512\u0085' }).maxCards).toBe(12);
  expect(() => parseChatAnkiRunArgs({ goal: 'g', templateMode: 'all', maxCards: '\uFEFF12' }))
    .toThrow('maxCards string must be a valid integer');
});
