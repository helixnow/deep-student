import { expect, it } from 'vitest';
import {
  checksumTables,
  isExcludedFromChecksum,
  syncClassificationRegistry,
  type TableClassification,
} from '../src/classification.ts';
import { fieldMergeColumnsForTable } from '../src/field-merge.ts';

function find(database: string, tableName: string): TableClassification {
  const entry = syncClassificationRegistry().find(
    candidate => candidate.database === database && candidate.table_name === tableName,
  );
  expect(entry, `${database}.${tableName} classification`).toBeDefined();
  return entry as TableClassification;
}

it('vfs_profile_ledger_is_rebuilt_locally_and_excluded_from_row_sync', () => {
  const profile = find('vfs', 'vfs_index_profiles');
  expect(profile.category).toBe('DerivedRebuild');
  expect(isExcludedFromChecksum('vfs', 'vfs_index_profiles')).toBe(true);
  expect(checksumTables('vfs').some(entry => entry.table_name === 'vfs_index_profiles')).toBe(false);
});

it('td02_completed_pomodoros_registered_as_derived_cache_of_pomodoro_records', () => {
  const todo = find('vfs', 'todo_items');
  expect(todo.merge_notes).toContain('completed_pomodoros');
  expect(todo.merge_notes).toContain('derived cache');
  expect(todo.merge_notes).toContain('pomodoro_records');

  const records = find('vfs', 'pomodoro_records');
  expect(records.category).toBe('RowSync');
  expect(records.merge_notes).toContain('fact table');

  expect(fieldMergeColumnsForTable('todo_items')).not.toContain('completed_pomodoros');
});

it('anki_cards_export_receipt_columns_are_registered_as_row_level_lww', () => {
  const entry = find('mistakes', 'anki_cards');
  expect(entry.category).toBe('RowSync');
  expect(entry.conflict_policy).toBe('FieldMerge');
  for (const column of ['anki_note_id', 'export_status', 'last_exported_at', 'content_hash']) {
    expect(entry.merge_notes, `anki_cards merge_notes must document receipt column ${column}`).toContain(column);
  }
  expect(entry.merge_notes).toContain('row-level LWW');
});
