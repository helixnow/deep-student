import type { SqlExecutor } from '../../platform/storage/api.ts';
import type {
  AnswerSubmission, CreateQuestionParams, Question, QuestionFilters, QuestionHistory,
  QuestionListResult, SubmitAnswerResult, UpdateQuestionParams, BatchResult,
  dstu_vfs__vfs__repos__question_repo__QuestionBankStats as QuestionBankStats,
} from '../../../contracts/ipc/generated/L14-qbank.ts';

export type * from '../../../contracts/ipc/generated/L14-qbank.ts';
export type { dstu_vfs__vfs__repos__question_repo__QuestionType as QuestionType } from '../../../contracts/ipc/generated/L14-qbank.ts';

/** qbank 服务版本描述（ARCHITECTURE.md §3）。 */
export const qbankService = { name: 'qbank', version: '1.0.0' } as const;

/** qbank: business operations corresponding to QuestionBankService in dstu-qbank.
 * All writes, including verdict/mastery/sync updates, use the same VFS connection.
 * Service failures carry the AppError wire value (as CommandError).
 */
export interface QbankService {
  getQuestion(questionId: string): Question | null;
  getQuestionByCardId(examId: string, cardId: string): Question | null;
  listQuestions(examId: string, filters: QuestionFilters, page: number, pageSize: number): QuestionListResult;
  createQuestion(params: CreateQuestionParams): Question;
  batchCreateQuestions(params: CreateQuestionParams[]): Question[];
  updateQuestion(questionId: string, params: UpdateQuestionParams, recordHistory: boolean): Question;
  batchUpdateQuestions(questionIds: string[], params: UpdateQuestionParams): BatchResult;
  deleteQuestion(questionId: string): void;
  batchDeleteQuestions(questionIds: string[]): BatchResult;
  submitAnswer(questionId: string, userAnswer: string, isCorrectOverride: boolean | null, clientRequestId: string | null): SubmitAnswerResult;
  regradeSubmission(questionId: string, submissionId: string, isCorrect: boolean): SubmitAnswerResult;
  getStats(examId: string): QuestionBankStats | null;
  refreshStats(examId: string): QuestionBankStats;
  getHistory(questionId: string, limit: number): QuestionHistory[];
  getSubmissions(questionId: string, limit: number): AnswerSubmission[];
  /** `question_export_service/vfs_hook.rs::ExamDocumentExporter::export_document`。
   * L13 的 DSTU 导出通过 `QbankExportHook` 取原始题目集文档；错误以 Rust `AppError`
   * 的显示文本抛出（trait 返回 `Result<Value, String>`）。 */
  exportDocument(examId: string): unknown;
  /** qbank-owned rows that follow an exam sheet (D1 `*WithConn`; caller owns the savepoint). */
  readonly examCascade: QbankExamCascade;
}

/**
 * Rust runs these statements inside `dstu-vfs` exam_repo / qbank_helpers; the tables
 * (`qbank_sources/materials/groups/group_materials/papers/practice_attempts/practice_drafts`)
 * are owned by qbank. L11 passes its own savepoint connection, so atomicity is unchanged.
 * Errors are thrown as-is (rusqlite / serde_json failures); L11 keeps its own error mapping.
 */
export interface QbankExamCascade {
  /** `exam_repo.rs:2115 copy_authoring_entities`: old id → new id for sources, materials and groups. */
  copyAuthoringEntitiesWithConn(conn: SqlExecutor, srcExamId: string, targetExamId: string,
    now: string): Map<string, string>;
  /** `exam_repo.rs:902-911`, excluding `questions` and `folder_items`. */
  softDeleteForExamWithConn(conn: SqlExecutor, examId: string, now: string, deletionBatch: string): void;
  /** `exam_repo.rs:1246-1254`, excluding `questions` and `folder_items`. */
  restoreForExamWithConn(conn: SqlExecutor, examId: string, now: string, deletionBatch: string | null): void;
  /** `qbank_helpers.rs:20 retains_asset` (read only). */
  retainsAssetWithConn(conn: SqlExecutor, value: string): boolean;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    qbank: QbankService;
  }
}
