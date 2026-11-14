import { expect, it } from 'vitest';
import type { DbJson as JsonValue } from '../api.ts';
import {
  fieldMergeColumnsForTable,
  fieldMergeTables,
  mergeField,
  type LearnerProfileMerger,
} from '../src/field-merge.ts';
import { syncClassificationRegistry } from '../src/classification.ts';

function tagsOf(value: JsonValue): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

it('test_tag_union', () => {
  const [result, merged] = mergeField('notes', 'tags', ['math', 'physics'], ['physics', 'chemistry']);
  const tags = tagsOf(result);
  expect(tags).toContain('math');
  expect(tags).toContain('physics');
  expect(tags).toContain('chemistry');
  expect(tags).toHaveLength(3);
  expect(merged).toBe(true);
});

it('test_max_value', () => {
  const [result, merged] = mergeField('review_plans', 'total_reviews', 10, 7);
  expect(result).toBe(10);
  expect(merged).toBe(true);
});

it('test_boolean_or', () => {
  const [result, merged] = mergeField('questions', 'is_favorite', false, true);
  expect(result).toBe(true);
  expect(merged).toBe(true);
});

it('regression_m14_boolean_or_accepts_sqlite_integer_bool', () => {
  const [result, merged] = mergeField('questions', 'is_favorite', 0, 1);
  expect(result).toBe(true);
  expect(merged).toBe(true);
});

it('regression_td02_completed_pomodoros_is_not_field_merged', () => {
  expect(fieldMergeColumnsForTable('todo_items')).not.toContain('completed_pomodoros');

  const [result, changed, conflict] = mergeField('todo_items', 'completed_pomodoros', 3, 5);
  expect(result).toBe(5);
  expect(changed).toBe(false);
  expect(conflict).toBe(true);

  const [estimated, estimatedChanged, estimatedConflict] = mergeField('todo_items', 'estimated_pomodoros', 3, 5);
  expect(estimated).toBe(5);
  expect(estimatedChanged).toBe(false);
  expect(estimatedConflict).toBe(true);
});

it('regression_r02_non_monotonic_fields_are_not_max_merged', () => {
  const pairs: Array<[string, string]> = [
    ['review_plans', 'interval_days'],
    ['review_plans', 'consecutive_failures'],
    ['todo_items', 'estimated_pomodoros'],
  ];
  for (const [table, column] of pairs) {
    expect(fieldMergeColumnsForTable(table)).not.toContain(column);
    const [result, changed, conflict] = mergeField(table, column, 10, 2);
    expect(result, `${table}.${column} 不得 MaxValue 回弹`).toBe(2);
    expect(changed).toBe(false);
    expect(conflict).toBe(true);
  }

  const [result, changed, conflict] = mergeField('review_plans', 'total_reviews', 10, 7);
  expect(result).toBe(10);
  expect(changed).toBe(true);
  expect(conflict).toBe(false);
});

it('regression_r04_question_counters_are_not_max_merged', () => {
  for (const column of ['attempt_count', 'correct_count']) {
    expect(fieldMergeColumnsForTable('questions')).not.toContain(column);
    const [result, changed, conflict] = mergeField('questions', column, 10, 0);
    expect(result, `questions.${column} 不得 MaxValue 回弹`).toBe(0);
    expect(changed).toBe(false);
    expect(conflict).toBe(true);
  }
});

it('regression_m21_ordered_json_arrays_fall_back_to_lww_conflict', () => {
  const remote: JsonValue = [{ resource_id: 'res_remote', kind: 'question' }];
  const [result, changed, conflict] = mergeField(
    'questions',
    'images_json',
    [{ resource_id: 'res_local', kind: 'question' }],
    remote,
  );
  expect(result).toEqual(remote);
  expect(changed).toBe(false);
  expect(conflict).toBe(true);
});

it('regression_m21_deep_json_falls_back_to_lww_conflict', () => {
  const remote: JsonValue = { remote: { y: 2 }, shared: { b: 2 } };
  const [result, changed, conflict] = mergeField(
    'resources',
    'metadata_json',
    { local: { x: 1 }, shared: { a: 1 } },
    remote,
  );
  expect(result).toEqual(remote);
  expect(changed).toBe(false);
  expect(conflict).toBe(true);
});

it('regression_m22_ref_count_is_not_auto_merged', () => {
  const [result, changed, conflict] = mergeField('resources', 'ref_count', 10, 7);
  expect(result).toBe(7);
  expect(changed).toBe(false);
  expect(conflict).toBe(true);
});

it('regression_m22_picklist_only_exposes_convergent_strategies', () => {
  expect(fieldMergeColumnsForTable('questions')).toEqual(['is_favorite', 'is_bookmarked', 'tags']);
  expect(fieldMergeColumnsForTable('resources')).not.toContain('ref_count');
  expect(fieldMergeColumnsForTable('questions')).not.toContain('images_json');
  expect(fieldMergeColumnsForTable('review_plans')).not.toContain('ease_factor');
});

it('regression_m22_registry_is_single_source_for_picklist', () => {
  for (const table of fieldMergeTables()) {
    expect(fieldMergeColumnsForTable(table).length, `${table} should expose at least one field merge column`).toBeGreaterThan(0);
  }
});

it('regression_m22_classification_field_merge_requires_registered_columns', () => {
  for (const entry of syncClassificationRegistry().filter(
    entry => entry.category === 'RowSync' && entry.conflict_policy === 'FieldMerge',
  )) {
    expect(
      fieldMergeColumnsForTable(entry.table_name).length,
      `${entry.database}.${entry.table_name} is classified FieldMerge but has no registered merge columns`,
    ).toBeGreaterThan(0);
  }
});

it('note_props_uses_whole_object_lww_not_unsafe_deep_merge', () => {
  expect(fieldMergeColumnsForTable('notes')).not.toContain('props');
  const local: JsonValue = { status: 'draft', localOnly: true };
  const remote: JsonValue = { status: 'done' };
  const [result, wasMerged, conflict] = mergeField('notes', 'props', local, remote);
  expect(result).toEqual(remote);
  expect(wasMerged).toBe(false);
  expect(conflict).toBe(true);
});

it('anki_export_receipt_columns_fall_back_to_row_level_lww', () => {
  const picklist = fieldMergeColumnsForTable('anki_cards');
  for (const column of ['anki_note_id', 'export_status', 'last_exported_at', 'content_hash']) {
    expect(picklist).not.toContain(column);
  }

  const remote = '2026-07-10T00:00:00Z';
  const [result, changed, conflict] = mergeField('anki_cards', 'last_exported_at', '2026-07-01T00:00:00Z', remote);
  expect(result).toBe(remote);
  expect(changed).toBe(false);
  expect(conflict).toBe(true);
});

it('test_unregistered_json_looking_field_remains_conflict', () => {
  const [result, changed, conflict] = mergeField('questions', 'unregistered_json', { local: true }, { remote: true });
  expect(result).toEqual({ remote: true });
  expect(changed).toBe(false);
  expect(conflict).toBe(true);
});

it('test_merge_field_ref_count', () => {
  const [result, changed, conflict] = mergeField('resources', 'ref_count', 10, 7);
  expect(result).toBe(7);
  expect(changed).toBe(false);
  expect(conflict).toBe(true);
});

it('test_merge_field_tags', () => {
  const [result, changed] = mergeField('notes', 'tags', ['a', 'b'], ['b', 'c']);
  expect(changed).toBe(true);
  expect(Array.isArray(result)).toBe(true);
  expect((result as JsonValue[]).length).toBe(3);
});

it('regression_j8b_notes_single_value_tags_keep_numeric_max', () => {
  const [result, changed, conflict] = mergeField(
    'notes',
    'tags',
    ['math', '_hits:3', '_last_hit:1730000000000', '_used:2', '_stale'],
    ['math', '_hits:10', '_last_hit:1731000000000', '_used:5'],
  );
  expect(changed).toBe(true);
  expect(conflict).toBe(false);
  const tags = tagsOf(result);
  expect(tags).toContain('_hits:10');
  expect(tags).not.toContain('_hits:3');
  expect(tags).toContain('_last_hit:1731000000000');
  expect(tags).not.toContain('_last_hit:1730000000000');
  expect(tags).toContain('_used:5');
  expect(tags).not.toContain('_used:2');
  expect(tags).toContain('math');
  expect(tags).toContain('_stale');
});

it('regression_j8b_notes_enum_value_tags_keep_single_deterministic', () => {
  const [result] = mergeField(
    'notes',
    'tags',
    ['_type:fact', '_purpose:memorized'],
    ['_type:study', '_purpose:memorized'],
  );
  const tags = tagsOf(result);
  expect(tags.filter(tag => tag.startsWith('_type:'))).toHaveLength(1);
  expect(tags).toContain('_type:fact');
  expect(tags).toContain('_purpose:memorized');
});

it('regression_j8b_ref_tags_keep_union_semantics', () => {
  const [result] = mergeField('notes', 'tags', ['_ref:res_a'], ['_ref:res_b']);
  const tags = tagsOf(result);
  expect(tags).toContain('_ref:res_a');
  expect(tags).toContain('_ref:res_b');
});

it('regression_j8b_other_tables_tags_are_pure_union', () => {
  const [result] = mergeField('mistakes', 'tags', ['_hits:3'], ['_hits:10']);
  const tags = tagsOf(result);
  expect(tags).toContain('_hits:3');
  expect(tags).toContain('_hits:10');
});

it('regression_j8c_resources_data_non_profile_falls_back_to_lww', () => {
  const remote = '远端笔记内容';
  const [result, changed, conflict] = mergeField('resources', 'data', '本地笔记内容', remote);
  expect(result).toBe(remote);
  expect(changed).toBe(false);
  expect(conflict).toBe(true);

  const history = '{"version":1}\n{"version":2}';
  const [historyResult, , historyConflict] = mergeField('resources', 'data', history, '{"foo":1}');
  expect(historyResult).toBe('{"foo":1}');
  expect(historyConflict).toBe(true);
});

it('test_merge_field_identity', () => {
  const [result, changed] = mergeField('notes', 'title', 'same', 'same');
  expect(result).toBe('same');
  expect(changed).toBe(false);
});

it('test_merge_field_conflict', () => {
  const [result, , conflict] = mergeField('notes', 'title', 'A', 'B');
  expect(result).toBe('B');
  expect(conflict).toBe(true);
});

/** Supplemental injected-merger coverage only. R4-SYNC-05 is pending until the Memory owner is public. */
it('supplemental profile merger adapter vectors (not Rust owner parity)', () => {
  const merger: LearnerProfileMerger = {
    mergeProfileJsonForSync(local, remote) {
      const localValue = JSON.parse(local) as Record<string, unknown>;
      const remoteValue = JSON.parse(remote) as Record<string, unknown>;
      const shape = ['version', 'updated_at', 'weak_points', 'preferences', 'goals'];
      if (!shape.every(key => Object.hasOwn(localValue, key) && Object.hasOwn(remoteValue, key))) return null;
      const newer = String(localValue.updated_at) >= String(remoteValue.updated_at) ? localValue : remoteValue;
      const older = newer === localValue ? remoteValue : localValue;
      const weakPoints = [...(newer.weak_points as Array<Record<string, unknown>>)];
      for (const point of older.weak_points as Array<Record<string, unknown>>) {
        const existing = weakPoints.find(
          item => item.subject === point.subject && item.knowledge_point === point.knowledge_point,
        );
        if (!existing) weakPoints.push(point);
        else if (Number(point.evidence_count) > Number(existing.evidence_count)) Object.assign(existing, point);
      }
      const goals = [...(newer.goals as Array<Record<string, unknown>>)];
      for (const goal of older.goals as Array<Record<string, unknown>>) {
        if (!goals.some(item => String(item.goal).trim() === String(goal.goal).trim())) goals.push(goal);
      }
      return JSON.stringify({
        ...newer,
        version: Math.max(Number(newer.version), Number(older.version)) + 1,
        weak_points: weakPoints,
        goals,
      });
    },
  };

  // Restore the original Rust vectors separately from the supplemental cases below.
  // These assertions still use the injected fixture and are not counted as ported.
  const originalLocal = JSON.stringify({ version: 3, updated_at: '2026-07-19T10:00:00+00:00',
    weak_points: [], preferences: { explanation_style: null, language: null, pace: null, others: [] },
    goals: [{ goal: '本地目标', deadline: null }], recent_status: null, last_promotion_fingerprint: null });
  const originalRemote = JSON.stringify({ version: 4, updated_at: '2026-07-19T11:00:00+00:00',
    weak_points: [], preferences: { explanation_style: null, language: null, pace: null, others: [] },
    goals: [{ goal: '远端目标', deadline: null }], recent_status: null, last_promotion_fingerprint: null });
  const [originalResult, originalChanged, originalConflict] = mergeField('resources', 'data', originalLocal, originalRemote, merger);
  expect(originalChanged).toBe(true);
  expect(originalConflict).toBe(false);
  const originalMerged = JSON.parse(originalResult as string) as { version: number; goals: Array<{ goal: string }> };
  expect(originalMerged.version).toBe(5);
  expect(originalMerged.goals.some(goal => goal.goal === '本地目标')).toBe(true);
  expect(originalMerged.goals.some(goal => goal.goal === '远端目标')).toBe(true);

  const local = JSON.stringify({
    version: 1,
    updated_at: '2026-01-01T00:00:00Z',
    weak_points: [{ subject: '数学', knowledge_point: '二次函数', error_pattern: '符号', evidence_count: 1 }],
    preferences: { language: '中文' },
    goals: [{ goal: '高考数学 130+' }],
    recent_status: 'local',
  });
  const remote = JSON.stringify({
    version: 2,
    updated_at: '2026-01-02T00:00:00Z',
    weak_points: [
      { subject: '数学', knowledge_point: '二次函数', error_pattern: '符号', evidence_count: 3 },
      { subject: '数学', knowledge_point: '数列', error_pattern: '递推', evidence_count: 1 },
    ],
    preferences: { language: '中文', pace: '快' },
    goals: [{ goal: '高考数学 130+' }, { goal: '竞赛' }],
    recent_status: 'remote',
  });

  const [result, changed, conflict] = mergeField('resources', 'data', local, remote, merger);
  expect(conflict).toBe(false);
  expect(changed).toBe(true);
  const merged = JSON.parse(result as string) as Record<string, unknown>;
  expect(merged.version).toBe(3);
  expect(merged.updated_at).toBe('2026-01-02T00:00:00Z');
  expect(merged.recent_status).toBe('remote');
  expect(merged.preferences).toEqual({ language: '中文', pace: '快' });
  expect(merged.weak_points).toEqual([
    { subject: '数学', knowledge_point: '二次函数', error_pattern: '符号', evidence_count: 3 },
    { subject: '数学', knowledge_point: '数列', error_pattern: '递推', evidence_count: 1 },
  ]);
  expect(merged.goals).toEqual([{ goal: '高考数学 130+' }, { goal: '竞赛' }]);

  // 非画像 JSON 仍回退到行级 LWW。
  const [, , nonProfileConflict] = mergeField('resources', 'data', local, '{"foo":1}', merger);
  expect(nonProfileConflict).toBe(true);
});
