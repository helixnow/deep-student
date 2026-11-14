import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  deleteFile, moveFile, recordExternalChanges, rollback, rollbackChangeSet,
  writeBytes, writeText, type ExternalFileSnapshot,
} from '../src/workspace-change-set.ts';

const dirs: string[] = [];
const tmp = () => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l05-change-'))); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const external = (value: string) => ({ bytes: Buffer.from(value), sha256: hash(value) });

it('create_modify_and_rollback_restore_exact_contents', () => {
  const root = tmp();
  const checkpoints = tmp();
  const created = writeText(root, checkpoints, 'workspace', 'src/new.txt', 'one');
  expect(created.op).toBe('created');
  const modified = writeText(root, checkpoints, 'workspace', 'src/new.txt', 'two', hash('one'));
  expect(modified.before_hash).toBe(hash('one'));
  rollback(root, checkpoints, modified);
  expect(fs.readFileSync(path.join(root, 'src/new.txt'), 'utf8')).toBe('one');
  rollback(root, checkpoints, created);
  expect(fs.existsSync(path.join(root, 'src/new.txt'))).toBe(false);
});

it('binary_write_is_hash_bound_and_rollback_restores_exact_bytes', () => {
  const root = tmp();
  const checkpoints = tmp();
  const original = Buffer.from([0, 1, 2, 0xff]);
  const replacement = Buffer.from([9, 8, 7, 0x80]);
  const created = writeBytes(root, checkpoints, 'workspace', 'reports/output.docx', original);
  const originalHash = created.after_hash!;
  const modified = writeBytes(root, checkpoints, 'workspace', 'reports/output.docx', replacement, originalHash);
  expect(modified.op).toBe('modified');
  expect(() => writeBytes(root, checkpoints, 'workspace', 'reports/output.docx', Buffer.from('stale'), originalHash)).toThrow();
  rollback(root, checkpoints, modified);
  expect(fs.readFileSync(path.join(root, 'reports/output.docx'))).toEqual(original);
});

it('move_delete_and_rollback_restore_tree', () => {
  const root = tmp();
  const checkpoints = tmp();
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs/a.txt'), 'alpha');
  const moved = moveFile(root, 'workspace', 'docs/a.txt', 'archive/a.txt', hash('alpha'));
  rollback(root, checkpoints, moved);
  expect(fs.readFileSync(path.join(root, 'docs/a.txt'), 'utf8')).toBe('alpha');
  const deleted = deleteFile(root, checkpoints, 'workspace', 'docs/a.txt', hash('alpha'));
  rollback(root, checkpoints, deleted);
  expect(fs.readFileSync(path.join(root, 'docs/a.txt'), 'utf8')).toBe('alpha');
});

it('external_shell_change_set_rolls_back_created_modified_and_deleted_files', () => {
  const root = tmp();
  const checkpoints = tmp();
  fs.writeFileSync(path.join(root, 'a.txt'), 'new');
  fs.writeFileSync(path.join(root, 'c.txt'), 'created');
  const before: ExternalFileSnapshot = new Map([['a.txt', external('old')], ['b.txt', external('deleted')]]);
  const after: ExternalFileSnapshot = new Map([['a.txt', external('new')], ['c.txt', external('created')]]);
  const changeSet = recordExternalChanges(checkpoints, 'workspace', before, after);
  expect(changeSet.changes.length).toBe(3);
  const result = rollbackChangeSet(root, checkpoints, changeSet);
  expect(result.complete).toBe(true);
  expect(result.reverted_count).toBe(3);
  expect(result.failed_count).toBe(0);
  expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('old');
  expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('deleted');
  expect(fs.existsSync(path.join(root, 'c.txt'))).toBe(false);
});

it('change_set_rollback_reports_partial_failure_and_continues', () => {
  const root = tmp();
  const checkpoints = tmp();
  fs.writeFileSync(path.join(root, 'a.txt'), 'agent-a');
  fs.writeFileSync(path.join(root, 'b.txt'), 'agent-b');
  fs.writeFileSync(path.join(root, 'c.txt'), 'created-c');
  const before: ExternalFileSnapshot = new Map([['a.txt', external('before-a')], ['b.txt', external('before-b')]]);
  const after: ExternalFileSnapshot = new Map([
    ['a.txt', external('agent-a')], ['b.txt', external('agent-b')], ['c.txt', external('created-c')],
  ]);
  const changeSet = recordExternalChanges(checkpoints, 'workspace', before, after);
  fs.writeFileSync(path.join(root, 'b.txt'), 'user-edit');
  const result = rollbackChangeSet(root, checkpoints, changeSet);
  expect(result.complete).toBe(false);
  expect(result.reverted_count).toBe(2);
  expect(result.failed_count).toBe(1);
  expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('before-a');
  expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('user-edit');
  expect(fs.existsSync(path.join(root, 'c.txt'))).toBe(false);
  expect(result.items.some(item => item.relative_path === 'b.txt' && !item.reverted && item.error != null)).toBe(true);
});

it('rejects_path_escape_protected_paths_and_stale_hashes', () => {
  const root = tmp();
  const checkpoints = tmp();
  expect(() => writeText(root, checkpoints, 'workspace', '../escape', 'x')).toThrow();
  expect(() => writeText(root, checkpoints, 'workspace', '.git/config', 'x')).toThrow();
  fs.writeFileSync(path.join(root, 'note.txt'), 'current');
  expect(() => writeText(root, checkpoints, 'workspace', 'note.txt', 'new', hash('old'))).toThrow();
  expect(fs.readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('current');
});

it('stale_rollback_never_overwrites_user_edits', () => {
  const root = tmp();
  const checkpoints = tmp();
  fs.writeFileSync(path.join(root, 'note.txt'), 'before');
  const receipt = writeText(root, checkpoints, 'workspace', 'note.txt', 'agent', hash('before'));
  fs.writeFileSync(path.join(root, 'note.txt'), 'user edit');
  expect(() => rollback(root, checkpoints, receipt)).toThrow();
  expect(fs.readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('user edit');
});

it('rejects_symlink_traversal', () => {
  if (process.platform === 'win32') return;
  const root = tmp();
  const outside = tmp();
  const checkpoints = tmp();
  fs.symlinkSync(outside, path.join(root, 'linked'));
  expect(() => writeText(root, checkpoints, 'workspace', 'linked/escape.txt', 'x')).toThrow();
  expect(fs.existsSync(path.join(outside, 'escape.txt'))).toBe(false);
});
