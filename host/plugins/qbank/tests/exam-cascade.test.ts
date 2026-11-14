/**
 * Owner methods L11 calls from exam_repo copy / delete / restore (D1 `*WithConn`).
 * Rust: `exam_repo.rs:902-911,1246-1254,2094-2175`. Called through the published
 * `ctx.qbank.examCascade` service on the real migrated VFS schema.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createMigratedStorage } from './support/storage.ts';
import qbank from '../index.ts';
import vfsRepos from '../../vfs-repos/index.ts';

const NOW = '2026-01-01T00:00:00+00:00';

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-exam-cascade-');
  const host = await createTestHost({ plugins: [vfsRepos, qbank], provide: {
    storage,
    paths: createPaths({ dataDir: base, platform: 'linux', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
  } });
  const db = storage.database('vfs');
  for (const id of ['exam_src', 'exam_dst']) {
    db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
      VALUES (?1, ?1, 'completed', ?1, '{}', '{}', ?2, ?2)`, [id, NOW]);
  }
  return {
    db, cascade: host.ctx.qbank.examCascade,
    async dispose() { await host.dispose(); storage.dispose(); fs.rmSync(base, { recursive: true, force: true }); },
  };
}

describe('exam_repo.rs qbank cascade via ctx.qbank.examCascade', () => {
  it('copy_authoring_entities_maps_every_live_entity_and_remaps_source_refs', async () => {
    const f = await fixture();
    try {
      f.db.run(`INSERT INTO qbank_sources(id,exam_id,source_key,descriptor_json,created_at,updated_at)
        VALUES('src_1','exam_src','k1','{"pages":[]}',?1,?1)`, [NOW]);
      f.db.run(`INSERT INTO qbank_materials(id,exam_id,content,images_json,source_refs_json,created_at,updated_at)
        VALUES('mat_1','exam_src','材料','[]','[{"source_id":"src_1","page":2,"nested":{"group_id":"grp_1"}},{"source_id":"other"}]',?1,?1)`, [NOW]);
      f.db.run(`INSERT INTO qbank_materials(id,exam_id,content,created_at,updated_at,deleted_at)
        VALUES('mat_dead','exam_src','gone',?1,?1,?1)`, [NOW]);
      f.db.run(`INSERT INTO qbank_groups(id,exam_id,label,position,created_at,updated_at)
        VALUES('grp_1','exam_src','组',3,?1,?1)`, [NOW]);
      f.db.run(`INSERT INTO qbank_group_materials(id,exam_id,group_id,material_id,position,created_at,updated_at)
        VALUES('gm_1','exam_src','grp_1','mat_1',5,?1,?1)`, [NOW]);

      const ids = f.db.transaction(tx => f.cascade.copyAuthoringEntitiesWithConn(tx, 'exam_src', 'exam_dst', NOW));
      expect([...ids.keys()].sort()).toEqual(['grp_1', 'mat_1', 'src_1']);
      expect(ids.get('src_1')).toMatch(/^qsource_[A-Za-z0-9_-]{16}$/);
      expect(ids.get('mat_1')).toMatch(/^qmat_[A-Za-z0-9_-]{16}$/);
      expect(ids.get('grp_1')).toMatch(/^qgroup_[A-Za-z0-9_-]{16}$/);

      const source = f.db.get<{ exam_id: string; source_key: string; created_at: string }>(
        'SELECT exam_id, source_key, created_at FROM qbank_sources WHERE id=?1', [ids.get('src_1')!]);
      expect(source).toEqual({ exam_id: 'exam_dst', source_key: 'k1', created_at: NOW });
      const material = f.db.get<{ content: string; source_refs_json: string }>(
        'SELECT content, source_refs_json FROM qbank_materials WHERE id=?1', [ids.get('mat_1')!]);
      expect(material!.content).toBe('材料');
      expect(JSON.parse(material!.source_refs_json)).toEqual([
        { source_id: ids.get('src_1'), page: 2, nested: { group_id: ids.get('grp_1') } },
        { source_id: 'other' },
      ]);
      const group = f.db.get<{ label: string; position: number }>(
        'SELECT label, position FROM qbank_groups WHERE id=?1', [ids.get('grp_1')!]);
      expect(group).toEqual({ label: '组', position: 3 });
      const link = f.db.get<{ id: string; group_id: string; material_id: string; position: number }>(
        "SELECT id, group_id, material_id, position FROM qbank_group_materials WHERE exam_id='exam_dst'");
      expect(link).toMatchObject({ group_id: ids.get('grp_1'), material_id: ids.get('mat_1'), position: 5 });
      expect(link!.id).toMatch(/^qgm_[A-Za-z0-9_-]{16}$/);
      // The deleted material is not copied; source rows stay untouched.
      expect(f.db.pluck<number>("SELECT COUNT(*) FROM qbank_materials WHERE exam_id='exam_dst'")).toBe(1);
      expect(f.db.pluck<string>("SELECT source_refs_json FROM qbank_materials WHERE id='mat_1'"))
        .toContain('"src_1"');
    } finally { await f.dispose(); }
  });

  it('copy_authoring_entities_propagates_invalid_source_refs_json_and_rolls_back_with_the_caller', async () => {
    const f = await fixture();
    try {
      f.db.run(`INSERT INTO qbank_materials(id,exam_id,content,source_refs_json,created_at,updated_at)
        VALUES('mat_bad','exam_src','x','not json',?1,?1)`, [NOW]);
      expect(() => f.db.transaction(tx =>
        f.cascade.copyAuthoringEntitiesWithConn(tx, 'exam_src', 'exam_dst', NOW))).toThrow(SyntaxError);
      expect(f.db.pluck<number>("SELECT COUNT(*) FROM qbank_materials WHERE exam_id='exam_dst'")).toBe(0);
    } finally { await f.dispose(); }
  });

  // exam_repo.rs:2151-2155：serde_json::from_str::<Value>（arbitrary_precision + preserve_order）→ remap →
  // to_string，数字原文与键序不变；解析错误为 serde_json Display（VfsError::Serialization）。
  it('copy_authoring_entities_keeps_rust_written_source_ref_numbers_verbatim', async () => {
    const f = await fixture();
    try {
      f.db.run(`INSERT INTO qbank_sources(id,exam_id,source_key,descriptor_json,created_at,updated_at)
        VALUES('src_1','exam_src','k1','{"pages":[]}',?1,?1)`, [NOW]);
      f.db.run(`INSERT INTO qbank_materials(id,exam_id,content,images_json,source_refs_json,created_at,updated_at)
        VALUES('mat_1','exam_src','材料','[]',?2,?1,?1)`,
      [NOW, '[{"source_id":"src_1","page":2,"bbox":[0.0,0.10,1.0,1e-2],"score":12345678901234567890}]']);
      const ids = f.db.transaction(tx => f.cascade.copyAuthoringEntitiesWithConn(tx, 'exam_src', 'exam_dst', NOW));
      expect(f.db.pluck<string>('SELECT source_refs_json FROM qbank_materials WHERE id=?1', [ids.get('mat_1')!]))
        .toBe(`[{"source_id":"${ids.get('src_1')}","page":2,"bbox":[0.0,0.10,1.0,1e-2],"score":12345678901234567890}]`);

      f.db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
        VALUES ('exam_bad', 'exam_bad', 'completed', 'exam_bad', '{}', '{}', ?1, ?1)`, [NOW]);
      f.db.run(`INSERT INTO qbank_materials(id,exam_id,content,source_refs_json,created_at,updated_at)
        VALUES('mat_bad','exam_bad','x','not json',?1,?1)`, [NOW]);
      expect(() => f.db.transaction(tx =>
        f.cascade.copyAuthoringEntitiesWithConn(tx, 'exam_bad', 'exam_dst', NOW)))
        .toThrow(new SyntaxError('expected ident at line 1 column 2'));
    } finally { await f.dispose(); }
  });

  it('soft_delete_and_restore_follow_the_exam_deletion_batch', async () => {
    const f = await fixture();
    try {
      f.db.run(`INSERT INTO qbank_materials(id,exam_id,content,created_at,updated_at)
        VALUES('mat_live','exam_src','a',?1,?1)`, [NOW]);
      f.db.run(`INSERT INTO qbank_materials(id,exam_id,content,created_at,updated_at,deleted_at,deletion_batch)
        VALUES('mat_earlier','exam_src','b',?1,?1,?1,'qdel_old')`, [NOW]);
      f.db.run(`INSERT INTO qbank_groups(id,exam_id,created_at,updated_at) VALUES('grp_live','exam_src',?1,?1)`, [NOW]);
      f.db.run(`INSERT INTO qbank_group_materials(id,exam_id,group_id,material_id,created_at,updated_at)
        VALUES('gm_live','exam_src','grp_live','mat_live',?1,?1)`, [NOW]);
      f.db.run(`INSERT INTO qbank_papers(id,exam_id,title,document_json,created_at,updated_at)
        VALUES('paper_1','exam_src','卷','{}',?1,?1)`, [NOW]);
      f.db.run(`INSERT INTO qbank_practice_attempts(id,scope_id,document_json,created_at,updated_at)
        VALUES('att_1','exam_src','{}',?1,?1)`, [NOW]);
      f.db.run(`INSERT INTO qbank_materials(id,exam_id,content,created_at,updated_at)
        VALUES('mat_other','exam_dst','c',?1,?1)`, [NOW]);

      const deletedAt = '2026-02-01T00:00:00.000Z';
      f.db.transaction(tx => f.cascade.softDeleteForExamWithConn(tx, 'exam_src', deletedAt, 'exam_delete_b1'));
      const rows = (table: string, id: string) => f.db.get<Record<string, unknown>>(
        `SELECT * FROM ${table} WHERE id=?1`, [id])!;
      for (const [table, id] of [['qbank_materials', 'mat_live'], ['qbank_groups', 'grp_live'],
        ['qbank_group_materials', 'gm_live'], ['qbank_papers', 'paper_1']] as const) {
        expect(rows(table, id)).toMatchObject({ deleted_at: deletedAt, updated_at: deletedAt, deletion_batch: 'exam_delete_b1' });
      }
      expect(rows('qbank_practice_attempts', 'att_1')).toMatchObject({
        deleted_at: deletedAt, deletion_batch: 'exam_delete_b1', local_version: 2 });
      // Already-deleted rows keep their own batch; another exam is untouched.
      expect(rows('qbank_materials', 'mat_earlier')).toMatchObject({ deletion_batch: 'qdel_old', deleted_at: NOW });
      expect(rows('qbank_materials', 'mat_other')).toMatchObject({ deleted_at: null });

      // Rust binds deletion_batch=?3: a NULL batch matches nothing.
      f.db.transaction(tx => f.cascade.restoreForExamWithConn(tx, 'exam_src', '2026-03-01', null));
      expect(rows('qbank_materials', 'mat_live')).toMatchObject({ deleted_at: deletedAt });

      f.db.transaction(tx => f.cascade.restoreForExamWithConn(tx, 'exam_src', '2026-03-01', 'exam_delete_b1'));
      for (const [table, id] of [['qbank_materials', 'mat_live'], ['qbank_groups', 'grp_live'],
        ['qbank_group_materials', 'gm_live'], ['qbank_papers', 'paper_1']] as const) {
        expect(rows(table, id)).toMatchObject({ deleted_at: null, deletion_batch: null, updated_at: '2026-03-01' });
      }
      expect(rows('qbank_practice_attempts', 'att_1')).toMatchObject({ deleted_at: null, local_version: 3 });
      expect(rows('qbank_materials', 'mat_earlier')).toMatchObject({ deletion_batch: 'qdel_old', deleted_at: NOW });
    } finally { await f.dispose(); }
  });
});
