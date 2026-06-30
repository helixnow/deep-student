import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Chat V2 archive and restore source contract', () => {
  const repoSource = readFileSync(
    resolve(process.cwd(), 'src-tauri/src/chat_v2/repo.rs'),
    'utf-8'
  );
  const manageSessionSource = readFileSync(
    resolve(process.cwd(), 'src-tauri/src/chat_v2/handlers/manage_session.rs'),
    'utf-8'
  );

  it('archives a topic by preserving group_id and marking carried sessions', () => {
    expect(repoSource).toContain('pub fn archive_group_with_conn');
    expect(repoSource).toContain("WHERE group_id = ?1 AND persist_status = 'active'");
    expect(repoSource).toContain('"groupArchivedBy".to_string()');
    expect(repoSource).toContain('"groupId": group_id');
    expect(repoSource).toContain("SET persist_status = 'archived', updated_at = ?2, metadata_json = ?3");
    expect(repoSource).not.toContain("archive_group_with_conn(conn: &Connection");
  });

  it('restores topic-carried sessions while preserving explicit manual archives', () => {
    expect(repoSource).toContain('pub fn restore_group_with_conn');
    expect(repoSource).toContain('let manually_archived = metadata.get("manuallyArchivedBy").is_some();');
    expect(repoSource).toContain('.unwrap_or(!manually_archived)');
    expect(repoSource).toContain('obj.remove("groupArchivedBy");');
    expect(repoSource).toContain("WHERE persist_status = 'archived'");
    expect(repoSource).toContain('OR metadata_json LIKE');
    expect(repoSource).toContain('marker_group_id == Some(group_id)');
  });

  it('marks individual archive operations and blocks orphaned restores from archived topics', () => {
    expect(manageSessionSource).toContain('const MANUALLY_ARCHIVED_BY_KEY: &str = "manuallyArchivedBy";');
    expect(manageSessionSource).toContain('obj.insert(');
    expect(manageSessionSource).toContain('MANUALLY_ARCHIVED_BY_KEY.to_string()');
    expect(manageSessionSource).toContain('obj.remove(MANUALLY_ARCHIVED_BY_KEY);');
    expect(manageSessionSource).toContain('请先恢复整个课题');
  });
});
