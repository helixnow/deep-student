/**
 * The plugin's observable surface — commands, services and tool executors — is
 * frozen here so splitting `apply()` into `src/register-*.ts` modules cannot add,
 * drop or rename anything.
 */
import fs from 'node:fs';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import type { AgentToolExecutor } from '../../agent-skills/api.ts';
import type { GenerationSessions } from '../src/generation-session.ts';
import type { QuestionImportCancellations } from '../src/question-import-cancellation.ts';
import qbank from '../index.ts';
import { createMigratedStorage } from './support/storage.ts';

const COMMANDS = [
  'cancel_question_bank_import', 'cancel_questions_csv_import', 'export_questions_csv',
  'get_csv_exportable_fields', 'get_csv_preview', 'get_enhanced_statistics',
  'get_exam_sheet_session_detail', 'get_learning_heatmap', 'import_question_bank',
  'import_question_bank_stream', 'import_questions_csv', 'inspect_pdf_text_for_qbank',
  'list_exam_sheet_sessions', 'list_importing_sessions', 'qbank_ai_generate_questions',
  'qbank_ai_grade', 'qbank_batch_create_questions', 'qbank_batch_delete_questions',
  'qbank_batch_update_questions', 'qbank_cancel_generation_task', 'qbank_cancel_grading',
  'qbank_commit_authoring_draft', 'qbank_complete_paper_export', 'qbank_count_by_type',
  'qbank_create_practice', 'qbank_create_question', 'qbank_crop_source_image',
  'qbank_delete_group', 'qbank_delete_material', 'qbank_delete_practice', 'qbank_delete_question',
  'qbank_export_document', 'qbank_export_paper_docx', 'qbank_export_portable',
  'qbank_generate_mock_exam', 'qbank_generate_paper', 'qbank_get_activity_heatmap',
  'qbank_get_authoring_draft', 'qbank_get_check_in_calendar', 'qbank_get_daily_practice',
  'qbank_get_generation_task', 'qbank_get_history', 'qbank_get_knowledge_stats',
  'qbank_get_knowledge_stats_with_comparison', 'qbank_get_learning_trend', 'qbank_get_paper',
  'qbank_get_practice', 'qbank_get_question', 'qbank_get_question_by_card_id',
  'qbank_get_source_images', 'qbank_get_source_page', 'qbank_get_stats', 'qbank_get_submissions',
  'qbank_grade_practice_manually', 'qbank_legacy_audit', 'qbank_legacy_migrate_selected',
  'qbank_list_authoring_drafts', 'qbank_list_generation_tasks', 'qbank_list_mistakes',
  'qbank_list_papers', 'qbank_list_practices', 'qbank_list_questions', 'qbank_list_structure',
  'qbank_rebuild_fts_index', 'qbank_refresh_stats', 'qbank_remove_question_image',
  'qbank_reparse_report', 'qbank_reparse_resolve', 'qbank_reset_progress',
  'qbank_reset_questions_progress', 'qbank_resolve_authoring_route',
  'qbank_resume_practice_grading', 'qbank_retry_practice_grading', 'qbank_review_authoring_draft',
  'qbank_save_practice', 'qbank_search_questions', 'qbank_start_timed_practice',
  'qbank_submit_answer', 'qbank_submit_mock_exam', 'qbank_submit_practice',
  'qbank_toggle_favorite', 'qbank_update_group', 'qbank_update_material', 'qbank_update_paper',
  'qbank_update_question', 'rename_exam_sheet_session', 'resume_question_import',
  'update_exam_sheet_cards',
];

it('declares and registers exactly the frozen command set, service and executor', async () => {
  expect(COMMANDS).toHaveLength(88);
  expect([...(qbank.meta.commands ?? [])].sort()).toEqual(COMMANDS);
  expect(qbank.meta.provides).toEqual(['qbank']);
  expect(qbank.inject).toEqual(['storage', 'paths']);

  const { storage, base } = await createMigratedStorage('qbank-surface-');
  const executors: string[] = [];
  const host = await createTestHost({
    plugins: [qbank],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-surface' } }),
      agentTools: {
        registerToolExecutors(list: readonly AgentToolExecutor[]) {
          executors.push(...list.map(executor => executor.name()));
          return { dispose: () => undefined };
        },
      },
    },
  });
  try {
    const entries = (host.ctx.commands as unknown as {
      _entries(): Array<{ name: string; kernel: boolean }>;
    })._entries().filter(entry => !entry.kernel).map(entry => entry.name).sort();
    expect(entries).toEqual(COMMANDS);
    expect(host.ctx.get('qbank')).toBeDefined();
    expect(executors).toEqual(['QBankExecutor']);
  } finally {
    await host.dispose();
    storage.dispose();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// V09 P2-3：卸载 qbank 时取消在途的出题会话与题目导入，管线不再用已卸载的 ctx 写库发事件。
it('disposing the plugin cancels in-flight generation sessions and question imports', async () => {
  const { storage, base } = await createMigratedStorage('qbank-dispose-');
  const host = await createTestHost({
    plugins: [qbank],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-dispose' } }),
    },
  });
  try {
    const service = host.ctx.get('qbank') as unknown as {
      generationSessions: GenerationSessions; questionImports: QuestionImportCancellations;
    };
    const cancelled: string[] = [];
    service.generationSessions.register('qbank_generation_stream_a', { cancel: () => { cancelled.push('a'); } });
    service.generationSessions.register('qbank_generation_stream_b', { cancel: () => { cancelled.push('b'); } });
    const running = service.questionImports.register('import-running')!;
    const finished = service.questionImports.register('import-finished')!;
    expect(finished.finishOrCancelled()).toBe(true);

    await host.dispose();
    expect(cancelled.sort()).toEqual(['a', 'b']);
    expect(running.signal.aborted).toBe(true);
    expect(running.finishOrCancelled()).toBe(false);
    expect(finished.signal.aborted).toBe(false);
  } finally {
    await host.dispose();
    storage.dispose();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
