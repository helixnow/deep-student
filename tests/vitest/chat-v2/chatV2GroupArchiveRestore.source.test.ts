import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Chat V2 group archive restore source contract', () => {
  const repoSource = readFileSync(
    resolve(process.cwd(), 'src-tauri/src/chat_v2/repo.rs'),
    'utf-8'
  );
  const zhDataSource = readFileSync(resolve(process.cwd(), 'src/locales/zh-CN/data.json'), 'utf-8');
  const enDataSource = readFileSync(resolve(process.cwd(), 'src/locales/en-US/data.json'), 'utf-8');

  it('archives topic sessions without clearing group_id and records a restore marker', () => {
    expect(repoSource).toContain('pub fn archive_group_with_conn');
    expect(repoSource).toContain('WHERE group_id = ?1 AND persist_status = \'active\'');
    expect(repoSource).toContain('"groupArchivedBy".to_string()');
    expect(repoSource).toContain('"groupId": group_id');
    expect(repoSource).not.toContain("SET persist_status = 'archived', group_id = NULL");
  });

  it('restores legacy topic-archived sessions even when older data has no marker', () => {
    expect(repoSource).toContain('pub fn restore_group_with_conn');
    expect(repoSource).toContain('Compatibility for older builds/sync repairs');
    expect(repoSource).toContain('let manually_archived = metadata.get("manuallyArchivedBy").is_some();');
    expect(repoSource).toContain('.unwrap_or(!manually_archived)');
    expect(repoSource).toContain('obj.remove("groupArchivedBy")');
    expect(repoSource).not.toContain('let Some(raw_metadata) = metadata_json.as_deref() else');
  });

  it('reattaches older marker sessions whose group_id was cleared by broken delete flows', () => {
    expect(repoSource).toContain('OR metadata_json LIKE');
    expect(repoSource).toContain('marker_group_id == Some(group_id)');
    expect(repoSource).toContain('group_id = ?4');
    expect(repoSource).toContain('test_restore_group_reattaches_marker_sessions_with_cleared_group_id');
  });

  it('permanently deletes archived topics without clearing session group_id into global chat', () => {
    expect(repoSource).toContain('pub fn permanently_delete_group_with_conn');
    expect(repoSource).toContain('pub fn list_session_ids_owned_by_group_with_conn');
    expect(repoSource).toContain('Cannot permanently delete an active topic. Archive it first.');
    expect(repoSource).toContain('Self::delete_session_with_tx(&tx, session_id)');
    expect(repoSource).toContain('test_permanently_delete_group_deletes_marker_orphan_sessions');
    expect(zhDataSource).toContain('课题及其归档会话已永久删除');
    expect(enDataSource).toContain('Topic and its archived sessions were permanently deleted.');
    expect(zhDataSource).not.toContain('归档会话保留在未分组区');
    expect(enDataSource).not.toContain('Archived sessions remain under Ungrouped');
  });

  it('keeps AI session-manager archives from being restored with an archived topic', () => {
    const sessionExecutorSource = readFileSync(
      resolve(process.cwd(), 'src-tauri/src/chat_v2/tools/session_executor.rs'),
      'utf-8'
    );

    expect(sessionExecutorSource).toContain('const MANUALLY_ARCHIVED_BY_KEY');
    expect(sessionExecutorSource).toContain('fn manually_archive_session');
    expect(sessionExecutorSource).toContain('MANUALLY_ARCHIVED_BY_KEY.to_string()');
    expect(sessionExecutorSource).toContain('let archived = manually_archive_session(existing);');
    expect(sessionExecutorSource).not.toContain('persist_status: PersistStatus::Archived,\n            updated_at: chrono::Utc::now(),\n            ..existing');
  });
});
