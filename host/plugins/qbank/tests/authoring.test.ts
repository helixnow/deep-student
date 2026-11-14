import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import qbank from '../index.ts';
import { vfsTestPorts, vfsTestServices } from './support/vfs-ports.ts';
import * as authoringService from '../src/authoring-service.ts';
import type {
  AuthoringCommitReceipt, DraftQuestion, QuestionAuthoringDraft, QuestionDocument, QuestionDraftSummary,
  QuestionMaterial,
} from '../api.ts';

const NOW = '2026-01-01T00:00:00+00:00';

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-authoring-');
  const db = storage.database('vfs');
  const host = await createTestHost({
    plugins: [qbank],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
        : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
      ...vfsTestServices(db),
    },
  });
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json,
      created_at, updated_at)
    VALUES ('exam_1', '题目集一', 'empty', 't1', '{}', '{"pages":[]}', ?1, ?1)`, [NOW]);
  return {
    host,
    db,
    storage,
    authoringHost: { db, ...vfsTestPorts(db) },
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function question(localId: string, overrides: Partial<DraftQuestion> = {}): DraftQuestion {
  return {
    local_id: localId, group_id: null, original_label: null, section_path: [], content: `Question ${localId}`,
    question_type: 'short_answer', options: null, answer: null, explanation: null, structured_data: null,
    difficulty: null, tags: [], source_refs: [], answer_source_refs: [], figures: [], images: [],
    answer_origin: null, smiles: null, smiles_caption: null, parent_id: null, parent_local_id: null,
    source_ref: null, ...overrides,
  };
}
function document(overrides: Partial<QuestionDocument> = {}): QuestionDocument {
  return {
    schema_version: 2, mode: 'extract', materials: [], groups: [], questions: [],
    unmatched_answers: [], coverage: [], issues: [], ...overrides,
  };
}
function groupDocument(): QuestionDocument {
  return document({
    materials: [{ local_id: 'm1', content: 'A full shared passage', source_refs: [], figures: [], images: [] }],
    groups: [{ local_id: 'g1', label: 'Reading', material_ids: ['m1'], question_ids: ['q1', 'q2'] }],
    questions: [question('q1', { group_id: 'g1', content: 'First question' }),
      question('q2', { group_id: 'g1', content: 'Second question' })],
  });
}

async function commit(f: Fixture, jobId: string, selected: string[], version: number) {
  return f.host.invoke('qbank_commit_authoring_draft', { jobId, selectedLocalIds: selected, expectedVersion: version });
}

describe('qbank_authoring_service/tests.rs', () => {
  it('selection_closes_material_dependencies_and_confirmation_is_idempotent', async () => {
    const f = await fixture();
    try {
      const job = authoringService.saveDraft(f.authoringHost, 'exam_1', groupDocument(), {});
      expect(f.db.pluck<number>('SELECT COUNT(*) FROM questions')).toBe(0);
      const draft = await f.host.invoke('qbank_get_authoring_draft', { jobId: job }) as QuestionAuthoringDraft;
      const receipt = await commit(f, job, ['q2'], draft.version) as {
        imported_count: number; material_ids: string[]; group_ids: string[]; question_ids: string[]; total_questions: number;
      };
      expect(receipt.imported_count).toBe(1);
      expect(receipt.material_ids).toHaveLength(1);
      expect(receipt.group_ids).toHaveLength(1);
      expect(receipt.total_questions).toBe(1);
      const replay = await commit(f, job, ['q2'], draft.version) as { question_ids: string[] };
      expect(replay.question_ids).toEqual(receipt.question_ids);
      await expect(commit(f, job, ['q1'], draft.version)).rejects.toMatchObject({
        error_type: 'Validation', message: expect.stringContaining('已按其他选择提交') as string,
      });
      expect(f.db.pluck<number>('SELECT COUNT(*) FROM questions WHERE deleted_at IS NULL')).toBe(1);
      const stored = f.db.get<{ group_id: string; group_position: number }>(
        'SELECT group_id, group_position FROM questions WHERE id = ?1', [receipt.question_ids[0]!])!;
      expect(stored.group_id).toBe(receipt.group_ids[0]);
      expect(stored.group_position).toBe(1);
    } finally { await f.dispose(); }
  });

  it('invalid_late_question_rolls_back_materials_groups_and_questions', async () => {
    const f = await fixture();
    try {
      const doc = groupDocument();
      doc.questions[1]!.parent_id = 'missing-parent';
      const job = authoringService.saveDraft(f.authoringHost, 'exam_1', doc, {});
      await expect(commit(f, job, ['q1', 'q2'], 1)).rejects.toMatchObject({
        error_type: 'Validation', message: '变式父题不属于目标题目集',
      });
      for (const table of ['questions', 'qbank_materials', 'qbank_groups', 'qbank_group_materials']) {
        expect(f.db.pluck<number>(`SELECT COUNT(*) FROM ${table}`)).toBe(0);
      }
      const draft = await f.host.invoke('qbank_get_authoring_draft', { jobId: job }) as QuestionAuthoringDraft;
      expect(draft.status).toBe('ready');
    } finally { await f.dispose(); }
  });

  it('material_occ_and_live_dependency_protection', async () => {
    const f = await fixture();
    try {
      const job = authoringService.saveDraft(f.authoringHost, 'exam_1', groupDocument(), {});
      const receipt = await commit(f, job, ['q1', 'q2'], 1) as { material_ids: string[] };
      const material = await f.host.invoke('qbank_update_material', {
        materialId: receipt.material_ids[0], content: 'Updated shared passage', expectedVersion: 1,
      }) as QuestionMaterial;
      expect(material.version).toBe(2);
      expect(material.content).toBe('Updated shared passage');
      await expect(f.host.invoke('qbank_update_material', {
        materialId: material.id, content: 'stale overwrite', expectedVersion: 1,
      })).rejects.toMatchObject({
        error_type: 'Validation', message: 'CONFLICT: 材料版本已变化或材料不存在',
      });
      await expect(f.host.invoke('qbank_delete_material', {
        materialId: material.id, expectedVersion: 2,
      })).rejects.toMatchObject({
        error_type: 'Validation', message: '材料仍被题组引用，请先替换或解除依赖',
      });
    } finally { await f.dispose(); }
  });

  it('commit_tail_completes_the_exam_in_one_statement_after_the_preview_update', async () => {
    // qbank_authoring_service.rs:533-534：refresh_canonical_preview（UPDATE preview_json）后紧接一条
    // json_set 完成语句，不改 updated_at，metadata 其余键按存储原文保留。
    const f = await fixture();
    try {
      f.db.run(`UPDATE exam_sheets SET status = 'importing', import_state_json = '{"stage":"draft"}',
        metadata_json = '{"score": 1.50, "big": 12345678901234567890, "question_document_version": 1}'
        WHERE id = 'exam_1'`);
      const job = authoringService.saveDraft(f.authoringHost, 'exam_1', document({ questions: [question('q1')] }), {});
      const before = f.db.pluck<number>('SELECT COALESCE(MAX(id), 0) FROM __change_log')!;
      await commit(f, job, ['q1'], 1);
      const log = f.db.all<{ table_name: string; record_id: string; operation: string }>(
        'SELECT table_name, record_id, operation FROM __change_log WHERE id > ?1 ORDER BY id', [before]);
      const examRows = log.flatMap((row, index) => (row.table_name === 'exam_sheets' ? [index] : []));
      expect(examRows.map(index => log[index])).toEqual([
        { table_name: 'exam_sheets', record_id: 'exam_1', operation: 'UPDATE' },
        { table_name: 'exam_sheets', record_id: 'exam_1', operation: 'UPDATE' },
      ]);
      expect(log.slice(examRows[0]!).every(row => row.table_name === 'exam_sheets')).toBe(true);
      expect(f.db.get("SELECT metadata_json, status, import_state_json FROM exam_sheets WHERE id = 'exam_1'")).toEqual({
        metadata_json: '{"score":1.50,"big":12345678901234567890,"question_document_version":2}',
        status: 'completed', import_state_json: null,
      });
    } finally { await f.dispose(); }
  });

  it('more_than_one_hundred_questions_project_without_truncation', async () => {
    const f = await fixture();
    try {
      const doc = document({ questions: Array.from({ length: 150 }, (_, index) => question(`q${index}`)) });
      const job = authoringService.saveDraft(f.authoringHost, 'exam_1', doc, {});
      const receipt = await commit(f, job, doc.questions.map(item => item.local_id), 1) as {
        imported_count: number; total_questions: number;
      };
      expect(receipt.imported_count).toBe(150);
      expect(receipt.total_questions).toBe(150);
      const preview = JSON.parse(f.db.pluck<string>("SELECT preview_json FROM exam_sheets WHERE id = 'exam_1'")!);
      const cards = (preview.pages as { cards: unknown[] }[]).flatMap(page => page.cards);
      expect(cards).toHaveLength(150);
    } finally { await f.dispose(); }
  });

  it('saved_chat_review_can_be_fixed_and_committed_without_regenerating_questions', async () => {
    const f = await fixture();
    try {
      const doc = groupDocument();
      doc.coverage = [{ exam: 'legacy summary', total_questions: 2 }];
      const job = authoringService.saveDraft(f.authoringHost, 'exam_1', doc, { source_format: 'chat_qbank_batch_import' });
      const drafts = await f.host.invoke('qbank_list_authoring_drafts', { examId: 'exam_1' }) as QuestionDraftSummary[];
      expect(drafts[0]!.job_id).toBe(job);
      const before = await f.host.invoke('qbank_get_authoring_draft', { jobId: job }) as QuestionAuthoringDraft;
      expect(before.status).toBe('needs_review');
      const reviewed = await f.host.invoke('qbank_review_authoring_draft', {
        jobId: job, expectedVersion: 1,
        coverage: [{ source_id: 'att_test', page: null, status: 'processed' }],
      }) as QuestionAuthoringDraft;
      expect(reviewed.version).toBe(2);
      expect(reviewed.document.questions[0]!.content).toBe(doc.questions[0]!.content);
      expect(reviewed.document.materials[0]!.content).toBe(doc.materials[0]!.content);
      await expect(f.host.invoke('qbank_review_authoring_draft', {
        jobId: job, expectedVersion: 1, coverage: [],
      })).rejects.toMatchObject({ error_type: 'Validation', message: 'CONFLICT: 草稿已提交或版本变化，请重新读取' });
      const receipt = await commit(f, job, ['q1', 'q2'], reviewed.version) as { imported_count: number };
      expect(receipt.imported_count).toBe(2);
      expect(await f.host.invoke('qbank_list_authoring_drafts', { examId: 'exam_1' })).toEqual([]);
      await expect(f.host.invoke('qbank_review_authoring_draft', {
        jobId: job, expectedVersion: 3, coverage: [],
      })).rejects.toMatchObject({ error_type: 'Validation', message: 'CONFLICT: 草稿已提交或版本变化，请重新读取' });
    } finally { await f.dispose(); }
  });

  it('scoped_import_remains_partial_after_explicit_selection_commit', async () => {
    const f = await fixture();
    try {
      const job = authoringService.saveDraft(f.authoringHost, 'exam_1', groupDocument(),
        { complete_document: false, expected_coverage: [{ source_id: 's1', page: 1 }] });
      const draft = await f.host.invoke('qbank_get_authoring_draft', { jobId: job }) as QuestionAuthoringDraft;
      expect(draft.status).toBe('partial');
      await expect(f.host.invoke('qbank_review_authoring_draft', {
        jobId: job, expectedVersion: 1, coverage: [],
      })).rejects.toMatchObject({ error_type: 'Validation', message: '复核不能删除来源覆盖范围' });
      const receipt = await commit(f, job, ['q1', 'q2'], 1) as {
        committed: boolean; partial: boolean; needs_review: boolean;
      };
      expect(receipt).toMatchObject({ committed: true, partial: true, needs_review: true });
    } finally { await f.dispose(); }
  });

  it('selected_source_ranges_merge_page_evidence_without_losing_earlier_pages', async () => {
    const f = await fixture();
    try {
      for (const page of [1, 2]) {
        const doc = document({
          questions: [question(`q${page}`, {
            original_label: String(page), content: `Question ${page}`,
            source_refs: [{ source_id: 's1', page, bbox: null }],
          })],
        });
        const job = authoringService.saveDraft(f.authoringHost, 'exam_1', doc, {
          complete_document: false,
          sources: [{ source_id: 's1', content_hash: 'stable-full-document-hash', page_count: 2 }],
          pages: [{ source_id: 's1', page, blob_hash: `page-image-${page}`, width: 100, height: 100 }],
        });
        await commit(f, job, [`q${page}`], 1);
      }
      const source = f.db.get<{ count: number; descriptor_json: string }>(
        "SELECT count(*) AS count, descriptor_json FROM qbank_sources WHERE exam_id = 'exam_1'")!;
      expect(source.count).toBe(1);
      const descriptor = JSON.parse(source.descriptor_json) as { pages: { blob_hash: string }[] };
      expect(descriptor.pages).toHaveLength(2);
      expect(descriptor.pages[1]!.blob_hash).toBe('page-image-2');
    } finally { await f.dispose(); }
  });

  // qbank_authoring_service.rs:344-357：旧 descriptor_json 以 serde_json::from_str::<Value> 读入，
  // 只替换 pages 后 to_string 写回；Rust 写下的小数、指数与大整数原文不变。
  it('source_page_merge_keeps_rust_written_descriptor_numbers_verbatim', async () => {
    const f = await fixture();
    try {
      const commitPage = async (page: number) => {
        const doc = document({
          questions: [question(`q${page}`, {
            original_label: String(page), content: `Question ${page}`,
            source_refs: [{ source_id: 's1', page, bbox: null }],
          })],
        });
        const job = authoringService.saveDraft(f.authoringHost, 'exam_1', doc, {
          complete_document: false,
          sources: [{ source_id: 's1', content_hash: 'stable-full-document-hash', page_count: 2 }],
          pages: [{ source_id: 's1', page, blob_hash: `page-image-${page}`, width: 100, height: 100 }],
        });
        await commit(f, job, [`q${page}`], 1);
      };
      await commitPage(1);
      const head = '{"source_id":"s1","content_hash":"stable-full-document-hash","page_count":2,"dpi":72.0,'
        + '"render":{"scale":1.50,"seed":12345678901234567890},"pages":[';
      const first = '{"source_id":"s1","page":1,"blob_hash":"page-image-1","width":1000.0,"height":1414.5,"zoom":1e-2}';
      f.db.run("UPDATE qbank_sources SET descriptor_json = ?1 WHERE exam_id = 'exam_1'", [`${head}${first}]}`]);
      await commitPage(2);
      expect(f.db.pluck<string>("SELECT descriptor_json FROM qbank_sources WHERE exam_id = 'exam_1'")).toBe(
        `${head}${first},{"source_id":"s1","page":2,"blob_hash":"page-image-2","width":100,"height":100}]}`);
    } finally { await f.dispose(); }
  });

  // X6-UD-0054/0055/0056/0066: authoring JSON follows qbank_document.rs / qbank_authoring_service.rs serde rules.
  it('persisted_authoring_json_decodes_with_serde_field_rules', async () => {
    const f = await fixture();
    try {
      const job = authoringService.saveDraft(f.authoringHost, 'exam_1', document({ questions: [question('q1')] }), {});
      const row = () => JSON.parse(f.db.pluck<string>(
        'SELECT document_json FROM qbank_import_jobs WHERE id = ?1', [job])!) as Record<string, unknown>;
      const write = (doc: unknown, metadata = '{}') => f.db.run(
        'UPDATE qbank_import_jobs SET document_json = ?2, metadata_json = ?3 WHERE id = ?1',
        [job, JSON.stringify(doc), metadata]);
      const get = () => f.host.invoke('qbank_get_authoring_draft', { jobId: job }) as Promise<QuestionAuthoringDraft>;
      const original = row();

      // serde aliases, defaults and unknown keys (qbank_document.rs:43-86).
      write({ schema_version: 2, mode: 'extract', extra: true,
        questions: [{ local_id: 'q1', content: 'Aliased', questionType: 'essay', questionLabel: '7',
          variant_parent_local_id: 'q0' }] }, '[]');
      const aliased = await get();
      expect(aliased.metadata).toEqual([]);
      expect(aliased.document).not.toHaveProperty('extra');
      expect(aliased.document.materials).toEqual([]);
      expect(aliased.document.questions[0]).toMatchObject({
        question_type: 'essay', original_label: '7', parent_local_id: 'q0', section_path: [], tags: [],
        figures: [], images: [], group_id: null, structured_data: null,
      });
      // Two names for one field, a missing required field and a bad width are Database errors.
      write({ schema_version: 2, mode: 'extract', questions: [{ local_id: 'q1', content: 'x',
        question_type: 'essay', questionType: 'essay' }] });
      await expect(get()).rejects.toMatchObject({ error_type: 'Database', message: expect.stringContaining('duplicate field `question_type`') });
      write({ schema_version: 2, mode: 'extract' });
      await expect(get()).rejects.toMatchObject({ error_type: 'Database', message: expect.stringContaining('missing field `questions`') });
      write({ ...original, schema_version: -2 });
      await expect(get()).rejects.toMatchObject({ error_type: 'Database', message: expect.stringContaining('expected u32') });
      write(original);

      // Committed receipt replay decodes AuthoringCommitReceipt (qbank_authoring_service.rs:280).
      const receipt = await commit(f, job, ['q1'], 1) as AuthoringCommitReceipt;
      expect(await commit(f, job, ['q1'], 1)).toEqual(receipt);
      const stored = JSON.parse(f.db.pluck<string>('SELECT receipt_json FROM qbank_import_jobs WHERE id = ?1', [job])!) as Record<string, unknown>;
      delete stored.partial;
      f.db.run('UPDATE qbank_import_jobs SET receipt_json = ?2 WHERE id = ?1', [job, JSON.stringify(stored)]);
      await expect(commit(f, job, ['q1'], 1)).rejects.toMatchObject({
        error_type: 'Database', message: expect.stringContaining('missing field `partial`') });
    } finally { await f.dispose(); }
  });

  // qbank_authoring_service.rs:392: unparsable provenance reads as Null, so a re-import is a conflict.
  it('unparsable_provenance_is_treated_as_null_and_blocks_same_source_reimport', async () => {
    const f = await fixture();
    try {
      const doc = () => document({ questions: [question('q1', {
        original_label: '1', content: 'Question 1', source_refs: [{ source_id: 's1', page: 1, bbox: null }],
      })] });
      const meta = { sources: [{ source_id: 's1', content_hash: 'stable-hash' }],
        pages: [{ source_id: 's1', page: 1, blob_hash: 'page-1' }] };
      const first = authoringService.saveDraft(f.authoringHost, 'exam_1', doc(), meta);
      await commit(f, first, ['q1'], 1);
      f.db.run("UPDATE questions SET provenance_json = 'not json' WHERE exam_id = 'exam_1'");
      const second = authoringService.saveDraft(f.authoringHost, 'exam_1', doc(), { ...meta, idempotency_key: 'again' });
      await expect(commit(f, second, ['q1'], 1)).rejects.toMatchObject({
        error_type: 'Validation', message: 'CONFLICT: 同源重新解析内容变化，需复核映射，未覆盖已有题目' });
    } finally { await f.dispose(); }
  });
});
