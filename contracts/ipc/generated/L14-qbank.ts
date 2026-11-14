// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L14-qbank.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** dstu_qbank::question_bank_service::ActivityHeatmapPoint */
export type ActivityHeatmapPoint = {
  date: string;
  count: number;
  correct_count: number;
  level: number;
};
/** dstu_vfs::vfs::repos::question_repo::AnswerSubmission */
export type AnswerSubmission = {
  id: string;
  question_id: string;
  user_answer: string;
  is_correct: boolean | null;
  grading_method: string;
  submitted_at: string;
};
/** dstu_qbank::qbank_authoring_service::AuthoringCommitReceipt */
export type AuthoringCommitReceipt = {
  committed: boolean;
  exam_id: string;
  question_ids: string[];
  material_ids: string[];
  group_ids: string[];
  imported_count: number;
  total_questions: number;
  partial: boolean;
  needs_review: boolean;
  coverage: unknown[];
  unmatched_answers: unknown[];
};
/** dstu_qbank::question_bank_service::BatchResult */
export type BatchResult = {
  success_count: number;
  failed_count: number;
  errors: string[];
};
/** deep_student_lib::commands::BatchUpdateQuestionsRequest */
export type BatchUpdateQuestionsRequest = {
  question_ids: string[];
  params: UpdateQuestionParams;
};
/** dstu_qbank::question_bank_service::CheckInCalendar */
export type CheckInCalendar = {
  exam_id: string | null;
  year: number;
  month: number;
  days: DailyCheckIn[];
  streak_days: number;
  month_check_in_days: number;
  month_total_questions: number;
  month_focus_seconds: number;
};
/** dstu_qbank::qbank_practice::CreatePracticeRequest */
export type CreatePracticeRequest = {
  id: string;
  scope_id: string;
  title: string;
  mode: string;
  question_ids?: string[];
  paper_id?: string | null;
  duration_seconds?: number | null;
  started_at?: string | null;
  attempt_id?: string | null;
  start_question_id?: string | null;
};
/** dstu_vfs::vfs::repos::question_repo::CreateQuestionParams */
export type CreateQuestionParams = {
  exam_id: string;
  card_id?: string | null;
  question_label?: string | null;
  content: string;
  options?: QuestionOption__De[] | null;
  answer?: string | null;
  explanation?: string | null;
  structured_data?: unknown | null;
  question_type?: QuestionType__De | null;
  difficulty?: Difficulty__De | null;
  tags?: string[] | null;
  source_type?: SourceType__De | null;
  source_ref?: string | null;
  images?: QuestionImage__De[] | null;
  parent_id?: string | null;
};
/** deep_student_lib::commands::CropSourceImageRequest */
export type CropSourceImageRequest = {
  question_id: string;
  blob_hash: string;
  crop_x: number;
  crop_y: number;
  crop_width: number;
  crop_height: number;
};
/** deep_student_lib::commands::CsvExportCommandRequest */
export type CsvExportCommandRequest = {
  exam_id: string;
  file_path: string;
  fields?: string[];
  filters?: QuestionFilters | null;
  include_answers?: boolean;
  encoding?: string | null;
};
/** dstu_qbank::question_export_service::CsvExportResult */
export type CsvExportResult = {
  exported_count: number;
  file_path: string;
  file_size: number;
};
/** deep_student_lib::commands::CsvImportCommandRequest */
export type CsvImportCommandRequest = {
  file_path: string;
  exam_id: string;
  field_mapping: { [key: string]: string };
  duplicate_strategy?: string | null;
  folder_id?: string | null;
  exam_name?: string | null;
  import_id?: string | null;
};
/** dstu_qbank::question_import_service::CsvImportError */
export type CsvImportError = {
  row: number;
  message: string;
  raw_data: string | null;
};
/** dstu_qbank::question_import_service::CsvImportProgress */
export type CsvImportProgress = {
  type: "Started";
  total_rows: number;
  file_path: string;
  exam_id: string;
} | {
  type: "Progress";
  current: number;
  total: number;
  success: number;
  skipped: number;
  failed: number;
  exam_id: string;
} | ({
  type: "Completed";
} & CsvImportResult) | ({
  type: "Cancelled";
} & CsvImportResult) | {
  type: "Failed";
  error: string;
  exam_id: string;
};
/** dstu_qbank::question_import_service::CsvImportResult */
export type CsvImportResult = {
  success_count: number;
  skipped_count: number;
  failed_count: number;
  errors: CsvImportError[];
  exam_id: string;
  total_rows: number;
  cancelled: boolean;
};
/** dstu_qbank::question_import_service::CsvPreviewResult */
export type CsvPreviewResult = {
  headers: string[];
  rows: string[][];
  total_rows: number;
  encoding: string;
};
/** deep_student_lib::commands::DailyActivityDetails */
export type DailyActivityDetails = {
  chatSessions: number;
  chatMessages: number;
  notesEdited: number;
  textbooksOpened: number;
  examsCreated: number;
  translationsCreated: number;
  essaysCreated: number;
  ankiCardsCreated: number;
  questionsAnswered: number;
};
/** dstu_qbank::question_bank_service::DailyCheckIn */
export type DailyCheckIn = {
  date: string;
  exam_id: string | null;
  question_count: number;
  correct_count: number;
  study_duration_seconds: number;
  target_achieved: boolean;
};
/** dstu_qbank::question_bank_service::DailyPracticeResult */
export type DailyPracticeResult = {
  date: string;
  exam_id: string;
  question_ids: string[];
  daily_target: number;
  completed_count: number;
  correct_count: number;
  source_distribution: DailySourceDistribution;
  is_completed: boolean;
};
/** dstu_qbank::question_bank_service::DailyProgressSnapshot */
export type DailyProgressSnapshot = {
  date: string;
  exam_id: string;
  answered_question_ids: string[];
  completed_count: number;
  correct_count: number;
};
/** dstu_qbank::question_bank_service::DailySourceDistribution */
export type DailySourceDistribution = {
  mistake_count: number;
  new_count: number;
  review_count: number;
};
/** dstu_qbank::qbank_management::DeleteGroupMode */
export type DeleteGroupMode = "ungroup" | "delete_members";
/** dstu_qbank::qbank_management::DeleteGroupMode */
export type DeleteGroupMode__De = ("ungroup" | "delete_members") | {
  ungroup: null;
} | {
  delete_members: null;
};
/** dstu_qbank::question_bank_service::DifficultyStatItem */
export type DifficultyStatItem = {
  total: number;
  correct: number;
  rate: number;
};
/** dstu_vfs::vfs::repos::question_repo::Difficulty */
export type Difficulty__De = ("easy" | "medium" | "hard" | "very_hard") | {
  easy: null;
} | {
  medium: null;
} | {
  hard: null;
} | {
  very_hard: null;
};
/** dstu_qbank::qbank_document::DraftFigure */
export type DraftFigure = {
  source_id: string;
  page: number | null;
  bbox: number[];
  label: string;
  role: string;
};
/** dstu_qbank::qbank_document::DraftGroup */
export type DraftGroup = {
  local_id: string;
  label: string;
  material_ids: string[];
  question_ids: string[];
};
/** dstu_qbank::qbank_document::DraftMaterial */
export type DraftMaterial = {
  local_id: string;
  content: string;
  source_refs: SourceRef[];
  figures: DraftFigure[];
  images: QuestionImage[];
};
/** dstu_qbank::qbank_document::DraftQuestion */
export type DraftQuestion = {
  local_id: string;
  group_id: string | null;
  original_label: string | null;
  section_path: string[];
  content: string;
  question_type: string;
  options: QuestionOption[] | null;
  answer: string | null;
  explanation: string | null;
  structured_data: unknown | null;
  difficulty: string | null;
  tags: string[];
  source_refs: SourceRef[];
  answer_source_refs: SourceRef[];
  figures: DraftFigure[];
  images: QuestionImage[];
  answer_origin: string | null;
  smiles: string | null;
  smiles_caption: string | null;
  parent_id: string | null;
  parent_local_id: string | null;
  source_ref: string | null;
};
/** dstu_core::models::ExamCardBBox */
export type ExamCardBBox__De = {
  x: number;
  y: number;
  width: number;
  height: number;
};
/** dstu_core::models::ExamCardPreview */
export type ExamCardPreview = {
  card_id: string;
  page_index: number;
  question_label: string;
  bbox: Shared.ExamCardBBox;
  resolved_bbox?: Shared.ExamCardBBox | null;
  cropped_image_path?: string;
  ocr_text: string;
  tags: string[];
  extra_metadata?: unknown | null;
  linked_mistake_ids?: string[] | null;
  question_type?: dstu_core__models__QuestionType | null;
  answer?: string | null;
  explanation?: string | null;
  difficulty?: dstu_core__models__Difficulty | null;
  status: dstu_core__models__QuestionStatus;
  user_answer?: string | null;
  is_correct?: boolean | null;
  attempt_count: number;
  correct_count: number;
  last_attempt_at?: string | null;
  user_note?: string | null;
  source_type: dstu_core__models__SourceType;
  source_info?: unknown | null;
  parent_card_id?: string | null;
  variant_ids?: string[] | null;
};
/** dstu_core::models::ExamSheetCardCreate */
export type ExamSheetCardCreate = {
  page_index: number;
  bbox?: ExamCardBBox__De | null;
  resolved_bbox?: ExamCardBBox__De | null;
  question_label?: string | null;
  ocr_text?: string | null;
  tags?: string[] | null;
};
/** dstu_core::models::ExamSheetCardUpdate */
export type ExamSheetCardUpdate = {
  card_id: string;
  page_index?: number | null;
  bbox?: ExamCardBBox__De | null;
  resolved_bbox?: ExamCardBBox__De | null;
  question_label?: string | null;
  ocr_text?: string | null;
  tags?: string[] | null;
};
/** dstu_core::models::ExamSheetPreviewPage */
export type ExamSheetPreviewPage = {
  page_index: number;
  blob_hash?: string | null;
  width?: number | null;
  height?: number | null;
  original_image_path?: string;
  cards: ExamCardPreview[];
  raw_ocr_text?: string | null;
  ocr_completed: boolean;
  parse_completed: boolean;
};
/** dstu_core::models::ExamSheetPreviewResult */
export type ExamSheetPreviewResult = {
  temp_id: string;
  exam_name: string | null;
  pages: ExamSheetPreviewPage[];
  raw_model_response?: unknown | null;
  instructions?: string | null;
  session_id?: string | null;
};
/** dstu_core::models::ExamSheetSessionDetail */
export type ExamSheetSessionDetail = {
  summary: ExamSheetSessionSummary;
  preview: ExamSheetPreviewResult;
};
/** dstu_core::models::ExamSheetSessionDetailRequest */
export type ExamSheetSessionDetailRequest = {
  session_id: string;
};
/** dstu_core::models::ExamSheetSessionDetailResponse */
export type ExamSheetSessionDetailResponse = {
  detail: ExamSheetSessionDetail;
};
/** dstu_core::models::ExamSheetSessionListRequest */
export type ExamSheetSessionListRequest = {
  limit?: number | null;
};
/** dstu_core::models::ExamSheetSessionListResponse */
export type ExamSheetSessionListResponse = {
  sessions: ExamSheetSessionSummary[];
};
/** dstu_core::models::ExamSheetSessionMetadata */
export type ExamSheetSessionMetadata = {
  instructions?: string | null;
  tags?: string[] | null;
  page_count?: number | null;
  card_count?: number | null;
  raw_model_response?: unknown | null;
  source_type: dstu_core__models__SourceType;
  import_source?: ImportSource | null;
  stats?: dstu_core__models__QuestionBankStats | null;
};
/** dstu_core::models::ExamSheetSessionSummary */
export type ExamSheetSessionSummary = {
  id: string;
  exam_name?: string | null;
  temp_id: string;
  created_at: string;
  updated_at: string;
  status: string;
  metadata?: ExamSheetSessionMetadata | null;
  linked_mistake_ids?: string[] | null;
};
/** dstu_qbank::qbank_practice::export_bridge::ExportRequest */
export type ExportRequest = {
  request_id: string;
  paper: GeneratedPaper;
  format: string;
  include_answers: boolean;
  include_explanations: boolean;
};
/** deep_student_lib::commands::GenerateMockExamRequest */
export type GenerateMockExamRequest = {
  exam_id: string;
  config: MockExamConfig__De;
};
/** deep_student_lib::commands::GeneratePaperRequest */
export type GeneratePaperRequest = {
  exam_id: string;
  config: PaperConfig__De;
};
/** dstu_qbank::question_bank_service::GeneratedPaper */
export type GeneratedPaper = {
  id: string;
  title: string;
  exam_id: string;
  questions: Question[];
  total_score: number;
  config: PaperConfig;
  created_at: string;
  export_path: string | null;
};
/** dstu_qbank::qbank_generation::types::GeneratedQuestionDraft */
export type GeneratedQuestionDraft = {
  local_id?: string | null;
  group_id?: string | null;
  original_label?: string | null;
  question_type: string;
  content: string;
  options: GeneratedQuestionOption[] | null;
  answer: string | null;
  explanation: string | null;
  difficulty: string | null;
  tags: string[] | null;
  structured_data?: unknown | null;
  smiles: string | null;
  smiles_caption: string | null;
  source_ref?: string | null;
};
/** dstu_qbank::qbank_generation::types::GeneratedQuestionOption */
export type GeneratedQuestionOption = {
  key: string;
  content: string;
};
/** dstu_qbank::qbank_generation::task_repo::GenerationTaskStatus */
export type GenerationTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
/** dstu_qbank::qbank_generation::task_repo::GenerationTaskView */
export type GenerationTaskView = {
  id: string;
  examId: string;
  status: GenerationTaskStatus;
  drafts: GeneratedQuestionDraft[];
  rejectedCount: number;
  rejectionReasons: string[];
  skippedReferences: SkippedReference[];
  usedReferenceCount: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  authoringResult: unknown | null;
};
/** deep_student_lib::commands::GetActivityHeatmapRequest */
export type GetActivityHeatmapRequest = {
  exam_id?: string | null;
  year: number;
};
/** deep_student_lib::commands::GetCheckInCalendarRequest */
export type GetCheckInCalendarRequest = {
  exam_id?: string | null;
  year: number;
  month: number;
  daily_target?: number | null;
};
/** deep_student_lib::commands::GetDailyPracticeRequest */
export type GetDailyPracticeRequest = {
  exam_id: string;
  count: number;
};
/** deep_student_lib::commands::GetKnowledgeStatsRequest */
export type GetKnowledgeStatsRequest = {
  exam_id?: string | null;
};
/** deep_student_lib::commands::GetLearningTrendRequest */
export type GetLearningTrendRequest = {
  exam_id?: string | null;
  start_date: string;
  end_date: string;
};
/** dstu_qbank::qbank_grading::types::GradingCompletionStatus */
export type GradingCompletionStatus = "completed" | "cancelled" | "truncated" | "provider_error" | "transport_error" | "incomplete" | "invalid_result" | "configuration_error" | "persistence_error";
/** dstu_qbank::qbank_grading::types::GradingDiagnostics */
export type GradingDiagnostics = {
  status: GradingCompletionStatus;
  model: string;
  model_config_id: string;
  max_output_tokens: number;
  finish_reason: string | null;
  usage: unknown | null;
  response_chars: number;
  reasoning_chars: number;
  http_status: number | null;
  error_message: string | null;
};
/** dstu_qbank::qbank_management::GroupDeleteResult */
export type GroupDeleteResult = {
  exam_id: string;
  group_id: string;
  mode: DeleteGroupMode;
  deleted_question_ids: string[];
  ungrouped_question_ids: string[];
  solo_group_ids: string[];
  material_ids: string[];
};
/** deep_student_lib::commands::ImportQuestionBankRequest */
export type ImportQuestionBankRequest = {
  content: string;
  format: string;
  name?: string | null;
  folder_id?: string | null;
  session_id?: string | null;
  model_config_id?: string | null;
  pdf_prefer_ocr?: boolean | null;
  import_id?: string | null;
  source_ranges?: SourceRange[];
};
/** dstu_core::models::ImportSource */
export type ImportSource = {
  file_name?: string | null;
  file_type?: string | null;
  import_time?: string | null;
};
/** dstu_vfs::vfs::repos::exam_repo::ImportingSession */
export type ImportingSession = {
  session_id: string;
  exam_name: string | null;
  import_state_json: string | null;
  existing_question_count: number;
};
/** deep_student_lib::commands::InspectPdfTextRequest */
export type InspectPdfTextRequest = {
  content: string;
};
/** dstu_qbank::question_bank_service::KnowledgePoint */
export type KnowledgePoint = {
  tag: string;
  total: number;
  mastered: number;
  in_progress: number;
  review: number;
  new_count: number;
  mastery_rate: number;
  correct_rate: number;
};
/** dstu_qbank::question_bank_service::KnowledgeStatsComparison */
export type KnowledgeStatsComparison = {
  current: KnowledgePoint[];
  previous: KnowledgePoint[];
};
/** deep_student_lib::commands::LearningActivity */
export type LearningActivity = {
  date: string;
  count: number;
  details: DailyActivityDetails;
  studySeconds: number;
};
/** dstu_qbank::question_bank_service::LearningTrendPoint */
export type LearningTrendPoint = {
  date: string;
  attempt_count: number;
  correct_count: number;
  correct_rate: number;
};
/** dstu_qbank::qbank_legacy_reconcile::LegacyAuditCard */
export type LegacyAuditCard = {
  card_id: string | null;
  page_index: number;
  card_index: number;
  question_label: string | null;
  preview_text: string;
  status: string;
  formal_question_id: string | null;
  candidate_question_ids: string[];
  deleted_question_ids: string[];
  migratable: boolean;
  reason: string | null;
};
/** dstu_qbank::qbank_legacy_reconcile::LegacyAuditPage */
export type LegacyAuditPage = {
  page_index: number;
  blob_hash: string | null;
  original_image_path: string;
  width: number | null;
  height: number | null;
  card_count: number;
};
/** dstu_qbank::qbank_legacy_reconcile::LegacyMigrationAudit */
export type LegacyMigrationAudit = {
  exam_id: string;
  canonical_marker: boolean;
  canonical_question_count: number;
  source_version: string;
  audit_version: string;
  pages: LegacyAuditPage[];
  cards: LegacyAuditCard[];
  migratable_card_ids: string[];
  matched_count: number;
  unmatched_count: number;
  ambiguous_count: number;
  deleted_count: number;
  invalid_count: number;
  suppressed_count: number;
};
/** dstu_qbank::qbank_legacy_reconcile::LegacyMigrationReceipt */
export type LegacyMigrationReceipt = {
  exam_id: string;
  committed: boolean;
  idempotent: boolean;
  job_id: string | null;
  migrated_card_ids: string[];
  question_ids: string[];
  imported_count: number;
  audit_version_before: string;
  audit_version_after: string | null;
};
/** deep_student_lib::commands::ListMistakesRequest */
export type ListMistakesRequest = {
  filters?: MistakeListFilters;
  page?: number;
  page_size?: number;
};
/** deep_student_lib::commands::ListQuestionsRequest */
export type ListQuestionsRequest = {
  exam_id: string;
  filters?: QuestionFilters | null;
  page?: number;
  page_size?: number;
};
/** dstu_vfs::vfs::repos::question_repo::MistakeExamCount */
export type MistakeExamCount = {
  exam_id: string;
  exam_name: string | null;
  count: number;
};
/** dstu_vfs::vfs::repos::question_repo::MistakeListFilters */
export type MistakeListFilters = {
  exam_id?: string | null;
  search?: string | null;
  sort?: string | null;
};
/** dstu_vfs::vfs::repos::question_repo::MistakeListResult */
export type MistakeListResult = {
  items: MistakeQuestion[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
  exams: MistakeExamCount[];
};
/** dstu_vfs::vfs::repos::question_repo::MistakeQuestion */
export type MistakeQuestion = {
  id: string;
  exam_id: string;
  card_id: string | null;
  question_label: string | null;
  content: string;
  options: QuestionOption[] | null;
  answer: string | null;
  explanation: string | null;
  structured_data: unknown | null;
  question_type: dstu_vfs__vfs__repos__question_repo__QuestionType;
  difficulty: dstu_vfs__vfs__repos__question_repo__Difficulty | null;
  tags: string[];
  status: dstu_vfs__vfs__repos__question_repo__QuestionStatus;
  user_answer: string | null;
  is_correct: boolean | null;
  attempt_count: number;
  correct_count: number;
  last_attempt_at: string | null;
  user_note: string | null;
  is_favorite: boolean;
  is_bookmarked: boolean;
  source_type: dstu_vfs__vfs__repos__question_repo__SourceType;
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
  exam_name: string | null;
};
/** dstu_qbank::question_bank_service::MockExamConfig */
export type MockExamConfig = {
  duration_minutes: number;
  type_distribution: { [key: string]: number };
  difficulty_distribution: { [key: string]: number };
  total_count: number | null;
  shuffle: boolean;
  include_mistakes: boolean;
  tags: string[] | null;
};
/** dstu_qbank::question_bank_service::MockExamConfig */
export type MockExamConfig__De = {
  duration_minutes: number;
  type_distribution: { [key: string]: number };
  difficulty_distribution: { [key: string]: number };
  total_count?: number | null;
  shuffle: boolean;
  include_mistakes: boolean;
  tags?: string[] | null;
};
/** dstu_qbank::question_bank_service::MockExamScoreCard */
export type MockExamScoreCard = {
  session_id: string;
  exam_id: string;
  total_count: number;
  answered_count: number;
  correct_count: number;
  wrong_count: number;
  unanswered_count: number;
  correct_rate: number;
  time_spent_seconds: number;
  type_stats: { [key: string]: TypeStatItem };
  difficulty_stats: { [key: string]: DifficultyStatItem };
  wrong_question_ids: string[];
  comment: string;
  completed_at: string;
};
/** dstu_qbank::question_bank_service::MockExamSession */
export type MockExamSession = {
  id: string;
  exam_id: string;
  config: MockExamConfig;
  question_ids: string[];
  started_at: string;
  ended_at: string | null;
  answers: { [key: string]: string };
  results: { [key: string]: boolean };
  is_submitted: boolean;
  score: number | null;
  correct_rate: number | null;
};
/** dstu_qbank::question_bank_service::MockExamSession */
export type MockExamSession__De = {
  id: string;
  exam_id: string;
  config: MockExamConfig__De;
  question_ids: string[];
  started_at: string;
  ended_at?: string | null;
  answers: { [key: string]: string };
  results: { [key: string]: boolean };
  is_submitted: boolean;
  score?: number | null;
  correct_rate?: number | null;
};
/** dstu_qbank::qbank_practice::export::PaperBlock */
export type PaperBlock = {
  kind: string;
  runs?: PaperRun[] | null;
  level?: number | null;
  rows?: PaperRun[][][] | null;
  image?: string | null;
  width?: number | null;
  height?: number | null;
  lines?: number | null;
  page_break?: boolean | null;
};
/** dstu_qbank::question_bank_service::PaperConfig */
export type PaperConfig = {
  title: string;
  type_selection: { [key: string]: number };
  difficulty_filter: string[] | null;
  tags_filter: string[] | null;
  shuffle: boolean;
  include_answers: boolean;
  include_explanations: boolean;
  export_format: PaperExportFormat;
};
/** dstu_qbank::question_bank_service::PaperConfig */
export type PaperConfig__De = {
  title: string;
  type_selection: { [key: string]: number };
  difficulty_filter?: string[] | null;
  tags_filter?: string[] | null;
  shuffle: boolean;
  include_answers: boolean;
  include_explanations: boolean;
  export_format: PaperExportFormat__De;
};
/** dstu_qbank::question_bank_service::PaperExportFormat */
export type PaperExportFormat = "preview" | "pdf" | "word" | "markdown";
/** dstu_qbank::question_bank_service::PaperExportFormat */
export type PaperExportFormat__De = ("preview" | "pdf" | "word" | "markdown") | {
  preview: null;
} | {
  pdf: null;
} | {
  word: null;
} | {
  markdown: null;
};
/** dstu_qbank::qbank_practice::export::PaperRun */
export type PaperRun = {
  text?: string | null;
  image?: string | null;
  width?: number | null;
  height?: number | null;
  bold?: boolean | null;
  italic?: boolean | null;
};
/** dstu_qbank::question_import_service::PdfTextInspection */
export type PdfTextInspection = {
  valid_char_count: number;
  total_char_count: number;
  preview_text: string;
  recommendation: string;
};
/** dstu_qbank::question_export_service::authoring::PortableExport */
export type PortableExport = {
  base64: string;
  name: string;
};
/** dstu_qbank::qbank_practice::PracticeAttempt */
export type PracticeAttempt = {
  id: string;
  scope_id: string;
  paper_id: string | null;
  title: string;
  mode: string;
  questions: Question[];
  answers: { [key: string]: string };
  marked_ids: string[];
  results: PracticeResult[];
  elapsed_seconds: number;
  duration_seconds: number | null;
  status: string;
  origin_device_id: string;
  created_at: string;
  submitted_at: string;
};
/** dstu_qbank::qbank_practice::PracticeDraft */
export type PracticeDraft = {
  id: string;
  scope_id: string;
  paper_id: string | null;
  title: string;
  mode: string;
  questions: Question[];
  answers: { [key: string]: string };
  marked_ids: string[];
  current_index: number;
  elapsed_seconds: number;
  duration_seconds: number | null;
  deadline: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};
/** dstu_qbank::qbank_practice::PracticeGradingDraft */
export type PracticeGradingDraft = {
  feedback: string;
  error: string;
  diagnostics: GradingDiagnostics | null;
  created_at: string;
};
/** dstu_qbank::qbank_practice::PracticeResult */
export type PracticeResult = {
  question_id: string;
  status: string;
  is_correct: boolean | null;
  score: number | null;
  feedback: string | null;
  error: string | null;
  submission_id: string | null;
  source_available: boolean;
  grading_diagnostics: GradingDiagnostics | null;
  grading_drafts: PracticeGradingDraft[];
};
/** dstu_qbank::qbank_practice::PracticeSummary */
export type PracticeSummary = {
  id: string;
  title: string;
  mode: string;
  paper_id: string | null;
  question_count: number;
  answered_count: number;
  correct_count: number;
  pending_count: number;
  status: string;
  updated_at: string;
};
/** dstu_qbank::qbank_generation::types::QbankGenerationRequest */
export type QbankGenerationRequest = {
  exam_id: string;
  stream_session_id: string;
  model_config_id?: string | null;
  max_questions?: number;
  specs?: QuestionGenerationSpec[];
  difficulty?: string | null;
  topic_hint?: string | null;
  based_on_existing?: boolean;
  language?: string | null;
  reference_file_ids?: string[];
  reference_files_base64?: ReferenceFileBase64[];
  knowledge_points?: string[];
};
/** dstu_qbank::qbank_grading::types::QbankGradingMode */
export type QbankGradingMode = ("grade" | "analyze") | {
  grade: null;
} | {
  analyze: null;
};
/** dstu_qbank::qbank_grading::types::QbankGradingRequest */
export type QbankGradingRequest = {
  question_id: string;
  submission_id?: string | null;
  stream_session_id: string;
  mode: QbankGradingMode;
  model_config_id?: string | null;
};
/** dstu_qbank::qbank_grading::types::QbankGradingResponse */
export type QbankGradingResponse = {
  submission_id: string | null;
  verdict: Verdict | null;
  score: number | null;
  feedback: string;
  explanation_written: boolean;
  diagnostics: GradingDiagnostics | null;
};
/** dstu_qbank::qbank_grading::types::QbankGradingStreamCancelled */
export type QbankGradingStreamCancelled = {
  type: string;
};
/** dstu_qbank::qbank_grading::types::QbankGradingStreamComplete */
export type QbankGradingStreamComplete = {
  type: string;
  submission_id: string | null;
  verdict: string | null;
  score: number | null;
  feedback: string;
  explanation_written: boolean;
  diagnostics: GradingDiagnostics | null;
};
/** dstu_qbank::qbank_grading::types::QbankGradingStreamData */
export type QbankGradingStreamData = {
  type: string;
  chunk: string;
  accumulated: string;
};
/** dstu_qbank::qbank_grading::types::QbankGradingStreamError */
export type QbankGradingStreamError = {
  type: string;
  message: string;
  feedback: string | null;
  diagnostics: GradingDiagnostics | null;
};
/** dstu_vfs::vfs::repos::question_repo::Question */
export type Question = {
  id: string;
  exam_id: string;
  card_id: string | null;
  question_label: string | null;
  content: string;
  options: QuestionOption[] | null;
  answer: string | null;
  explanation: string | null;
  structured_data: unknown | null;
  question_type: dstu_vfs__vfs__repos__question_repo__QuestionType;
  difficulty: dstu_vfs__vfs__repos__question_repo__Difficulty | null;
  tags: string[];
  status: dstu_vfs__vfs__repos__question_repo__QuestionStatus;
  user_answer: string | null;
  is_correct: boolean | null;
  attempt_count: number;
  correct_count: number;
  last_attempt_at: string | null;
  user_note: string | null;
  is_favorite: boolean;
  is_bookmarked: boolean;
  source_type: dstu_vfs__vfs__repos__question_repo__SourceType;
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
};
/** dstu_qbank::qbank_authoring_service::QuestionAuthoringDraft */
export type QuestionAuthoringDraft = {
  job_id: string;
  exam_id: string;
  document: QuestionDocument;
  status: string;
  version: number;
  metadata: unknown;
};
/** dstu_qbank::qbank_management::QuestionBankStructure */
export type QuestionBankStructure = {
  exam_id: string;
  materials: QuestionMaterial[];
  groups: QuestionGroupView[];
};
/** dstu_qbank::qbank_document::QuestionDocument */
export type QuestionDocument = {
  schema_version: number;
  mode: string;
  materials: DraftMaterial[];
  groups: DraftGroup[];
  questions: DraftQuestion[];
  unmatched_answers: unknown[];
  coverage: unknown[];
  issues: unknown[];
};
/** dstu_qbank::qbank_authoring_service::QuestionDraftSummary */
export type QuestionDraftSummary = {
  job_id: string;
  exam_id: string;
  status: string;
  version: number;
  question_count: number;
  created_at: string;
};
/** dstu_vfs::vfs::repos::question_repo::QuestionFilters */
export type QuestionFilters = {
  status?: QuestionStatus__De[] | null;
  difficulty?: Difficulty__De[] | null;
  question_type?: QuestionType__De[] | null;
  tags?: string[] | null;
  search?: string | null;
  is_favorite?: boolean | null;
  is_bookmarked?: boolean | null;
};
/** dstu_qbank::qbank_generation::types::QuestionGenerationSpec */
export type QuestionGenerationSpec = {
  question_type: string;
  count?: number;
  difficulty?: string | null;
};
/** dstu_qbank::qbank_management::QuestionGroupView */
export type QuestionGroupView = {
  id: string;
  exam_id: string;
  label: string;
  position: number;
  version: number;
  material_ids: string[];
  question_ids: string[];
};
/** dstu_vfs::vfs::repos::question_repo::QuestionHistory */
export type QuestionHistory = {
  id: string;
  question_id: string;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  operator: string;
  reason: string | null;
  created_at: string;
};
/** dstu_vfs::vfs::repos::question_repo::QuestionImage */
export type QuestionImage = {
  id: string;
  name: string;
  mime: string;
  hash: string;
  role?: string | null;
};
/** dstu_vfs::vfs::repos::question_repo::QuestionImage */
export type QuestionImage__De = {
  id: string;
  name: string;
  mime: string;
  hash: string;
  role?: string | null;
};
/** deep_student_lib::commands::QuestionImportDraftResponse */
export type QuestionImportDraftResponse = {
  summary: ExamSheetSessionSummary;
  preview: ExamSheetPreviewResult;
  draft_job_id: string | null;
  draft_version: number | null;
  draft_document: unknown | null;
  model_route: unknown | null;
  committed: boolean;
};
/** dstu_qbank::question_import_service::QuestionImportProgress */
export type QuestionImportProgress = {
  type: "Preprocessing";
  stage: string;
  message: string;
  percent: number;
} | {
  type: "RenderingPages";
  current: number;
  total: number;
} | {
  type: "OcrImageCompleted";
  image_index: number;
  total_images: number;
} | {
  type: "OcrPhaseCompleted";
  total_images: number;
  total_chars: number;
} | {
  type: "SessionCreated";
  session_id: string;
  name: string;
  total_chunks: number;
} | {
  type: "ExtractingFigures";
  current: number;
  total: number;
} | {
  type: "StructuringQuestion";
  current: number;
  total: number;
} | {
  type: "QuestionParsed";
  question: unknown;
  question_index: number;
  total_parsed: number;
} | {
  type: "ChunkStart";
  chunk_index: number;
  total_chunks: number;
} | {
  type: "ChunkCompleted";
  chunk_index: number;
  total_chunks: number;
  questions_in_chunk: number;
  total_parsed: number;
} | {
  type: "Completed";
  session_id: string;
  name: string;
  total_questions: number;
  partial: boolean;
  failed_count: number;
} | {
  type: "Failed";
  session_id: string | null;
  error: string;
  total_parsed: number;
};
/** dstu_vfs::vfs::repos::question_repo::QuestionListResult */
export type QuestionListResult = {
  questions: Question[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
};
/** dstu_vfs::vfs::qbank_types::QuestionMaterial */
export type QuestionMaterial = {
  id: string;
  content: string;
  images: QuestionImage[];
  source_refs: SourceRef[];
  version: number;
};
/** dstu_vfs::vfs::repos::question_repo::QuestionOption */
export type QuestionOption = {
  key: string;
  content: string;
};
/** dstu_vfs::vfs::repos::question_repo::QuestionOption */
export type QuestionOption__De = {
  key: string;
  content: string;
};
/** dstu_vfs::vfs::repos::question_repo::QuestionSearchFilters */
export type QuestionSearchFilters = {
  status?: QuestionStatus__De[] | null;
  difficulty?: Difficulty__De[] | null;
  question_type?: QuestionType__De[] | null;
  tags?: string[] | null;
  search?: string | null;
  is_favorite?: boolean | null;
  is_bookmarked?: boolean | null;
  sort_by?: SearchSortBy | null;
};
/** dstu_vfs::vfs::repos::question_repo::QuestionSearchListResult */
export type QuestionSearchListResult = {
  results: QuestionSearchResult[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
  search_time_ms: number;
};
/** dstu_vfs::vfs::repos::question_repo::QuestionSearchResult */
export type QuestionSearchResult = {
  question: Question;
  highlight_content: string | null;
  highlight_answer: string | null;
  highlight_explanation: string | null;
  relevance_score: number;
};
/** dstu_vfs::vfs::repos::question_repo::QuestionStatus */
export type QuestionStatus__De = ("new" | "in_progress" | "mastered" | "review") | {
  new: null;
} | {
  in_progress: null;
} | {
  mastered: null;
} | {
  review: null;
};
/** dstu_vfs::vfs::repos::question_repo::QuestionType */
export type QuestionType__De = ("single_choice" | "multiple_choice" | "indefinite_choice" | "fill_blank" | "short_answer" | "essay" | "calculation" | "proof" | "true_false" | "matching" | "ordering" | "numeric" | "other") | {
  single_choice: null;
} | {
  multiple_choice: null;
} | {
  indefinite_choice: null;
} | {
  fill_blank: null;
} | {
  short_answer: null;
} | {
  essay: null;
} | {
  calculation: null;
} | {
  proof: null;
} | {
  true_false: null;
} | {
  matching: null;
} | {
  ordering: null;
} | {
  numeric: null;
} | {
  other: null;
};
/** dstu_qbank::qbank_generation::types::ReferenceFileBase64 */
export type ReferenceFileBase64 = {
  name: string;
  base64: string;
};
/** dstu_core::models::RenameExamSheetSessionRequest */
export type RenameExamSheetSessionRequest = {
  session_id: string;
  exam_name?: string | null;
};
/** dstu_core::models::RenameExamSheetSessionResponse */
export type RenameExamSheetSessionResponse = {
  summary: ExamSheetSessionSummary;
};
/** dstu_qbank::qbank_legacy_reconcile::ReparseAppliedItem */
export type ReparseAppliedItem = {
  local_id: string;
  action: string;
  question_id: string | null;
};
/** dstu_qbank::qbank_legacy_reconcile::ReparseCanonicalOnlyItem */
export type ReparseCanonicalOnlyItem = {
  question_id: string;
  source_key: string;
  canonical_revision: string;
  question_label: string | null;
};
/** dstu_qbank::qbank_legacy_reconcile::ReparseDecision */
export type ReparseDecision = {
  local_id: string;
  action: string;
  expected_revision?: string | null;
};
/** dstu_qbank::qbank_legacy_reconcile::ReparseFieldChange */
export type ReparseFieldChange = {
  field: string;
  before: unknown;
  after: unknown;
};
/** dstu_qbank::qbank_legacy_reconcile::ReparseItem */
export type ReparseItem = {
  local_id: string;
  source_key: string | null;
  status: string;
  canonical_question_id: string | null;
  canonical_revision: string | null;
  candidate_question_ids: string[];
  changes: ReparseFieldChange[];
  allowed_actions: string[];
  reason: string | null;
};
/** dstu_qbank::qbank_legacy_reconcile::ReparseReport */
export type ReparseReport = {
  exam_id: string;
  job_id: string;
  job_version: number;
  report_version: string;
  canonical_marker: boolean;
  canonical_question_count: number;
  items: ReparseItem[];
  canonical_only: ReparseCanonicalOnlyItem[];
  changed_count: number;
  new_count: number;
  deleted_count: number;
  ambiguous_count: number;
  resolved: boolean;
  resolution: ReparseResolveReceipt | null;
};
/** dstu_qbank::qbank_legacy_reconcile::ReparseResolveReceipt */
export type ReparseResolveReceipt = {
  exam_id: string;
  job_id: string;
  applied: ReparseAppliedItem[];
  imported_question_ids: string[];
  replaced_question_ids: string[];
  kept_local_ids: string[];
};
/** dstu_qbank::qbank_practice::SavePracticeRequest */
export type SavePracticeRequest = {
  id: string;
  revision: number;
  answers: { [key: string]: string };
  marked_ids: string[];
  current_index: number;
  elapsed_seconds: number;
};
/** deep_student_lib::commands::SearchQuestionsRequest */
export type SearchQuestionsRequest = {
  keyword: string;
  exam_id?: string | null;
  filters?: QuestionSearchFilters | null;
  page?: number;
  page_size?: number;
};
/** dstu_vfs::vfs::repos::question_repo::SearchSortBy */
export type SearchSortBy = ("relevance" | "created_desc" | "created_asc" | "updated_desc") | {
  relevance: null;
} | {
  created_desc: null;
} | {
  created_asc: null;
} | {
  updated_desc: null;
};
/** dstu_qbank::qbank_generation::types::SkippedReference */
export type SkippedReference = {
  name: string;
  reason: string;
  detail?: string | null;
};
/** deep_student_lib::commands::SourceImageInfo */
export type SourceImageInfo = {
  blobHash: string;
  dataUrl: string;
  pageIndex: number;
};
/** dstu_qbank::qbank_source_view::SourcePageView */
export type SourcePageView = {
  source_id: string;
  page: number | null;
  blob_hash: string | null;
  width: number | null;
  height: number | null;
  text: string | null;
  source_name: string | null;
  source_format: string | null;
  original_path: string | null;
  page_count: number | null;
  available_pages: number[];
};
/** dstu_qbank::question_authoring_runner::SourceRange */
export type SourceRange = {
  source_id: string;
  start_page?: number | null;
  end_page?: number | null;
};
/** dstu_vfs::vfs::qbank_types::SourceRef */
export type SourceRef = {
  source_id: string;
  page: number | null;
  bbox: number[] | null;
};
/** dstu_vfs::vfs::repos::question_repo::SourceType */
export type SourceType__De = ("ocr" | "imported" | "ai_generated" | "manual") | {
  ocr: null;
} | {
  imported: null;
} | {
  ai_generated: null;
} | {
  manual: null;
};
/** deep_student_lib::commands::StartTimedPracticeRequest */
export type StartTimedPracticeRequest = {
  exam_id: string;
  duration_minutes: number;
  question_count: number;
};
/** deep_student_lib::commands::SubmitAnswerRequest */
export type SubmitAnswerRequest = {
  question_id: string;
  user_answer: string;
  is_correct_override?: boolean | null;
  client_request_id?: string | null;
  regrade_submission_id?: string | null;
};
/** dstu_qbank::question_bank_service::SubmitAnswerResult */
export type SubmitAnswerResult = {
  is_correct: boolean | null;
  correct_answer: string | null;
  needs_manual_grading: boolean;
  message: string;
  updated_question: Question;
  updated_stats: dstu_vfs__vfs__repos__question_repo__QuestionBankStats;
  submission_id: string;
  daily_progress?: DailyProgressSnapshot | null;
};
/** deep_student_lib::commands::SubmitMockExamRequest */
export type SubmitMockExamRequest = {
  session: MockExamSession__De;
};
/** dstu_qbank::question_bank_service::TimedPracticeSession */
export type TimedPracticeSession = {
  id: string;
  exam_id: string;
  duration_minutes: number;
  question_count: number;
  question_ids: string[];
  started_at: string;
  ended_at: string | null;
  answered_count: number;
  correct_count: number;
  is_timeout: boolean;
  is_submitted: boolean;
  paused_seconds: number;
  is_paused: boolean;
};
/** dstu_qbank::question_bank_service::TypeStatItem */
export type TypeStatItem = {
  total: number;
  correct: number;
  rate: number;
};
/** dstu_core::models::UpdateExamSheetCardsRequest */
export type UpdateExamSheetCardsRequest = {
  session_id: string;
  cards?: ExamSheetCardUpdate[] | null;
  exam_name?: string | null;
  create_cards?: ExamSheetCardCreate[] | null;
  delete_card_ids?: string[] | null;
};
/** dstu_core::models::UpdateExamSheetCardsResponse */
export type UpdateExamSheetCardsResponse = {
  detail: ExamSheetSessionDetail;
};
/** dstu_vfs::vfs::repos::question_repo::UpdateQuestionParams */
export type UpdateQuestionParams = {
  question_label?: string | null;
  content?: string | null;
  options?: QuestionOption__De[] | null;
  answer?: string | null;
  explanation?: string | null;
  structured_data?: unknown | null;
  question_type?: QuestionType__De | null;
  difficulty?: Difficulty__De | null;
  tags?: string[] | null;
  status?: QuestionStatus__De | null;
  user_answer?: string | null;
  is_correct?: boolean | null;
  user_note?: string | null;
  is_favorite?: boolean | null;
  is_bookmarked?: boolean | null;
  images?: QuestionImage__De[] | null;
  expected_updated_at?: string | null;
};
/** deep_student_lib::commands::UpdateQuestionRequest */
export type UpdateQuestionRequest = {
  question_id: string;
  params: UpdateQuestionParams;
  record_history?: boolean;
};
/** dstu_qbank::qbank_grading::types::Verdict */
export type Verdict = "correct" | "partial" | "incorrect";
/** dstu_core::models::Difficulty */
export type dstu_core__models__Difficulty = "easy" | "medium" | "hard" | "very_hard";
/** dstu_core::models::QuestionBankStats */
export type dstu_core__models__QuestionBankStats = {
  total_count: number;
  mastered_count: number;
  review_count: number;
  in_progress_count: number;
  new_count: number;
  correct_rate?: number | null;
  last_updated?: string | null;
};
/** dstu_core::models::QuestionStatus */
export type dstu_core__models__QuestionStatus = "new" | "in_progress" | "mastered" | "review";
/** dstu_core::models::QuestionType */
export type dstu_core__models__QuestionType = "single_choice" | "multiple_choice" | "indefinite_choice" | "fill_blank" | "short_answer" | "essay" | "calculation" | "proof" | "true_false" | "matching" | "ordering" | "numeric" | "other";
/** dstu_core::models::SourceType */
export type dstu_core__models__SourceType = "ocr_image" | "import_file" | "manual_create" | "ai_generated";
/** dstu_vfs::vfs::repos::question_repo::Difficulty */
export type dstu_vfs__vfs__repos__question_repo__Difficulty = "easy" | "medium" | "hard" | "very_hard";
/** dstu_vfs::vfs::repos::question_repo::QuestionBankStats */
export type dstu_vfs__vfs__repos__question_repo__QuestionBankStats = {
  exam_id: string;
  total_count: number;
  new_count: number;
  in_progress_count: number;
  mastered_count: number;
  review_count: number;
  total_attempts: number;
  total_correct: number;
  correct_rate: number;
  updated_at: string;
};
/** dstu_vfs::vfs::repos::question_repo::QuestionStatus */
export type dstu_vfs__vfs__repos__question_repo__QuestionStatus = "new" | "in_progress" | "mastered" | "review";
/** dstu_vfs::vfs::repos::question_repo::QuestionType */
export type dstu_vfs__vfs__repos__question_repo__QuestionType = "single_choice" | "multiple_choice" | "indefinite_choice" | "fill_blank" | "short_answer" | "essay" | "calculation" | "proof" | "true_false" | "matching" | "ordering" | "numeric" | "other";
/** dstu_vfs::vfs::repos::question_repo::SourceType */
export type dstu_vfs__vfs__repos__question_repo__SourceType = "ocr" | "imported" | "ai_generated" | "manual";

export interface Commands {
  /** src/commands.rs:1264 `cancel_question_bank_import` */
  cancel_question_bank_import: {
    args: {
      importId: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/commands.rs:1859 `cancel_questions_csv_import` */
  cancel_questions_csv_import: {
    args: {
      importId: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/commands.rs:1875 `export_questions_csv` */
  export_questions_csv: {
    args: {
      request: CsvExportCommandRequest;
    };
    result: CsvExportResult;
    error: Shared.AppError;
  };
  /** src/commands.rs:2005 `get_csv_exportable_fields` */
  get_csv_exportable_fields: {
    args: Record<string, never>;
    result: [string, string][];
    error: never;
  };
  /** src/commands.rs:1967 `get_csv_preview` */
  get_csv_preview: {
    args: {
      filePath: string;
      rows?: number | null;
    };
    result: CsvPreviewResult;
    error: Shared.AppError;
  };
  /** src/commands.rs:2109 `get_enhanced_statistics` */
  get_enhanced_statistics: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** src/commands.rs:945 `get_exam_sheet_session_detail` */
  get_exam_sheet_session_detail: {
    args: {
      request: ExamSheetSessionDetailRequest;
    };
    result: ExamSheetSessionDetailResponse;
    error: Shared.AppError;
  };
  /** src/commands.rs:8244 `get_learning_heatmap` */
  get_learning_heatmap: {
    args: {
      startDate: string;
      endDate: string;
    };
    result: LearningActivity[];
    error: Shared.AppError;
  };
  /** src/commands.rs:1087 `import_question_bank` */
  import_question_bank: {
    args: {
      request: ImportQuestionBankRequest;
    };
    result: QuestionImportDraftResponse;
    error: Shared.AppError;
  };
  /** src/commands.rs:1122 `import_question_bank_stream` */
  import_question_bank_stream: {
    args: {
      request: ImportQuestionBankRequest;
    };
    result: QuestionImportDraftResponse;
    error: Shared.AppError;
  };
  /** src/commands.rs:1709 `import_questions_csv` */
  import_questions_csv: {
    args: {
      request: CsvImportCommandRequest;
    };
    result: CsvImportResult;
    error: Shared.AppError;
  };
  /** src/commands.rs:1042 `inspect_pdf_text_for_qbank` */
  inspect_pdf_text_for_qbank: {
    args: {
      request: InspectPdfTextRequest;
    };
    result: PdfTextInspection;
    error: Shared.AppError;
  };
  /** src/commands.rs:932 `list_exam_sheet_sessions` */
  list_exam_sheet_sessions: {
    args: {
      request: ExamSheetSessionListRequest;
    };
    result: ExamSheetSessionListResponse;
    error: Shared.AppError;
  };
  /** src/commands.rs:1646 `list_importing_sessions` */
  list_importing_sessions: {
    args: Record<string, never>;
    result: ImportingSession[];
    error: Shared.AppError;
  };
  /** src/qbank_generation.rs:16 `qbank_ai_generate_questions` */
  qbank_ai_generate_questions: {
    args: {
      request: QbankGenerationRequest;
    };
    result: GenerationTaskView;
    error: Shared.AppError;
  };
  /** src/qbank_grading.rs:22 `qbank_ai_grade` */
  qbank_ai_grade: {
    args: {
      request: QbankGradingRequest;
    };
    result: QbankGradingResponse | null;
    error: Shared.AppError;
  };
  /** src/commands.rs:7718 `qbank_batch_create_questions` */
  qbank_batch_create_questions: {
    args: {
      paramsList: CreateQuestionParams[];
    };
    result: Question[];
    error: Shared.AppError;
  };
  /** src/commands.rs:7789 `qbank_batch_delete_questions` */
  qbank_batch_delete_questions: {
    args: {
      questionIds: string[];
    };
    result: BatchResult;
    error: Shared.AppError;
  };
  /** src/commands.rs:7764 `qbank_batch_update_questions` */
  qbank_batch_update_questions: {
    args: {
      request: BatchUpdateQuestionsRequest;
    };
    result: BatchResult;
    error: Shared.AppError;
  };
  /** src/qbank_generation.rs:48 `qbank_cancel_generation_task` */
  qbank_cancel_generation_task: {
    args: {
      taskId: string;
    };
    result: GenerationTaskView | null;
    error: Shared.AppError;
  };
  /** src/qbank_grading.rs:33 `qbank_cancel_grading` */
  qbank_cancel_grading: {
    args: {
      streamEventName: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:1361 `qbank_commit_authoring_draft` */
  qbank_commit_authoring_draft: {
    args: {
      jobId: string;
      selectedLocalIds: string[];
      expectedVersion: number;
    };
    result: AuthoringCommitReceipt;
    error: Shared.AppError;
  };
  /** crates/dstu-qbank/src/qbank_practice/export_bridge.rs:66 `qbank_complete_paper_export` */
  qbank_complete_paper_export: {
    args: {
      requestId: string;
      data?: string | null;
      error?: string | null;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:7882 `qbank_count_by_type` */
  qbank_count_by_type: {
    args: {
      examId: string;
    };
    result: { [key: string]: number };
    error: Shared.AppError;
  };
  /** src/qbank_practice.rs:16 `qbank_create_practice` */
  qbank_create_practice: {
    args: {
      request: CreatePracticeRequest;
    };
    result: PracticeDraft;
    error: Shared.AppError;
  };
  /** src/commands.rs:7704 `qbank_create_question` */
  qbank_create_question: {
    args: {
      params: CreateQuestionParams;
    };
    result: Question;
    error: Shared.AppError;
  };
  /** src/commands.rs:8609 `qbank_crop_source_image` */
  qbank_crop_source_image: {
    args: {
      request: CropSourceImageRequest;
    };
    result: QuestionImage;
    error: Shared.AppError;
  };
  /** src/commands.rs:1612 `qbank_delete_group` */
  qbank_delete_group: {
    args: {
      groupId: string;
      mode: DeleteGroupMode__De;
      expectedVersion: number;
    };
    result: GroupDeleteResult;
    error: Shared.AppError;
  };
  /** src/commands.rs:1453 `qbank_delete_material` */
  qbank_delete_material: {
    args: {
      materialId: string;
      expectedVersion: number;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/qbank_practice.rs:63 `qbank_delete_practice` */
  qbank_delete_practice: {
    args: {
      id: string;
      submitted: boolean;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:7778 `qbank_delete_question` */
  qbank_delete_question: {
    args: {
      questionId: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:1489 `qbank_export_document` */
  qbank_export_document: {
    args: {
      examId: string;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** crates/dstu-qbank/src/qbank_practice/export.rs:228 `qbank_export_paper_docx` */
  qbank_export_paper_docx: {
    args: {
      title: string;
      blocks: PaperBlock[];
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/commands.rs:1633 `qbank_export_portable` */
  qbank_export_portable: {
    args: {
      examId: string;
    };
    result: PortableExport;
    error: Shared.AppError;
  };
  /** src/commands.rs:8106 `qbank_generate_mock_exam` */
  qbank_generate_mock_exam: {
    args: {
      request: GenerateMockExamRequest;
    };
    result: MockExamSession;
    error: Shared.AppError;
  };
  /** src/commands.rs:8168 `qbank_generate_paper` */
  qbank_generate_paper: {
    args: {
      request: GeneratePaperRequest;
    };
    result: GeneratedPaper;
    error: Shared.AppError;
  };
  /** src/commands.rs:8018 `qbank_get_activity_heatmap` */
  qbank_get_activity_heatmap: {
    args: {
      request: GetActivityHeatmapRequest;
    };
    result: ActivityHeatmapPoint[];
    error: Shared.AppError;
  };
  /** src/commands.rs:1386 `qbank_get_authoring_draft` */
  qbank_get_authoring_draft: {
    args: {
      jobId: string;
    };
    result: QuestionAuthoringDraft;
    error: Shared.AppError;
  };
  /** src/commands.rs:8193 `qbank_get_check_in_calendar` */
  qbank_get_check_in_calendar: {
    args: {
      request: GetCheckInCalendarRequest;
    };
    result: CheckInCalendar;
    error: Shared.AppError;
  };
  /** src/commands.rs:8147 `qbank_get_daily_practice` */
  qbank_get_daily_practice: {
    args: {
      request: GetDailyPracticeRequest;
    };
    result: DailyPracticeResult;
    error: Shared.AppError;
  };
  /** src/qbank_generation.rs:27 `qbank_get_generation_task` */
  qbank_get_generation_task: {
    args: {
      taskId: string;
    };
    result: GenerationTaskView | null;
    error: Shared.AppError;
  };
  /** src/commands.rs:7910 `qbank_get_history` */
  qbank_get_history: {
    args: {
      questionId: string;
      limit?: number | null;
    };
    result: QuestionHistory[];
    error: Shared.AppError;
  };
  /** src/commands.rs:8041 `qbank_get_knowledge_stats` */
  qbank_get_knowledge_stats: {
    args: {
      request: GetKnowledgeStatsRequest;
    };
    result: KnowledgePoint[];
    error: Shared.AppError;
  };
  /** src/commands.rs:8055 `qbank_get_knowledge_stats_with_comparison` */
  qbank_get_knowledge_stats_with_comparison: {
    args: {
      request: GetKnowledgeStatsRequest;
    };
    result: KnowledgeStatsComparison;
    error: Shared.AppError;
  };
  /** src/commands.rs:7989 `qbank_get_learning_trend` */
  qbank_get_learning_trend: {
    args: {
      request: GetLearningTrendRequest;
    };
    result: LearningTrendPoint[];
    error: Shared.AppError;
  };
  /** src/qbank_practice.rs:80 `qbank_get_paper` */
  qbank_get_paper: {
    args: {
      id: string;
    };
    result: GeneratedPaper;
    error: Shared.AppError;
  };
  /** src/qbank_practice.rs:33 `qbank_get_practice` */
  qbank_get_practice: {
    args: {
      id: string;
      submitted: boolean;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/commands.rs:7675 `qbank_get_question` */
  qbank_get_question: {
    args: {
      questionId: string;
    };
    result: Question | null;
    error: Shared.AppError;
  };
  /** src/commands.rs:7689 `qbank_get_question_by_card_id` */
  qbank_get_question_by_card_id: {
    args: {
      examId: string;
      cardId: string;
    };
    result: Question | null;
    error: Shared.AppError;
  };
  /** src/commands.rs:8515 `qbank_get_source_images` */
  qbank_get_source_images: {
    args: {
      examId: string;
    };
    result: SourceImageInfo[];
    error: Shared.AppError;
  };
  /** crates/dstu-qbank/src/qbank_source_view.rs:339 `qbank_get_source_page` */
  qbank_get_source_page: {
    args: {
      examId: string;
      sourceId: string;
      page?: number | null;
    };
    result: SourcePageView;
    error: Shared.AppError;
  };
  /** src/commands.rs:7868 `qbank_get_stats` */
  qbank_get_stats: {
    args: {
      examId: string;
    };
    result: dstu_vfs__vfs__repos__question_repo__QuestionBankStats | null;
    error: Shared.AppError;
  };
  /** src/commands.rs:7925 `qbank_get_submissions` */
  qbank_get_submissions: {
    args: {
      questionId: string;
      limit?: number | null;
    };
    result: AnswerSubmission[];
    error: Shared.AppError;
  };
  /** src/qbank_practice.rs:112 `qbank_grade_practice_manually` */
  qbank_grade_practice_manually: {
    args: {
      id: string;
      questionId: string;
      correct: boolean;
    };
    result: PracticeAttempt;
    error: Shared.AppError;
  };
  /** src/commands.rs:1542 `qbank_legacy_audit` */
  qbank_legacy_audit: {
    args: {
      examId: string;
    };
    result: LegacyMigrationAudit;
    error: Shared.AppError;
  };
  /** src/commands.rs:1555 `qbank_legacy_migrate_selected` */
  qbank_legacy_migrate_selected: {
    args: {
      examId: string;
      cardIds: string[];
      expectedVersion: string;
    };
    result: LegacyMigrationReceipt;
    error: Shared.AppError;
  };
  /** src/commands.rs:1398 `qbank_list_authoring_drafts` */
  qbank_list_authoring_drafts: {
    args: {
      examId: string;
    };
    result: QuestionDraftSummary[];
    error: Shared.AppError;
  };
  /** src/qbank_generation.rs:37 `qbank_list_generation_tasks` */
  qbank_list_generation_tasks: {
    args: {
      examId: string;
      limit?: number | null;
    };
    result: GenerationTaskView[];
    error: Shared.AppError;
  };
  /** src/commands.rs:7600 `qbank_list_mistakes` */
  qbank_list_mistakes: {
    args: {
      request: ListMistakesRequest;
    };
    result: MistakeListResult;
    error: Shared.AppError;
  };
  /** src/qbank_practice.rs:72 `qbank_list_papers` */
  qbank_list_papers: {
    args: {
      examId: string;
    };
    result: GeneratedPaper[];
    error: Shared.AppError;
  };
  /** src/qbank_practice.rs:42 `qbank_list_practices` */
  qbank_list_practices: {
    args: {
      scopeId: string;
      submitted: boolean;
      offset?: number | null;
    };
    result: PracticeSummary[];
    error: Shared.AppError;
  };
  /** src/commands.rs:7572 `qbank_list_questions` */
  qbank_list_questions: {
    args: {
      request: ListQuestionsRequest;
    };
    result: QuestionListResult;
    error: Shared.AppError;
  };
  /** src/commands.rs:1530 `qbank_list_structure` */
  qbank_list_structure: {
    args: {
      examId: string;
    };
    result: QuestionBankStructure;
    error: Shared.AppError;
  };
  /** src/commands.rs:7664 `qbank_rebuild_fts_index` */
  qbank_rebuild_fts_index: {
    args: Record<string, never>;
    result: number;
    error: Shared.AppError;
  };
  /** src/commands.rs:7896 `qbank_refresh_stats` */
  qbank_refresh_stats: {
    args: {
      examId: string;
    };
    result: dstu_vfs__vfs__repos__question_repo__QuestionBankStats;
    error: Shared.AppError;
  };
  /** src/commands.rs:8727 `qbank_remove_question_image` */
  qbank_remove_question_image: {
    args: {
      questionId: string;
      imageId: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:1576 `qbank_reparse_report` */
  qbank_reparse_report: {
    args: {
      examId: string;
      jobId?: string | null;
    };
    result: ReparseReport;
    error: Shared.AppError;
  };
  /** src/commands.rs:1590 `qbank_reparse_resolve` */
  qbank_reparse_resolve: {
    args: {
      examId: string;
      jobId: string;
      decisions: ReparseDecision[];
      expectedReportVersion: string;
    };
    result: ReparseResolveReceipt;
    error: Shared.AppError;
  };
  /** src/commands.rs:7940 `qbank_reset_progress` */
  qbank_reset_progress: {
    args: {
      examId: string;
    };
    result: dstu_vfs__vfs__repos__question_repo__QuestionBankStats;
    error: Shared.AppError;
  };
  /** src/commands.rs:7954 `qbank_reset_questions_progress` */
  qbank_reset_questions_progress: {
    args: {
      questionIds: string[];
    };
    result: BatchResult;
    error: Shared.AppError;
  };
  /** src/commands.rs:1467 `qbank_resolve_authoring_route` */
  qbank_resolve_authoring_route: {
    args: {
      modelConfigId?: string | null;
      requiresVision: boolean;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/qbank_practice.rs:96 `qbank_resume_practice_grading` */
  qbank_resume_practice_grading: {
    args: Record<string, never>;
    result: null;
    error: never;
  };
  /** src/qbank_practice.rs:101 `qbank_retry_practice_grading` */
  qbank_retry_practice_grading: {
    args: {
      id: string;
      questionId: string;
    };
    result: PracticeAttempt;
    error: Shared.AppError;
  };
  /** src/commands.rs:1410 `qbank_review_authoring_draft` */
  qbank_review_authoring_draft: {
    args: {
      jobId: string;
      expectedVersion: number;
      coverage?: unknown[] | null;
      issues?: unknown[] | null;
      unmatchedAnswers?: unknown[] | null;
    };
    result: QuestionAuthoringDraft;
    error: Shared.AppError;
  };
  /** src/qbank_practice.rs:25 `qbank_save_practice` */
  qbank_save_practice: {
    args: {
      request: SavePracticeRequest;
    };
    result: PracticeDraft;
    error: Shared.AppError;
  };
  /** src/commands.rs:7641 `qbank_search_questions` */
  qbank_search_questions: {
    args: {
      request: SearchQuestionsRequest;
    };
    result: QuestionSearchListResult;
    error: Shared.AppError;
  };
  /** src/commands.rs:8081 `qbank_start_timed_practice` */
  qbank_start_timed_practice: {
    args: {
      request: StartTimedPracticeRequest;
    };
    result: TimedPracticeSession;
    error: Shared.AppError;
  };
  /** src/commands.rs:7817 `qbank_submit_answer` */
  qbank_submit_answer: {
    args: {
      request: SubmitAnswerRequest;
    };
    result: SubmitAnswerResult;
    error: Shared.AppError;
  };
  /** src/commands.rs:8126 `qbank_submit_mock_exam` */
  qbank_submit_mock_exam: {
    args: {
      request: SubmitMockExamRequest;
    };
    result: MockExamScoreCard;
    error: Shared.AppError;
  };
  /** src/qbank_practice.rs:53 `qbank_submit_practice` */
  qbank_submit_practice: {
    args: {
      id: string;
      revision: number;
    };
    result: PracticeAttempt;
    error: Shared.AppError;
  };
  /** src/commands.rs:7854 `qbank_toggle_favorite` */
  qbank_toggle_favorite: {
    args: {
      questionId: string;
    };
    result: Question;
    error: Shared.AppError;
  };
  /** src/commands.rs:1501 `qbank_update_group` */
  qbank_update_group: {
    args: {
      groupId: string;
      label: string;
      questionIds: string[];
      materialIds: string[];
      expectedVersion: number;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/commands.rs:1432 `qbank_update_material` */
  qbank_update_material: {
    args: {
      materialId: string;
      content: string;
      expectedVersion: number;
    };
    result: QuestionMaterial;
    error: Shared.AppError;
  };
  /** src/qbank_practice.rs:85 `qbank_update_paper` */
  qbank_update_paper: {
    args: {
      id: string;
      title?: string | null;
      deleted: boolean;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:7740 `qbank_update_question` */
  qbank_update_question: {
    args: {
      request: UpdateQuestionRequest;
    };
    result: Question;
    error: Shared.AppError;
  };
  /** src/commands.rs:980 `rename_exam_sheet_session` */
  rename_exam_sheet_session: {
    args: {
      request: RenameExamSheetSessionRequest;
    };
    result: RenameExamSheetSessionResponse;
    error: Shared.AppError;
  };
  /** src/commands.rs:1285 `resume_question_import` */
  resume_question_import: {
    args: {
      sessionId: string;
      importId?: string | null;
    };
    result: QuestionImportDraftResponse;
    error: Shared.AppError;
  };
  /** src/commands.rs:957 `update_exam_sheet_cards` */
  update_exam_sheet_cards: {
    args: {
      request: UpdateExamSheetCardsRequest;
    };
    result: UpdateExamSheetCardsResponse;
    error: Shared.AppError;
  };
}

export interface Events {
  "csv_import_progress": CsvImportProgress;
  "mistake_status_update": {
    mistake_id: string;
  };
  "qbank-export-paper": ExportRequest;
  "qbank-practice-updated": string;
  "qbank://changed": {
    exam_id: string;
    reason: string;
  } | {
    reason: string;
    material_id: string;
  } | {
    source: string;
    action: string;
    entityIds: string[];
    runId: string;
  };
  "qbank_generation_task_event": GenerationTaskView;
  [name: `qbank_grading_stream_${string}`]: QbankGradingStreamError | (QbankGradingStreamCancelled | QbankGradingStreamComplete | QbankGradingStreamData | QbankGradingStreamError);
  "question_import_progress": QuestionImportProgress;
  "review://changed": unknown;
}

export type CommandName = keyof Commands;
export type CancelQuestionBankImportCommandArgs = Commands['cancel_question_bank_import']['args'];
export type CancelQuestionBankImportCommandResult = Commands['cancel_question_bank_import']['result'];
export type CancelQuestionsCsvImportCommandArgs = Commands['cancel_questions_csv_import']['args'];
export type CancelQuestionsCsvImportCommandResult = Commands['cancel_questions_csv_import']['result'];
export type ExportQuestionsCsvCommandArgs = Commands['export_questions_csv']['args'];
export type ExportQuestionsCsvCommandResult = Commands['export_questions_csv']['result'];
export type GetCsvExportableFieldsCommandArgs = Commands['get_csv_exportable_fields']['args'];
export type GetCsvExportableFieldsCommandResult = Commands['get_csv_exportable_fields']['result'];
export type GetCsvPreviewCommandArgs = Commands['get_csv_preview']['args'];
export type GetCsvPreviewCommandResult = Commands['get_csv_preview']['result'];
export type GetEnhancedStatisticsCommandArgs = Commands['get_enhanced_statistics']['args'];
export type GetEnhancedStatisticsCommandResult = Commands['get_enhanced_statistics']['result'];
export type GetExamSheetSessionDetailCommandArgs = Commands['get_exam_sheet_session_detail']['args'];
export type GetExamSheetSessionDetailCommandResult = Commands['get_exam_sheet_session_detail']['result'];
export type GetLearningHeatmapCommandArgs = Commands['get_learning_heatmap']['args'];
export type GetLearningHeatmapCommandResult = Commands['get_learning_heatmap']['result'];
export type ImportQuestionBankCommandArgs = Commands['import_question_bank']['args'];
export type ImportQuestionBankCommandResult = Commands['import_question_bank']['result'];
export type ImportQuestionBankStreamCommandArgs = Commands['import_question_bank_stream']['args'];
export type ImportQuestionBankStreamCommandResult = Commands['import_question_bank_stream']['result'];
export type ImportQuestionsCsvCommandArgs = Commands['import_questions_csv']['args'];
export type ImportQuestionsCsvCommandResult = Commands['import_questions_csv']['result'];
export type InspectPdfTextForQbankCommandArgs = Commands['inspect_pdf_text_for_qbank']['args'];
export type InspectPdfTextForQbankCommandResult = Commands['inspect_pdf_text_for_qbank']['result'];
export type ListExamSheetSessionsCommandArgs = Commands['list_exam_sheet_sessions']['args'];
export type ListExamSheetSessionsCommandResult = Commands['list_exam_sheet_sessions']['result'];
export type ListImportingSessionsCommandArgs = Commands['list_importing_sessions']['args'];
export type ListImportingSessionsCommandResult = Commands['list_importing_sessions']['result'];
export type QbankAiGenerateQuestionsCommandArgs = Commands['qbank_ai_generate_questions']['args'];
export type QbankAiGenerateQuestionsCommandResult = Commands['qbank_ai_generate_questions']['result'];
export type QbankAiGradeCommandArgs = Commands['qbank_ai_grade']['args'];
export type QbankAiGradeCommandResult = Commands['qbank_ai_grade']['result'];
export type QbankBatchCreateQuestionsCommandArgs = Commands['qbank_batch_create_questions']['args'];
export type QbankBatchCreateQuestionsCommandResult = Commands['qbank_batch_create_questions']['result'];
export type QbankBatchDeleteQuestionsCommandArgs = Commands['qbank_batch_delete_questions']['args'];
export type QbankBatchDeleteQuestionsCommandResult = Commands['qbank_batch_delete_questions']['result'];
export type QbankBatchUpdateQuestionsCommandArgs = Commands['qbank_batch_update_questions']['args'];
export type QbankBatchUpdateQuestionsCommandResult = Commands['qbank_batch_update_questions']['result'];
export type QbankCancelGenerationTaskCommandArgs = Commands['qbank_cancel_generation_task']['args'];
export type QbankCancelGenerationTaskCommandResult = Commands['qbank_cancel_generation_task']['result'];
export type QbankCancelGradingCommandArgs = Commands['qbank_cancel_grading']['args'];
export type QbankCancelGradingCommandResult = Commands['qbank_cancel_grading']['result'];
export type QbankCommitAuthoringDraftCommandArgs = Commands['qbank_commit_authoring_draft']['args'];
export type QbankCommitAuthoringDraftCommandResult = Commands['qbank_commit_authoring_draft']['result'];
export type QbankCompletePaperExportCommandArgs = Commands['qbank_complete_paper_export']['args'];
export type QbankCompletePaperExportCommandResult = Commands['qbank_complete_paper_export']['result'];
export type QbankCountByTypeCommandArgs = Commands['qbank_count_by_type']['args'];
export type QbankCountByTypeCommandResult = Commands['qbank_count_by_type']['result'];
export type QbankCreatePracticeCommandArgs = Commands['qbank_create_practice']['args'];
export type QbankCreatePracticeCommandResult = Commands['qbank_create_practice']['result'];
export type QbankCreateQuestionCommandArgs = Commands['qbank_create_question']['args'];
export type QbankCreateQuestionCommandResult = Commands['qbank_create_question']['result'];
export type QbankCropSourceImageCommandArgs = Commands['qbank_crop_source_image']['args'];
export type QbankCropSourceImageCommandResult = Commands['qbank_crop_source_image']['result'];
export type QbankDeleteGroupCommandArgs = Commands['qbank_delete_group']['args'];
export type QbankDeleteGroupCommandResult = Commands['qbank_delete_group']['result'];
export type QbankDeleteMaterialCommandArgs = Commands['qbank_delete_material']['args'];
export type QbankDeleteMaterialCommandResult = Commands['qbank_delete_material']['result'];
export type QbankDeletePracticeCommandArgs = Commands['qbank_delete_practice']['args'];
export type QbankDeletePracticeCommandResult = Commands['qbank_delete_practice']['result'];
export type QbankDeleteQuestionCommandArgs = Commands['qbank_delete_question']['args'];
export type QbankDeleteQuestionCommandResult = Commands['qbank_delete_question']['result'];
export type QbankExportDocumentCommandArgs = Commands['qbank_export_document']['args'];
export type QbankExportDocumentCommandResult = Commands['qbank_export_document']['result'];
export type QbankExportPaperDocxCommandArgs = Commands['qbank_export_paper_docx']['args'];
export type QbankExportPaperDocxCommandResult = Commands['qbank_export_paper_docx']['result'];
export type QbankExportPortableCommandArgs = Commands['qbank_export_portable']['args'];
export type QbankExportPortableCommandResult = Commands['qbank_export_portable']['result'];
export type QbankGenerateMockExamCommandArgs = Commands['qbank_generate_mock_exam']['args'];
export type QbankGenerateMockExamCommandResult = Commands['qbank_generate_mock_exam']['result'];
export type QbankGeneratePaperCommandArgs = Commands['qbank_generate_paper']['args'];
export type QbankGeneratePaperCommandResult = Commands['qbank_generate_paper']['result'];
export type QbankGetActivityHeatmapCommandArgs = Commands['qbank_get_activity_heatmap']['args'];
export type QbankGetActivityHeatmapCommandResult = Commands['qbank_get_activity_heatmap']['result'];
export type QbankGetAuthoringDraftCommandArgs = Commands['qbank_get_authoring_draft']['args'];
export type QbankGetAuthoringDraftCommandResult = Commands['qbank_get_authoring_draft']['result'];
export type QbankGetCheckInCalendarCommandArgs = Commands['qbank_get_check_in_calendar']['args'];
export type QbankGetCheckInCalendarCommandResult = Commands['qbank_get_check_in_calendar']['result'];
export type QbankGetDailyPracticeCommandArgs = Commands['qbank_get_daily_practice']['args'];
export type QbankGetDailyPracticeCommandResult = Commands['qbank_get_daily_practice']['result'];
export type QbankGetGenerationTaskCommandArgs = Commands['qbank_get_generation_task']['args'];
export type QbankGetGenerationTaskCommandResult = Commands['qbank_get_generation_task']['result'];
export type QbankGetHistoryCommandArgs = Commands['qbank_get_history']['args'];
export type QbankGetHistoryCommandResult = Commands['qbank_get_history']['result'];
export type QbankGetKnowledgeStatsCommandArgs = Commands['qbank_get_knowledge_stats']['args'];
export type QbankGetKnowledgeStatsCommandResult = Commands['qbank_get_knowledge_stats']['result'];
export type QbankGetKnowledgeStatsWithComparisonCommandArgs = Commands['qbank_get_knowledge_stats_with_comparison']['args'];
export type QbankGetKnowledgeStatsWithComparisonCommandResult = Commands['qbank_get_knowledge_stats_with_comparison']['result'];
export type QbankGetLearningTrendCommandArgs = Commands['qbank_get_learning_trend']['args'];
export type QbankGetLearningTrendCommandResult = Commands['qbank_get_learning_trend']['result'];
export type QbankGetPaperCommandArgs = Commands['qbank_get_paper']['args'];
export type QbankGetPaperCommandResult = Commands['qbank_get_paper']['result'];
export type QbankGetPracticeCommandArgs = Commands['qbank_get_practice']['args'];
export type QbankGetPracticeCommandResult = Commands['qbank_get_practice']['result'];
export type QbankGetQuestionCommandArgs = Commands['qbank_get_question']['args'];
export type QbankGetQuestionCommandResult = Commands['qbank_get_question']['result'];
export type QbankGetQuestionByCardIdCommandArgs = Commands['qbank_get_question_by_card_id']['args'];
export type QbankGetQuestionByCardIdCommandResult = Commands['qbank_get_question_by_card_id']['result'];
export type QbankGetSourceImagesCommandArgs = Commands['qbank_get_source_images']['args'];
export type QbankGetSourceImagesCommandResult = Commands['qbank_get_source_images']['result'];
export type QbankGetSourcePageCommandArgs = Commands['qbank_get_source_page']['args'];
export type QbankGetSourcePageCommandResult = Commands['qbank_get_source_page']['result'];
export type QbankGetStatsCommandArgs = Commands['qbank_get_stats']['args'];
export type QbankGetStatsCommandResult = Commands['qbank_get_stats']['result'];
export type QbankGetSubmissionsCommandArgs = Commands['qbank_get_submissions']['args'];
export type QbankGetSubmissionsCommandResult = Commands['qbank_get_submissions']['result'];
export type QbankGradePracticeManuallyCommandArgs = Commands['qbank_grade_practice_manually']['args'];
export type QbankGradePracticeManuallyCommandResult = Commands['qbank_grade_practice_manually']['result'];
export type QbankLegacyAuditCommandArgs = Commands['qbank_legacy_audit']['args'];
export type QbankLegacyAuditCommandResult = Commands['qbank_legacy_audit']['result'];
export type QbankLegacyMigrateSelectedCommandArgs = Commands['qbank_legacy_migrate_selected']['args'];
export type QbankLegacyMigrateSelectedCommandResult = Commands['qbank_legacy_migrate_selected']['result'];
export type QbankListAuthoringDraftsCommandArgs = Commands['qbank_list_authoring_drafts']['args'];
export type QbankListAuthoringDraftsCommandResult = Commands['qbank_list_authoring_drafts']['result'];
export type QbankListGenerationTasksCommandArgs = Commands['qbank_list_generation_tasks']['args'];
export type QbankListGenerationTasksCommandResult = Commands['qbank_list_generation_tasks']['result'];
export type QbankListMistakesCommandArgs = Commands['qbank_list_mistakes']['args'];
export type QbankListMistakesCommandResult = Commands['qbank_list_mistakes']['result'];
export type QbankListPapersCommandArgs = Commands['qbank_list_papers']['args'];
export type QbankListPapersCommandResult = Commands['qbank_list_papers']['result'];
export type QbankListPracticesCommandArgs = Commands['qbank_list_practices']['args'];
export type QbankListPracticesCommandResult = Commands['qbank_list_practices']['result'];
export type QbankListQuestionsCommandArgs = Commands['qbank_list_questions']['args'];
export type QbankListQuestionsCommandResult = Commands['qbank_list_questions']['result'];
export type QbankListStructureCommandArgs = Commands['qbank_list_structure']['args'];
export type QbankListStructureCommandResult = Commands['qbank_list_structure']['result'];
export type QbankRebuildFtsIndexCommandArgs = Commands['qbank_rebuild_fts_index']['args'];
export type QbankRebuildFtsIndexCommandResult = Commands['qbank_rebuild_fts_index']['result'];
export type QbankRefreshStatsCommandArgs = Commands['qbank_refresh_stats']['args'];
export type QbankRefreshStatsCommandResult = Commands['qbank_refresh_stats']['result'];
export type QbankRemoveQuestionImageCommandArgs = Commands['qbank_remove_question_image']['args'];
export type QbankRemoveQuestionImageCommandResult = Commands['qbank_remove_question_image']['result'];
export type QbankReparseReportCommandArgs = Commands['qbank_reparse_report']['args'];
export type QbankReparseReportCommandResult = Commands['qbank_reparse_report']['result'];
export type QbankReparseResolveCommandArgs = Commands['qbank_reparse_resolve']['args'];
export type QbankReparseResolveCommandResult = Commands['qbank_reparse_resolve']['result'];
export type QbankResetProgressCommandArgs = Commands['qbank_reset_progress']['args'];
export type QbankResetProgressCommandResult = Commands['qbank_reset_progress']['result'];
export type QbankResetQuestionsProgressCommandArgs = Commands['qbank_reset_questions_progress']['args'];
export type QbankResetQuestionsProgressCommandResult = Commands['qbank_reset_questions_progress']['result'];
export type QbankResolveAuthoringRouteCommandArgs = Commands['qbank_resolve_authoring_route']['args'];
export type QbankResolveAuthoringRouteCommandResult = Commands['qbank_resolve_authoring_route']['result'];
export type QbankResumePracticeGradingCommandArgs = Commands['qbank_resume_practice_grading']['args'];
export type QbankResumePracticeGradingCommandResult = Commands['qbank_resume_practice_grading']['result'];
export type QbankRetryPracticeGradingCommandArgs = Commands['qbank_retry_practice_grading']['args'];
export type QbankRetryPracticeGradingCommandResult = Commands['qbank_retry_practice_grading']['result'];
export type QbankReviewAuthoringDraftCommandArgs = Commands['qbank_review_authoring_draft']['args'];
export type QbankReviewAuthoringDraftCommandResult = Commands['qbank_review_authoring_draft']['result'];
export type QbankSavePracticeCommandArgs = Commands['qbank_save_practice']['args'];
export type QbankSavePracticeCommandResult = Commands['qbank_save_practice']['result'];
export type QbankSearchQuestionsCommandArgs = Commands['qbank_search_questions']['args'];
export type QbankSearchQuestionsCommandResult = Commands['qbank_search_questions']['result'];
export type QbankStartTimedPracticeCommandArgs = Commands['qbank_start_timed_practice']['args'];
export type QbankStartTimedPracticeCommandResult = Commands['qbank_start_timed_practice']['result'];
export type QbankSubmitAnswerCommandArgs = Commands['qbank_submit_answer']['args'];
export type QbankSubmitAnswerCommandResult = Commands['qbank_submit_answer']['result'];
export type QbankSubmitMockExamCommandArgs = Commands['qbank_submit_mock_exam']['args'];
export type QbankSubmitMockExamCommandResult = Commands['qbank_submit_mock_exam']['result'];
export type QbankSubmitPracticeCommandArgs = Commands['qbank_submit_practice']['args'];
export type QbankSubmitPracticeCommandResult = Commands['qbank_submit_practice']['result'];
export type QbankToggleFavoriteCommandArgs = Commands['qbank_toggle_favorite']['args'];
export type QbankToggleFavoriteCommandResult = Commands['qbank_toggle_favorite']['result'];
export type QbankUpdateGroupCommandArgs = Commands['qbank_update_group']['args'];
export type QbankUpdateGroupCommandResult = Commands['qbank_update_group']['result'];
export type QbankUpdateMaterialCommandArgs = Commands['qbank_update_material']['args'];
export type QbankUpdateMaterialCommandResult = Commands['qbank_update_material']['result'];
export type QbankUpdatePaperCommandArgs = Commands['qbank_update_paper']['args'];
export type QbankUpdatePaperCommandResult = Commands['qbank_update_paper']['result'];
export type QbankUpdateQuestionCommandArgs = Commands['qbank_update_question']['args'];
export type QbankUpdateQuestionCommandResult = Commands['qbank_update_question']['result'];
export type RenameExamSheetSessionCommandArgs = Commands['rename_exam_sheet_session']['args'];
export type RenameExamSheetSessionCommandResult = Commands['rename_exam_sheet_session']['result'];
export type ResumeQuestionImportCommandArgs = Commands['resume_question_import']['args'];
export type ResumeQuestionImportCommandResult = Commands['resume_question_import']['result'];
export type UpdateExamSheetCardsCommandArgs = Commands['update_exam_sheet_cards']['args'];
export type UpdateExamSheetCardsCommandResult = Commands['update_exam_sheet_cards']['result'];
