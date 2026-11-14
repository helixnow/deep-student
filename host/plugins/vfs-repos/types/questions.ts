/** Question bank wire types and connection-bound repository contract. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { JsonValue } from './common.ts';

export type QuestionType = 'single_choice' | 'multiple_choice' | 'indefinite_choice' | 'fill_blank' | 'short_answer' | 'essay' | 'calculation' | 'proof' | 'true_false' | 'matching' | 'ordering' | 'numeric' | 'other';
export type Difficulty = 'easy' | 'medium' | 'hard' | 'very_hard';
export type QuestionStatus = 'new' | 'in_progress' | 'mastered' | 'review';
export type SourceType = 'ocr' | 'imported' | 'ai_generated' | 'manual';
export type SearchSortBy = 'relevance' | 'created_desc' | 'created_asc' | 'updated_desc';
export interface QuestionOption { key: string; content: string }
export interface QuestionImage { id: string; name: string; mime: string; hash: string; role?: string }
/** Shared pure VFS data, re-exported by Rust's qbank_document module. */
export interface SourceRef { source_id: string; page: number | null; bbox: [number, number, number, number] | null }
export interface QuestionMaterial { id: string; content: string; images: QuestionImage[]; source_refs: SourceRef[]; version: number }
export interface Question {
  id: string;
  exam_id: string;
  card_id: string | null;
  question_label: string | null;
  content: string;
  options: QuestionOption[] | null;
  answer: string | null;
  explanation: string | null;
  structured_data: JsonValue;
  question_type: QuestionType;
  difficulty: Difficulty | null;
  tags: string[];
  status: QuestionStatus;
  user_answer: string | null;
  is_correct: boolean | null;
  attempt_count: number;
  correct_count: number;
  last_attempt_at: string | null;
  user_note: string | null;
  is_favorite: boolean;
  is_bookmarked: boolean;
  source_type: SourceType;
  source_ref: string | null;
  images: QuestionImage[];
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  ai_feedback: string | null;
  ai_score: number | null;
  ai_graded_at: string | null;
  group_id: string | null;
  group_position: number | null;
  group_label: string | null;
  materials: QuestionMaterial[];
  answer_origin: string | null;
  source_refs: SourceRef[];
  answer_source_refs: SourceRef[];
  source_key: string | null;
}
export interface AnswerSubmission {
  id: string; question_id: string; user_answer: string; is_correct: boolean | null;
  grading_method: string; submitted_at: string;
}
/** question_bank_service.rs:820-957 `VerdictApplyOutcome` (mastery/stats are caller-owned). */
export interface VerdictApplyOutcome {
  changed: boolean;
  updated_question: Question;
  submission: AnswerSubmission;
}
/** `question_service.rs:631-663` 的当日进度读取结果。 */
export interface QuestionDailyProgress { ids: string[]; correct: number }
/**
 * 创建后的出题/迁移元数据补写（authoring.ts:364-366、377）。只写列，不推进
 * `updated_at`/`sync_status`/`content_hash`，与 L14 原 SQL 一致。
 */
export interface QuestionMetadataPatch {
  card_id?: string | null;
  group_id?: string | null;
  group_position?: number | null;
  source_key?: string | null;
  provenance?: JsonValue;
  answer_origin?: string | null;
  parent_id?: string | null;
}
/** `management.ts:170,207,222,274` 的题组成员变更条件。 */
export interface QuestionGroupMembershipPatch {
  group_id: string | null;
  group_position: number | null;
  exam_id?: string | null;
  /** `undefined` = 不校验；`null` = 要求 group_id IS NULL；字符串 = 要求等于该值。 */
  expected_group_id?: string | null;
  /** 追加 `(group_id IS NULL OR group_id = <group_id>)`（management.ts:222）。 */
  allow_existing_group?: boolean;
}
/** `legacy.ts:831-844` `replace_existing` 重解析写入。 */
export interface ReparseQuestionParams {
  content: string;
  options: QuestionOption[] | null;
  answer: string | null;
  explanation: string | null;
  question_type: QuestionType;
  difficulty: Difficulty | null;
  tags: string[];
  structured_data: JsonValue;
  /** 空数组/`null` 时保留原图（SQL `COALESCE(?9, images_json)`）。 */
  images?: QuestionImage[] | null;
  provenance_marker: JsonValue;
}
export interface SubmissionSnapshot {
  submission_id: string; question_snapshot_json: string | null; material_snapshot_json: string | null;
}
export interface QuestionFilters {
  status?: QuestionStatus[] | null; difficulty?: Difficulty[] | null; question_type?: QuestionType[] | null;
  tags?: string[] | null; search?: string | null; is_favorite?: boolean | null; is_bookmarked?: boolean | null;
}
export interface QuestionListResult { questions: Question[]; total: number; page: number; page_size: number; has_more: boolean }
export interface MistakeListFilters { exam_id?: string | null; search?: string | null; sort?: string | null }
export type MistakeQuestion = Question & { exam_name: string | null };
export interface MistakeExamCount { exam_id: string; exam_name: string | null; count: number }
export interface MistakeListResult {
  items: MistakeQuestion[]; total: number; page: number; page_size: number; has_more: boolean; exams: MistakeExamCount[];
}
export interface QuestionSearchResult {
  question: Question; highlight_content: string | null; highlight_answer: string | null;
  highlight_explanation: string | null; relevance_score: number;
}
export interface QuestionSearchListResult {
  results: QuestionSearchResult[]; total: number; page: number; page_size: number; has_more: boolean; search_time_ms: number;
}
export type QuestionSearchFilters = QuestionFilters & { sort_by?: SearchSortBy | null };
export interface CreateQuestionParams {
  exam_id: string; content: string; card_id?: string | null; question_label?: string | null;
  options?: QuestionOption[] | null; answer?: string | null; explanation?: string | null;
  structured_data?: JsonValue; question_type?: QuestionType | null; difficulty?: Difficulty | null;
  tags?: string[] | null; source_type?: SourceType | null; source_ref?: string | null;
  images?: QuestionImage[] | null; parent_id?: string | null;
}
export interface UpdateQuestionParams {
  question_label?: string | null; content?: string | null; options?: QuestionOption[] | null;
  answer?: string | null; explanation?: string | null; structured_data?: JsonValue;
  question_type?: QuestionType | null; difficulty?: Difficulty | null; tags?: string[] | null;
  status?: QuestionStatus | null; user_answer?: string | null; is_correct?: boolean | null;
  user_note?: string | null; is_favorite?: boolean | null; is_bookmarked?: boolean | null;
  images?: QuestionImage[] | null; expected_updated_at?: string;
}
export interface QuestionHistory {
  id: string; question_id: string; field_name: string; old_value: string | null;
  new_value: string | null; operator: string; reason: string | null; created_at: string;
}
export interface QuestionBankStats {
  exam_id: string; total_count: number; new_count: number; in_progress_count: number;
  mastered_count: number; review_count: number; total_attempts: number; total_correct: number;
  correct_rate: number; updated_at: string;
}
/** Connection-bound question operations. updateQuestion/submitAnswer include the Rust sync_status/content_hash side effects on `questions`; markAsModified/updateContentHash/updateAiFeedback/updateAiAnalysis expose those atomic writes for L14 orchestration on the caller's conn. */
export interface QuestionRepository {
  getQuestion(conn: SqlExecutor, id: string): Question | null;
  getQuestionByCardId(conn: SqlExecutor, examId: string, cardId: string): Question | null;
  getQuestionsByIds(conn: SqlExecutor, ids: readonly string[]): Question[];
  hydrateQuestionContext(conn: SqlExecutor, questions: Question[]): void;
  listQuestions(conn: SqlExecutor, examId: string, filters: QuestionFilters, page: number, pageSize: number): QuestionListResult;
  listMistakes(conn: SqlExecutor, filters: MistakeListFilters, page: number, pageSize: number): MistakeListResult;
  searchQuestions(conn: SqlExecutor, keyword: string, examId: string | null, filters: QuestionSearchFilters, page: number, pageSize: number): QuestionSearchListResult;
  rebuildFtsIndex(conn: SqlExecutor): number;
  canonicalQuestions(conn: SqlExecutor, examId: string): Question[];
  canonicalText(conn: SqlExecutor, examId: string): string;
  invalidateExamContentIndex(conn: SqlExecutor, examId: string): void;
  examIdForQuestion(conn: SqlExecutor, id: string): string | null;
  createQuestion(conn: SqlExecutor, params: CreateQuestionParams): Question;
  batchCreateQuestions(conn: SqlExecutor, params: readonly CreateQuestionParams[]): Question[];
  updateQuestion(conn: SqlExecutor, id: string, params: UpdateQuestionParams): Question;
  /** authoring.ts:364-366/377：创建后的卡片/题组/来源元数据补写，不推进同步状态。 */
  applyQuestionMetadata(conn: SqlExecutor, id: string, params: QuestionMetadataPatch): Question;
  /** legacy.ts:349-350 `bindMigratedCard` 的卡片身份写入（推进 updated_at）。 */
  bindQuestionCard(conn: SqlExecutor, examId: string, cardId: string, questionId: string, now: string): number;
  /** legacy.ts:356-358/855-856 的 `json_patch(provenance_json, ...)`。 */
  mergeQuestionProvenance(conn: SqlExecutor, questionId: string, patch: JsonValue): number;
  /** legacy.ts:831-844 `replace_existing` 重解析覆盖（OCC + 同步标记 + 来源补丁）。 */
  replaceQuestionForReparse(conn: SqlExecutor, examId: string, questionId: string,
    expectedUpdatedAt: string, params: ReparseQuestionParams, now: string): number;
  /** management.ts:170/207/222/274 的题组成员写入，返回 `sqlite3_changes()`。 */
  updateQuestionGroupMembership(conn: SqlExecutor, questionId: string,
    patch: QuestionGroupMembershipPatch): number;
  /** management.ts:288-291 删除题组时软删成员并清空题组字段。 */
  softDeleteQuestionInGroup(conn: SqlExecutor, questionId: string, examId: string, now: string): number;
  submitAnswer(conn: SqlExecutor, questionId: string, userAnswer: string, isCorrect: boolean | null,
    needsManualGrading: boolean): Question;
  /** question_bank_service.rs:820-957：submission 改判 + 题目的 correct_count/status + 同步标记/内容哈希。 */
  applySubmissionVerdict(conn: SqlExecutor, questionId: string, submissionId: string,
    isCorrect: boolean, gradingMethod: string, now: string): VerdictApplyOutcome;
  /** question_bank_service.rs:1725-1790 `reset_progress` 的全部 L11 表写入。 */
  resetExamProgress(conn: SqlExecutor, examId: string, now: string): QuestionBankStats;
  /** question_bank_service.rs:1793-1916 单题重置（含 submission 删除），返回 exam_id。 */
  resetQuestionProgress(conn: SqlExecutor, questionId: string, now: string): string;
  /**
   * qbank_grading/pipeline.rs:596-601 Grade 分支 AI 缓存写入：`ai_feedback/ai_score/ai_graded_at/updated_at`
   * （后两者 = `now`），仅未删除行；返回 `sqlite3_changes()`。SQLite 错误原样抛出 `StorageError`，
   * 由调用方包装为 `保存 AI 反馈失败: …`；0 行时的 not_found 也由调用方判断。
   */
  updateAiFeedback(conn: SqlExecutor, questionId: string, feedback: string, score: number | null, now: string): number;
  /** pipeline.rs:602-607 Analyze 分支：只写 `ai_feedback/ai_graded_at/updated_at`，保留 `ai_score`；错误语义同上。 */
  updateAiAnalysis(conn: SqlExecutor, questionId: string, feedback: string, now: string): number;
  /**
   * pipeline.rs:680-688：仅条件 UPDATE explanation（NULL 或空格/tab/LF/CR），返回原 changes。
   * 使用传入 conn；输入判空、history、mark/hash 由 L14 编排；SQLite 错误原样传播。
   * 不主动更新其他列；schema 的 updated_at/FTS/change_log 触发器照常执行。
   */
  fillExplanationIfEmpty(conn: SqlExecutor, id: string, explanation: string): number;
  /**
   * question_sync_service.rs:1518-1531 `mark_as_modified_with_conn`：仅 `synced → modified`，其他状态与
   * 已删除行不变；行不存在不报错。SQLite 错误为 `VFS_STORAGE` / `Database error: …`。
   */
  markAsModified(conn: SqlExecutor, questionId: string): void;
  /**
   * question_sync_service.rs:1540-1556 `update_content_hash_with_conn`：按 `get_question_by_id` 读未删除题目、
   * 以 `compute_content_hash`（:471-517）计算并写 `content_hash`（只写此列），返回 hash。题目缺失或行转换失败为
   * `VFS_NOT_FOUND` / `question not found: <id>`；prepare/UPDATE 失败为 `VFS_STORAGE`。
   */
  updateContentHash(conn: SqlExecutor, questionId: string): string;
  deleteQuestion(conn: SqlExecutor, id: string): void;
  deleteQuestionIfVersion(conn: SqlExecutor, id: string, expectedUpdatedAt: string): void;
  batchDeleteQuestions(conn: SqlExecutor, ids: readonly string[]): number;
  countQuestions(conn: SqlExecutor, examId: string): number;
  countByType(conn: SqlExecutor, examId: string): Record<string, number>;
  randomQuestionIds(conn: SqlExecutor, examId: string, filters: QuestionFilters, excludeIds: readonly string[], lastAttemptBefore: string | null, limit: number): string[];
  randomQuestions(conn: SqlExecutor, examId: string, filters: QuestionFilters, excludeIds: readonly string[], limit: number): Question[];
  recordHistory(conn: SqlExecutor, questionId: string, fieldName: string, oldValue: string | null, newValue: string | null, operator: string, reason: string | null): QuestionHistory;
  getHistory(conn: SqlExecutor, questionId: string, limit?: number | null): QuestionHistory[];
  getStats(conn: SqlExecutor, examId: string): QuestionBankStats | null;
  refreshStats(conn: SqlExecutor, examId: string): QuestionBankStats;
  insertSubmission(conn: SqlExecutor, questionId: string, userAnswer: string, isCorrect: boolean | null, gradingMethod: string, clientRequestId: string | null, questionSnapshotJson?: string | null, materialSnapshotJson?: string | null): string;
  getSubmissionSnapshot(conn: SqlExecutor, submissionId: string): SubmissionSnapshot | null;
  buildSubmissionSnapshots(conn: SqlExecutor, questionId: string): [string | null, string | null];
  getSubmissions(conn: SqlExecutor, questionId: string, limit: number): AnswerSubmission[];
  getSubmissionsWithSnapshots(conn: SqlExecutor, questionId: string, limit: number): [AnswerSubmission, SubmissionSnapshot][];
  getSubmissionByClientRequest(conn: SqlExecutor, questionId: string, requestId: string): AnswerSubmission | null;
  getSubmissionById(conn: SqlExecutor, submissionId: string): AnswerSubmission | null;
  /** question_bank_service.rs:665-709 提交后 best-effort 快照读取；调用方负责日志降级。 */
  dailyProgressRows(conn: SqlExecutor, examId: string, date: string): QuestionDailyProgress;
  updateSubmissionCorrect(conn: SqlExecutor, submissionId: string, isCorrect: boolean, gradingMethod: string): void;
  deleteSubmissionsByQuestion(conn: SqlExecutor, questionId: string): number;
  deleteSubmissionsByExam(conn: SqlExecutor, examId: string): number;
}
