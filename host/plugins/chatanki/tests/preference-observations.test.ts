import { describe, expect, it } from 'vitest';
import type { AnkiCard } from '../api.ts';
import {
  cardEditObservations, deletionPreferenceObservation,
} from '../src/preference-observations.ts';

function makeCard(id: string, front: string, back: string): AnkiCard {
  return {
    id, front, back, text: null, tags: [], images: [], task_id: 'task-pref',
    is_error_card: false, error_content: null, created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z', extra_fields: {}, template_id: null,
  };
}

function cloneCard(card: AnkiCard): AnkiCard {
  return { ...card, tags: [...card.tags], extra_fields: { ...card.extra_fields } };
}

describe('chatanki_executor.rs (preference observations)', () => {
  it('test_preference_edit_observations_capture_canonical_content_changes', () => {
    const before = makeCard('card-pref-edit', 'Question', 'Answer');
    const after = cloneCard(before);
    after.front = '问题是什么？';
    after.back = '这是中文答案。';

    const edits = cardEditObservations(before, after);
    expect(edits).toHaveLength(2);
    expect(edits[0]?.field).toBe('front');
    expect(edits[0]?.before).toBe('Question');
    expect(edits[0]?.after).toBe('问题是什么？');
    expect(edits[1]?.field).toBe('back');
  });

  it('test_preference_edit_observations_ignore_whitespace_and_metadata_only_changes', () => {
    const before = makeCard('card-pref-meta', 'Question', 'Answer');
    const after = cloneCard(before);
    after.front = '  Question  ';
    after.back = '\nAnswer\t';
    after.tags = ['changed-tag'];
    after.updated_at = '2026-08-24T10:00:00Z';

    expect(cardEditObservations(before, after)).toEqual([]);
  });

  it('test_preference_edit_observations_capture_cloze_text_changes', () => {
    const before = makeCard('card-pref-text', '', '');
    before.text = 'The {{c1::cell}} is basic.';
    const after = cloneCard(before);
    after.text = '{{c1::细胞}}是生命的基本单位。';

    const edits = cardEditObservations(before, after);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.field).toBe('text');
    expect(edits[0]?.after).toContain('细胞');
  });

  it('test_preference_edit_observations_capture_custom_template_fields', () => {
    const before = makeCard('card-pref-extra', 'Q', 'A');
    before.extra_fields.Explanation = 'English explanation';
    const after = cloneCard(before);
    after.extra_fields.Explanation = '这是用户改写后的中文解释';

    const edits = cardEditObservations(before, after);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.field).toBe('extra_fields.Explanation');
  });

  it('test_preference_edit_observations_do_not_duplicate_synced_aliases', () => {
    const before = makeCard('card-pref-alias', 'Question', 'Answer');
    before.extra_fields.question = 'Question';
    const after = cloneCard(before);
    after.front = '问题';
    after.extra_fields.question = '问题';

    const edits = cardEditObservations(before, after);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.field).toBe('front');
  });

  it('test_preference_deletion_observation_excludes_error_cards', () => {
    const normal = makeCard('card-pref-delete', 'Q', 'A');
    const diagnostic = makeCard('card-pref-diagnostic', 'error', 'error');
    diagnostic.is_error_card = true;

    const observation = deletionPreferenceObservation([normal, diagnostic], 8);
    expect(observation.generatedCount).toBe(8);
    expect(observation.deletions).toHaveLength(1);
    expect(observation.deletions[0]?.front).toBe('Q');
  });
});
