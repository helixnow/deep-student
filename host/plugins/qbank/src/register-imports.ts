import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type {
  ExamSheetSessionDetailRequest, ExamSheetSessionListRequest, ImportQuestionBankRequest,
  RenameExamSheetSessionRequest, UpdateExamSheetCardsRequest,
} from '../api.ts';
import { listImportingSessions } from '../repository/import-sessions.ts';
import { getExportableFields } from './csv-export.ts';
import {
  CsvImportRegistry, exportQuestionsCsvCommand, getCsvPreviewCommand, importQuestionsCsvCommand,
  type CsvCommandEnv, type CsvExportCommandRequest, type CsvImportCommandRequest,
} from './csv-commands.ts';
import { listExamSheetSessions } from './exam-sheet-sessions.ts';
import { importQuestionBank, importQuestionBankStream, resumeQuestionImport } from './question-import-commands.ts';
import { importCommandDepsOf } from './question-import-wiring.ts';
import { examSheetSessionCall, serviceCall, serviceCallAsync, type QbankPluginDeps } from './plugin-deps.ts';

/** Rust `let _ = app_handle.emit(...)`：按 `updated_mistake_ids` 顺序逐个发送，
 * 发送失败不改变命令结果。 */
function emitMistakeStatusUpdates(ctx: Context, mistakeIds: readonly string[]): void {
  for (const mistakeId of mistakeIds) {
    try {
      ctx.backendEvents.emit('mistake_status_update', { mistake_id: mistakeId });
    } catch { // boundary-allow empty-catch: commands.rs:969/999 `let _ = emit` 显式忽略单次发送失败且 Rust 无日志
    }
  }
}

/** CSV import/export, question-bank import and exam-sheet session commands. */
export function registerImports(deps: QbankPluginDeps): void {
  const { ctx, qbank, log } = deps;
  ctx.commands.register('get_csv_exportable_fields', () => getExportableFields());
  const csvImports = new CsvImportRegistry();
  const csvEnv: CsvCommandEnv = {
    get appDataDir() { return ctx.paths.appDataDir; },
    importHost: () => {
      const repos = ctx.get('vfsRepo') as VfsReposService | undefined;
      return repos === undefined ? null : {
        db: ctx.storage.database('vfs'), questions: repos.questions, exams: repos.exams,
        blobsDir: deps.blobsDir(), log, platform: ctx.app.platform,
      };
    },
    exportHost: () => {
      const repos = ctx.get('vfsRepo') as VfsReposService | undefined;
      return repos === undefined ? null
        : { db: ctx.storage.database('vfs'), questions: repos.questions, log, platform: ctx.app.platform };
    },
    emitProgress: payload => {
      try { ctx.backendEvents.emit('csv_import_progress', payload); }
      catch (error) {
        log.warn(`[csv_import_progress] emit failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    log,
    platform: ctx.app.platform,
  };
  ctx.commands.register<{ filePath: string; rows?: number | null }>('get_csv_preview',
    ({ filePath, rows }) => serviceCallAsync(() => getCsvPreviewCommand(csvEnv, filePath, rows)));
  ctx.commands.register<{ request: CsvImportCommandRequest }>('import_questions_csv',
    ({ request }) => serviceCallAsync(() => importQuestionsCsvCommand(csvEnv, csvImports, request)));
  ctx.commands.register<{ importId: string }>('cancel_questions_csv_import',
    ({ importId }) => csvImports.cancel(importId));
  ctx.commands.register<{ request: CsvExportCommandRequest }>('export_questions_csv',
    ({ request }) => serviceCallAsync(() => exportQuestionsCsvCommand(csvEnv, request)));
  // commands.rs:1265 —— 同步命令，未登记返回 false，否则返回 request_cancel() 的结果。
  ctx.commands.register<{ importId: string }>('cancel_question_bank_import',
    ({ importId }) => qbank.questionImports.cancel(importId));
  // commands.rs:1087 / 1122 / 1285 —— 题目集导入与断点续导。
  const importDeps = importCommandDepsOf(ctx, qbank.questionImports);
  ctx.commands.register<{ request: ImportQuestionBankRequest }>('import_question_bank',
    ({ request }) => serviceCallAsync(() => importQuestionBank(importDeps, request)));
  ctx.commands.register<{ request: ImportQuestionBankRequest }>('import_question_bank_stream',
    ({ request }) => serviceCallAsync(() => importQuestionBankStream(importDeps, request)));
  ctx.commands.register<{ sessionId: string; importId?: string | null }>('resume_question_import',
    ({ sessionId, importId }) => serviceCallAsync(() => resumeQuestionImport(importDeps, sessionId, importId)));
  ctx.commands.register('list_importing_sessions', () => {
    try {
      return listImportingSessions(ctx.storage.database('vfs'), log);
    } catch (error) {
      throw new CommandError(AppError.database(
        `查询中断会话失败: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
  ctx.commands.register<{ request: ExamSheetSessionListRequest }>(
    'list_exam_sheet_sessions', ({ request }) => serviceCall(() => listExamSheetSessions({
      db: ctx.storage.database('vfs'),
      exams: (ctx.get('vfsRepo') as VfsReposService | undefined)?.exams,
      log,
    }, request)));
  ctx.commands.register<{ request: ExamSheetSessionDetailRequest }>(
    'get_exam_sheet_session_detail', ({ request }) => serviceCallAsync(async () => ({
      detail: await examSheetSessionCall(ctx,
        service => service.getExamSheetSessionDetail(request.session_id)),
    })));
  ctx.commands.register<{ request: UpdateExamSheetCardsRequest }>(
    'update_exam_sheet_cards', ({ request }) => serviceCallAsync(async () => {
      const outcome = await examSheetSessionCall(ctx,
        service => service.updateExamSheetCards(request));
      emitMistakeStatusUpdates(ctx, outcome.updated_mistake_ids);
      return { detail: outcome.detail };
    }));
  ctx.commands.register<{ request: RenameExamSheetSessionRequest }>(
    'rename_exam_sheet_session', ({ request }) => serviceCallAsync(async () => {
      // Rust commands.rs:981-1005 走 update_exam_sheet_cards 而不是另一个服务方法：
      // 缺失 exam_name 用空串显式清空，并保留 updated_mistake_ids 的事件副作用。
      const outcome = await examSheetSessionCall(ctx, service => service.updateExamSheetCards({
        session_id: request.session_id,
        exam_name: request.exam_name ?? '',
      }));
      emitMistakeStatusUpdates(ctx, outcome.updated_mistake_ids);
      return { summary: outcome.detail.summary };
    }));
}
