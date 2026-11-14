/**
 * qbank-owned rows that follow an exam sheet's lifecycle.
 *
 * Rust keeps these statements inside `dstu-vfs` (`exam_repo.rs:902-911,1246-1254`,
 * `copy_authoring_entities` at `exam_repo.rs:2115-2175`, `qbank_helpers::retains_asset`),
 * but the tables belong to qbank. L11 calls these through `ctx.qbank.examCascade` with its
 * own savepoint connection (D1), so statement order and transaction boundaries stay the same.
 */
import { nanoid } from 'nanoid';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import { valueFromStr } from '../src/raw-json-number.ts';

/** `exam_repo.rs:2094 remap_entity_references`. */
export function remapEntityReferences(value: JsonValue, ids: ReadonlyMap<string, string>): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) remapEntityReferences(item, ids);
    return;
  }
  const object = value as Record<string, JsonValue>;
  for (const key of Object.keys(object)) {
    const child = object[key]!;
    if (key === 'source_id' || key === 'group_id' || key === 'material_id') {
      if (typeof child === 'string') {
        const mapped = ids.get(child);
        if (mapped !== undefined) object[key] = mapped;
      }
    } else {
      remapEntityReferences(child, ids);
    }
  }
}

/**
 * `exam_repo.rs:2115 copy_authoring_entities`. One map covers sources, materials and groups,
 * and every id is run through all three INSERT ... SELECT statements as in Rust. A
 * `serde_json::from_str` failure on `source_refs_json` propagates as a `SyntaxError` carrying
 * the serde_json Display text; the caller maps it to `VfsError::Serialization`.
 */
export function copyAuthoringEntities(conn: SqlExecutor, src: string, target: string,
  now: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const table of ['qbank_sources', 'qbank_materials', 'qbank_groups'] as const) {
    const prefix = table === 'qbank_sources' ? 'qsource' : table === 'qbank_materials' ? 'qmat' : 'qgroup';
    for (const row of conn.all<{ id: string }>(
      `SELECT id FROM ${table} WHERE exam_id=?1 AND deleted_at IS NULL`, [src])) {
      ids.set(row.id, `${prefix}_${nanoid(16)}`);
    }
  }
  for (const [oldId, newId] of ids) {
    conn.run(`INSERT INTO qbank_sources(id,exam_id,source_key,descriptor_json,created_at,updated_at)
      SELECT ?1,?2,source_key,descriptor_json,?3,?3 FROM qbank_sources WHERE id=?4`,
    [newId, target, now, oldId]);
    conn.run(`INSERT INTO qbank_materials(id,exam_id,content,images_json,source_refs_json,created_at,updated_at)
      SELECT ?1,?2,content,images_json,source_refs_json,?3,?3 FROM qbank_materials WHERE id=?4`,
    [newId, target, now, oldId]);
    conn.run(`INSERT INTO qbank_groups(id,exam_id,label,position,created_at,updated_at)
      SELECT ?1,?2,label,position,?3,?3 FROM qbank_groups WHERE id=?4`,
    [newId, target, now, oldId]);
    const refsRaw = conn.get<{ source_refs_json: string | null }>(
      'SELECT source_refs_json FROM qbank_materials WHERE id=?1', [newId])?.source_refs_json ?? null;
    if (refsRaw !== null) {
      let refs: JsonValue;
      try { refs = valueFromStr(refsRaw); } catch (error) {
        throw new SyntaxError(error instanceof Error ? error.message : String(error));
      }
      remapEntityReferences(refs, ids);
      conn.run('UPDATE qbank_materials SET source_refs_json=?1 WHERE id=?2', [JSON.stringify(refs), newId]);
    }
  }
  for (const row of conn.all<{ group_id: string; material_id: string; position: number }>(
    `SELECT group_id,material_id,position FROM qbank_group_materials
     WHERE exam_id=?1 AND deleted_at IS NULL`, [src])) {
    const group = ids.get(row.group_id);
    const material = ids.get(row.material_id);
    if (group !== undefined && material !== undefined) {
      conn.run(`INSERT INTO qbank_group_materials(id,exam_id,group_id,material_id,position,created_at,updated_at)
        VALUES(?1,?2,?3,?4,?5,?6,?6)`,
      [`qgm_${nanoid(16)}`, target, group, material, row.position, now]);
    }
  }
  return ids;
}

const EXAM_SCOPED = ['qbank_materials', 'qbank_groups', 'qbank_group_materials', 'qbank_papers'] as const;

/** `exam_repo.rs:902-911` without the `questions`/`folder_items` rows, which stay with L11. */
export function softDeleteForExam(conn: SqlExecutor, examId: string, now: string, batch: string): void {
  for (const table of EXAM_SCOPED) {
    conn.run(`UPDATE ${table} SET deleted_at=?1,updated_at=?1,deletion_batch=?3
      WHERE exam_id=?2 AND deleted_at IS NULL`, [now, examId, batch]);
  }
  conn.run(`UPDATE qbank_practice_attempts
    SET deleted_at=?1,updated_at=?1,deletion_batch=?3,local_version=local_version+1
    WHERE scope_id=?2 AND deleted_at IS NULL`, [now, examId, batch]);
}

/** `exam_repo.rs:1246-1254`; Rust binds `deletion_batch=?3`, so a NULL batch restores nothing. */
export function restoreForExam(conn: SqlExecutor, examId: string, now: string, batch: string | null): void {
  for (const table of EXAM_SCOPED) {
    conn.run(`UPDATE ${table} SET deleted_at=NULL,deletion_batch=NULL,updated_at=?1
      WHERE exam_id=?2 AND deletion_batch=?3`, [now, examId, batch]);
  }
  conn.run(`UPDATE qbank_practice_attempts
    SET deleted_at=NULL,deletion_batch=NULL,updated_at=?1,local_version=local_version+1
    WHERE scope_id=?2 AND deletion_batch=?3`, [now, examId, batch]);
}

/** `qbank_helpers.rs:20 retains_asset`. */
export function retainsAsset(conn: SqlExecutor, value: string): boolean {
  for (const table of ['qbank_papers', 'qbank_practice_drafts', 'qbank_practice_attempts']) {
    const exists = Number(conn.pluck<number>(
      "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table]) ?? 0) !== 0;
    if (!exists) continue;
    if (Number(conn.pluck<number>(
      `SELECT EXISTS(SELECT 1 FROM ${table},json_tree(document_json) j WHERE j.key IN ('id','hash') AND j.value=?1)`,
      [value]) ?? 0) !== 0) return true;
    if (Number(conn.pluck<number>(
      `SELECT EXISTS(SELECT 1 FROM ${table},json_each(document_json,'$.answers') a,json_tree(CASE WHEN json_valid(a.value) THEN a.value ELSE '{}' END) j WHERE j.key IN ('id','hash') AND j.value=?1)`,
      [value]) ?? 0) !== 0) return true;
  }
  return false;
}
