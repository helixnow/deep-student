import type { DatabaseHandle, SqlExecutor, SqlParam } from '../../../platform/storage/api.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { serializeSyncChange } from '../src/change-payload.ts';
import { mergeField, fieldMergeColumnsForTable } from '../src/field-merge.ts';
import { ClockDriftSuspectedError, SyncError } from '../src/errors.ts';
import { syncClassificationRegistry } from '../src/classification.ts';
import { MAX_DRIFT_MS } from '../src/hlc.ts';
import { isJsonFloat, isJsonObject, parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import { compareLwwTimestamps, lwwDevicePair, lwwTimestampMillis, timestampValueToLwwString } from '../src/lww.ts';
import { recomputeTodoCompletedPomodorosIfRelevant } from './pomodoro-counts.ts';
import { snapshotRecordWithData } from './history.ts';
import { newBatchId, REASON_POLICY_OVERRIDE } from '../src/history.ts';
import { canonicalizeSyncValueForCompare, getRecordData, recordsSemanticallyEqualForSync, SYNC_FIELD_DELTAS_KEY } from './record-data.ts';
import { saveConflictRecord, ensureConflictTable, resolveOne } from './conflict-resolver.ts';
import {
  buildPrimaryKeyPredicate,
  columnDeclaredType,
  ensureTableAllowedAndExists,
  getTableColumns,
  isLocalDerivedSyncColumn,
  jsonValueToAliasKey,
  jsonValueToSqlParam,
  parseRecordKeyValues,
  pluckSafe,
  primaryKeyColumns,
  quoteIdentifier,
  rowToJson,
  selectWithTypes,
  tableColumnNames,
  tableExists,
  tableHasColumn,
} from './sqlite-values.ts';
import {
  type ApplyChangeFailure,
  type ApplyChangesResult,
  type ApplyContext,
  type NoteHistoryHooks,
  beginApplySavepoint,
  databaseError,
  emptyApplyChangesResult,
  getDefaultNoteHistory,
  keyOf,
  message,
  releaseApplySavepoint,
  rollbackAndReleaseApplySavepoint,
  setDefaultNoteHistory,
  suppressEchoChangeLog,
} from './apply-shared.ts';

export function changesAffectRefCounts(db: SqlExecutor, changes: readonly EngineChange[]): boolean {
  const seen = new Set<string>();
  for (const change of changes) {
    const table = change.table_name;
    if (seen.has(table)) continue;
    seen.add(table);
    if (table === 'resources' || table === 'blobs') return true;
    for (const column of ['resource_id', 'blob_hash', 'compressed_blob_hash', 'image_blob_hash', 'preview_json', 'images_json', 'descriptor_json']) {
      if (tableHasColumn(db, table, column)) return true;
    }
  }
  return false;
}

export function changeLogMaxId(db: SqlExecutor): bigint | null {
  if (!tableExists(db, '__change_log')) return null;
  try {
    return pluckSafe<bigint>(db, 'SELECT COALESCE(MAX(id), 0) FROM __change_log') ?? 0n;
  } catch {
    return null;
  }
}

function userTablesWithColumn(db: SqlExecutor, columnName: string): string[] {
  const tables = db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_%' ESCAPE '\\'",
  ).map(row => row.name);
  return tables.filter(table => tableHasColumn(db, table, columnName));
}

function recomputeResourceRefCounts(db: SqlExecutor): void {
  if (!tableHasColumn(db, 'resources', 'ref_count')) return;
  const subqueries: string[] = [];
  for (const table of userTablesWithColumn(db, 'resource_id')) {
    if (table === 'resources') continue;
    const ident = quoteIdentifier(table);
    const deletedFilter = tableHasColumn(db, table, 'deleted_at') ? ' AND deleted_at IS NULL' : '';
    subqueries.push(`SELECT resource_id AS resource_id FROM ${ident} WHERE resource_id IS NOT NULL${deletedFilter}`);
  }
  try {
    if (subqueries.length === 0) {
      db.run('UPDATE resources SET ref_count = 0 WHERE ref_count IS NOT 0');
      return;
    }
    const refsUnion = subqueries.join(' UNION ALL ');
    db.run(`UPDATE resources
       SET ref_count = rc.cnt
       FROM (
           SELECT resource_id, COUNT(*) AS cnt
           FROM (${refsUnion}) refs
           WHERE refs.resource_id IS NOT NULL
           GROUP BY resource_id
       ) rc
       WHERE resources.id = rc.resource_id
         AND resources.ref_count IS NOT rc.cnt`);
    db.run(`UPDATE resources
       SET ref_count = 0
       WHERE ref_count IS NOT 0
         AND id NOT IN (
             SELECT refs.resource_id FROM (${refsUnion}) refs
             WHERE refs.resource_id IS NOT NULL
         )`);
  } catch (error) {
    databaseError(`重算 resources.ref_count 失败: ${message(error)}`);
  }
}

export function recomputeBlobRefCounts(db: SqlExecutor): void {
  if (!tableHasColumn(db, 'blobs', 'ref_count')) return;
  const subqueries: string[] = [];
  if (tableHasColumn(db, 'files', 'blob_hash')) {
    subqueries.push('SELECT blob_hash AS blob_hash FROM files WHERE blob_hash IS NOT NULL');
  }
  if (tableHasColumn(db, 'files', 'compressed_blob_hash')) {
    // "压缩不划算"路径把 compressed_blob_hash 指向原始 blob_hash 而不额外
    // store_blob(+1)，等值时不得重复计数。
    subqueries.push(`SELECT compressed_blob_hash AS blob_hash FROM files
       WHERE compressed_blob_hash IS NOT NULL
         AND compressed_blob_hash IS NOT blob_hash`);
  }
  if (tableHasColumn(db, 'vfs_index_units', 'image_blob_hash')) {
    subqueries.push(
      'SELECT image_blob_hash AS blob_hash FROM vfs_index_units WHERE image_blob_hash IS NOT NULL',
    );
  }
  // JSON 内嵌 blob 引用必须参与重算，否则仅存在于 JSON 的图片会被清零并
  // 被启动清扫物理删除。json_valid 守卫让非法 JSON 行按无引用处理。
  if (tableHasColumn(db, 'files', 'preview_json')) {
    subqueries.push(`SELECT json_extract(page.value, '$.blob_hash') AS blob_hash
       FROM files, json_each(files.preview_json, '$.pages') AS page
       WHERE files.preview_json IS NOT NULL
         AND json_valid(files.preview_json)
         AND json_extract(page.value, '$.blob_hash') IS NOT NULL
         AND json_extract(page.value, '$.blob_hash') <> ''`);
    subqueries.push(`SELECT json_extract(page.value, '$.compressed_blob_hash') AS blob_hash
       FROM files, json_each(files.preview_json, '$.pages') AS page
       WHERE files.preview_json IS NOT NULL
         AND json_valid(files.preview_json)
         AND json_extract(page.value, '$.compressed_blob_hash') IS NOT NULL
         AND json_extract(page.value, '$.compressed_blob_hash') <> ''
         AND json_extract(page.value, '$.compressed_blob_hash')
             IS NOT json_extract(page.value, '$.blob_hash')`);
  }
  if (tableHasColumn(db, 'exam_sheets', 'preview_json')) {
    subqueries.push(`SELECT json_extract(page.value, '$.blob_hash') AS blob_hash
       FROM exam_sheets, json_each(exam_sheets.preview_json, '$.pages') AS page
       WHERE exam_sheets.preview_json IS NOT NULL
         AND json_valid(exam_sheets.preview_json)
         AND json_extract(page.value, '$.blob_hash') IS NOT NULL
         AND json_extract(page.value, '$.blob_hash') <> ''`);
  }
  if (tableHasColumn(db, 'questions', 'images_json')) {
    subqueries.push(`SELECT json_extract(img.value, '$.hash') AS blob_hash
       FROM questions, json_each(questions.images_json) AS img
       WHERE questions.images_json IS NOT NULL
         AND json_valid(questions.images_json)
         AND json_extract(img.value, '$.hash') IS NOT NULL
         AND json_extract(img.value, '$.hash') <> ''`);
  }
  if (tableHasColumn(db, 'qbank_materials', 'images_json')) {
    subqueries.push(`SELECT ref.value AS blob_hash
       FROM qbank_materials, json_tree(qbank_materials.images_json) AS ref
       WHERE qbank_materials.images_json IS NOT NULL
         AND json_valid(qbank_materials.images_json)
         AND ref.key = 'hash' AND ref.type = 'text'
         AND ref.value IS NOT NULL AND ref.value <> ''`);
  }
  if (tableHasColumn(db, 'qbank_sources', 'descriptor_json')) {
    subqueries.push(`SELECT ref.value AS blob_hash
       FROM qbank_sources, json_tree(qbank_sources.descriptor_json) AS ref
       WHERE qbank_sources.descriptor_json IS NOT NULL
         AND json_valid(qbank_sources.descriptor_json)
         AND ref.key = 'blob_hash' AND ref.type = 'text'
         AND ref.value IS NOT NULL AND ref.value <> ''`);
  }
  if (tableHasColumn(db, 'qbank_import_jobs', 'document_json')) {
    subqueries.push(`SELECT ref.value AS blob_hash
       FROM qbank_import_jobs, json_tree(qbank_import_jobs.document_json) AS ref
       WHERE qbank_import_jobs.status IN ('ready', 'needs_review', 'partial')
         AND json_valid(qbank_import_jobs.document_json)
         AND ref.key = 'hash' AND ref.type = 'text'
         AND ref.value IS NOT NULL AND ref.value <> ''`);
    subqueries.push(`SELECT ref.value AS blob_hash
       FROM qbank_import_jobs, json_tree(qbank_import_jobs.metadata_json) AS ref
       WHERE qbank_import_jobs.status IN ('ready', 'needs_review', 'partial')
         AND json_valid(qbank_import_jobs.metadata_json)
         AND ref.key IN ('blob_hash', 'content_hash') AND ref.type = 'text'
         AND ref.value IS NOT NULL AND ref.value <> ''`);
  }
  if (tableHasColumn(db, 'exam_sheets', 'import_state_json')) {
    subqueries.push(`SELECT ref.value AS blob_hash
       FROM exam_sheets, json_tree(exam_sheets.import_state_json) AS ref
       WHERE exam_sheets.import_state_json IS NOT NULL
         AND json_valid(exam_sheets.import_state_json)
         AND ref.key IN ('blob_hash', 'hash') AND ref.type = 'text' AND ref.value <> ''`);
  }
  for (const table of ['qbank_papers', 'qbank_practice_drafts', 'qbank_practice_attempts']) {
    if (!tableHasColumn(db, table, 'document_json')) continue;
    const ident = quoteIdentifier(table);
    subqueries.push(`SELECT ref.value AS blob_hash FROM ${ident},json_tree(document_json) ref
       WHERE json_valid(document_json) AND ref.key='hash' AND ref.type='text' AND ref.value<>''`);
    subqueries.push(`SELECT ref.value AS blob_hash FROM ${ident},json_each(document_json,'$.answers') a,
       json_tree(CASE WHEN json_valid(a.value) THEN a.value ELSE '{}' END) ref
       WHERE ref.key='hash' AND ref.type='text' AND ref.value<>''`);
  }
  try {
    if (subqueries.length === 0) {
      db.run('UPDATE blobs SET ref_count = 0 WHERE ref_count IS NOT 0');
      return;
    }
    const refsUnion = subqueries.join(' UNION ALL ');
    db.run(`UPDATE blobs
       SET ref_count = rc.cnt
       FROM (
           SELECT blob_hash, COUNT(*) AS cnt
           FROM (${refsUnion}) refs
           WHERE refs.blob_hash IS NOT NULL
           GROUP BY blob_hash
       ) rc
       WHERE blobs.hash = rc.blob_hash
         AND blobs.ref_count IS NOT rc.cnt`);
    db.run(`UPDATE blobs
       SET ref_count = 0
       WHERE ref_count IS NOT 0
         AND hash NOT IN (
             SELECT refs.blob_hash FROM (${refsUnion}) refs
             WHERE refs.blob_hash IS NOT NULL
         )`);
  } catch (error) {
    databaseError(`重算 blobs.ref_count 失败: ${message(error)}`);
  }
}

export function recomputeDerivedRefCountsIfRelevant(db: SqlExecutor, changes: readonly EngineChange[]): void {
  if (!changesAffectRefCounts(db, changes)) return;
  const preLogMax = changeLogMaxId(db);
  recomputeResourceRefCounts(db);
  recomputeBlobRefCounts(db);
  if (preLogMax !== null) {
    try {
      db.run(
        `UPDATE __change_log SET sync_version = ?1
         WHERE id > ?2 AND sync_version = 0 AND table_name IN ('resources', 'blobs')`,
        [Math.floor(Date.now() / 1000), preLogMax],
      );
    } catch { // boundary-allow empty-catch: Rust recompute_derived_ref_counts 对回声抑制 UPDATE 用 `let _ = conn.execute(...)`。
    }
  }
}
