import { describe, expect, it } from 'vitest';
import { NotesImportExecutor } from '../src/notes-import-tool.ts';

describe('notes import executor tests', () => {
  it('test_can_handle', () => {
    const executor = new NotesImportExecutor();
    expect(executor.canHandle('builtin-notes_import')).toBe(true);
    expect(executor.canHandle('notes_import')).toBe(true);
    expect(executor.canHandle('builtin-notes_export')).toBe(false);
    expect(executor.canHandle('builtin-note_create')).toBe(false);
  });

  it('test_sensitivity_level', () => {
    const executor = new NotesImportExecutor();
    expect(executor.sensitivityLevel('builtin-notes_import')).toBe('medium');
  });
});
