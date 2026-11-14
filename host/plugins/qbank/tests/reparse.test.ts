import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import qbank from '../index.ts';
import { vfsTestPorts, vfsTestServices } from './support/vfs-ports.ts';
import * as authoring from '../src/authoring-service.ts';
import { listDraftSummaries, readDraft } from '../repository/authoring.ts';
import type {
  DraftQuestion, QuestionDocument, ReparseDecision, ReparseReport, ReparseResolveReceipt,
  SourceRef,
} from '../api.ts';

const NOW = '2026-01-01T00:00:00+00:00';

function questionRef(): SourceRef {
  return { source_id: 'src1', page: 1, bbox: [0.1, 0.1, 0.9, 0.9] };
}

function draft(localId: string, overrides: Partial<DraftQuestion> = {}): DraftQuestion {
  return {
    local_id: localId, group_id: null, original_label: localId === 'q1' ? '1' : '2',
    section_path: [], content: localId === 'q1' ? 'draft content' : 'draft two',
    question_type: 'short_answer', options: null, answer: null, explanation: null,
    structured_data: null, difficulty: null, tags: [], source_refs: [questionRef()],
    answer_source_refs: [], figures: [], images: [], answer_origin: null, smiles: null,
    smiles_caption: null, parent_id: null, parent_local_id: null, source_ref: null,
    ...overrides,
  };
}

function documentWith(questions: DraftQuestion[], groupSecond = false): QuestionDocument {
  const groups = groupSecond ? [{
    local_id: 'g1', label: 'group', material_ids: [], question_ids: ['q2'],
  }] : [];
  return {
    schema_version: 2, mode: 'extract', materials: [], groups, questions,
    unmatched_answers: [], coverage: [], issues: [],
  };
}

function metadata(): Record<string, unknown> {
  return {
    sources: [{ source_id: 'src1', blob_hash: 'source-blob-1', pages: [] }],
    pages: [{ source_id: 'src1', page: 1, blob_hash: 'source-blob-1', width: 1000, height: 1400 }],
  };
}

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-reparse-');
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
    VALUES ('exam_1', 'reparse test', 'empty', 'tmp_reparse', '{}', '{"pages":[]}', ?1, ?1)`,
  [NOW]);

  // reparse_fixture(): commit q1 from src1.
  const firstJob = authoring.saveDraft({ db, ...vfsTestPorts(db) }, 'exam_1',
    documentWith([draft('q1')]), metadata());
  const firstReceipt = authoring.commitDraft({ db, ...vfsTestPorts(db) }, firstJob,
    ['q1'], readDraft(db, firstJob).version);
  const firstId = firstReceipt.question_ids[0]!;

  async function pending(groupedSecond: boolean): Promise<{
    job: string; ids: string[];
  }> {
    // pending_reparse_fixture(): commit q2 from the same sources, then a draft
    // that contains both questions and edits both canonical questions.
    const secondJob = authoring.saveDraft({ db, ...vfsTestPorts(db) }, 'exam_1',
      documentWith([draft('q2')]), metadata());
    const secondReceipt = authoring.commitDraft({ db, ...vfsTestPorts(db) }, secondJob,
      ['q2'], readDraft(db, secondJob).version);
    const secondId = secondReceipt.question_ids[0]!;
    const second = draft('q2');
    if (groupedSecond) second.group_id = 'g1';
    const stored = documentWith([draft('q1'), second], groupedSecond);
    const job = authoring.saveDraft({ db, ...vfsTestPorts(db) }, 'exam_1', stored, metadata());
    db.run("UPDATE questions SET content = 'edited one', updated_at = '2030-01-01' WHERE id = ?1",
      [firstId]);
    db.run("UPDATE questions SET content = 'edited two', updated_at = '2030-01-02' WHERE id = ?1",
      [secondId]);
    db.run('UPDATE exam_sheets SET import_state_json = ?1 WHERE id = ?2', [
      JSON.stringify({ schema_version: 2, job_id: job }), 'exam_1',
    ]);
    return { job, ids: [firstId, secondId] };
  }

  function snapshot(): unknown {
    const questions = db.all<Record<string, unknown>>(
      `SELECT id, content, updated_at, provenance_json, card_id, source_key
       FROM questions WHERE exam_id = 'exam_1' ORDER BY id`);
    const jobs = db.all<Record<string, unknown>>(
      `SELECT id, status, version, document_json, metadata_json, receipt_json, selected_json
       FROM qbank_import_jobs WHERE exam_id = 'exam_1' ORDER BY id`);
    const sheet = db.get<Record<string, unknown>>(
      `SELECT preview_json, metadata_json, import_state_json, updated_at
       FROM exam_sheets WHERE id = 'exam_1'`)!;
    return { questions, jobs, sheet };
  }

  function decision(report: ReparseReport, localId: string, action: string): ReparseDecision {
    return {
      local_id: localId, action,
      expected_revision: action === 'replace_existing'
        ? report.items.find(item => item.local_id === localId)!.canonical_revision
        : null,
    };
  }

  return {
    host, db, snapshot, pending, decision, seedJob: firstJob,
    async report(job: string | null): Promise<ReparseReport> {
      return host.invoke('qbank_reparse_report', job === null
        ? { examId: 'exam_1' } : { examId: 'exam_1', jobId: job }) as Promise<ReparseReport>;
    },
    async resolve(job: string, decisions: ReparseDecision[], expectedReportVersion: string):
      Promise<ReparseResolveReceipt> {
      return host.invoke('qbank_reparse_resolve', {
        examId: 'exam_1', jobId: job, decisions, expectedReportVersion,
      }) as Promise<ReparseResolveReceipt>;
    },
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function rejection(promise: Promise<unknown>): Promise<{ message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { message: string };
  }
  throw new Error('expected rejection');
}

describe('qbank_legacy_reconcile.rs reparse', () => {
  it('reparse_late_import_failure_rolls_back_earlier_replacement', async () => {
    const f = await fixture();
    try {
      const pending = await f.pending(false);
      f.db.exec(`CREATE TRIGGER fail_reparse_import BEFORE INSERT ON questions
        WHEN NEW.content = 'draft two'
        BEGIN SELECT RAISE(ABORT, 'late reparse import'); END;`);
      const report = await f.report(pending.job);
      const before = f.snapshot();
      const error = await rejection(f.resolve(pending.job, [
        f.decision(report, 'q1', 'replace_existing'),
        f.decision(report, 'q2', 'import_as_new'),
      ], report.report_version));
      expect(error.message).toContain('late reparse import');
      expect(f.snapshot()).toEqual(before);
    } finally { await f.dispose(); }
  });

  it('reparse_late_occ_failure_rolls_back_earlier_import', async () => {
    const f = await fixture();
    try {
      const pending = await f.pending(false);
      f.db.exec(`CREATE TRIGGER change_later_question AFTER INSERT ON questions
        WHEN NEW.content = 'draft content'
        BEGIN UPDATE questions SET content = 'raced', updated_at = '2040-01-01'
        WHERE id = '${pending.ids[1]}'; END;`);
      const report = await f.report(pending.job);
      const before = f.snapshot();
      const error = await rejection(f.resolve(pending.job, [
        f.decision(report, 'q1', 'import_as_new'),
        f.decision(report, 'q2', 'replace_existing'),
      ], report.report_version));
      expect(error.message).toContain('版本已变化');
      expect(f.snapshot()).toEqual(before);
    } finally { await f.dispose(); }
  });

  it('reparse_receipt_failure_rolls_back_questions_and_child_drafts', async () => {
    const f = await fixture();
    try {
      const pending = await f.pending(false);
      f.db.exec(`CREATE TRIGGER fail_reparse_receipt BEFORE UPDATE ON qbank_import_jobs
        WHEN json_type(NEW.metadata_json, '$.reparse_resolution') = 'object'
        BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END;`);
      const report = await f.report(pending.job);
      const before = f.snapshot();
      const error = await rejection(f.resolve(pending.job, [
        f.decision(report, 'q1', 'import_as_new'),
        f.decision(report, 'q2', 'replace_existing'),
      ], report.report_version));
      expect(error.message).toContain('receipt write failed');
      expect(f.snapshot()).toEqual(before);
    } finally { await f.dispose(); }
  });

  it('reparse_does_not_offer_group_import_and_prevalidates_all_decisions', async () => {
    const f = await fixture();
    try {
      const pending = await f.pending(true);
      const report = await f.report(pending.job);
      const second = report.items.find(item => item.local_id === 'q2')!;
      expect(second.allowed_actions).not.toContain('import_as_new');
      const before = f.snapshot();
      await expect(f.resolve(pending.job, [
        f.decision(report, 'q1', 'replace_existing'),
        f.decision(report, 'q2', 'import_as_new'),
      ], report.report_version)).rejects.toThrow();
      expect(f.snapshot()).toEqual(before);
    } finally { await f.dispose(); }
  });

  it('reparse_keep_is_terminal_and_normalized_retry_survives_fresh_reports', async () => {
    const f = await fixture();
    try {
      const pending = await f.pending(false);
      const report = await f.report(pending.job);
      const receipt = await f.resolve(pending.job, [], report.report_version);
      expect(receipt.kept_local_ids).toEqual(['q1', 'q2']);
      const saved = readDraft(f.db, pending.job);
      expect(saved.status).toBe('cancelled');
      expect(saved.version).toBe(report.job_version + 1);
      expect((saved.metadata as Record<string, unknown>).reparse_resolution).toBeTruthy();
      expect(listDraftSummaries(f.db, 'exam_1')
        .some(summary => summary.job_id === pending.job)).toBe(false);
      expect(() => authoring.commitDraft({ db: f.db, ...vfsTestPorts(f.db) }, pending.job, ['q1'], saved.version))
        .toThrow();

      f.db.run("UPDATE questions SET content = 'later user edit' WHERE id = ?1", [pending.ids[0]!]);
      const fresh = await f.report(pending.job);
      const before = f.snapshot();
      const retry = await f.resolve(pending.job, [
        f.decision(fresh, 'q2', 'keep_existing'),
        f.decision(fresh, 'q1', 'keep_existing'),
      ], fresh.report_version);
      expect(retry).toEqual(receipt);
      expect(f.snapshot()).toEqual(before);
      await expect(f.resolve(pending.job, [
        f.decision(fresh, 'q1', 'import_as_new'),
      ], fresh.report_version)).rejects.toThrow();
      expect(f.snapshot()).toEqual(before);
    } finally { await f.dispose(); }
  });

  it('mixed_reparse_resolution_rejects_stale_report_and_persists_retry_receipt', async () => {
    const f = await fixture();
    try {
      const pending = await f.pending(false);
      const stale = await f.report(pending.job);
      f.db.run("UPDATE questions SET content = 'new user edit', updated_at = '2031-01-01' WHERE id = ?1",
        [pending.ids[1]!]);
      const before = f.snapshot();
      const error = await rejection(f.resolve(pending.job, [
        f.decision(stale, 'q1', 'import_as_new'),
        f.decision(stale, 'q2', 'replace_existing'),
      ], stale.report_version));
      expect(error.message).toContain('报告已变化');
      expect(f.snapshot()).toEqual(before);

      const report = await f.report(pending.job);
      const decisions = [
        f.decision(report, 'q1', 'import_as_new'),
        f.decision(report, 'q2', 'replace_existing'),
      ];
      const receipt = await f.resolve(pending.job, decisions, report.report_version);
      expect(receipt.imported_question_ids).toHaveLength(1);
      expect(receipt.replaced_question_ids).toEqual([pending.ids[1]!]);
      expect(f.db.pluck<string>('SELECT content FROM questions WHERE id = ?1', [pending.ids[1]!]))
        .toBe('draft two');
      expect(f.db.pluck<string | null>('SELECT source_key FROM questions WHERE id = ?1',
        [receipt.imported_question_ids[0]!])).toBeNull();
      expect(f.db.pluck<string | null>("SELECT import_state_json FROM exam_sheets WHERE id = 'exam_1'"))
        .toBeNull();
      expect(f.db.pluck<number>(
        "SELECT COUNT(*) FROM questions WHERE exam_id = 'exam_1' AND deleted_at IS NULL")).toBe(3);
      expect(readDraft(f.db, pending.job).status).toBe('cancelled');
      expect(listDraftSummaries(f.db, 'exam_1')
        .some(summary => summary.job_id === pending.job)).toBe(false);

      const fresh = await f.report(null);
      expect(fresh.job_id).toBe(pending.job);
      expect(fresh.resolved).toBe(true);
      const beforeRetry = f.snapshot();
      const retry = await f.resolve(pending.job, [...decisions].reverse(), fresh.report_version);
      expect(retry).toEqual(receipt);
      expect(f.snapshot()).toEqual(beforeRetry);
    } finally { await f.dispose(); }
  });

  it('reparse_replacement_preserves_identity_history_and_is_idempotent', async () => {
    const f = await fixture();
    try {
      const cardIdBefore = f.db.pluck<string | null>(
        'SELECT card_id FROM questions WHERE source_key IS NOT NULL ORDER BY created_at LIMIT 1');
      const questionId = f.db.pluck<string>(
        "SELECT id FROM questions WHERE question_label = '1' AND exam_id = 'exam_1'")!;
      expect(cardIdBefore).not.toBeNull();
      f.db.run("UPDATE questions SET content = 'edited canonical', updated_at = '2030-01-01T00:00:00Z' WHERE id = ?1",
        [questionId]);
      f.db.run(`INSERT INTO answer_submissions
          (id, question_id, user_answer, grading_method, submitted_at)
          VALUES ('sub-1', ?1, 'old answer', 'auto', '2029-12-31T00:00:00Z')`, [questionId]);

      const report = await f.report(f.seedJob);
      expect(report.items).toHaveLength(1);
      expect(report.items[0]!.status).toBe('changed');
      expect(report.items[0]!.canonical_question_id).toBe(questionId);
      expect(report.items[0]!.changes.some(change => change.field === 'content')).toBe(true);
      const decision: ReparseDecision = {
        local_id: 'q1', action: 'replace_existing',
        expected_revision: report.items[0]!.canonical_revision!,
      };
      const replaced = await f.resolve(report.job_id, [decision], report.report_version);
      expect(replaced.replaced_question_ids).toEqual([questionId]);
      expect(f.db.pluck<string>('SELECT content FROM questions WHERE id = ?1', [questionId]))
        .toBe('draft content');
      expect(f.db.pluck<string | null>('SELECT card_id FROM questions WHERE id = ?1', [questionId]))
        .toBe(cardIdBefore);
      expect(f.db.pluck<number>(
        'SELECT COUNT(*) FROM answer_submissions WHERE question_id = ?1', [questionId])).toBe(1);
      expect(f.db.pluck<number>(
        "SELECT COUNT(*) FROM questions WHERE exam_id = 'exam_1' AND deleted_at IS NULL")).toBe(1);

      const beforeRetry = await f.report(report.job_id);
      expect(beforeRetry.resolved).toBe(true);
      expect(beforeRetry.items[0]!.allowed_actions).toEqual([]);
      const retry = await f.resolve(report.job_id, [decision], report.report_version);
      expect(retry).toEqual(replaced);
      const error = await rejection(f.resolve(report.job_id, [
        { local_id: 'q1', action: 'keep_existing', expected_revision: null },
      ], beforeRetry.report_version));
      expect(error.message).toContain('已完成复核');
    } finally { await f.dispose(); }
  });

  it('reparse_import_as_new_keeps_existing_question_and_identity', async () => {
    const f = await fixture();
    try {
      const questionId = f.db.pluck<string>(
        "SELECT id FROM questions WHERE question_label = '1' AND exam_id = 'exam_1'")!;
      const job = f.seedJob;
      f.db.run("UPDATE questions SET content = 'edited canonical', updated_at = '2030-02-02T00:00:00Z' WHERE id = ?1",
        [questionId]);
      const report = await f.report(job);
      const resolved = await f.resolve(job, [
        { local_id: 'q1', action: 'import_as_new', expected_revision: null },
      ], report.report_version);
      expect(resolved.imported_question_ids).toHaveLength(1);
      expect(resolved.imported_question_ids[0]).not.toBe(questionId);
      expect(f.db.pluck<number>(
        "SELECT COUNT(*) FROM questions WHERE exam_id = 'exam_1' AND deleted_at IS NULL")).toBe(2);
      expect(f.db.pluck<string>('SELECT content FROM questions WHERE id = ?1', [questionId]))
        .toBe('edited canonical');
      const originalReceipt = f.db.pluck<string>(
        'SELECT receipt_json FROM qbank_import_jobs WHERE id = ?1', [job])!;
      expect(originalReceipt.includes(resolved.imported_question_ids[0]!)).toBe(false);

      const after = await f.report(job);
      expect(after.resolved).toBe(true);
      const retry = await f.resolve(job, [
        { local_id: 'q1', action: 'import_as_new', expected_revision: null },
      ], after.report_version);
      expect(retry.imported_question_ids).toEqual(resolved.imported_question_ids);
      expect(f.db.pluck<number>(
        "SELECT COUNT(*) FROM questions WHERE exam_id = 'exam_1' AND deleted_at IS NULL")).toBe(2);
      expect((await f.report(null)).job_id).toBe(job);
    } finally { await f.dispose(); }
  });

  it('reparse_deleted_canonical_never_offers_recreation', async () => {
    const f = await fixture();
    try {
      const questionId = f.db.pluck<string>(
        "SELECT id FROM questions WHERE question_label = '1' AND exam_id = 'exam_1'")!;
      const job = f.seedJob;
      await f.host.invoke('qbank_delete_question', { questionId });
      const report = await f.report(job);
      expect(report.canonical_question_count).toBe(0);
      expect(report.items[0]!.status).toBe('deleted');
      expect(report.items[0]!.allowed_actions).toEqual(['keep_existing']);
      const error = await rejection(f.resolve(job, [
        { local_id: 'q1', action: 'import_as_new', expected_revision: null },
      ], report.report_version));
      expect(error.message).toContain('不允许操作');
      expect(f.db.pluck<number>(
        "SELECT COUNT(*) FROM questions WHERE exam_id = 'exam_1' AND deleted_at IS NULL")).toBe(0);
    } finally { await f.dispose(); }
  });

  // load_canonical_rows: structured_data 为 serde_json::from_str 的 Value（arbitrary_precision），
  // 与草稿 Value 逐字面比较；changes.before 原样输出 Rust 写下的数字文本。
  it('reparse_report_compares_rust_written_structured_data_losslessly', async () => {
    const f = await fixture();
    try {
      const pending = await f.pending(false);
      const canonical = '{"answer_value":2.50,"tolerance":1e-2,"big":12345678901234567890}';
      f.db.run("UPDATE questions SET content = 'draft content', structured_data = ?1 WHERE id = ?2",
        [canonical, pending.ids[0]!]);
      f.db.run("UPDATE questions SET content = 'draft two', structured_data = ?1 WHERE id = ?2",
        [canonical, pending.ids[1]!]);
      const stored = JSON.parse(f.db.pluck<string>(
        'SELECT document_json FROM qbank_import_jobs WHERE id = ?1', [pending.job])!) as QuestionDocument;
      stored.questions[0]!.structured_data = '__Q1__';
      stored.questions[1]!.structured_data = '__Q2__';
      f.db.run('UPDATE qbank_import_jobs SET document_json = ?1 WHERE id = ?2', [
        JSON.stringify(stored).replace('"__Q1__"', canonical)
          .replace('"__Q2__"', '{"answer_value":2.5,"tolerance":1e-2,"big":12345678901234567890}'),
        pending.job]);

      const report = await f.report(pending.job);
      const q1 = report.items.find(item => item.local_id === 'q1')!;
      const q2 = report.items.find(item => item.local_id === 'q2')!;
      expect(q1.status).toBe('unchanged');
      expect(q1.changes).toEqual([]);
      expect(q2.status).toBe('changed');
      const outcome = await f.host.runtime.dispatchInvoke({
        id: 'reparse-lossless', cmd: 'qbank_reparse_report', args: { examId: 'exam_1', jobId: pending.job },
        source: { window: 'main', webview: 'main' },
      });
      if (outcome.kind !== 'ok') throw new Error(JSON.stringify(outcome));
      expect(outcome.json).toContain(`"changes":[{"field":"structured_data","before":${canonical},`
        + '"after":{"answer_value":2.5,"tolerance":1e-2,"big":12345678901234567890}}]');
    } finally { await f.dispose(); }
  });

  // qbank_legacy_reconcile.rs:691-699：保留的 import_state_json 原样写回；非法 JSON 同样保留。
  it('reparse_resolve_keeps_foreign_import_state_text_verbatim', async () => {
    for (const state of [
      '{"schema_version":2,"job_id":"other_job","progress":1.0,"ratio":0.10,"big":12345678901234567890}',
      '{"schema_version":2,"job_id":',
    ]) {
      const f = await fixture();
      try {
        const pending = await f.pending(false);
        f.db.run("UPDATE exam_sheets SET import_state_json = ?1 WHERE id = 'exam_1'", [state]);
        const report = await f.report(pending.job);
        await f.resolve(pending.job, [
          f.decision(report, 'q1', 'keep_existing'),
          f.decision(report, 'q2', 'keep_existing'),
        ], report.report_version);
        expect(f.db.pluck<string | null>("SELECT import_state_json FROM exam_sheets WHERE id = 'exam_1'"))
          .toBe(state);
      } finally { await f.dispose(); }
    }
  });
});
