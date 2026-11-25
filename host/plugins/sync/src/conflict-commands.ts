import { fs } from '../src/local-runtime.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { toRfc3339Opts } from '../../../platform/time/index.ts';
import { dirname } from '../../../platform/util/path.ts';
import { CommandError } from '../../../kernel/api.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';
import type { CoordinatedDatabaseName, DatabaseHandle, SqlExecutor, SqlParam, StorageService } from '../../../platform/storage/api.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { syncClassificationRegistry } from '../src/classification.ts';
import { SyncError } from '../src/errors.ts';
import { MAX_DRIFT_MS } from '../src/hlc.ts';
import { lwwTimestampMillis, timestampValueToLwwString } from '../src/lww.ts';
import { newBatchId, REASON_CONFLICT_RESOLVE } from '../src/history.ts';
import type { DbJson } from '../../../platform/util/lossless-json.ts';
import { dbJsonEquals, isJsonObject, parseJsonLossless } from '../../../platform/util/lossless-json.ts';
import { getRecordData, recordsSemanticallyEqualForSync } from '../repository/record-data.ts';
import { applyDownloadedChangesForceExactWithHooks, getDefaultNoteHistory } from '../repository/apply.ts';
import { rollbackBatch, snapshotRecordWithData } from '../repository/history.ts';
import { latestConflictSideData, listUnresolvedConflictIds, markConflictResolved } from '../repository/conflicts.ts';
import { columnDeclaredType, jsonValueToSqlParam, quoteIdentifier, tableExists, tableHasColumn, tableInfo } from '../repository/sqlite-values.ts';

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

function extractEpochMillis(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 100_000_000_000 ? Math.trunc(value) : value >= 1_000_000_000 ? Math.trunc(value * 1000) : null;
  }
  if (typeof value === 'bigint') {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n >= 100_000_000_000 ? Math.trunc(n) : n >= 1_000_000_000 ? Math.trunc(n * 1000) : null;
  }
  const str = timestampValueToLwwString(value);
  if (str === null) return null;
  const parsed = lwwTimestampMillis(str);
  return parsed === null ? null : Number(parsed);
}

function computeResolvedClock(
  db: SqlExecutor,
  tableName: string,
  recordId: string,
  snapshots: ReadonlyArray<DbJson | null | undefined>,
): { now: string; epochMs: number } {
  const wallMs = Date.now();
  let maxObserved = wallMs - 1;
  const observe = (val: unknown): void => {
    const ms = extractEpochMillis(val);
    if (ms !== null && ms > maxObserved) maxObserved = ms;
  };
  for (const snap of snapshots) {
    if (isJsonObject(snap)) {
      observe(snap.updated_at);
      observe(snap.deleted_at);
      if (tableName === 'notes' && typeof snap.resource_id === 'string' && tableExists(db, 'resources') && tableHasColumn(db, 'resources', 'updated_at')) {
        try {
          const resRow = db.get<{ updated_at: unknown }>('SELECT updated_at FROM resources WHERE id = ?1', [snap.resource_id]);
          if (resRow) observe(resRow.updated_at);
        } catch {
          // ignore optional lookup errors
        }
      }
    }
  }
  if (tableName === 'notes' && tableExists(db, 'notes') && tableHasColumn(db, 'notes', 'updated_at')) {
    try {
      const noteRow = db.get<{ updated_at: unknown }>('SELECT updated_at FROM notes WHERE id = ?1', [recordId]);
      if (noteRow) observe(noteRow.updated_at);
    } catch {
      // ignore optional lookup errors
    }
  }
  const epochMs = Math.min(Math.max(wallMs, maxObserved + 1), wallMs + Math.floor(MAX_DRIFT_MS / 2));
  const now = toRfc3339Opts(BigInt(epochMs) * 1_000_000n, 'Millis', true);
  return { now, epochMs };
}

function timestampForColumn(
  tx: SqlExecutor,
  tableName: string,
  columnName: string,
  rfc3339Now: string,
  epochMs: number,
  sampleValue?: unknown,
): string | number {
  const declared = columnDeclaredType(tx, tableName, columnName);
  if (declared !== null && declared.toUpperCase().includes('INT')) return epochMs;
  if ((declared === null || declared.trim() === '') && (typeof sampleValue === 'number' || typeof sampleValue === 'bigint')) {
    return epochMs;
  }
  return rfc3339Now;
}

function bumpUpdatedAtAndLog(
  tx: SqlExecutor,
  tableName: string,
  recordId: string,
  now: string,
  epochMs = Date.now(),
): void {
  if (!tableExists(tx, tableName)) return;
  if (tableHasColumn(tx, tableName, 'updated_at')) {
    try {
      const sample = tx.get<{ updated_at: unknown }>(
        `SELECT updated_at FROM ${quoteIdentifier(tableName)} WHERE id = ?1`,
        [recordId],
      );
      if (sample !== undefined) {
        const nextVal = timestampForColumn(tx, tableName, 'updated_at', now, epochMs, sample.updated_at);
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

function formatConflictCopyDate(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  return iso.slice(0, 10);
}

function appendConflictCopyLabel(base: string, dateStr: string, disambiguator: string): string {
  const tag = `(本地冲突副本 ${dateStr})`;
  const trimmed = base.trim();
  if (!trimmed) return `本地冲突副本 ${dateStr} (${disambiguator})`;
  if (trimmed.includes(tag)) return `${trimmed} (${disambiguator})`;
  return `${trimmed} ${tag}`;
}

function isCompositePrimaryKeyTable(tableName: string): boolean {
  for (const entry of syncClassificationRegistry()) {
    if (entry.table_name === tableName) {
      const pk = rustTrim(entry.primary_key);
      return pk === '' || pk === '(virtual)' || pk.includes(',');
    }
  }
  return false;
}

function insertClonedTableRow(
  tx: SqlExecutor,
  tableName: string,
  rowObj: Record<string, DbJson>,
  idColumn: string,
  cloneId: string,
  now: string,
  epochMs: number,
): void {
  const cols = tableInfo(tx, tableName);
  const insertCols: string[] = [];
  const insertVals: SqlParam[] = [];
  for (const col of cols) {
    const colName = col.name;
    let rawVal: DbJson | undefined;
    if (colName === idColumn) {
      rawVal = cloneId;
    } else if (colName === 'created_at') {
      rawVal = timestampForColumn(tx, tableName, 'created_at', now, epochMs, rowObj.created_at);
    } else if (colName === 'updated_at') {
      rawVal = timestampForColumn(tx, tableName, 'updated_at', now, epochMs, rowObj.updated_at);
    } else if (colName === 'deleted_at') {
      rawVal = null;
    } else if (Object.hasOwn(rowObj, colName)) {
      rawVal = rowObj[colName];
    } else {
      continue;
    }
    insertCols.push(quoteIdentifier(colName));
    insertVals.push(jsonValueToSqlParam(rawVal ?? null) ?? null);
  }
  if (insertCols.length === 0) {
    throw new SyncError(`Database error: 无法克隆表 ${tableName} 的记录（无可用列）`);
  }
  const placeholders = insertVals.map((_, idx) => `?${idx + 1}`).join(', ');
  tx.run(
    `INSERT INTO ${quoteIdentifier(tableName)} (${insertCols.join(', ')}) VALUES (${placeholders})`,
    insertVals,
  );
  ensurePendingChangeLog(tx, tableName, cloneId, 'INSERT', now);
}

function cloneNoteAuxiliaryRows(
  tx: SqlExecutor,
  sourceNoteId: string,
  cloneNoteId: string,
  now: string,
  epochMs: number,
): void {
  if (tableExists(tx, 'folder_items')) {
    const hasDeletedAt = tableHasColumn(tx, 'folder_items', 'deleted_at');
    const whereClause = hasDeletedAt
      ? "WHERE item_type = 'note' AND item_id = ?1 AND deleted_at IS NULL"
      : "WHERE item_type = 'note' AND item_id = ?1";
    const mounts = tx.all<Record<string, unknown>>(
      `SELECT * FROM folder_items ${whereClause}`,
      [sourceNoteId],
    );
    for (const mount of mounts) {
      const mountObj: Record<string, DbJson> = {};
      for (const [k, v] of Object.entries(mount)) {
        mountObj[k] = (v ?? null) as DbJson;
      }
      mountObj.item_id = cloneNoteId;
      const cloneMountId = globalThis.crypto.randomUUID();
      insertClonedTableRow(tx, 'folder_items', mountObj, 'id', cloneMountId, now, epochMs);
    }
  }
  if (tableExists(tx, 'note_document_formats')) {
    const fmt = tx.get<Record<string, unknown>>(
      'SELECT * FROM note_document_formats WHERE note_id = ?1',
      [sourceNoteId],
    );
    if (fmt) {
      const fmtObj: Record<string, DbJson> = {};
      for (const [k, v] of Object.entries(fmt)) {
        fmtObj[k] = (v ?? null) as DbJson;
      }
      insertClonedTableRow(tx, 'note_document_formats', fmtObj, 'note_id', cloneNoteId, now, epochMs);
    }
  }
  if (tableHasColumn(tx, 'note_document_revisions', 'version_id')) {
    try {
      getDefaultNoteHistory()?.snapshotNotes?.(tx, [cloneNoteId], 'remote_sync');
    } catch {
      // optional note history hook
    }
  }
}

function captureLocalNoteBodyBeforeOverwrite(
  tx: SqlExecutor,
  tableName: string,
  recordId: string,
  localVirtualContentMd: string | null,
  localSnapshot: DbJson | null,
  cloudSnapshot: DbJson | null,
): { body: string | null; isRawResourceData: boolean } {
  if (tableName !== 'notes') return { body: null, isRawResourceData: false };
  if (localVirtualContentMd !== null) {
    return { body: localVirtualContentMd, isRawResourceData: false };
  }
  if (!tableExists(tx, 'resources')) return { body: null, isRawResourceData: false };
  const localResId = isJsonObject(localSnapshot) && typeof localSnapshot.resource_id === 'string'
    ? localSnapshot.resource_id
    : null;
  const cloudResId = isJsonObject(cloudSnapshot) && typeof cloudSnapshot.resource_id === 'string'
    ? cloudSnapshot.resource_id
    : null;
  const currentNote = tx.get<{ resource_id: string | null }>('SELECT resource_id FROM notes WHERE id = ?1', [recordId]);
  const targetResId = typeof currentNote?.resource_id === 'string' ? currentNote.resource_id : null;
  const candidates = [...new Set([localResId, targetResId, cloudResId].filter((id): id is string => Boolean(id)))];
  for (const candidateId of candidates) {
    const rawRes = latestConflictSideData(tx, 'resources', candidateId, 'local');
    if (rawRes !== null) {
      try {
        const extracted = extractNoteContentFromResource(parseJsonLossless(rawRes));
        if (extracted !== null) return { body: extracted, isRawResourceData: true };
      } catch {
        // ignore unparseable conflict snapshot
      }
    }
  }
  const fallbackResId = localResId ?? targetResId;
  if (fallbackResId) {
    const resRow = tx.get<{ data: unknown }>('SELECT data FROM resources WHERE id = ?1', [fallbackResId]);
    if (typeof resRow?.data === 'string') {
      return { body: resRow.data, isRawResourceData: true };
    }
  }
  return { body: null, isRawResourceData: false };
}

function captureLocalLinkedNoteConflictBeforeOverwrite(
  tx: SqlExecutor,
  tableName: string,
  recordId: string,
): Record<string, DbJson> | null {
  if (tableName !== 'resources' || !tableExists(tx, 'notes')) return null;
  const linkedNote = tx.get<{ id: string }>('SELECT id FROM notes WHERE resource_id = ?1', [recordId]);
  if (!linkedNote?.id) return null;
  const rawLocalNote = latestConflictSideData(tx, 'notes', linkedNote.id, 'local');
  if (!rawLocalNote) return null;
  try {
    const parsed = parseJsonLossless(rawLocalNote);
    if (isJsonObject(parsed)) return parsed;
  } catch {
    // ignore unparseable conflict snapshot
  }
  return null;
}

function createLocalConflictCopy(
  tx: SqlExecutor,
  tableName: string,
  recordId: string,
  idColumn: string,
  now: string,
  epochMs: number,
  recordedLocalSnapshot: Record<string, DbJson>,
  capturedLocalNoteBody: { body: string | null; isRawResourceData: boolean },
  capturedLocalLinkedNote: Record<string, DbJson> | null,
): void {
  const dateStr = formatConflictCopyDate(epochMs);
  const cloneId = globalThis.crypto.randomUUID();
  const shortTag = cloneId.slice(0, 4);

  if (tableName === 'notes') {
    const clonedNote: Record<string, DbJson> = { ...recordedLocalSnapshot };
    clonedNote.title = appendConflictCopyLabel(
      typeof recordedLocalSnapshot.title === 'string' ? recordedLocalSnapshot.title : '',
      dateStr,
      shortTag,
    );
    if (tableExists(tx, 'resources') && tableHasColumn(tx, 'notes', 'resource_id')) {
      const cloneResId = globalThis.crypto.randomUUID();
      const origResId = typeof recordedLocalSnapshot.resource_id === 'string'
        ? recordedLocalSnapshot.resource_id
        : null;
      const origResRow = origResId
        ? tx.get<Record<string, unknown>>('SELECT * FROM resources WHERE id = ?1', [origResId])
        : undefined;
      const rawBody = capturedLocalNoteBody.body ?? '';
      const finalResData = capturedLocalNoteBody.isRawResourceData
        ? rawBody
        : encodeResourceDataPreservingShape(origResRow?.data, rawBody);
      const nextHash = createHasherSync('SHA-256').update(`${cloneId}\0${finalResData}`).digestHex();
      const clonedRes: Record<string, DbJson> = {};
      if (origResRow) {
        for (const [k, v] of Object.entries(origResRow)) {
          clonedRes[k] = (v ?? null) as DbJson;
        }
      }
      clonedRes.id = cloneResId;
      clonedRes.hash = nextHash;
      clonedRes.type = typeof clonedRes.type === 'string' && clonedRes.type ? clonedRes.type : 'note';
      clonedRes.source_id = cloneId;
      clonedRes.source_table = 'notes';
      clonedRes.data = finalResData;
      insertClonedTableRow(tx, 'resources', clonedRes, 'id', cloneResId, now, epochMs);
      clonedNote.resource_id = cloneResId;
    }
    insertClonedTableRow(tx, 'notes', clonedNote, idColumn, cloneId, now, epochMs);
    cloneNoteAuxiliaryRows(tx, recordId, cloneId, now, epochMs);
    return;
  }

  if (tableName === 'resources') {
    const linkedNote = tableExists(tx, 'notes')
      ? tx.get<Record<string, unknown>>('SELECT * FROM notes WHERE resource_id = ?1', [recordId])
      : undefined;
    const localDataStr = typeof recordedLocalSnapshot.data === 'string' ? recordedLocalSnapshot.data : '';
    if (linkedNote && typeof linkedNote.id === 'string') {
      const cloneNoteId = globalThis.crypto.randomUUID();
      const cloneResId = cloneId;
      const nextHash = createHasherSync('SHA-256').update(`${cloneNoteId}\0${localDataStr}`).digestHex();
      const clonedRes: Record<string, DbJson> = {
        ...recordedLocalSnapshot,
        id: cloneResId,
        hash: nextHash,
        source_id: cloneNoteId,
        source_table: 'notes',
      };
      insertClonedTableRow(tx, 'resources', clonedRes, 'id', cloneResId, now, epochMs);

      const baseNote: Record<string, DbJson> = {};
      for (const [k, v] of Object.entries(linkedNote)) {
        baseNote[k] = (v ?? null) as DbJson;
      }
      if (capturedLocalLinkedNote) {
        for (const [k, v] of Object.entries(capturedLocalLinkedNote)) {
          if (k !== 'content_md') baseNote[k] = v;
        }
      }
      baseNote.id = cloneNoteId;
      baseNote.resource_id = cloneResId;
      baseNote.title = appendConflictCopyLabel(
        typeof baseNote.title === 'string' ? baseNote.title : '',
        dateStr,
        shortTag,
      );
      insertClonedTableRow(tx, 'notes', baseNote, 'id', cloneNoteId, now, epochMs);
      cloneNoteAuxiliaryRows(tx, linkedNote.id, cloneNoteId, now, epochMs);
      return;
    }

    const nextHash = createHasherSync('SHA-256').update(`${cloneId}\0${localDataStr}`).digestHex();
    const clonedRes: Record<string, DbJson> = {
      ...recordedLocalSnapshot,
      id: cloneId,
      hash: nextHash,
    };
    insertClonedTableRow(tx, 'resources', clonedRes, idColumn, cloneId, now, epochMs);
    return;
  }

  const copy: Record<string, DbJson> = { ...recordedLocalSnapshot };
  if (tableName === 'anki_cards') {
    if (typeof copy.text === 'string' && copy.text.trim().length > 0) {
      copy.text = appendConflictCopyLabel(copy.text, dateStr, shortTag);
      if (typeof copy.front === 'string' && copy.front.trim().length > 0) {
        copy.front = appendConflictCopyLabel(copy.front, dateStr, shortTag);
      }
    } else if (typeof copy.front === 'string') {
      copy.front = appendConflictCopyLabel(copy.front, dateStr, shortTag);
    } else if (typeof copy.back === 'string') {
      copy.back = appendConflictCopyLabel(copy.back, dateStr, shortTag);
    }
    insertClonedTableRow(tx, 'anki_cards', copy, idColumn, cloneId, now, epochMs);
    return;
  }

  if (tableName === 'questions') {
    if (Object.hasOwn(copy, 'source_key')) copy.source_key = null;
    if (typeof copy.question_label === 'string' && copy.question_label.trim().length > 0) {
      copy.question_label = appendConflictCopyLabel(copy.question_label, dateStr, shortTag);
    } else if (typeof copy.content === 'string') {
      copy.content = appendConflictCopyLabel(copy.content, dateStr, shortTag);
    } else if (typeof copy.title === 'string') {
      copy.title = appendConflictCopyLabel(copy.title, dateStr, shortTag);
    }
    insertClonedTableRow(tx, 'questions', copy, idColumn, cloneId, now, epochMs);
    return;
  }

  if (tableName === 'mistakes') {
    if (Object.hasOwn(copy, 'irec_card_id')) copy.irec_card_id = null;
    if (typeof copy.mistake_summary === 'string' && copy.mistake_summary.trim().length > 0) {
      copy.mistake_summary = appendConflictCopyLabel(copy.mistake_summary, dateStr, shortTag);
    } else if (typeof copy.user_question === 'string') {
      copy.user_question = appendConflictCopyLabel(copy.user_question, dateStr, shortTag);
    } else if (typeof copy.title === 'string') {
      copy.title = appendConflictCopyLabel(copy.title, dateStr, shortTag);
    }
    insertClonedTableRow(tx, 'mistakes', copy, idColumn, cloneId, now, epochMs);
    return;
  }

  const labelColumns = ['title', 'name', 'file_name', 'front', 'text', 'user_question', 'content', 'question_label', 'label'];
  for (const col of labelColumns) {
    if (typeof copy[col] === 'string' && (copy[col] as string).trim().length > 0) {
      copy[col] = appendConflictCopyLabel(copy[col] as string, dateStr, shortTag);
      break;
    }
  }
  insertClonedTableRow(tx, tableName, copy, idColumn, cloneId, now, epochMs);
}

function synchronizePairedNoteAndResource(
  tx: SqlExecutor,
  tableName: string,
  recordId: string,
  resolution: string,
  now: string,
  epochMs: number,
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
      if (bodyToWrite === null && (resolution === 'keep_cloud' || resolution === 'keep_local' || resolution === 'keep_both')) {
        const side = resolution === 'keep_local' ? 'local' : 'cloud';
        const candidates = resolution === 'keep_local'
          ? [localResId, targetResId, cloudResId]
          : [cloudResId, targetResId, localResId];
        for (const candidateId of candidates) {
          if (!candidateId) continue;
          const rawRes = latestConflictSideData(tx, 'resources', candidateId, side);
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
        const nextHash = createHasherSync('SHA-256').update(`${recordId}\0${bodyToWrite}`).digestHex();
        if (existingRes) {
          const nextData = encodeResourceDataPreservingShape(existingRes.data, bodyToWrite);
          const assignments: string[] = ['data = ?1'];
          const params: SqlParam[] = [nextData];
          if (tableHasColumn(tx, 'resources', 'hash')) {
            params.push(nextHash);
            assignments.push(`hash = ?${params.length}`);
          }
          if (tableHasColumn(tx, 'resources', 'updated_at')) {
            params.push(timestampForColumn(tx, 'resources', 'updated_at', now, epochMs));
            assignments.push(`updated_at = ?${params.length}`);
          }
          if (tableHasColumn(tx, 'resources', 'deleted_at')) {
            assignments.push('deleted_at = NULL');
          }
          params.push(targetResId);
          tx.run(`UPDATE resources SET ${assignments.join(', ')} WHERE id = ?${params.length}`, params);
          ensurePendingChangeLog(tx, 'resources', targetResId, 'UPDATE', now);
        } else {
          const resCols = new Set(tableInfo(tx, 'resources').map(c => c.name));
          const insertCols: string[] = ['id'];
          const insertVals: SqlParam[] = [targetResId];
          const pushCol = (col: string, val: SqlParam): void => {
            if (!resCols.has(col)) return;
            insertCols.push(quoteIdentifier(col));
            insertVals.push(val);
          };
          pushCol('hash', nextHash);
          pushCol('type', 'note');
          pushCol('source_id', recordId);
          pushCol('source_table', 'notes');
          pushCol('data', bodyToWrite);
          pushCol('created_at', timestampForColumn(tx, 'resources', 'created_at', now, epochMs));
          pushCol('updated_at', timestampForColumn(tx, 'resources', 'updated_at', now, epochMs));
          const placeholders = insertVals.map((_, idx) => `?${idx + 1}`).join(', ');
          tx.run(`INSERT INTO resources (${insertCols.join(', ')}) VALUES (${placeholders})`, insertVals);
          ensurePendingChangeLog(tx, 'resources', targetResId, 'INSERT', now);
        }
        if (tableHasColumn(tx, 'note_document_revisions', 'version_id')) {
          try {
            getDefaultNoteHistory()?.snapshotNotes?.(tx, [recordId], 'remote_sync');
            if (tableExists(tx, 'note_document_formats')) {
              const fmtExists = Boolean(tx.pluck('SELECT EXISTS(SELECT 1 FROM note_document_formats WHERE note_id = ?1)', [recordId]));
              if (fmtExists) ensurePendingChangeLog(tx, 'note_document_formats', recordId, 'UPDATE', now);
            }
          } catch {
            // optional note history sync hook
          }
        }
      } else if (existingRes) {
        bumpUpdatedAtAndLog(tx, 'resources', targetResId, now, epochMs);
        if (tableExists(tx, 'note_document_formats')) {
          const fmtExists = Boolean(tx.pluck('SELECT EXISTS(SELECT 1 FROM note_document_formats WHERE note_id = ?1)', [recordId]));
          if (fmtExists) ensurePendingChangeLog(tx, 'note_document_formats', recordId, 'UPDATE', now);
        }
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
      bumpUpdatedAtAndLog(tx, 'notes', note.id, now, epochMs);
      if (resolution === 'keep_local' || resolution === 'keep_cloud' || resolution === 'merged' || resolution === 'keep_both') {
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
    case 'keep_both': {
      if (!isJsonObject(recordedLocalSnapshot) || !isJsonObject(recordedCloudSnapshot)) {
        throw new CommandError('仅当本地与云端均存在记录内容时才支持保留两者');
      }
      if (isCompositePrimaryKeyTable(tableName)) {
        throw new CommandError('当前记录类型不支持保留两者，请选择保留本地、采用云端或手动合并');
      }
      operation = 'Update';
      data = recordedCloudSnapshot;
      virtualContentMd = cloudStripped.virtualContentMd;
      break;
    }
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

  const { now, epochMs } = computeResolvedClock(db, tableName, recordId, [
    currentLocalSnapshot,
    recordedLocalSnapshot,
    recordedCloudSnapshot,
    data,
  ]);
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
      epochMs,
      virtualContentMd,
      localStripped.virtualContentMd,
      recordedLocalSnapshot,
      recordedCloudSnapshot,
    );
    return;
  }

  if (data !== null && isJsonObject(data) && tableHasColumn(db, tableName, 'updated_at')) {
    const current = data.updated_at;
    data.updated_at = timestampForColumn(db, tableName, 'updated_at', now, epochMs, current);
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
  let capturedLocalNoteBody: { body: string | null; isRawResourceData: boolean } = { body: null, isRawResourceData: false };
  let capturedLocalLinkedNote: Record<string, DbJson> | null = null;
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
          if (resolution === 'keep_both') {
            capturedLocalNoteBody = captureLocalNoteBodyBeforeOverwrite(
              tx,
              tableName,
              recordId,
              localStripped.virtualContentMd,
              recordedLocalSnapshot,
              recordedCloudSnapshot,
            );
            capturedLocalLinkedNote = captureLocalLinkedNoteConflictBeforeOverwrite(tx, tableName, recordId);
          }
          snapshotRecordWithData(tx, historyBatchId, REASON_CONFLICT_RESOLVE, tableName, recordId, latest as never);
          tempWriteGrantTokens = acquireTemporaryNoteWriteGrants(tx, tableName, recordId);
          // If resolving a notes conflict selects a resource_id whose resources row was deferred/missing
          // locally, materialize it before notes upsert so FK checks pass atomically.
          if (
            tableName === 'notes'
            && operation !== 'Delete'
            && isJsonObject(data)
            && typeof data.resource_id === 'string'
            && tableExists(tx, 'resources')
          ) {
            const targetResId = data.resource_id;
            const exists = Boolean(tx.pluck('SELECT EXISTS(SELECT 1 FROM resources WHERE id = ?1)', [targetResId]));
            if (!exists) {
              let body = virtualContentMd;
              if (body === null) {
                const rawRes = latestConflictSideData(tx, 'resources', targetResId, resolution === 'keep_local' ? 'local' : 'cloud');
                if (rawRes !== null) {
                  try {
                    body = extractNoteContentFromResource(parseJsonLossless(rawRes));
                  } catch {
                    // ignore unparseable conflict snapshot
                  }
                }
              }
              const initialBody = body ?? '';
              const nextHash = createHasherSync('SHA-256').update(`${recordId}\0${initialBody}`).digestHex();
              const resCols = new Set(tableInfo(tx, 'resources').map(c => c.name));
              const insertCols: string[] = ['id'];
              const insertVals: SqlParam[] = [targetResId];
              const pushCol = (col: string, val: SqlParam): void => {
                if (!resCols.has(col)) return;
                insertCols.push(quoteIdentifier(col));
                insertVals.push(val);
              };
              pushCol('hash', nextHash);
              pushCol('type', 'note');
              pushCol('source_id', recordId);
              pushCol('source_table', 'notes');
              pushCol('data', initialBody);
              pushCol('created_at', timestampForColumn(tx, 'resources', 'created_at', now, epochMs));
              pushCol('updated_at', timestampForColumn(tx, 'resources', 'updated_at', now, epochMs));
              const placeholders = insertVals.map((_, idx) => `?${idx + 1}`).join(', ');
              tx.run(`INSERT INTO resources (${insertCols.join(', ')}) VALUES (${placeholders})`, insertVals);
              ensurePendingChangeLog(tx, 'resources', targetResId, 'INSERT', now);
            }
          }
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
            epochMs,
            virtualContentMd,
            recordedLocalSnapshot,
            recordedCloudSnapshot,
          );
          if (resolution === 'keep_both' && isJsonObject(recordedLocalSnapshot)) {
            createLocalConflictCopy(
              tx,
              tableName,
              recordId,
              idColumn,
              now,
              epochMs,
              recordedLocalSnapshot,
              capturedLocalNoteBody,
              capturedLocalLinkedNote,
            );
          }
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
  epochMs: number,
  virtualContentMd: string | null,
  localVirtualContentMd: string | null,
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
      const capturedLocalNoteBody = resolution === 'keep_both'
        ? captureLocalNoteBodyBeforeOverwrite(
            tx,
            tableName,
            recordId,
            localVirtualContentMd,
            localSnapshot,
            cloudSnapshot,
          )
        : { body: null, isRawResourceData: false };
      const capturedLocalLinkedNote = resolution === 'keep_both'
        ? captureLocalLinkedNoteConflictBeforeOverwrite(tx, tableName, recordId)
        : null;
      if (resolution === 'keep_both') {
        snapshotRecordWithData(tx, newBatchId(), REASON_CONFLICT_RESOLVE, tableName, recordId, latest as never);
      }
      const tempTokens = acquireTemporaryNoteWriteGrants(tx, tableName, recordId);
      try {
        if (operation !== 'Delete') {
          bumpUpdatedAtAndLog(tx, tableName, recordId, now, epochMs);
        } else {
          ensurePendingChangeLog(tx, tableName, recordId, 'DELETE', now);
        }
        synchronizePairedNoteAndResource(
          tx,
          tableName,
          recordId,
          resolution,
          now,
          epochMs,
          virtualContentMd,
          localSnapshot,
          cloudSnapshot,
        );
        if (resolution === 'keep_both' && isJsonObject(localSnapshot)) {
          createLocalConflictCopy(
            tx,
            tableName,
            recordId,
            idColumn,
            now,
            epochMs,
            localSnapshot,
            capturedLocalNoteBody,
            capturedLocalLinkedNote,
          );
        }
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
