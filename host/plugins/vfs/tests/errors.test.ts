import { describe, expect, it } from 'vitest';
import { VfsError } from '../api.ts';

describe('vfs/error.rs', () => {
  it('test_error_display', () => {
    expect(String(new VfsError('NotFound', { resource_type: 'Note', id: 'note_abc123' })))
      .toBe('Note not found: note_abc123');
    expect(String(new VfsError('InvalidArgument', { param: 'subject', reason: 'cannot be empty' })))
      .toBe("Invalid argument 'subject': cannot be empty");
  });
  it('test_error_to_string', () => {
    expect(String(new VfsError('Database', 'connection failed'))).toBe('Database error: connection failed');
  });
  it('stable_code_is_independent_of_message', () => {
    const a = new VfsError('Conflict', { key: 'todo.conflict', message: 'TODO_CONFLICT: item was modified' });
    const b = new VfsError('Conflict', { key: 'notes.conflict', message: '完全不同的新文案（fully reworded message）' });
    expect(String(a)).not.toBe(String(b));
    expect(a.stableCode()).toBe('VFS_CONFLICT');
    expect(a.stableCode()).toBe(b.stableCode());
    const old = new VfsError('Database', 'disk I/O error');
    const changed = new VfsError('Database', '数据库暂时不可用，请稍后重试');
    expect(old.stableCode()).toBe('VFS_STORAGE');
    expect(old.stableCode()).toBe(changed.stableCode());
  });
  it('stable_code_covers_key_variants', () => {
    expect(new VfsError('NotFound', { resource_type: 'Note', id: 'n1' }).stableCode()).toBe('VFS_NOT_FOUND');
    expect(new VfsError('ItemNotFound', { item_type: 'todo', item_id: 't1' }).stableCode()).toBe('VFS_NOT_FOUND');
    expect(new VfsError('InvalidArgument', { param: 'title', reason: 'empty' }).stableCode()).toBe('VFS_INVALID_ARGUMENT');
    expect(new VfsError('InvalidParent', { folder_id: 'child', reason: 'cycle' }).stableCode()).toBe('VFS_INVALID_ARGUMENT');
    expect(new VfsError('InvalidOperation', { operation: 'batch', reason: 'too many' }).stableCode()).toBe('VFS_INVALID_OPERATION');
    expect(new VfsError('Maintenance', { component: 'vfs' }).stableCode()).toBe('VFS_MAINTENANCE');
    expect(new VfsError('Pool', 'busy').stableCode()).toBe('VFS_STORAGE');
    expect(new VfsError('Other', 'misc').stableCode()).toBe('VFS_INTERNAL');
  });
  it('command_error_envelope_carries_code_message_and_data', () => {
    const err = new VfsError('Conflict', { key: 'todo.conflict', message: 'TODO_CONFLICT: stale' });
    const envelope = err.toCommandError();
    expect(envelope.code).toBe('VFS_CONFLICT');
    expect(envelope.message).toBe(String(err));
    const value = JSON.parse(JSON.stringify(envelope));
    expect(value.code).toBe('VFS_CONFLICT');
    expect(value.data.key).toBe('todo.conflict');
  });
});
