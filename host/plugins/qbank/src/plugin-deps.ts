/**
 * What `index.ts` hands every `register-*.ts` module: the service instance, the
 * per-call host builders and the shared command error mapping.
 */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { ExamSheetSessionError, type ExamSheetSessionService } from '../../media/api.ts';
import type {
  BatchResult, Question, QbankService, QuestionHistory, QuestionSearchFilters, QuestionSearchListResult,
  dstu_vfs__vfs__repos__question_repo__QuestionBankStats as QuestionBankStats,
} from '../api.ts';
import type { MistakeListFilters, MistakeListResult } from '../repository/questions.ts';
import type * as authoring from './authoring-service.ts';
import type * as qbankExport from './export-service.ts';
import type { GenerationCommandHost } from './generation-command.ts';
import type { GenerationSessions } from './generation-session.ts';
import type { GradingEmitter, GradingHost } from './grading-service.ts';
import type * as legacy from './legacy-service.ts';
import type * as management from './management-service.ts';
import type { PaperExportBridge, PaperExportHost } from './paper-export-bridge.ts';
import type { PracticeServiceHost } from './practice-service.ts';
import type { QuestionImportCancellations } from './question-import-cancellation.ts';
import { QbankServiceError, type QuestionServiceHost } from './question-service.ts';
import type * as statistics from './statistics-service.ts';

export interface QbankPluginService extends QbankService {
  /** `AppState.question_import_cancellations`（lib.rs:3579）。 */
  readonly questionImports: QuestionImportCancellations;
  readonly generationSessions: GenerationSessions;
  listMistakes(filters: MistakeListFilters, page: number, pageSize: number): MistakeListResult;
  searchQuestions(keyword: string, examId: string | null, filters: QuestionSearchFilters,
    page: number, pageSize: number): QuestionSearchListResult;
  rebuildFtsIndex(): number;
  toggleFavorite(questionId: string): Question;
  countByType(examId: string): Record<string, number>;
  resetProgress(examId: string): QuestionBankStats;
  resetQuestionsProgress(questionIds: string[]): BatchResult;
  deleteQuestion(questionId: string): void;
  getHistory(questionId: string, limit: number | null): QuestionHistory[];
}

export interface QbankPluginDeps {
  readonly ctx: Context;
  readonly qbank: QbankPluginService;
  readonly log: ReturnType<Context['logger']>;
  readonly paperExports: PaperExportBridge;
  paperExportHost(): PaperExportHost;
  blobsDir(): string;
  questionHost(): QuestionServiceHost;
  gradingHost(): GradingHost;
  generationHost(): GenerationCommandHost;
  gradingEmitter(): GradingEmitter;
  practiceHost(): Promise<PracticeServiceHost>;
  statisticsHost(): statistics.StatisticsServiceHost;
  managementHost(): management.ManagementHost;
  authoringHost(): authoring.AuthoringHost;
  legacyHost(): legacy.LegacyHost;
  exportHost(): qbankExport.ExportHost;
}

export function serviceCall<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof QbankServiceError) throw new CommandError(error.appError);
    throw new CommandError(AppError.database(error instanceof Error ? error.message : String(error)));
  }
}

export async function serviceCallAsync<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof QbankServiceError) throw new CommandError(error.appError);
    throw new CommandError(AppError.database(error instanceof Error ? error.message : String(error)));
  }
}

export async function examSheetSessionCall<T>(ctx: Context,
  operation: (service: ExamSheetSessionService) => Promise<T>): Promise<T> {
  const service = ctx.get('examSheetSession') as ExamSheetSessionService | undefined;
  if (service === undefined) {
    throw new QbankServiceError(AppError.configuration('整卷会话服务未提供'));
  }
  try {
    return await operation(service);
  } catch (error) {
    // Rust 的 `?` 原样转给命令层：只解包 L18 的 AppError 线缆值，其它异常走既有分类。
    if (error instanceof ExamSheetSessionError) throw new QbankServiceError(error.appError);
    throw error;
  }
}
