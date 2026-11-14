import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import qbank from '../index.ts';
import { vfsTestPorts, vfsTestServices } from './support/vfs-ports.ts';
import * as authoring from '../src/authoring-service.ts';
import { readDraft } from '../repository/authoring.ts';
import type { DraftQuestion, QuestionDocument, ReparseReport } from '../api.ts';

const NOW = '2026-01-01T00:00:00+00:00';

function draft(localId: string): DraftQuestion {
  return {
    local_id: localId, group_id: null, original_label: localId === 'q1' ? '1' : '2',
    section_path: [], content: localId === 'q1' ? 'draft content' : 'draft two',
    question_type: 'short_answer', options: null, answer: null, explanation: null,
    structured_data: null, difficulty: null, tags: [],
    source_refs: [{ source_id: 'src1', page: 1, bbox: [0.1, 0.1, 0.9, 0.9] }],
    answer_source_refs: [], figures: [], images: [], answer_origin: null, smiles: null,
    smiles_caption: null, parent_id: null, parent_local_id: null, source_ref: null,
  };
}

function documentWith(questions: DraftQuestion[]): QuestionDocument {
  return {
    schema_version: 2, mode: 'extract', materials: [], groups: [], questions,
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
  const { storage, base } = await createMigratedStorage('qbank-reconcile-import-state-');
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
    VALUES ('exam_1', 'reconcile import state', 'empty', 'tmp_reconcile', '{}', '{"pages":[]}', ?1, ?1)`,
  [NOW]);
  for (const localId of ['q1', 'q2']) {
    const job = authoring.saveDraft({ db, ...vfsTestPorts(db) }, 'exam_1',
      documentWith([draft(localId)]), metadata());
    authoring.commitDraft({ db, ...vfsTestPorts(db) }, job, [localId], readDraft(db, job).version);
  }
  const job = authoring.saveDraft({ db, ...vfsTestPorts(db) }, 'exam_1',
    documentWith([draft('q1'), draft('q2')]), metadata());

  return {
    db, job,
    sheetChangeCount(): number {
      return db.pluck<number>(
        "SELECT COUNT(*) FROM __change_log WHERE table_name = 'exam_sheets' AND record_id = 'exam_1'")!;
    },
    sheet(): { import_state_json: string | null; updated_at: string } {
      return db.get<{ import_state_json: string | null; updated_at: string }>(
        "SELECT import_state_json, updated_at FROM exam_sheets WHERE id = 'exam_1'")!;
    },
    async keepAll(): Promise<void> {
      const report = await host.invoke('qbank_reparse_report', { examId: 'exam_1', jobId: job }) as ReparseReport;
      await host.invoke('qbank_reparse_resolve', {
        examId: 'exam_1', jobId: job, expectedReportVersion: report.report_version,
        decisions: report.items.map(item => ({
          local_id: item.local_id, action: 'keep_existing', expected_revision: null,
        })),
      });
    },
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

// qbank_legacy_reconcile.rs:691-699：无论导入状态属于谁，都执行一次
// `UPDATE exam_sheets SET import_state_json=?1 WHERE id=?2`（不改 updated_at），
// exam_sheets 的 AFTER UPDATE 触发器因此恰好记一行 __change_log。
describe('qbank reparse resolve writes exam_sheets.import_state_json unconditionally', () => {
  it('foreign import state is written back verbatim with exactly one change_log row', async () => {
    const f = await fixture();
    try {
      const state = '{"schema_version":2,"job_id":"other_job","progress":1.0,"ratio":0.10,"big":12345678901234567890}';
      f.db.run("UPDATE exam_sheets SET import_state_json = ?1 WHERE id = 'exam_1'", [state]);
      const before = f.sheet();
      const count = f.sheetChangeCount();
      await f.keepAll();
      expect(f.sheetChangeCount()).toBe(count + 1);
      expect(f.sheet()).toEqual({ import_state_json: state, updated_at: before.updated_at });
    } finally { await f.dispose(); }
  });

  it('import state owned by the resolved draft becomes NULL with exactly one change_log row', async () => {
    const f = await fixture();
    try {
      f.db.run("UPDATE exam_sheets SET import_state_json = ?1 WHERE id = 'exam_1'",
        [`{"schema_version":2,"job_id":"${f.job}"}`]);
      const before = f.sheet();
      const count = f.sheetChangeCount();
      await f.keepAll();
      expect(f.sheetChangeCount()).toBe(count + 1);
      expect(f.sheet()).toEqual({ import_state_json: null, updated_at: before.updated_at });
    } finally { await f.dispose(); }
  });

  it('NULL import state stays NULL with exactly one change_log row', async () => {
    const f = await fixture();
    try {
      f.db.run("UPDATE exam_sheets SET import_state_json = NULL WHERE id = 'exam_1'");
      const before = f.sheet();
      const count = f.sheetChangeCount();
      await f.keepAll();
      expect(f.sheetChangeCount()).toBe(count + 1);
      expect(f.sheet()).toEqual({ import_state_json: null, updated_at: before.updated_at });
    } finally { await f.dispose(); }
  });
});
