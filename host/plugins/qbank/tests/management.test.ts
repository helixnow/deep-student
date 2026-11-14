import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import qbank from '../index.ts';
import { deleteUnusedMaterials } from '../repository/management.ts';
// boundary-allow cross-plugin-impl: L11 真实题目仓储，验证 history 写入
import { QuestionRepo } from '../../vfs-repos/repository/questions.ts';
import { vfsTestPorts, vfsTestServices } from './support/vfs-ports.ts';
import { fakeMasteryService } from './support/mastery.ts';
import type {
  CreateQuestionParams, Question, QuestionBankStructure, GroupDeleteResult, QuestionMaterial,
} from '../api.ts';

const NOW = '2026-01-01T00:00:00+00:00';
const questionRepo = new QuestionRepo();

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-management-');
  const db = storage.database('vfs');
  const host = await createTestHost({
    plugins: [qbank],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
        : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
      ...vfsTestServices(db),
      ...fakeMasteryService(),
    },
  });
  db.run(`INSERT INTO resources (id, hash, type, created_at, updated_at, index_state, indexed_at)
    VALUES ('res_1', 'hash-management', 'exam', 0, 0, 'indexed', 1)`);
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json,
      resource_id, created_at, updated_at)
    VALUES ('exam_1', '题目集一', 'completed', 't1', '{}',
      '{"pages":[{"page_index":0,"cards":[]}]}', 'res_1', ?1, ?1)`, [NOW]);
  db.run(`INSERT INTO qbank_materials (id, exam_id, content, images_json, source_refs_json, created_at, updated_at)
    VALUES ('mat_1', 'exam_1', 'A shared passage that must stay out of question text', '[]', '[]', ?1, ?1)`,
  [NOW]);
  db.run(`INSERT INTO qbank_groups (id, exam_id, label, position, created_at, updated_at)
    VALUES ('grp_1', 'exam_1', 'Reading', 0, ?1, ?1)`, [NOW]);
  db.run(`INSERT INTO qbank_group_materials (id, exam_id, group_id, material_id, position, created_at, updated_at)
    VALUES ('gm_1', 'exam_1', 'grp_1', 'mat_1', 0, ?1, ?1)`, [NOW]);

  const create = async (content: string): Promise<Question> => host.invoke('qbank_create_question', {
    params: { exam_id: 'exam_1', content, answer: null, options: null, question_type: 'short_answer',
      difficulty: null, tags: [], source_type: 'manual' } as CreateQuestionParams,
  }) as Promise<Question>;
  const q1 = await create('First question');
  const q2 = await create('Second question');
  db.run("UPDATE questions SET group_id = 'grp_1', group_position = 0 WHERE id = ?1", [q1.id]);
  db.run("UPDATE questions SET group_id = 'grp_1', group_position = 1 WHERE id = ?1", [q2.id]);
  return {
    host, db, storage, q1, q2,
    async createStandalone(content: string): Promise<Question> { return create(content); },
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function previewCardCount(db: import('../../../platform/storage/api.ts').DatabaseHandle): number {
  const raw = db.pluck<string>("SELECT preview_json FROM exam_sheets WHERE id = 'exam_1'");
  const preview = JSON.parse(raw ?? '{"pages":[]}') as { pages: { cards: unknown[] }[] };
  return preview.pages.reduce((sum, page) => sum + page.cards.length, 0);
}

describe('qbank_management/tests.rs', () => {
  it('list_structure_exposes_versions_and_canonical_member_order', async () => {
    const f = await fixture();
    try {
      const structure = await f.host.invoke('qbank_list_structure', { examId: 'exam_1' }) as QuestionBankStructure;
      expect(structure.exam_id).toBe('exam_1');
      expect(structure.materials).toEqual([{
        id: 'mat_1', content: 'A shared passage that must stay out of question text',
        images: [], source_refs: [], version: 1,
      }]);
      expect(structure.groups).toEqual([{
        id: 'grp_1', exam_id: 'exam_1', label: 'Reading', position: 0, version: 1,
        material_ids: ['mat_1'], question_ids: [f.q1.id, f.q2.id],
      }]);
    } finally { await f.dispose(); }
  });

  it('list_structure_decodes_material_json_like_serde_and_spells_bbox_as_f64', async () => {
    const f = await fixture();
    try {
      f.db.run("UPDATE qbank_materials SET images_json = ?1, source_refs_json = ?2 WHERE id = 'mat_1'", [
        '[{"id":"img_1","name":"a.png","mime":"image/png","hash":"h1","legacy":1}]',
        '[{"source_id":"src_1","bbox":[0,0,1,0.5],"legacy":1},{"source_id":"src_2","page":3}]',
      ]);
      const outcome = await f.host.runtime.dispatchInvoke({
        id: 'list-structure-wire', cmd: 'qbank_list_structure', args: { examId: 'exam_1' },
        source: { window: 'main', webview: 'main' },
      });
      if (outcome.kind !== 'ok') throw new Error(JSON.stringify(outcome));
      // qbank_types.rs:11 SourceRef 的 page/bbox 总是写出、bbox 是 [f64; 4]；question_repo.rs:257 role 为 None 时跳过；未知键丢弃。
      expect(outcome.json).toContain(
        '"images":[{"id":"img_1","name":"a.png","mime":"image/png","hash":"h1"}],'
        + '"source_refs":[{"source_id":"src_1","page":null,"bbox":[0.0,0.0,1.0,0.5]},'
        + '{"source_id":"src_2","page":3,"bbox":null}],"version":');
    } finally { await f.dispose(); }
  });

  it('list_structure_reports_corrupt_material_json_with_the_serde_text', async () => {
    const f = await fixture();
    try {
      f.db.run("UPDATE qbank_materials SET source_refs_json = 'not json' WHERE id = 'mat_1'");
      // qbank_management.rs:184 `serde_json::from_str(&refs).map_err(storage)?`
      await expect(f.host.invoke('qbank_list_structure', { examId: 'exam_1' }))
        .rejects.toEqual({ error_type: 'Database', message: 'expected ident at line 1 column 2', details: null });
    } finally { await f.dispose(); }
  });

  it('update_group_reorders_adds_and_removes_with_solo_material_context_and_occ', async () => {
    const f = await fixture();
    try {
      const q3 = await f.createStandalone('Third question');
      const result = await f.host.invoke('qbank_update_group', {
        groupId: 'grp_1', label: 'Updated reading', questionIds: [f.q2.id, q3.id],
        materialIds: ['mat_1'], expectedVersion: 1,
      }) as { group: { version: number; label: string; question_ids: string[] }; removed_question_ids: string[];
        solo_group_ids: string[] };
      expect(result.group.version).toBe(2);
      expect(result.group.label).toBe('Updated reading');
      expect(result.group.question_ids).toEqual([f.q2.id, q3.id]);
      expect(result.removed_question_ids).toEqual([f.q1.id]);
      expect(result.solo_group_ids).toHaveLength(1);

      const structure = await f.host.invoke('qbank_list_structure', { examId: 'exam_1' }) as QuestionBankStructure;
      expect(structure.groups).toHaveLength(2);
      const updated = structure.groups.find(group => group.id === 'grp_1')!;
      expect(updated.version).toBe(2);
      expect(updated.position).toBe(0);
      const solo = structure.groups.find(group => group.id === result.solo_group_ids[0])!;
      expect(solo.question_ids).toEqual([f.q1.id]);
      expect(solo.label).toContain('独立题');
      expect(solo.material_ids).toEqual(['mat_1']);
      expect(solo.version).toBe(1);
      const frozen = structure.materials.find(material => material.id === solo.material_ids[0]) as QuestionMaterial;
      expect(frozen.content).toBe('A shared passage that must stay out of question text');
      const q1 = await f.host.invoke('qbank_get_question', { questionId: f.q1.id }) as Question;
      expect(q1.group_id).toBe(solo.id);
      expect(q1.content).not.toContain('shared passage');
      expect(f.db.all<{ id: string; group_position: number }>(
        "SELECT id, group_position FROM questions WHERE group_id = 'grp_1' AND deleted_at IS NULL ORDER BY group_position"))
        .toEqual([{ id: f.q2.id, group_position: 0 }, { id: q3.id, group_position: 1 }]);
      const history = questionRepo.getHistory(f.db, f.q1.id, 20);
      expect(history.some(entry => entry.field_name === 'group_id' && entry.old_value === 'grp_1'
        && entry.new_value === solo.id && entry.operator === 'system')).toBe(true);

      const before = await f.host.invoke('qbank_list_structure', { examId: 'exam_1' }) as QuestionBankStructure;
      await expect(f.host.invoke('qbank_update_group', {
        groupId: 'grp_1', label: 'stale', questionIds: [f.q2.id, q3.id], materialIds: [], expectedVersion: 1,
      })).rejects.toMatchObject({
        error_type: 'Validation', message: 'CONFLICT: 题组版本已变化，请重新载入',
      });
      const after = await f.host.invoke('qbank_list_structure', { examId: 'exam_1' }) as QuestionBankStructure;
      expect(after.groups).toHaveLength(before.groups.length);
      expect(after.groups.find(group => group.id === 'grp_1')!.version).toBe(2);
    } finally { await f.dispose(); }
  });

  it('ungroup_and_delete_members_preserve_submission_snapshots_history_stats_and_preview', async () => {
    const f = await fixture();
    try {
      await f.host.invoke('qbank_submit_answer', {
        request: { question_id: f.q1.id, user_answer: 'initial answer', is_correct_override: true,
          client_request_id: 'management-1' },
      });
      questionRepo.recordHistory(f.db, f.q1.id, 'content', 'old text', 'First question', 'user', 'manual edit');
      const before = f.db.get<{ material_snapshot_json: string }>(
        'SELECT material_snapshot_json FROM answer_submissions WHERE question_id = ?1', [f.q1.id])!;
      f.db.run("UPDATE resources SET index_state = 'indexed', indexed_at = 1 WHERE id = 'res_1'");

      const result = await f.host.invoke('qbank_delete_group', {
        groupId: 'grp_1', mode: 'ungroup', expectedVersion: 1,
      }) as GroupDeleteResult;
      expect(result.mode).toBe('ungroup');
      expect(result.deleted_question_ids).toEqual([]);
      expect(result.ungrouped_question_ids).toEqual([]);
      expect(result.solo_group_ids).toHaveLength(2);
      expect(f.db.pluck<number>("SELECT COUNT(*) FROM questions WHERE exam_id = 'exam_1' AND deleted_at IS NULL"))
        .toBe(2);

      const structure = await f.host.invoke('qbank_list_structure', { examId: 'exam_1' }) as QuestionBankStructure;
      expect(structure.groups.every(group => group.id !== 'grp_1')).toBe(true);
      expect(structure.groups).toHaveLength(2);
      expect(structure.groups.every(group => group.material_ids.length === 1 && group.question_ids.length === 1))
        .toBe(true);
      expect(structure.materials).toHaveLength(1);
      const after = f.db.get<{ material_snapshot_json: string }>(
        'SELECT material_snapshot_json FROM answer_submissions WHERE question_id = ?1', [f.q1.id])!;
      expect(after.material_snapshot_json).toBe(before.material_snapshot_json);
      expect(questionRepo.getHistory(f.db, f.q1.id, 20).some(entry => entry.field_name === 'content')).toBe(true);
      expect(f.db.get<{ total_count: number }>(
        "SELECT total_count FROM question_bank_stats WHERE exam_id = 'exam_1'")!.total_count).toBe(2);
      expect(previewCardCount(f.db)).toBe(2);
      expect(f.db.pluck<string>("SELECT index_state FROM resources WHERE id = 'res_1'")).toBe('pending');

      const soloQ1 = structure.groups.find(group => group.question_ids[0] === f.q1.id)!;
      const deleted = await f.host.invoke('qbank_delete_group', {
        groupId: soloQ1.id, mode: { delete_members: null }, expectedVersion: soloQ1.version,
      }) as GroupDeleteResult;
      expect(deleted.deleted_question_ids).toEqual([f.q1.id]);
      expect(await f.host.invoke('qbank_get_question', { questionId: f.q1.id })).toBeNull();
      expect(f.db.pluck<number>("SELECT COUNT(*) FROM questions WHERE exam_id = 'exam_1' AND deleted_at IS NULL"))
        .toBe(1);
      expect(previewCardCount(f.db)).toBe(1);
      expect(f.db.get<{ total_count: number }>(
        "SELECT total_count FROM question_bank_stats WHERE exam_id = 'exam_1'")!.total_count).toBe(1);
      expect(f.db.pluck<number>('SELECT COUNT(*) FROM answer_submissions WHERE question_id = ?1', [f.q1.id]))
        .toBe(1);
      expect(f.db.get<{ material_snapshot_json: string }>(
        'SELECT material_snapshot_json FROM answer_submissions WHERE question_id = ?1', [f.q1.id])!
        .material_snapshot_json).toBe(after.material_snapshot_json);
      const history = questionRepo.getHistory(f.db, f.q1.id, 20);
      expect(history.some(entry => entry.field_name === 'content')).toBe(true);
      expect(history.some(entry => entry.field_name === 'deleted_at')).toBe(true);
    } finally { await f.dispose(); }
  });

  it('delete_group_delete_members_rejects_variant_dependency_and_rolls_back', async () => {
    const f = await fixture();
    try {
      const q3 = await f.createStandalone('Variant child');
      f.db.run('UPDATE questions SET parent_id = ?1 WHERE id = ?2', [f.q1.id, q3.id]);
      await expect(f.host.invoke('qbank_delete_group', {
        groupId: 'grp_1', mode: 'delete_members', expectedVersion: 1,
      })).rejects.toMatchObject({ error_type: 'Validation', message: expect.stringContaining('变式') as string });
      expect(await f.host.invoke('qbank_get_question', { questionId: f.q1.id })).not.toBeNull();
      expect(await f.host.invoke('qbank_get_question', { questionId: f.q2.id })).not.toBeNull();
      const structure = await f.host.invoke('qbank_list_structure', { examId: 'exam_1' }) as QuestionBankStructure;
      expect(structure.groups.find(group => group.id === 'grp_1')!.version).toBe(1);
      expect(f.db.pluck<number>("SELECT COUNT(*) FROM questions WHERE exam_id = 'exam_1' AND deleted_at IS NULL"))
        .toBe(3);

      f.db.run('UPDATE questions SET parent_id = NULL WHERE id = ?1', [q3.id]);
      const result = await f.host.invoke('qbank_delete_group', {
        groupId: 'grp_1', mode: 'delete_members', expectedVersion: 1,
      }) as GroupDeleteResult;
      expect(result.deleted_question_ids).toHaveLength(2);
      expect(f.db.pluck<number>("SELECT COUNT(*) FROM questions WHERE exam_id = 'exam_1' AND deleted_at IS NULL"))
        .toBe(1);
      const final = await f.host.invoke('qbank_list_structure', { examId: 'exam_1' }) as QuestionBankStructure;
      expect(final.groups.every(group => group.id !== 'grp_1')).toBe(true);
    } finally { await f.dispose(); }
  });

  // commands.rs:1615 `mode: DeleteGroupMode`：非法值在 tauri 参数反序列化阶段被拒（error.rs:59 InvalidArgs + serde 原文），
  // 前端拿到的是字符串而不是 AppError（V05-04）。
  it('delete_group_rejects_unknown_mode_with_tauri_invalid_args_text', async () => {
    const f = await fixture();
    try {
      const prefix = 'invalid args `mode` for command `qbank_delete_group`: ';
      const reject = (mode: unknown) => f.host.invoke('qbank_delete_group', { groupId: 'grp_1', mode, expectedVersion: 1 });
      await expect(reject('purge')).rejects.toBe(`${prefix}unknown variant \`purge\`, expected \`ungroup\` or \`delete_members\``);
      await expect(reject({ purge: null })).rejects.toBe(`${prefix}unknown variant \`purge\`, expected \`ungroup\` or \`delete_members\``);
      await expect(reject(3)).rejects.toBe(`${prefix}invalid type: number, expected string or map`);
      const structure = await f.host.invoke('qbank_list_structure', { examId: 'exam_1' }) as QuestionBankStructure;
      expect(structure.groups.find(group => group.id === 'grp_1')!.version).toBe(1);
    } finally { await f.dispose(); }
  });

  it('delete_unused_materials_is_reference_safe_occ_and_atomic', async () => {
    const f = await fixture();
    try {
      f.db.run(`INSERT INTO qbank_materials (id, exam_id, content, images_json, source_refs_json, created_at, updated_at)
        VALUES ('mat_unused', 'exam_1', 'unused material', '[]', '[]', ?1, ?1)`, [NOW]);
      f.db.run("UPDATE resources SET index_state = 'indexed', indexed_at = 1 WHERE id = 'res_1'");

      expect(() => deleteUnusedMaterials(f.db, 'exam_1', [
        { material_id: 'mat_unused', expected_version: 1 },
        { material_id: 'mat_1', expected_version: 1 },
      ], vfsTestPorts(f.db))).toThrow('材料仍被题组引用');
      expect(f.db.pluck<number>("SELECT COUNT(*) FROM qbank_materials WHERE deleted_at IS NULL")).toBe(2);

      expect(() => deleteUnusedMaterials(f.db, 'exam_1', [
        { material_id: 'mat_unused', expected_version: 9 },
      ], vfsTestPorts(f.db))).toThrow('CONFLICT: 材料版本已变化，请重新载入');
      expect(f.db.pluck<number>("SELECT COUNT(*) FROM qbank_materials WHERE deleted_at IS NULL")).toBe(2);

      const result = deleteUnusedMaterials(f.db, 'exam_1', [
        { material_id: 'mat_unused', expected_version: 1 },
      ], vfsTestPorts(f.db));
      expect(result).toEqual({ exam_id: 'exam_1', deleted_material_ids: ['mat_unused'] });
      expect(f.db.pluck<string>("SELECT index_state FROM resources WHERE id = 'res_1'")).toBe('pending');
      expect(f.db.pluck<number>("SELECT COUNT(*) FROM qbank_materials WHERE deleted_at IS NULL")).toBe(1);
    } finally { await f.dispose(); }
  });
});
