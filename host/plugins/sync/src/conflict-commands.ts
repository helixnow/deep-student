import { fs } from '../src/local-runtime.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { dirname } from '../../../platform/util/path.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { CoordinatedDatabaseName, DatabaseHandle, SqlExecutor, StorageService } from '../../../platform/storage/api.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { syncClassificationRegistry } from '../src/classification.ts';
import { SyncError } from '../src/errors.ts';
import { newBatchId, REASON_CONFLICT_RESOLVE } from '../src/history.ts';
import type { DbJson } from '../../../platform/util/lossless-json.ts';
import { dbJsonEquals, isJsonObject, parseJsonLossless, stringifyJsonLossless } from '../../../platform/util/lossless-json.ts';
import { getRecordData, recordsSemanticallyEqualForSync } from '../repository/record-data.ts';
import { applyDownloadedChangesForceExactWithHooks } from '../repository/apply.ts';
import { rollbackBatch, snapshotRecordWithData } from '../repository/history.ts';
import { latestConflictSideData, listUnresolvedConflictIds, markConflictResolved } from '../repository/conflicts.ts';
import { quoteIdentifier, tableExists, tableHasColumn } from '../repository/sqlite-values.ts';

const databases: readonly CoordinatedDatabaseName[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** commands_backup.rs:227 `build_id_column_map`。 */
export function buildIdColumnMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of syncClassificationRegistry()) {
    if (entry.category !== 'RowSync') continue;
    const primaryKey = rustTrim(entry.primary_key);
    if (primaryKey === '' || primaryKey === '(virtual)' || primaryKey.includes(',')) continue;
    if (primaryKey !== 'id') map.set(entry.table_name, primaryKey);
  }
  return map;
}

function open(storage: StorageService, name: CoordinatedDatabaseName): DatabaseHandle {
  const path = storage.pathOf(name);
  if (!fs.existsSync(dirname(path))) throw new Error(`unable to open database file: ${path}`);
  return storage.openFile(path, { profile: 'plain' });
}

function unresolvedConflictIds(db: SqlExecutor, tableName: string, recordId: string): bigint[] {
  try {
    return listUnresolvedConflictIds(db, tableName, recordId);
  } catch (error) {
    throw new CommandError(`查询冲突版本失败: ${message(error)}`);
  }
}

function parseSnapshot(raw: string, label: string): DbJson | null {
  let value: DbJson;
  try {
    value = parseJsonLossless(raw);
  } catch (error) {
    throw new CommandError(`解析冲突中的${label}快照失败: ${message(error)}`);
  }
  return value === null ? null : value;
}

/** commands_sync.rs:4611-5009 `data_governance_resolve_record_conflict`。 */
export function resolveRecordConflict(
  storage: StorageService,
  databaseName: string,
  tableName: string,
  recordId: string,
  resolution: string,
  mergedDataJson: string | null,
  expectedConflictIds: readonly number[],
): void {
  if (expectedConflictIds.length === 0) {
    throw new CommandError('缺少冲突版本标识，请刷新冲突列表后重试');
  }
  const expectedIds = [...new Set(expectedConflictIds.map(id => BigInt(Math.trunc(id))))].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const name = databases.find(value => value === databaseName);
  if (!name) throw new CommandError(`未知数据库: ${databaseName}`);
  let db: DatabaseHandle;
  try {
    db = open(storage, name);
  } catch (error) {
    throw new CommandError(`打开数据库 ${databaseName} 失败: ${message(error)}`);
  }
  try {
    resolveOnDatabase(db, name, tableName, recordId, resolution, mergedDataJson, expectedIds);
  } finally {
    storage.close(db);
  }
}

function stripVirtualNoteContent(
  db: SqlExecutor,
  tableName: string,
  value: DbJson | null,
): { data: DbJson | null; virtualContentMd: string | null } {
  if (value === null || !isJsonObject(value)) return { data: value, virtualContentMd: null };
  if (tableName !== 'notes' || tableHasColumn(db, 'notes', 'content_md')) {
    return { data: value, virtualContentMd: null };
  }
  const hasVirtual = Object.hasOwn(value, 'content_md');
  const contentMd = typeof value.content_md === 'string' ? value.content_md : null;
  if (!hasVirtual) return { data: value, virtualContentMd: null };
  const copy: { [key: string]: DbJson } = { ...value };
  delete copy.content_md;
  return { data: copy, virtualContentMd: contentMd };
}

function ensurePendingChangeLog(
  tx: SqlExecutor,
  tableName: string,
  recordId: string,
  operation: 'INSERT' | 'UPDATE' | 'DELETE',
  now: string,
): void {
  if (!tableExists(tx, '__change_log')) return;
  const pendingCount = Number(
    tx.pluck<number | bigint>(
      'SELECT COUNT(*) FROM __change_log WHERE table_name = ?1 AND record_id = ?2 AND sync_version = 0',
      [tableName, recordId],
    ) ?? 0,
  );
  if (pendingCount === 0) {
    tx.run(
      `INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
       VALUES (?1, ?2, ?3, ?4, 0)`,
      [tableName, recordId, operation, now],
    );
  }
}

function bumpUpdatedAtAndLog(
  tx: SqlExecutor,
  tableName: string,
  recordId: string,
  now: string,
): void {
  if (!tableExists(tx, tableName)) return;
  if (tableHasColumn(tx, tableName, 'updated_at')) {
    try {
      const sample = tx.get<{ updated_at: unknown }>(
        `SELECT updated_at FROM ${quoteIdentifier(tableName)} WHERE id = ?1`,
        [recordId],
      );
      if (sample !== undefined) {
        const nextVal = typeof sample.updated_at === 'number' || typeof sample.updated_at === 'bigint'
          ? Date.now()
          : now;
        tx.run(
          `UPDATE ${quoteIdentifier(tableName)} SET updated_at = ?1 WHERE id = ?2`,
          [nextVal, recordId],
        );
      }
    } catch {
      // fallback cleanly if primary key column differs
    }
  }
  ensurePendingChangeLog(tx, tableName, recordId, 'UPDATE', now);
}

function extractNoteContentFromResource(raw: DbJson | null): string | null {
  if (raw === null) return null;
  if (typeof raw === 'string') return raw;
  if (isJsonObject(raw) && typeof raw.data === 'string') return raw.data;
  return null;
}

function encodeResourceDataPreservingShape(existingData: unknown, newBody: string): string {
  if (typeof existingData === 'string' && existingData.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(existingData) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if ('content_md' in parsed) return JSON.stringify({ ...parsed, content_md: newBody });
        if ('content' in parsed) return JSON.stringify({ ...parsed, content: newBody });
      }
    } catch {
      // plain text fallback
    }
  }
  return newBody;
}

function acquireTemporaryNoteWriteGrants(
  tx: SqlExecutor,
  tableName: string,
  recordId: string,
): string[] {
  const granted: string[] = [];
  if (
    (tableName !== 'notes' && tableName !== 'resources')
    || !tableExists(tx, 'note_editor_lease_notes')
    || !tableExists(tx, 'note_editor_write_grants')
  ) {
    return granted;
  }
  const rows = tableName === 'notes'
    ? tx.all<{ token: string }>(
        `SELECT DISTINCT ln.token FROM note_editor_lease_notes ln
         WHERE ln.note_id = ?1
           AND NOT EXISTS (SELECT 1 FROM note_editor_write_grants g WHERE g.token = ln.token)`,
        [recordId],
      )
    : tx.all<{ token: string }>(
        `SELECT DISTINCT ln.token FROM note_editor_lease_notes ln
         JOIN notes n ON n.id = ln.note_id
         WHERE n.resource_id = ?1
           AND NOT EXISTS (SELECT 1 FROM note_editor_write_grants g WHERE g.token = ln.token)`,
        [recordId],
      );
  for (const row of rows) {
    if (row?.token) {
      tx.run('INSERT OR IGNORE INTO note_editor_write_grants (token) VALUES (?1)', [row.token]);
      granted.push(row.token);
    }
  }
  return granted;
}

function releaseTemporaryNoteWriteGrants(tx: SqlExecutor, tokens: readonly string[]): void {
  for (const token of tokens) {
    tx.run('DELETE FROM note_editor_write_grants WHERE token = ?1', [token]);
  }
}

function synchronizePairedNoteAndResource(
  tx: SqlExecutor,
  tableName: string,
  recordId: string,
  resolution: string,
  now: string,
  virtualContentMd: string | null,
  localSnapshot: DbJson | null,
  cloudSnapshot: DbJson | null,
): void {
  if (!tableExists(tx, 'notes') || !tableExists(tx, 'resources')) return;
  if (tableName === 'notes') {
    const localResId = isJsonObject(localSnapshot) && typeof localSnapshot.resource_id === 'string'
      ? localSnapshot.resource_id
      : null;
    const cloudResId = isJsonObject(cloudSnapshot) && typeof cloudSnapshot.resource_id === 'string'
      ? cloudSnapshot.resource_id
      : null;
    const currentNote = tx.get<{ resource_id: string | null }>('SELECT resource_id FROM notes WHERE id = ?1', [recordId]);
    const targetResId = typeof currentNote?.resource_id === 'string' ? currentNote.resource_id : (cloudResId ?? localResId);

    if (targetResId) {
      let bodyToWrite = virtualContentMd;
      if (bodyToWrite === null && resolution === 'keep_cloud') {
        for (const candidateId of [cloudResId, targetResId, localResId]) {
          if (!candidateId) continue;
          const rawRes = latestConflictSideData(tx, 'resources', candidateId, 'cloud');
          if (rawRes !== null) {
            try {
              bodyToWrite = extractNoteContentFromResource(parseJsonLossless(rawRes));
              if (bodyToWrite !== null) break;
            } catch {
              // ignore unparseable conflict snapshot
            }
          }
        }
      }
      const existingRes = tx.get<{ id: string; data: unknown }>('SELECT id, data FROM resources WHERE id = ?1', [targetResId]);
      if (bodyToWrite !== null) {
        if (existingRes) {
          const nextData = encodeResourceDataPreservingShape(existingRes.data, bodyToWrite);
          const nextUpdated = tableHasColumn(tx, 'resources', 'updated_at') ? now : null;
          if (nextUpdated !== null) {
            tx.run('UPDATE resources SET data = ?1, updated_at = ?2 WHERE id = ?3', [nextData, nextUpdated, targetResId]);
          } else {
            tx.run('UPDATE resources SET data = ?1 WHERE id = ?2', [nextData, targetResId]);
          }
          ensurePendingChangeLog(tx, 'resources', targetResId, 'UPDATE', now);
        } else {
          const hasUpdated = tableHasColumn(tx, 'resources', 'updated_at');
          const hasType = tableHasColumn(tx, 'resources', 'type');
          if (hasUpdated && hasType) {
            tx.run("INSERT OR IGNORE INTO resources (id, type, data, updated_at) VALUES (?1, 'note', ?2, ?3)", [targetResId, bodyToWrite, now]);
          } else if (hasType) {
            tx.run("INSERT OR IGNORE INTO resources (id, type, data) VALUES (?1, 'note', ?2)", [targetResId, bodyToWrite]);
          }
          ensurePendingChangeLog(tx, 'resources', targetResId, 'INSERT', now);
        }
      } else if (existingRes) {
        bumpUpdatedAtAndLog(tx, 'resources', targetResId, now);
      }
    }

    const resIds = [...new Set([targetResId, localResId, cloudResId].filter((id): id is string => Boolean(id)))];
    for (const resId of resIds) {
      const pairedIds = listUnresolvedConflictIds(tx, 'resources', resId);
      for (const id of pairedIds) {
        markConflictResolved(tx, id, 'resources', resId, now, resolution);
      }
    }
  } else if (tableName === 'resources') {
    const linkedNotes = tx.all<{ id: string }>('SELECT id FROM notes WHERE resource_id = ?1', [recordId]);
    for (const note of linkedNotes) {
      if (!note?.id) continue;
      bumpUpdatedAtAndLog(tx, 'notes', note.id, now);
      if (resolution === 'keep_local' || resolution === 'keep_cloud') {
        const noteConflictIds = listUnresolvedConflictIds(tx, 'notes', note.id);
        for (const id of noteConflictIds) {
          markConflictResolved(tx, id, 'notes', note.id, now, resolution);
        }
      }
    }
  }
}

function resolveOnDatabase(
  db: DatabaseHandle,
  databaseName: CoordinatedDatabaseName,
  tableName: string,
  recordId: string,
  resolution: string,
  mergedDataJson: string | null,
  expectedIds: readonly bigint[],
): void {
  const currentIds = unresolvedConflictIds(db, tableName, recordId);
  if (currentIds.length !== expectedIds.length || currentIds.some((id, index) => id !== expectedIds[index])) {
    throw new CommandError('冲突已在后台变化，旧决策未执行；请刷新后重新确认');
  }

  const idColumnMap = buildIdColumnMap();
  const idColumn = idColumnMap.get(tableName) ?? 'id';
  let currentLocalSnapshot: DbJson | null;
  try {
    currentLocalSnapshot = getRecordData(db, tableName, recordId, idColumn) as DbJson | null;
  } catch (error) {
    throw new CommandError(`读取当前本地记录失败: ${message(error)}`);
  }
  const recordedLocalRaw = latestConflictSideData(db, tableName, recordId, 'local');
  const recordedCloudRaw = latestConflictSideData(db, tableName, recordId, 'cloud');
  if (recordedCloudRaw === null) {
    throw new CommandError('找不到该冲突的 cloud side 数据');
  }
  const parsedLocalRaw = recordedLocalRaw === null
    ? currentLocalSnapshot
    : parseSnapshot(recordedLocalRaw, '本地');
  const parsedCloudRaw = parseSnapshot(recordedCloudRaw, '云端');
  const localStripped = stripVirtualNoteContent(db, tableName, parsedLocalRaw);
  const cloudStripped = stripVirtualNoteContent(db, tableName, parsedCloudRaw);
  const recordedLocalSnapshot = localStripped.data;
  const recordedCloudSnapshot = cloudStripped.data;

  if (resolution !== 'keep_local') {
    const matches = jsonEquals(currentLocalSnapshot, recordedLocalSnapshot)
      || jsonEquals(currentLocalSnapshot, recordedCloudSnapshot);
    if (!matches) {
      throw new CommandError('本地记录在冲突生成后已再次变化，拒绝用旧冲突覆盖；请重新同步或手动合并');
    }
  }

  let operation: EngineChange['operation'];
  let data: DbJson | null;
  let virtualContentMd: string | null = null;
  switch (resolution) {
    case 'keep_local': {
      const selected = jsonEquals(currentLocalSnapshot, recordedCloudSnapshot)
        && !jsonEquals(currentLocalSnapshot, recordedLocalSnapshot)
        ? recordedLocalSnapshot
        : currentLocalSnapshot;
      operation = selected === null ? 'Delete' : 'Update';
      data = selected;
      virtualContentMd = localStripped.virtualContentMd;
      break;
    }
    case 'keep_cloud':
      operation = recordedCloudSnapshot === null ? 'Delete' : 'Update';
      data = recordedCloudSnapshot;
      virtualContentMd = cloudStripped.virtualContentMd;
      break;
    case 'merged': {
      if (mergedDataJson === null) {
        throw new CommandError("resolution='merged' 时必须提供 merged_data_json");
      }
      let value: DbJson;
      try {
        value = parseJsonLossless(mergedDataJson);
      } catch (error) {
        throw new CommandError(`解析合并后数据失败: ${message(error)}`);
      }
      const mergedStripped = stripVirtualNoteContent(db, tableName, value);
      operation = mergedStripped.data === null ? 'Delete' : 'Update';
      data = mergedStripped.data;
      virtualContentMd = mergedStripped.virtualContentMd;
      break;
    }
    default:
      throw new CommandError(`未知 resolution: ${resolution}`);
  }

  const now = toRfc3339();
  const desiredState = (current: DbJson | null): boolean => {
    if (operation === 'Delete') return current === null;
    if (data === null) return false;
    return current !== null && recordsSemanticallyEqualForSync(current, data);
  };

  if (desiredState(currentLocalSnapshot)) {
    markResolvedWithoutWrite(
      db,
      tableName,
      recordId,
      idColumn,
      resolution,
      expectedIds,
      operation,
      data,
      now,
      virtualContentMd,
      recordedLocalSnapshot,
      recordedCloudSnapshot,
    );
    return;
  }

  if (data !== null && isJsonObject(data) && tableHasColumn(db, tableName, 'updated_at')) {
    const current = data.updated_at;
    data.updated_at = typeof current === 'number' || typeof current === 'bigint'
      ? Date.now()
      : now;
  }

  const change: EngineChange = {
    table_name: tableName,
    record_id: recordId,
    operation,
    data,
    changed_at: now,
    change_log_id: null,
    database_name: databaseName,
    suppress_change_log: false,
    source_device_id: null,
    source_seq: null,
  };

  const historyBatchId = newBatchId();
  const preflightSnapshot = currentLocalSnapshot;
  let tempWriteGrantTokens: string[] = [];
  let applyResult;
  try {
    applyResult = applyDownloadedChangesForceExactWithHooks(
      db,
      [change],
      { deviceId: '', idColumnMap },
      {
        preflight(tx) {
          const latest = getRecordData(tx, tableName, recordId, idColumn) as DbJson | null;
          if (!jsonEquals(latest, preflightSnapshot)) {
            throw new SyncError('Database error: 本地记录在提交冲突决策前发生变化');
          }
          snapshotRecordWithData(tx, historyBatchId, REASON_CONFLICT_RESOLVE, tableName, recordId, latest as never);
          tempWriteGrantTokens = acquireTemporaryNoteWriteGrants(tx, tableName, recordId);
        },
        finalize(tx, result) {
          if (result.success_count === 0) {
            releaseTemporaryNoteWriteGrants(tx, tempWriteGrantTokens);
            throw new SyncError('Database error: 冲突决策未写入任何业务记录');
          }
          if (operation !== 'Delete') {
            ensurePendingChangeLog(tx, tableName, recordId, 'UPDATE', now);
          }
          synchronizePairedNoteAndResource(
            tx,
            tableName,
            recordId,
            resolution,
            now,
            virtualContentMd,
            recordedLocalSnapshot,
            recordedCloudSnapshot,
          );
          releaseTemporaryNoteWriteGrants(tx, tempWriteGrantTokens);
          const latestIds = unresolvedConflictIds(tx, tableName, recordId);
          if (latestIds.length !== expectedIds.length || latestIds.some((id, index) => id !== expectedIds[index])) {
            throw new SyncError('Database error: 冲突 generation 在提交前发生变化');
          }
          for (const conflictId of expectedIds) {
            let updated;
            try {
              updated = markConflictResolved(tx, conflictId, tableName, recordId, now, resolution);
            } catch (error) {
              throw new SyncError(`Database error: 更新冲突状态失败: ${message(error)}`);
            }
            if (updated !== 1) throw new SyncError('Database error: 冲突状态在提交前发生变化');
          }
        },
      },
    );
  } catch (error) {
    throw new CommandError(`写回冲突解决失败: ${message(error)}`);
  }
  if (applyResult.success_count === 0) {
    throw new CommandError('冲突解决未写入任何记录，已拒绝标记为 resolved');
  }
}

function markResolvedWithoutWrite(
  db: DatabaseHandle,
  tableName: string,
  recordId: string,
  idColumn: string,
  resolution: string,
  expectedIds: readonly bigint[],
  operation: EngineChange['operation'],
  data: DbJson | null,
  now: string,
  virtualContentMd: string | null,
  localSnapshot: DbJson | null,
  cloudSnapshot: DbJson | null,
): void {
  try {
    db.transaction(tx => {
      const latestIds = unresolvedConflictIds(tx, tableName, recordId);
      if (latestIds.length !== expectedIds.length || latestIds.some((id, index) => id !== expectedIds[index])) {
        throw new CommandError('冲突已在后台变化，旧决策未执行；请刷新后重新确认');
      }
      const latest = getRecordData(tx, tableName, recordId, idColumn) as DbJson | null;
      const stillDesired = operation === 'Delete'
        ? latest === null
        : data !== null && latest !== null && recordsSemanticallyEqualForSync(latest, data);
      if (!stillDesired) {
        throw new CommandError('本地记录在冲突确认期间已变化，请刷新后重新确认');
      }
      const tempTokens = acquireTemporaryNoteWriteGrants(tx, tableName, recordId);
      try {
        if (operation !== 'Delete') {
          bumpUpdatedAtAndLog(tx, tableName, recordId, now);
        } else {
          ensurePendingChangeLog(tx, tableName, recordId, 'DELETE', now);
        }
        synchronizePairedNoteAndResource(
          tx,
          tableName,
          recordId,
          resolution,
          now,
          virtualContentMd,
          localSnapshot,
          cloudSnapshot,
        );
      } finally {
        releaseTemporaryNoteWriteGrants(tx, tempTokens);
      }
      for (const conflictId of expectedIds) {
        let updated;
        try {
          updated = markConflictResolved(tx, conflictId, tableName, recordId, now, resolution);
        } catch (error) {
          throw new CommandError(`更新冲突状态失败: ${message(error)}`);
        }
        if (updated !== 1) throw new CommandError('冲突状态在提交前发生变化');
      }
    }, { behavior: 'immediate' });
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(`提交冲突标记事务失败: ${message(error)}`);
  }
}

function jsonEquals(left: DbJson | null | undefined, right: DbJson | null | undefined): boolean {
  return dbJsonEquals(left, right);
}

/** commands_sync.rs:5245-5295 `data_governance_rollback_sync_snapshot_batch`。 */
export function rollbackSyncSnapshotBatch(
  storage: StorageService,
  databaseName: string,
  batchId: string,
) {
  const name = databases.find(value => value === databaseName);
  if (!name) throw new CommandError(`未知数据库: ${databaseName}`);
  let db: DatabaseHandle;
  try {
    db = open(storage, name);
  } catch (error) {
    throw new CommandError(`打开数据库 ${databaseName} 失败: ${message(error)}`);
  }
  try {
    let outcome;
    try {
      outcome = rollbackBatch(db, batchId, buildIdColumnMap(), databaseName);
    } catch (error) {
      throw new CommandError(`回退快照批次失败: ${message(error)}`);
    }
    return {
      batch_id: outcome.batch_id,
      restored: outcome.restored,
      deleted: outcome.deleted,
      skipped: outcome.skipped,
      undo_batch_id: outcome.undo_batch_id,
    };
  } finally {
    storage.close(db);
  }
}
