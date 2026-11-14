/**
 * `qbank_authoring_service/tests.rs::canonical_copy_preserves_materials_and_structured_data_and_restore_preserves_prior_deletions`。
 *
 * 组合真实 vfs-repos 的 exam copy/restore 与 qbank 作者草稿提交，验证复制后的
 * 题目材料/结构化数据/分组身份，以及恢复题集时保留题目的删除状态。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import qbank from '../index.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import * as authoring from '../src/authoring-service.ts';
import * as repo from '../repository/questions.ts';
import type { DraftQuestion, QuestionDocument } from '../api.ts';

const NOW = '2020-01-01T00:00:00Z';

function draftQuestion(localId: string, overrides: Partial<DraftQuestion> = {}): DraftQuestion {
  return {
    local_id: localId,
    group_id: 'g1',
    original_label: null,
    section_path: [],
    content: `Question ${localId}`,
    question_type: 'short_answer',
    options: null,
    answer: null,
    explanation: null,
    structured_data: null,
    difficulty: null,
    tags: [],
    source_refs: [],
    answer_source_refs: [],
    figures: [],
    images: [],
    answer_origin: null,
    smiles: null,
    smiles_caption: null,
    parent_id: null,
    parent_local_id: null,
    source_ref: null,
    ...overrides,
  };
}

function groupDocument(): QuestionDocument {
  return {
    schema_version: 2,
    mode: 'extract',
    materials: [{
      local_id: 'm1', content: 'A full shared passage', source_refs: [], figures: [], images: [],
    }],
    groups: [{
      local_id: 'g1', label: 'Reading', material_ids: ['m1'], question_ids: ['q1', 'q2'],
    }],
    questions: [draftQuestion('q1'), draftQuestion('q2')],
    unmatched_answers: [],
    coverage: [],
    issues: [],
  };
}

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-authoring-copy-');
  const host = await createTestHost({
    // 考试复制/恢复经 L11 ExamRepo 委托 qbank 的 examCascade；测试必须装载真实 qbank 服务。
    plugins: [vfsRepos, qbank],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
        : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
    },
  });
  const db = storage.database('vfs');
  const exams = (host.ctx.vfsRepo as VfsReposService).exams;
  const questions = (host.ctx.vfsRepo as VfsReposService).questions;
  const exam = exams.createExamSheet(db, {
    examName: 'test', tempId: 'tmp', metadataJson: {}, previewJson: { pages: [] },
    status: 'empty', folderId: null,
  });
  return {
    base, host, db, exams, questions, examId: exam.id,
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

describe('qbank_authoring_service/tests.rs', () => {
  it('canonical_copy_preserves_materials_and_structured_data_and_restore_preserves_prior_deletions', async () => {
    const f = await fixture();
    try {
      const document = groupDocument();
      document.questions[0]!.question_type = 'numeric';
      document.questions[0]!.structured_data = { answer_value: 42, tolerance: 0.1 };
      const receipt = authoring.submitDocument({ db: f.db, questions: f.questions }, f.examId, document, 'seed');

      const copied = f.exams.copyExamSheet(f.db, f.examId, null);
      const questions = repo.listQuestions(f.db, copied.id, {}, 1, 100).questions;
      expect(questions).toHaveLength(2);
      expect(questions.every(question => question.materials.length === 1)).toBe(true);
      expect(questions.some(question =>
        (question.structured_data as { answer_value?: number } | null)?.answer_value === 42))
        .toBe(true);
      expect(questions[0]!.group_id).not.toBe(receipt.group_ids[0]);
      expect(questions.every(question => question.group_id?.startsWith('qgroup_'))).toBe(true);

      f.questions.deleteQuestion(f.db, receipt.question_ids[0]!);
      f.exams.deleteExamSheet(f.db, f.examId);
      f.exams.restoreExam(f.db, f.examId);
      expect(repo.getQuestion(f.db, receipt.question_ids[0]!)).toBeNull();
      expect(repo.getQuestion(f.db, receipt.question_ids[1]!)).not.toBeNull();
      expect(f.db.pluck<number>(
        'SELECT COUNT(*) FROM questions WHERE exam_id = ?1 AND deleted_at IS NULL',
        [f.examId])).toBe(1);
    } finally {
      await f.dispose();
    }
  });
});
