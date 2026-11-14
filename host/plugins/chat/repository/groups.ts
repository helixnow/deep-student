/**
 * `chat_v2_session_groups` persistence. Rust source: `chat_v2/repo.rs:682-1129`.
 * VFS folder side effects live in the (blocked) group handlers, not here.
 */
import type { SessionGroup } from '../api.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { deleteSessionHard } from './sessions.ts';
import { ChatV2Error } from '../src/error.ts';
import { errorText, type ChatLogger } from '../src/logger.ts';
import { databaseOperation } from './errors.ts';
import { databaseNow, databaseTimestamp, utcTimestamp } from '../src/types.ts';

export const GROUP_COLUMNS = `id, name, description, icon, color, system_prompt, default_skill_ids_json,
  workspace_id, sort_order, persist_status, created_at, updated_at, pinned_resource_ids_json,
  default_runtime_root_id, preferred_project_root_path, root_folder_id`;

export interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  system_prompt: string | null;
  default_skill_ids_json: string | null;
  workspace_id: string | null;
  sort_order: number;
  persist_status: string;
  created_at: string;
  updated_at: string;
  pinned_resource_ids_json: string | null;
  default_runtime_root_id: string | null;
  preferred_project_root_path: string | null;
  root_folder_id: string | null;
}

function parseStringArray(value: string | null): string[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function firstPinnedFolderIdFromList(pinnedResourceIds: readonly string[]): string | null {
  for (const id of pinnedResourceIds) {
    const trimmed = id.trim();
    if (trimmed.startsWith('fld_')) return trimmed;
  }
  return null;
}

function resolvePersistedRootFolderId(group: SessionGroup): string | null {
  if (group.rootFolderId === null) return null;
  if (typeof group.rootFolderId === 'string' && group.rootFolderId.trim() !== '') {
    return group.rootFolderId.trim();
  }
  return firstPinnedFolderIdFromList(group.pinnedResourceIds);
}

export function rowToGroup(row: GroupRow): SessionGroup {
  const status = row.persist_status === 'archived' || row.persist_status === 'deleted'
    ? row.persist_status : 'active';
  const pinnedResourceIds = parseStringArray(row.pinned_resource_ids_json);
  const resolvedRootFolderId = (row.root_folder_id !== null && row.root_folder_id.trim() !== '')
    ? row.root_folder_id.trim()
    : firstPinnedFolderIdFromList(pinnedResourceIds);
  const group: SessionGroup = {
    id: row.id,
    name: row.name,
    defaultSkillIds: parseStringArray(row.default_skill_ids_json),
    pinnedResourceIds,
    sortOrder: row.sort_order,
    persistStatus: status,
    createdAt: utcTimestamp(row.created_at),
    updatedAt: utcTimestamp(row.updated_at),
  };
  if (resolvedRootFolderId !== null) group.rootFolderId = resolvedRootFolderId;
  if (row.description !== null) group.description = row.description;
  if (row.icon !== null) group.icon = row.icon;
  if (row.color !== null) group.color = row.color;
  if (row.system_prompt !== null) group.systemPrompt = row.system_prompt;
  if (row.workspace_id !== null) group.workspaceId = row.workspace_id;
  if (row.default_runtime_root_id !== null) group.defaultRuntimeRootId = row.default_runtime_root_id;
  if (row.preferred_project_root_path !== null) group.preferredProjectRootPath = row.preferred_project_root_path;
  return group;
}

export function getGroup(db: SqlExecutor, groupId: string): SessionGroup | null {
  return databaseOperation(() => {
    const row = db.get<GroupRow>(`SELECT ${GROUP_COLUMNS} FROM chat_v2_session_groups WHERE id = ?1`, [groupId]);
    return row ? rowToGroup(row) : null;
  });
}

export function listGroups(db: SqlExecutor, status: string | null, workspaceId: string | null, log?: ChatLogger): SessionGroup[] {
  return databaseOperation(() => {
    let sql = `SELECT ${GROUP_COLUMNS} FROM chat_v2_session_groups WHERE 1=1`;
    const params: string[] = [];
    if (status !== null) { sql += ' AND persist_status = ?'; params.push(status); }
    if (workspaceId !== null) { sql += ' AND workspace_id = ?'; params.push(workspaceId); }
    sql += ' ORDER BY sort_order ASC, updated_at DESC';
    return db.all<GroupRow>(sql, params).flatMap(row => {
      try { return [rowToGroup(row)]; } catch (error) {
        log?.warn('[ChatV2Repo] Skipping malformed row: ' + errorText(error));
        return [];
      }
    });
  });
}

export function createGroup(db: SqlExecutor, group: SessionGroup): void {
  databaseOperation(() => {
    db.run(`INSERT INTO chat_v2_session_groups (
      id, name, description, icon, color, system_prompt, default_skill_ids_json,
      workspace_id, sort_order, persist_status, created_at, updated_at, pinned_resource_ids_json,
      default_runtime_root_id, preferred_project_root_path, root_folder_id
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`, [
      group.id, group.name, group.description ?? null, group.icon ?? null, group.color ?? null,
      group.systemPrompt ?? null, JSON.stringify(group.defaultSkillIds), group.workspaceId ?? null,
      group.sortOrder, group.persistStatus, databaseTimestamp(group.createdAt),
      databaseTimestamp(group.updatedAt), JSON.stringify(group.pinnedResourceIds),
      group.defaultRuntimeRootId ?? null, group.preferredProjectRootPath ?? null,
      resolvePersistedRootFolderId(group),
    ]);
  });
}

export function updateGroup(db: SqlExecutor, group: SessionGroup): void {
  databaseOperation(() => {
    const result = db.run(`UPDATE chat_v2_session_groups SET
      name = ?2, description = ?3, icon = ?4, color = ?5, system_prompt = ?6,
      default_skill_ids_json = ?7, workspace_id = ?8, sort_order = ?9, persist_status = ?10,
      updated_at = ?11, pinned_resource_ids_json = ?12, default_runtime_root_id = ?13,
      preferred_project_root_path = ?14, root_folder_id = ?15 WHERE id = ?1`, [
      group.id, group.name, group.description ?? null, group.icon ?? null, group.color ?? null,
      group.systemPrompt ?? null, JSON.stringify(group.defaultSkillIds), group.workspaceId ?? null,
      group.sortOrder, group.persistStatus, databaseTimestamp(group.updatedAt),
      JSON.stringify(group.pinnedResourceIds), group.defaultRuntimeRootId ?? null,
      group.preferredProjectRootPath ?? null, resolvePersistedRootFolderId(group),
    ]);
    if (!result.changes) throw new ChatV2Error('GroupNotFound', group.id);
  });
}

/** `reorder_groups_with_conn` (repo.rs:1101-1114): one IMMEDIATE tx, index → sort_order. */
export function reorderGroups(db: DatabaseHandle, groupIds: string[]): void {
  databaseOperation(() => {
    db.transaction(tx => {
      groupIds.forEach((groupId, index) => {
        tx.run('UPDATE chat_v2_session_groups SET sort_order = ?2, updated_at = ?3 WHERE id = ?1',
          [groupId, index, databaseNow()]);
      });
    }, { behavior: 'immediate' });
  });
}

/**
 * `list_session_ids_owned_by_group_with_conn` (repo.rs:992-1037): sessions that
 * still carry `group_id` plus legacy rows that only kept `groupArchivedBy`.
 */
export function listSessionIdsOwnedByGroup(db: SqlExecutor, groupId: string): string[] {
  return databaseOperation(() => {
    const rows = db.all<{ id: string; metadata_json: string | null; group_id: string | null }>(`
      SELECT id, metadata_json, group_id
      FROM chat_v2_sessions
      WHERE group_id = ?1
         OR metadata_json LIKE '%"groupArchivedBy"%'`, [groupId]);
    const ids: string[] = [];
    for (const row of rows) {
      if (row.group_id === groupId) { ids.push(row.id); continue; }
      let marker: string | null = null;
      if (row.metadata_json !== null) {
        try {
          const metadata = JSON.parse(row.metadata_json) as unknown;
          if (metadata !== null && typeof metadata === 'object') {
            const archived = (metadata as Record<string, unknown>).groupArchivedBy;
            if (archived !== null && typeof archived === 'object') {
              const value = (archived as Record<string, unknown>).groupId;
              if (typeof value === 'string') marker = value;
            }
          }
        } catch { marker = null; }
      }
      if (marker === groupId) ids.push(row.id);
    }
    return ids;
  });
}

/** `archive_group_with_conn` (repo.rs:827-885). */
export function archiveGroup(db: DatabaseHandle, groupId: string): void {
  databaseOperation(() => {
    db.transaction((tx) => {
      const now = databaseNow();
      tx.run(`UPDATE chat_v2_session_groups
        SET persist_status = 'archived', updated_at = ?2
        WHERE id = ?1 AND persist_status != 'deleted'`, [groupId, now]);
      const sessions = tx.all<{ id: string; metadata_json: string | null }>(`
        SELECT id, metadata_json
        FROM chat_v2_sessions
        WHERE group_id = ?1 AND persist_status = 'active'`, [groupId]);
      for (const session of sessions) {
        const metadata = parseMetadataObject(session.metadata_json);
        metadata.groupArchivedBy = { groupId, archivedAt: now };
        tx.run(`UPDATE chat_v2_sessions
          SET persist_status = 'archived', updated_at = ?2, metadata_json = ?3
          WHERE id = ?1`, [session.id, now, JSON.stringify(metadata)]);
      }
    }, { behavior: 'immediate' });
  });
}

/** `restore_group_with_conn` (repo.rs:888-984). */
export function restoreGroup(db: DatabaseHandle, groupId: string): void {
  databaseOperation(() => {
    db.transaction((tx) => {
      const now = databaseNow();
      tx.run(`UPDATE chat_v2_session_groups
        SET persist_status = 'active', updated_at = ?2
        WHERE id = ?1 AND persist_status = 'archived'`, [groupId, now]);
      const sessions = tx.all<{ id: string; metadata_json: string | null; group_id: string | null }>(`
        SELECT id, metadata_json, group_id
        FROM chat_v2_sessions
        WHERE persist_status = 'archived'
          AND (group_id = ?1 OR metadata_json LIKE '%"groupArchivedBy"%')`, [groupId]);
      for (const session of sessions) {
        const metadata = parseMetadataObject(session.metadata_json);
        const manuallyArchived = 'manuallyArchivedBy' in metadata;
        const archived = metadata.groupArchivedBy;
        const markerGroupId = archived !== null && typeof archived === 'object'
          ? (archived as Record<string, unknown>).groupId : undefined;
        const shouldRestore = session.group_id === groupId
          ? (typeof markerGroupId === 'string'
            ? markerGroupId === groupId
            // Compat: rows archived before groupArchivedBy existed restore unless manually archived.
            : !manuallyArchived)
          // Compat: reattach rows whose group_id was cleared but the marker survived.
          : markerGroupId === groupId;
        if (!shouldRestore) continue;
        delete metadata.groupArchivedBy;
        tx.run(`UPDATE chat_v2_sessions
          SET persist_status = 'active', updated_at = ?2, metadata_json = ?3, group_id = ?4
          WHERE id = ?1`, [session.id, now, JSON.stringify(metadata), groupId]);
      }
    }, { behavior: 'immediate' });
  });
}

/** `soft_delete_group_with_conn` (repo.rs:1080-1098): the only flow that ungroups sessions. */
export function softDeleteGroup(db: DatabaseHandle, groupId: string): void {
  databaseOperation(() => {
    db.transaction((tx) => {
      const now = databaseNow();
      tx.run(`UPDATE chat_v2_session_groups
        SET persist_status = 'deleted', updated_at = ?2
        WHERE id = ?1`, [groupId, now]);
      tx.run('UPDATE chat_v2_sessions SET group_id = NULL WHERE group_id = ?1', [groupId]);
    }, { behavior: 'immediate' });
  });
}

/** `permanently_delete_group_with_conn` (repo.rs:1040-1076). */
export function permanentlyDeleteGroup(db: DatabaseHandle, groupId: string): string[] {
  return databaseOperation(() => {
    let deleted: string[] = [];
    db.transaction((tx) => {
      const row = tx.get<{ persist_status: string }>(
        'SELECT persist_status FROM chat_v2_session_groups WHERE id = ?1', [groupId]);
      if (!row) throw new ChatV2Error('GroupNotFound', groupId);
      if (row.persist_status === 'active') {
        throw new ChatV2Error('Validation', 'Cannot permanently delete an active topic. Archive it first.');
      }
      deleted = listSessionIdsOwnedByGroup(tx, groupId);
      for (const sessionId of deleted) deleteSessionHard(tx, sessionId);
      const affected = tx.run('DELETE FROM chat_v2_session_groups WHERE id = ?1', [groupId]).changes;
      if (affected === 0) throw new ChatV2Error('GroupNotFound', groupId);
    }, { behavior: 'immediate' });
    return deleted;
  });
}

/** Rust treats non-object / unparsable metadata as an empty object. */
function parseMetadataObject(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}
