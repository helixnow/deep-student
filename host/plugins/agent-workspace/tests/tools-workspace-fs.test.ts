/**
 * `workspace_fs` 工具执行器测试：逐条对应
 * `chat_v2/tools/workspace_fs_executor.rs` 的 `mod tests`。
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import nativePlugin from '../../../platform/native/index.ts';
import type { NativeWindowsFiles } from '../../../platform/native/windows/api.ts';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_TOOL_RESULT_CHAR_BUDGET, MAX_FILE_SOURCE_BYTES, WorkspaceFsExecutor,
  ensurePublicRuntimePath,
} from '../src/tools/workspace-fs.ts';
import { safeSessionDir } from '../src/runtime-paths.ts';
import { createWriteBackup } from '../src/write-backups.ts';
import { decodeUtf8Window } from '../src/utf8-paged-read.ts';

const dirs: string[] = [];
let nativeHost: Awaited<ReturnType<typeof createTestHost>> | undefined;
let windowsFiles: NativeWindowsFiles | undefined;
beforeAll(async () => {
  if (process.platform === 'win32') {
    nativeHost = await createTestHost({ plugins: [nativePlugin] });
    windowsFiles = nativeHost.ctx.nativeWindowsFiles;
  }
});
afterAll(async () => { await nativeHost?.dispose(); });
const tmp = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l05-workspace-fs-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const failure = (operation: () => unknown): string => {
  try {
    operation();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the operation to fail');
};

it('normalizes_safe_relative_path', () => {
  expect(WorkspaceFsExecutor.normalizeRelativePath('./notes/summary.md'))
    .toBe(path.join('notes', 'summary.md'));
  expect(WorkspaceFsExecutor.normalizeRelativePath('')).toBe('');
});

it('rejects_escape_paths', () => {
  expect(() => WorkspaceFsExecutor.normalizeRelativePath('../secret.txt')).toThrow();
  expect(() => WorkspaceFsExecutor.normalizeRelativePath('a/../../secret.txt')).toThrow();
  expect(() => WorkspaceFsExecutor.normalizeRelativePath('/tmp/secret.txt')).toThrow();
});

it('sanitizes_session_dir', () => {
  const unsafeId = safeSessionDir('sess:abc/123');
  const formerlyColliding = safeSessionDir('sess_abc_123');
  expect(unsafeId.startsWith('v2-sess_abc_123-')).toBe(true);
  expect(unsafeId).not.toBe(formerlyColliding);
});

it('overwrite_backups_land_in_temp_backup_area', () => {
  const tempDir = tmp();
  const backupRef = createWriteBackup(tempDir, 'notes.md', Buffer.from('old content'));
  expect(backupRef.startsWith('.write_backups/')).toBe(true);
  expect(backupRef.endsWith('notes.md')).toBe(true);
  expect(fs.readFileSync(path.join(tempDir, backupRef))).toEqual(Buffer.from('old content'));
});

it('sensitivity_marks_artifact_write_medium', () => {
  const executor = new WorkspaceFsExecutor();
  expect(executor.canHandle('workspace_file_read')).toBe(true);
  expect(executor.canHandle('builtin-workspace_file_read')).toBe(true);
  expect(executor.sensitivityLevel('builtin-workspace_artifact_write')).toBe('medium');
  expect(executor.sensitivityLevel('builtin-workspace_file_read')).toBe('low');
});

it('hidden_and_secret_paths_are_private_by_default', () => {
  for (const relative of [
    '.env',
    '.npmrc',
    '.ssh/id_ed25519',
    'config/credentials.json',
    'keys/server.pem',
    'auth/private_key.txt',
  ]) {
    expect(() => ensurePublicRuntimePath(relative)).toThrow();
  }
  expect(() => ensurePublicRuntimePath('notes/semester-plan.md')).not.toThrow();
});

// Rust: `#[cfg(unix)]`。
it.skipIf(process.platform === 'win32')('existing_path_resolution_rejects_symlinked_private_targets', () => {
  const tempDir = tmp();
  fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET=value');
  fs.symlinkSync(path.join(tempDir, '.env'), path.join(tempDir, 'public.txt'));
  const rootCanon = fs.realpathSync.native(tempDir);

  const error = failure(() => WorkspaceFsExecutor.ensureInsideExisting(rootCanon, 'public.txt'));
  expect(error).toContain('symlink');
});

it('directory_list_stops_after_requested_limit', () => {
  const tempDir = tmp();
  for (let index = 0; index < 50; index++) {
    fs.writeFileSync(path.join(tempDir, `file-${String(index).padStart(3, '0')}.txt`), 'x');
  }

  const listed = WorkspaceFsExecutor.listDirectoryBounded(tempDir, '', 5);
  expect(listed.entries.length).toBe(5);
  expect(listed.truncated).toBe(true);
  expect(listed.scanned).toBeLessThanOrEqual(20);
});

it('directory_list_filters_hidden_and_secret_entries', () => {
  const tempDir = tmp();
  fs.writeFileSync(path.join(tempDir, 'visible.txt'), 'ok');
  fs.writeFileSync(path.join(tempDir, '.env'), 'secret');
  fs.writeFileSync(path.join(tempDir, 'credentials.json'), 'secret');

  const listed = WorkspaceFsExecutor.listDirectoryBounded(tempDir, '', 10);
  const names = listed.entries
    .map(entry => entry['name'])
    .filter((name): name is string => typeof name === 'string');
  expect(names).toEqual(['visible.txt']);
  expect(listed.skipped).toBe(2);
  expect(listed.truncated).toBe(false);
});

it('file_read_streams_full_hash_but_keeps_only_visible_prefix', () => {
  const tempDir = tmp();
  const target = path.join(tempDir, 'unicode.txt');
  const content = 'ab你cd';
  fs.writeFileSync(target, content);

  const read = WorkspaceFsExecutor.readFileBounded(target, 0, 4, windowsFiles);
  expect(read.bytes).toBe(Buffer.byteLength(content));
  expect(read.visible.length).toBe(4);
  expect(read.offset).toBe(0);
  expect(read.sha256).toBe(WorkspaceFsExecutor.sha256Hex(Buffer.from(content)));
  expect(WorkspaceFsExecutor.decodeUtf8Prefix(read.visible, true)).toBe('ab');
});

it('file_read_rejects_mid_utf8_offset', () => {
  const tempDir = tmp();
  const target = path.join(tempDir, 'unicode.txt');
  fs.writeFileSync(target, 'ab你cd');
  const error = failure(() => WorkspaceFsExecutor.readFileBounded(target, 3, 8, windowsFiles));
  expect(error).toContain('character boundary');
});

it('file_read_rejects_offset_past_eof', () => {
  const tempDir = tmp();
  const target = path.join(tempDir, 'short.txt');
  fs.writeFileSync(target, 'hi');
  const error = failure(() => WorkspaceFsExecutor.readFileBounded(target, 3, 8, windowsFiles));
  expect(error).toContain('exceeds');
});

it('file_read_at_eof_returns_empty_visible', () => {
  const tempDir = tmp();
  const target = path.join(tempDir, 'short.txt');
  fs.writeFileSync(target, 'hi');
  const read = WorkspaceFsExecutor.readFileBounded(target, 2, 8, windowsFiles);
  expect(read.visible.length).toBe(0);
  expect(read.bytes).toBe(2);
  expect(read.offset).toBe(2);
});

it('file_read_pages_reconstruct_full_utf8_and_hash_is_whole_file', () => {
  const tempDir = tmp();
  const target = path.join(tempDir, 'paged.txt');
  const content = 'ab你cd我ef';
  fs.writeFileSync(target, content);
  const whole = WorkspaceFsExecutor.readFileBounded(target, 0, 1024, windowsFiles);
  expect(whole.sha256).toBe(WorkspaceFsExecutor.sha256Hex(Buffer.from(content)));

  let offset = 0;
  let acc = '';
  for (;;) {
    const read = WorkspaceFsExecutor.readFileBounded(target, offset, 4, windowsFiles);
    expect(read.sha256).toBe(whole.sha256);
    if (offset === read.bytes) {
      expect(read.visible.length).toBe(0);
      break;
    }
    const more = offset + read.visible.length < read.bytes;
    const chunk = decodeUtf8Window(read.visible, more);
    acc += chunk;
    offset += Buffer.byteLength(chunk, 'utf8');
    if (offset >= read.bytes) break;
  }
  expect(acc).toBe(content);
});

it('file_read_result_budget_is_disabled', () => {
  const executor = new WorkspaceFsExecutor();
  expect(executor.resultCharBudget('builtin-workspace_file_read')).toBeNull();
  expect(executor.resultCharBudget('builtin-workspace_file_list')).toBe(DEFAULT_TOOL_RESULT_CHAR_BUDGET);
});

it('file_read_rejects_oversized_sparse_files_before_allocating', () => {
  const tempDir = tmp();
  const target = path.join(tempDir, 'oversized.txt');
  const fd = fs.openSync(target, 'w');
  try {
    fs.ftruncateSync(fd, MAX_FILE_SOURCE_BYTES + 1);
  } finally {
    fs.closeSync(fd);
  }
  expect(() => WorkspaceFsExecutor.readFileBounded(target, 0, 1024, windowsFiles)).toThrow();
});

it('atomic_write_replaces_or_preserves_existing_content', () => {
  const tempDir = tmp();
  const target = path.join(tempDir, 'artifact.md');
  fs.writeFileSync(target, 'old');

  WorkspaceFsExecutor.atomicWriteBytes(target, Buffer.from('new'), true);
  expect(fs.readFileSync(target, 'utf8')).toBe('new');

  expect(() => WorkspaceFsExecutor.atomicWriteBytes(target, Buffer.from('unexpected'), false)).toThrow();
  expect(fs.readFileSync(target, 'utf8')).toBe('new');
});

it('apply_edits_single_unique_replacement', () => {
  const content = 'fn main() {\n    println!("hello");\n}\n';
  const edits = [{ old_string: 'println!("hello")', new_string: 'println!("world")' }];
  const result = WorkspaceFsExecutor.applyEdits(content, edits, false);
  expect(result.content).toContain('println!("world")');
  expect(result.counts).toEqual([1]);
});

it('apply_edits_rejects_non_unique_without_replace_all', () => {
  const content = 'foo bar foo baz foo';
  const edits = [{ old_string: 'foo', new_string: 'qux' }];
  const error = failure(() => WorkspaceFsExecutor.applyEdits(content, edits, false));
  expect(error).toContain('3 次');
  // replace_all 放行
  const result = WorkspaceFsExecutor.applyEdits(content, edits, true);
  expect(result.content).toBe('qux bar qux baz qux');
  expect(result.counts).toEqual([3]);
});

it('apply_edits_rejects_missing_old_string', () => {
  const content = 'hello world';
  const edits = [{ old_string: 'nonexistent', new_string: 'x' }];
  const error = failure(() => WorkspaceFsExecutor.applyEdits(content, edits, false));
  expect(error).toContain('未找到匹配');
});

it('apply_edits_rejects_empty_and_noop_edits', () => {
  const content = 'abc';
  const empty = [{ old_string: '', new_string: 'x' }];
  expect(() => WorkspaceFsExecutor.applyEdits(content, empty, false)).toThrow();
  const noop = [{ old_string: 'abc', new_string: 'abc' }];
  expect(() => WorkspaceFsExecutor.applyEdits(content, noop, false)).toThrow();
});

it('apply_edits_applies_multiple_edits_sequentially', () => {
  const content = 'let a = 1;\nlet b = 2;\n';
  const edits = [
    { old_string: 'let a = 1;', new_string: 'let a = 10;' },
    { old_string: 'let b = 2;', new_string: 'let b = 20;' },
  ];
  const result = WorkspaceFsExecutor.applyEdits(content, edits, false);
  expect(result.content).toBe('let a = 10;\nlet b = 20;\n');
  expect(result.counts).toEqual([1, 1]);
});

it('apply_edits_is_atomic_on_any_failure', () => {
  // 第二处编辑失败时，第一处不应生效（返回 Err，调用方不落盘）。
  const content = 'aaa bbb';
  const edits = [
    { old_string: 'aaa', new_string: 'xxx' },
    { old_string: 'missing', new_string: 'yyy' },
  ];
  expect(() => WorkspaceFsExecutor.applyEdits(content, edits, false)).toThrow();
});
