import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { isJsonObject, parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { Hlc } from '../src/hlc.ts';
import { compareLwwTimestamps, lwwTimestampMillis } from '../src/lww.ts';
import { persistIdAlias, resolvePersistedIdAlias } from './apply-id-aliases.ts';
import { getRecordData } from './record-data.ts';
import { jsonValueToSqlParam, quoteIdentifier, tableExists } from './sqlite-values.ts';
import { readUnknownFieldsForRoundTrip, vaultUnknownFieldsWithVersion, type UnknownFieldVersion, type VersionedUnknownField } from './unknown-fields.ts';
import { getV5RowMetaRow, upsertV5ColumnVersion, upsertV5RowMeta } from './v5-runtime-bridge.ts';
import { attachV5ReviewHistory, detachV5ReviewHistory } from './v5-review-history.ts';
import { restoreReviewPlanRevision } from './v5-vaults.ts';

const TABLE = 'review_plans';
type Fields = Record<string, VersionedUnknownField>;
type Versions = Record<string, UnknownFieldVersion>;
interface Member { record_id: string; question_id: string | null; fields_json: string | null }
interface PlanKey { id: string; question_id: string; updated_at: string }
interface RecoveryTarget { record_id: string; question_id: string }
interface RecordedReview { change: EngineChange; versions: Versions }

const compare = (a: UnknownFieldVersion, b: UnknownFieldVersion) => compareLwwTimestamps(a.hlc, a.dev, '', b.hlc, b.dev, '');
const decodeFields = (json: string) => parseJsonLossless(json) as unknown as Fields;

function member(db: SqlExecutor, id: string): Member | undefined {
  return db.get<Member>('SELECT * FROM __sync_v5_review_plan_members WHERE record_id=?', [id]);
}

function localPlan(db: SqlExecutor, questionId: string): PlanKey | undefined {
  return db.get<PlanKey>('SELECT id, question_id, updated_at FROM review_plans WHERE question_id=?', [questionId]);
}

export function hasMaterializedV5ReviewPlan(db: SqlExecutor, id: string): boolean {
  return Boolean(db.get('SELECT 1 FROM review_plans WHERE id=?', [id]));
}

function knownIds(db: SqlExecutor, id: string): string[] {
  if (!tableExists(db, '__sync_id_aliases')) return [id];
  return db.all<{ id: string }>(`WITH RECURSIVE aliases(id) AS (
      SELECT ?1 UNION SELECT remote_id FROM __sync_id_aliases JOIN aliases ON canonical_id=aliases.id WHERE table_name=?2
    ) SELECT id FROM aliases ORDER BY id`, [id, TABLE]).map(row => row.id);
}

/** An explicit delete covers the identities this device had already merged. A legacy delete names only its own ID. */
export function v5ReviewPlanDeleteData(db: SqlExecutor, id: string): DbJson {
  const ids = knownIds(db, id);
  return ids.length > 1 ? { review_plan_ids: ids } : null;
}

function deletedIds(change: EngineChange): Set<string> {
  const supplied = isJsonObject(change.data) ? change.data.review_plan_ids : null;
  return new Set([change.record_id, ...(Array.isArray(supplied) ? supplied.filter((value): value is string => typeof value === 'string') : [])]);
}

function seedExistingPlan(db: SqlExecutor, plan: PlanKey | undefined): void {
  if (!plan || member(db, plan.id)) return;
  const data = getRecordData(db, TABLE, plan.id, 'id');
  if (!isJsonObject(data)) return;
  const meta = getV5RowMetaRow(db, TABLE, plan.id);
  const versions = meta ? parseJsonLossless(meta.col_versions_json) as unknown as Versions : {};
  const opaque = readUnknownFieldsForRoundTrip(db, TABLE, plan.id);
  const bootstrap = { hlc: new Hlc(lwwTimestampMillis(plan.updated_at) ?? 0n, 0).toString(), dev: '' };
  const fields: Fields = Object.create(null);
  for (const [col, value] of Object.entries(data)) if (col !== 'id') fields[col] = { value, ...(versions[col] ?? bootstrap) };
  for (const [col, value] of Object.entries(opaque.values)) {
    if (!Object.hasOwn(data, col)) fields[col] = { value, ...(opaque.fieldDeltas[col] ?? versions[col] ?? bootstrap) };
  }
  writeMember(db, plan.id, plan.question_id, fields);
}

function writeMember(db: SqlExecutor, id: string, questionId: string, fields: Fields | null): void {
  db.run(`INSERT INTO __sync_v5_review_plan_members VALUES(?,?,?)
    ON CONFLICT(record_id) DO UPDATE SET question_id=excluded.question_id,fields_json=excluded.fields_json`,
  [id, questionId, fields && stringifyJsonLossless(fields as unknown as DbJson)]);
}

function mergeFields(fields: Fields, data: Record<string, DbJson>, versions: Versions): boolean {
  let changed = false;
  for (const [col, value] of Object.entries(data)) {
    if (col === 'id') continue;
    const version = versions[col];
    if (!version) throw new TypeError(`列缺少原始版本: ${col}`);
    if (!fields[col] || compare(version, fields[col]!) > 0) {
      fields[col] = { value, ...version };
      changed = true;
    }
  }
  return changed;
}

export function listV5ReviewRecoveryTargets(db: SqlExecutor): RecoveryTarget[] {
  return tableExists(db, '__sync_v5_review_plan_recovery')
    ? db.all<RecoveryTarget>('SELECT record_id,question_id FROM __sync_v5_review_plan_recovery')
    : [];
}

/** Rebuild old aliases from the original operations, without replaying their intermediate business states. */
export function restoreV5ReviewMembers(
  db: SqlExecutor, targets: readonly RecoveryTarget[], recorded: readonly RecordedReview[],
): string[] {
  const questionById = new Map(targets.map(t => [t.record_id, t.question_id]));
  const originals = new Map<string, Fields | null>();
  for (const { change, versions } of recorded) {
    if (change.operation === 'Delete') {
      for (const id of deletedIds(change)) if (questionById.has(id)) originals.set(id, null);
      continue;
    }
    const id = change.record_id;
    const questionId = questionById.get(id);
    if (questionId === undefined || originals.get(id) === null || !isJsonObject(change.data)
        || change.data.question_id !== questionId) continue;
    const fields: Fields = originals.get(id) ?? Object.create(null);
    mergeFields(fields, change.data, versions);
    originals.set(id, fields);
  }
  const completed = new Set(questionById.values());
  for (const [id, questionId] of questionById) {
    const fields = originals.get(id);
    if (fields === undefined || (fields !== null && !['question_id', 'exam_id', 'created_at', 'updated_at', 'next_review_date']
      .every(col => typeof fields[col]?.value === 'string'))) completed.delete(questionId);
  }
  for (const [id, questionId] of questionById) {
    if (completed.has(questionId)) writeMember(db, id, questionId, originals.get(id)!);
  }
  for (const questionId of completed) db.run('DELETE FROM __sync_v5_review_plan_recovery WHERE question_id=?', [questionId]);
  return [...completed];
}

/** Record wire IDs separately from the displayed ID. NULL fields mark a retired ID, which a rating cannot revive. */
export function recordV5ReviewPlanChange(db: SqlExecutor, change: EngineChange, versions: Versions): string[] {
  const id = change.record_id;
  if (change.operation === 'Delete') {
    const questions = new Set<string>();
    for (const target of deletedIds(change)) {
      if (!member(db, target)) {
        seedExistingPlan(db, db.get<PlanKey>('SELECT id, question_id, updated_at FROM review_plans WHERE id=?',
          [resolvePersistedIdAlias(db, TABLE, target)]));
      }
      const previous = member(db, target);
      if (previous?.fields_json === null) continue;
      if (previous?.question_id != null) questions.add(previous.question_id);
      db.run(`INSERT INTO __sync_v5_review_plan_members VALUES(?,?,NULL)
        ON CONFLICT(record_id) DO UPDATE SET fields_json=NULL`, [target, previous?.question_id ?? null]);
    }
    return [...questions];
  }
  if (!isJsonObject(change.data)) return [];
  const known = member(db, id);
  const questionId = known?.question_id ?? change.data.question_id;
  if (known?.fields_json === null || typeof questionId !== 'string') return [];
  seedExistingPlan(db, localPlan(db, questionId));
  const previous = member(db, id);
  if (previous?.fields_json === null) return [];
  if (!previous) {
    const oldId = resolvePersistedIdAlias(db, TABLE, id);
    // Retain a tombstone recorded by a pre-upgrade client.
    if (getV5RowMetaRow(db, TABLE, oldId)?.floor_deleted_hlc && !hasMaterializedV5ReviewPlan(db, oldId)) {
      db.run('INSERT INTO __sync_v5_review_plan_members VALUES(?,?,NULL)', [id, questionId]);
      return [];
    }
  }
  const fields: Fields = Object.assign(Object.create(null), previous ? decodeFields(previous.fields_json!) : {});
  if (!mergeFields(fields, change.data, versions)) return [];
  writeMember(db, id, questionId, fields);
  return [questionId];
}

function clearProjectedRegisters(db: SqlExecutor, id: string): void {
  for (const table of ['__sync_row_meta', '__sync_unknown_fields', '__sync_v5_column_versions']) {
    db.run(`DELETE FROM ${table} WHERE table_name=? AND record_id=?`, [TABLE, id]);
  }
}

/** Materialize the live members as one row. If a member is deleted, another member's schedule can win again. */
export function projectV5ReviewPlan(db: SqlExecutor, databaseName: string, questionId: string): void {
  // If a writer's history is temporarily unavailable, leave the old view
  // intact and finish this question on a later pull. Other questions proceed.
  if (tableExists(db, '__sync_v5_review_plan_recovery')
      && db.get('SELECT 1 FROM __sync_v5_review_plan_recovery WHERE question_id=? LIMIT 1', [questionId])) return;
  const existing = localPlan(db, questionId);
  const members = db.all<{ record_id: string; fields_json: string }>(`SELECT record_id, fields_json FROM __sync_v5_review_plan_members
    WHERE question_id=? AND fields_json IS NOT NULL ORDER BY record_id COLLATE BINARY`, [questionId]);
  if (!members.length) {
    if (existing) {
      detachV5ReviewHistory(db, existing.id);
      db.run('DELETE FROM review_plans WHERE id=?', [existing.id]);
      clearProjectedRegisters(db, existing.id);
    }
    return;
  }

  const id = members[0]!.record_id;
  const fields: Fields = Object.create(null);
  for (const row of members) for (const [col, field] of Object.entries(decodeFields(row.fields_json))) {
    if (!fields[col] || compare(field, fields[col]!) > 0) fields[col] = field;
  }
  const schema = db.all<{ name: string; dflt_value: string | null }>('PRAGMA table_info(review_plans)');
  const known = new Set(schema.map(col => col.name));
  const selected = Object.entries(fields).filter(([col]) => known.has(col));
  const params = selected.map(([col, field]) => {
    const param = jsonValueToSqlParam(field.value);
    if (param === undefined) throw new TypeError(`列无法转换到 SQLite: ${col}`);
    return param;
  });
  if (existing) {
    if (id !== existing.id) {
      // The parent changes ID in place; deleting it would cascade into local history.
      db.exec('PRAGMA defer_foreign_keys = ON');
      db.run('UPDATE review_plans SET id=? WHERE id=?', [id, existing.id]);
      db.run('UPDATE review_history SET plan_id=? WHERE plan_id=?', [id, existing.id]);
      clearProjectedRegisters(db, existing.id);
    }
    const sets = selected.map(([col]) => `${quoteIdentifier(col)}=?`);
    for (const col of schema) if (col.name !== 'id' && !fields[col.name]) {
      sets.push(`${quoteIdentifier(col.name)}=${col.dflt_value ?? 'NULL'}`);
    }
    db.run(`UPDATE review_plans SET ${sets.join(',')} WHERE id=?`, [...params, id]);
    if (typeof fields.updated_at?.value === 'string') restoreReviewPlanRevision(db, id, fields.updated_at.value);
  } else {
    const columns = selected.map(([col]) => quoteIdentifier(col));
    db.run(`INSERT INTO review_plans (id,${columns.join(',')}) VALUES (?,${params.map(() => '?').join(',')})`, [id, ...params]);
  }
  attachV5ReviewHistory(db, questionId, id);

  clearProjectedRegisters(db, id);
  const registers: Versions = Object.create(null);
  const opaque: Fields = Object.create(null);
  for (const [col, { value, ...version }] of Object.entries(fields)) {
    registers[col] = version;
    if (known.has(col)) upsertV5ColumnVersion(db, databaseName, TABLE, id, col, version.hlc, sha256HexSync(stringifyJsonLossless(value)), version.dev);
    else opaque[col] = { value, ...version };
  }
  upsertV5RowMeta(db, TABLE, id, null, null, stringifyJsonLossless(registers as unknown as DbJson));
  vaultUnknownFieldsWithVersion(db, TABLE, id, opaque);

  // Re-electing a surviving ID after a delete must break its old outgoing
  // alias before any other live member is pointed at it.
  if (tableExists(db, '__sync_id_aliases')) {
    db.run(`DELETE FROM __sync_id_aliases WHERE table_name=? AND (
      remote_id=? OR remote_id IN (SELECT record_id FROM __sync_v5_review_plan_members WHERE question_id=? AND fields_json IS NULL)
    )`, [TABLE, id, questionId]);
  }
  for (const row of members.slice(1)) persistIdAlias(db, TABLE, row.record_id, id);
}
