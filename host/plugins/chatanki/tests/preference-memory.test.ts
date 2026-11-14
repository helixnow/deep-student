import { expect, it } from 'vitest';
import type {
  AnkiCard, ChatAnkiPreferenceStore, ChatAnkiSessionObservation,
} from '../api.ts';
import {
  CHATANKI_PREFERENCE_MEMORY_SETTING_KEY, persistPreferenceObservation,
  persistPreferenceObservationBestEffort,
} from '../src/preference-memory.ts';
import {
  cardEditObservations, deletionPreferenceObservation,
} from '../src/preference-observations.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';
import { PreferenceMemoryDouble } from './preference-memory-double.ts';

const memory = new PreferenceMemoryDouble();

function emptyObservation(): ChatAnkiSessionObservation {
  return {
    extraRequirements: null, edits: [], deletions: [], generatedCount: 0, templateUsed: null,
  };
}

function makeCard(id: string, front: string, back: string): AnkiCard {
  return {
    id, front, back, text: null, tags: ['tag'], images: [], task_id: 'task-pref',
    is_error_card: false, error_content: null, created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z', extra_fields: {}, template_id: 'design-swiss',
  };
}

function storedStore(repo: CardStoreDouble): ChatAnkiPreferenceStore {
  const raw = repo.getSetting(CHATANKI_PREFERENCE_MEMORY_SETTING_KEY);
  if (raw === null) throw new Error('preference store missing');
  return JSON.parse(raw) as ChatAnkiPreferenceStore;
}

it('test_preference_persist_creates_local_store_from_extra_requirements', () => {
  const repo = new CardStoreDouble();
  const outcome = persistPreferenceObservation(
    repo, memory,
    { ...emptyObservation(), extraRequirements: '请用中文回答，不要翻译术语' },
    1_000,
  );
  const raw = repo.getSetting(CHATANKI_PREFERENCE_MEMORY_SETTING_KEY);
  expect(raw).not.toBeNull();
  const store = storedStore(repo);
  expect(outcome.added.length).toBe(2);
  expect(store.entries.length).toBe(2);
});

it('test_preference_persist_reinforces_duplicate_observation', () => {
  const repo = new CardStoreDouble();
  const observation = { ...emptyObservation(), extraRequirements: '请用中文回答' };
  persistPreferenceObservation(repo, memory, observation, 1_000);

  const outcome = persistPreferenceObservation(repo, memory, observation, 2_000);
  const store = storedStore(repo);
  expect(outcome.reinforced.length).toBe(1);
  expect(store.entries.length).toBe(1);
  expect(store.entries[0]?.evidence_count).toBe(2);
  expect(store.entries[0]?.last_seen_ms).toBe(2_000);
});

it('test_preference_persist_keeps_conflicts_add_only', () => {
  const repo = new CardStoreDouble();
  for (const [nowMs, requirement] of [
    [1_000, '请用中文回答'],
    [2_000, 'Please write cards in English'],
  ] as const) {
    persistPreferenceObservation(
      repo, memory, { ...emptyObservation(), extraRequirements: requirement }, nowMs,
    );
  }
  const store = storedStore(repo);
  expect(store.entries.length).toBe(2);
  expect(store.entries.some((entry) => entry.subject === 'zh')).toBe(true);
  expect(store.entries.some((entry) => entry.subject === 'en')).toBe(true);
});

it('test_preference_persist_failure_is_best_effort_and_preserves_corrupt_value', () => {
  const repo = new CardStoreDouble();
  repo.saveSetting(CHATANKI_PREFERENCE_MEMORY_SETTING_KEY, '{not-json');
  const warnings: string[] = [];
  persistPreferenceObservationBestEffort(
    repo, memory, { ...emptyObservation(), extraRequirements: '请用中文回答' },
    'test_corrupt_store', 1_000, (message) => warnings.push(message),
  );
  expect(repo.getSetting(CHATANKI_PREFERENCE_MEMORY_SETTING_KEY)).toBe('{not-json');
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain('parse local preference store:');
});

it('test_preference_persist_executes_closure_without_extractable_candidate', () => {
  const repo = new CardStoreDouble();
  const outcome = persistPreferenceObservation(
    repo, memory,
    {
      ...emptyObservation(),
      edits: [{
        field: 'back', before: 'old answer', after: 'more precise answer',
      }],
    },
    1_000,
  );
  const raw = repo.getSetting(CHATANKI_PREFERENCE_MEMORY_SETTING_KEY);
  expect(raw).not.toBeNull();
  const store = storedStore(repo);
  expect(outcome).toEqual({ added: [], reinforced: [], evicted: [] });
  expect(store.entries).toEqual([]);
});

it('test_preference_persist_extracts_language_from_substantive_card_edit', () => {
  const repo = new CardStoreDouble();
  const before = makeCard(
    'card-pref-language', 'What is a cell?', 'A cell is the basic unit of life.',
  );
  const after = { ...before, front: '什么是细胞？', back: '细胞是生命活动的基本单位。' };
  const edits = cardEditObservations(before, after);

  const outcome = persistPreferenceObservation(
    repo, memory, { ...emptyObservation(), edits }, 1_000,
  );
  expect(outcome.added.length).toBe(1);
  expect(outcome.added[0]).toContain('中文');
});

it('test_preference_persist_extracts_density_from_batch_deletion', () => {
  const repo = new CardStoreDouble();
  const deleted = [
    makeCard('card-pref-delete-1', 'Q1', 'A1'),
    makeCard('card-pref-delete-2', 'Q2', 'A2'),
  ];
  const observation = deletionPreferenceObservation(deleted, 5);
  const outcome = persistPreferenceObservation(
    repo, memory,
    { ...emptyObservation(), ...observation },
    1_000,
  );
  expect(outcome.added.length).toBe(1);
  expect(outcome.added[0]).toContain('少而精');
});

it('test_preference_store_does_not_persist_unrecognized_extra_requirement_text', () => {
  const repo = new CardStoreDouble();
  const sensitiveSuffix = '临时上下文编号 secret-12345';
  persistPreferenceObservation(
    repo, memory,
    { ...emptyObservation(), extraRequirements: `请用中文回答；${sensitiveSuffix}` },
    1_000,
  );
  const raw = repo.getSetting(CHATANKI_PREFERENCE_MEMORY_SETTING_KEY);
  if (raw === null) throw new Error('preference store missing');
  expect(raw.includes(sensitiveSuffix)).toBe(false);
  expect(raw.includes('中文')).toBe(true);
});
