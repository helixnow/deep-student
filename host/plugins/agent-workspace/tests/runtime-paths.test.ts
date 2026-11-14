import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorkspaceHost } from './host-support.ts';
import { safeSessionDir, resolveSessionRuntimeRoot, cleanupSessionRuntimeRoots, normalizeRuntimeRelativePath,
  authorizedRootId, canonicalizeExistingDir, assessAuthorizedRootRisk, stripWindowsVerbatimPrefix,
  assessAuthorizedRootRiskCanonical, effectiveRuntimeRootId, explicitRuntimeRootIdFromArgs,
  listRuntimeDirectoryPage, redactPathForDisplay, removeArtifactFile } from '../src/runtime-paths.ts';

const dirs: string[] = [];
const tmp = () => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l05-'))); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
it('sanitizes_session_dir', () => {
  const value = safeSessionDir('sess:abc/123');
  expect(value.startsWith('v2-sess_abc_123-')).toBe(true);
  expect(value.length).toBe('v2-sess_abc_123-'.length + 32);
  expect(value).not.toBe(safeSessionDir('sess_abc_123'));
  expect(safeSessionDir(value)).not.toBe(value);
});
it('session_runtime_root_migrates_legacy_directory_once', () => {
  const base = tmp(); const session = 'agent_01JUPPERCASE';
  const legacy = path.join(base, 'chat_v2_artifacts', session);
  fs.mkdirSync(legacy, { recursive: true }); fs.writeFileSync(path.join(legacy, 'result.md'), 'kept');
  const migrated = resolveSessionRuntimeRoot(base, 'chat_v2_artifacts', session, true);
  expect(path.basename(migrated)).toBe(safeSessionDir(session));
  expect(fs.readFileSync(path.join(migrated, 'result.md'), 'utf8')).toBe('kept');
  expect(fs.existsSync(legacy)).toBe(false);
});
it('session_runtime_root_rejects_symlink_rebinding', () => {
  const base = tmp(); const container = path.join(base, 'chat_v2_artifacts'); const outside = path.join(base, 'outside');
  fs.mkdirSync(container); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(container, safeSessionDir('sess_rebound')), 'junction');
  expect(() => resolveSessionRuntimeRoot(base, 'chat_v2_artifacts', 'sess_rebound', true)).toThrow();
});
it('ambiguous_legacy_session_names_are_never_migrated_or_deleted', () => {
  const base = tmp(); const legacy = path.join(base, 'chat_v2_artifacts', 'sess_a_b');
  fs.mkdirSync(legacy, { recursive: true }); fs.writeFileSync(path.join(legacy, 'keep.md'), 'keep');
  const root = resolveSessionRuntimeRoot(base, 'chat_v2_artifacts', 'sess_a/b', true);
  expect(root).not.toBe(legacy); expect(fs.existsSync(path.join(legacy, 'keep.md'))).toBe(true);
  cleanupSessionRuntimeRoots(base, 'sess_a/b');
  expect(fs.existsSync(path.join(legacy, 'keep.md'))).toBe(true);
});
it('authorized_root_ids_are_stable', () => {
  expect(authorizedRootId('C:/Users/example/project')).toBe(authorizedRootId('C:/Users/example/project'));
  expect(authorizedRootId('C:/Users/example/project').startsWith('authorized_')).toBe(true);
});
it('normalizes_runtime_relative_path', () => {
  expect(normalizeRuntimeRelativePath('./notes/summary.md')).toBe(path.join('notes', 'summary.md'));
  expect(normalizeRuntimeRelativePath('')).toBe('');
});
it('rejects_runtime_relative_path_escapes', () => {
  for (const value of ['../secret.txt', 'a/../../secret.txt', '/tmp/secret.txt']) {
    expect(() => normalizeRuntimeRelativePath(value)).toThrow();
  }
});
for (const [title, label] of [
  ['canonicalizes_authorized_directory_and_rejects_non_dirs', 'authorized runtime root'],
  ['canonicalizes_workspace_directory_and_rejects_non_dirs', 'workspace runtime root'],
] as const) it(title, () => {
  const base = tmp(); const dir = path.join(base, 'materials'); fs.mkdirSync(dir);
  expect(canonicalizeExistingDir(` ${dir} `, label)).toBe(fs.realpathSync(dir));
  const file = path.join(dir, 'note.txt'); fs.writeFileSync(file, 'hello');
  expect(() => canonicalizeExistingDir(file, label)).toThrow();
  expect(() => canonicalizeExistingDir('   ', label)).toThrow();
});
it('assesses_windows_authorized_root_risk', () => {
  for (const value of ['C:\\', 'C:\\Users', 'C:\\Users\\foo', '~']) expect(assessAuthorizedRootRisk(value)).toBe('critical');
  for (const value of ['C:\\Users\\foo\\Desktop', '~/Downloads']) expect(assessAuthorizedRootRisk(value)).toBe('broad');
  expect(assessAuthorizedRootRisk('C:\\Users\\foo\\Documents\\project\\data')).toBe('safe');
});
it('assesses_risk_on_canonical_paths_with_verbatim_prefix', () => {
  expect(stripWindowsVerbatimPrefix('\\\\?\\C:\\Users\\foo')).toBe('C:\\Users\\foo');
  expect(stripWindowsVerbatimPrefix('\\\\?\\UNC\\server\\share')).toBe('\\\\server\\share');
  expect(stripWindowsVerbatimPrefix('C:\\plain\\path')).toBe('C:\\plain\\path');
  expect(assessAuthorizedRootRiskCanonical('\\\\?\\C:\\Users\\foo')).toBe('critical');
  expect(assessAuthorizedRootRiskCanonical('\\\\?\\C:\\Users\\foo\\Desktop')).toBe('broad');
  expect(assessAuthorizedRootRiskCanonical('\\\\?\\C:\\Users\\foo\\Documents\\project\\data')).toBe('safe');
});
it('canonicalize_resolves_parent_traversal_before_risk_assessment', () => {
  const base = tmp(); const child = path.join(base, 'child'); fs.mkdirSync(child);
  const canonical = canonicalizeExistingDir(`${child}${path.sep}..`, 'authorized runtime root');
  expect(canonical).toBe(fs.realpathSync(base)); expect(canonical.split(path.sep)).not.toContain('..');
});
it('effective_runtime_root_id_prefers_explicit_then_preferred_then_workspace', () => {
  expect(effectiveRuntimeRootId('temp', 'authorized_x')).toBe('temp');
  expect(effectiveRuntimeRootId('  ', 'authorized_x')).toBe('authorized_x');
  expect(effectiveRuntimeRootId(null, 'authorized_x')).toBe('authorized_x');
  expect(effectiveRuntimeRootId(null, null)).toBe('workspace');
  expect(effectiveRuntimeRootId('', '')).toBe('workspace');
});
it('explicit_runtime_root_id_from_args_reads_snake_and_camel', () => {
  expect(explicitRuntimeRootIdFromArgs({ root_id: 'temp' })).toBe('temp');
  expect(explicitRuntimeRootIdFromArgs({ rootId: 'artifacts' })).toBe('artifacts');
  expect(explicitRuntimeRootIdFromArgs({ root_id: '  ' })).toBeNull();
  expect(explicitRuntimeRootIdFromArgs({ cwd: '.' })).toBeNull();
});
it('runtime_directory_page_exposes_folders_and_visible_truncation', () => {
  const root = tmp(); fs.mkdirSync(path.join(root, 'context-folder'));
  for (const [file, value] of [['a.txt', 'a'], ['b.txt', 'bb'], ['.env', 'secret']] as const) fs.writeFileSync(path.join(root, file), value);
  const first = listRuntimeDirectoryPage('workspace', root, '', 0, 2);
  expect(first.entries).toHaveLength(2); expect(first.truncated).toBe(true);
  const cursor = Number(first.nextCursor); expect(cursor).toBe(first.scanned);
  expect(first.entries.every(e => e.name !== '.env')).toBe(true);
  const second = listRuntimeDirectoryPage('workspace', root, '', cursor, 2);
  expect(second.entries).toHaveLength(1); expect(second.truncated).toBe(false);
  const entries = [...first.entries, ...second.entries];
  expect(entries.some(e => e.kind === 'directory' && e.relativePath === 'context-folder')).toBe(true);
  expect(new Set(entries.map(e => e.name))).toEqual(new Set(['a.txt', 'b.txt', 'context-folder']));
});
it('runtime_directory_page_rejects_paths_outside_bound_root', () => {
  const root = path.join(tmp(), 'root'); fs.mkdirSync(root);
  expect(() => listRuntimeDirectoryPage('workspace', root, '..', 0, 10)).toThrow('outside');
});
it('runtime_directory_pagination_crosses_scan_cap_and_terminates', () => {
  const root = tmp(); for (let i = 0; i < 1025; i++) fs.writeFileSync(path.join(root, `file-${String(i).padStart(4, '0')}.txt`), 'x');
  let cursor = 0; const names = new Set<string>(); let pages = 0;
  for (;;) {
    const page = listRuntimeDirectoryPage('workspace', root, '', cursor, 100);
    for (const entry of page.entries) { expect(names.has(entry.name)).toBe(false); names.add(entry.name); }
    pages++;
    if (page.nextCursor === null) break;
    const next = Number(page.nextCursor); expect(next).toBeGreaterThan(cursor); cursor = next;
    expect(pages).toBeLessThan(20);
  }
  expect(names.size).toBe(1025);
});
it('runtime_directory_cursor_past_end_terminates_empty', () => {
  const root = tmp(); fs.writeFileSync(path.join(root, 'only.txt'), 'x');
  const page = listRuntimeDirectoryPage('workspace', root, '', 10, 40);
  expect(page.entries).toEqual([]); expect(page.nextCursor).toBeNull(); expect(page.truncated).toBe(false);
});
it('redact_path_for_display_masks_home_prefix', () => {
  expect(redactPathForDisplay(path.join(os.homedir(), 'Projects', 'demo'))).toBe('~/Projects/demo');
  expect(redactPathForDisplay(os.homedir())).toBe('~'); expect(redactPathForDisplay('  ')).toBe('');
});
it('chat_v2_delete_artifact preserves the IPC result and errors', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    await expect(host.invoke('chat_v2_delete_artifact', { sessionId: 's', relativePath: '' })).rejects.toBe('A relative artifact path is required');
    await expect(host.invoke('chat_v2_delete_artifact', { sessionId: 's', relativePath: 'a' })).rejects.toBe('No artifacts exist for this session yet');
    const root = resolveSessionRuntimeRoot(host.app.dataDir, 'chat_v2_artifacts', 's', true);
    fs.writeFileSync(path.join(root, 'a'), 'content');
    await expect(host.invoke('chat_v2_delete_artifact', { sessionId: 's', relativePath: './a' })).resolves.toEqual({ deleted: true, root_id: 'artifacts', relative_path: 'a' });
    expect(fs.existsSync(path.join(root, 'a'))).toBe(false);
  } finally { storage.dispose(); await host.dispose(); }
});
it('deleting_symlink_artifact_removes_link_not_referent', () => {
  const base = tmp(); const artifacts = path.join(base, 'artifacts'); fs.mkdirSync(artifacts);
  const outside = path.join(base, 'outside.txt'); fs.writeFileSync(outside, 'keep me');
  const link = path.join(artifacts, 'link.txt'); fs.symlinkSync(outside, link);
  removeArtifactFile(artifacts, 'link.txt');
  expect(fs.existsSync(link)).toBe(false); expect(fs.readFileSync(outside, 'utf8')).toBe('keep me');
});
it('session_runtime_cleanup_removes_artifacts_temp_and_backups', () => {
  const base = tmp(); const session = 'sess_cleanup-test';
  const artifacts = path.join(base, 'chat_v2_artifacts', safeSessionDir(session));
  const temp = path.join(base, 'chat_v2_temp', safeSessionDir(session));
  fs.mkdirSync(artifacts, { recursive: true }); fs.mkdirSync(path.join(temp, '.write_backups'), { recursive: true });
  fs.writeFileSync(path.join(artifacts, 'result.md'), 'result'); fs.writeFileSync(path.join(temp, '.write_backups', 'backup.md'), 'backup');
  const legacy = path.join(base, 'chat_v2_artifacts', session); fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'old.md'), 'old');
  const unrelated = path.join(base, 'unrelated.txt'); fs.writeFileSync(unrelated, 'keep');
  cleanupSessionRuntimeRoots(base, session);
  expect(fs.existsSync(artifacts)).toBe(false); expect(fs.existsSync(temp)).toBe(false);
  expect(fs.existsSync(legacy)).toBe(false); expect(fs.existsSync(unrelated)).toBe(true);
});
