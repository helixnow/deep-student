import type { MistakeItem, ChatMessage, RagSourceInfo } from '../types';
export type { MistakeItem, ChatMessage, RagSourceInfo };

export interface GraphRecallStageLogDto {
  name: string;
  duration_ms: number;
  detail?: string | null;
}

export interface GraphRecallDiagnosticsResult {
  stages: GraphRecallStageLogDto[];
  warnings: string[];
  total_results: number;
  note_results: number;
  low_confidence: boolean;
}

export interface GraphRecallTestResult {
  success: boolean;
  error?: string | null;
  sources: RagSourceInfo[];
  payload: any[];
  diagnostics: GraphRecallDiagnosticsResult;
}

export interface ExamCardPreview {
  card_id: string;
  page_index: number;
  question_label: string;
  bbox: { x: number; y: number; width: number; height: number };
  resolved_bbox?: { x: number; y: number; width: number; height: number };
  /** @deprecated 旧数据兼容，新数据使用 page.blob_hash + card.bbox 实时裁剪 */
  cropped_image_path?: string;
  ocr_text: string;
  tags: string[];
  extra_metadata?: Record<string, unknown> | null;
  linked_mistake_ids?: string[];
  question_type?: string;
  options?: Array<{ key: string; content: string }>;
  answer?: string;
  explanation?: string;
  difficulty?: string;
  status?: string;
  user_answer?: string;
  is_correct?: boolean;
  attempt_count?: number;
  correct_count?: number;
  last_attempt_at?: string;
  user_note?: string;
  source_type?: string;
  source_info?: string;
  parent_card_id?: string;
  variant_ids?: string[];
}

export interface ExamSheetPreviewPage {
  page_index: number;
  /** @deprecated 旧数据兼容，新数据使用 blob_hash */
  original_image_path?: string;
  /** ★ VFS blob 哈希（文档25改造）*/
  blob_hash?: string;
  /** ★ 图片宽度（像素）*/
  width?: number;
  /** ★ 图片高度（像素）*/
  height?: number;
  cards: ExamCardPreview[];
}

export interface ExamSheetPreviewResult {
  session_id: string;
  /** @deprecated 使用 session_id */
  mistake_id?: string;
  exam_name?: string | null;
  pages: ExamSheetPreviewPage[];
  raw_model_response?: unknown;
  instructions?: string | null;
}

export interface ExamSheetPreviewRequestPayload {
  examName?: string;
  pageImages: Array<File | string>;
  instructions?: string;
  // 新增：合并提示词与识别侧重点（传给后端用于分组流程）
  groupingPrompt?: string;
  groupingFocus?: string;
  chunkSize?: number;
  concurrency?: number;
  outputFormat?: 'deepseek_ocr'; // 题目集识别固定使用 DeepSeek-OCR
  /** ★ 追加模式：如果提供 sessionId，将新识别的 pages 追加到现有会话 */
  sessionId?: string;
}

export interface ExamSheetCardUpdatePayload {
  card_id: string;
  page_index?: number;
  bbox?: ExamCardPreview['bbox'];
  resolved_bbox?: ExamCardPreview['bbox'];
  question_label?: string;
  ocr_text?: string;
  tags?: string[];
}

export interface ExamSheetCardCreatePayload {
  page_index: number;
  bbox?: ExamCardPreview['bbox'];
  resolved_bbox?: ExamCardPreview['bbox'];
  question_label?: string;
  ocr_text?: string;
  tags?: string[];
}

export interface UpdateExamSheetCardsRequestPayload {
  session_id: string;
  cards?: ExamSheetCardUpdatePayload[];
  exam_name?: string;
  create_cards?: ExamSheetCardCreatePayload[];
  delete_card_ids?: string[];
}

export interface UpdateExamSheetCardsResponsePayload {
  detail: ExamSheetSessionDetail;
}

export interface RenameExamSheetSessionResponsePayload {
  summary: ExamSheetSessionSummary;
}

// ★ 2026-01 清理：MistakeExamSheetLink 已废弃，使用 ExamSheetLink
export interface ExamSheetLink {
  exam_id: string;
  origin_exam_id?: string | null;
  exam_name?: string | null;
  card_id?: string | null;
  page_index?: number;
  question_label?: string;
  bbox?: ExamCardPreview['bbox'];
  resolved_bbox?: ExamCardPreview['bbox'];
  original_image_path?: string | null;
  cropped_image_path?: string | null;
  session_id?: string | null;
  ocr_text?: string | null;
  tags?: string[] | null;
}
/** @deprecated 使用 ExamSheetLink */
export type MistakeExamSheetLink = ExamSheetLink;



export type BackupTier =
  | 'core_config_chat'
  | 'vfs_full'
  | 'rebuildable'
  | 'large_files';

export interface BackupInfo {
  file_name: string;
  file_path: string;
  size: number;
  created_at: string;
  is_auto_backup: boolean;
}

export interface AnalysisRequest {
  question_image_files: string[]; // Base64编码的图片字符串
  analysis_image_files: string[]; // Base64编码的图片字符串
  user_question: string;
}

export interface AnalysisResponse {
  mistake_id: string; // 首轮即正式：直接是mistake_id
  business_session_id: string;
  generation_id: number;
  initial_data: {
    ocr_text: string;
    tags: string[];
    mistake_type: string;
    first_answer: string;
  };
}

export interface ContinueChatRequest {
  mistake_id: string; // 首轮即正式：直接是mistake_id
  chat_history: ChatMessage[];
}

export interface ContinueChatResponse {
  new_assistant_message: string;
}

export interface SaveMistakeRequest {
  mistake_id: string; // 首轮即正式：直接是mistake_id
  final_chat_history: ChatMessage[];
  source?: 'auto' | 'manual' | string;
  autosave_signature?: string | null;
  generation_id?: number | null;
  save_reason?: string | null;
}

export interface SaveMistakeResponse {
  success: boolean;
  final_mistake_item?: MistakeItem;
  source?: 'auto' | 'manual' | string;
}

// 统一封装：带调试埋点的 invoke
export interface ExamSheetSessionMetadata {
  instructions?: string | null;
  tags?: string[] | null;
  page_count?: number | null;
  card_count?: number | null;
  raw_model_response?: any;
}

export interface ExamSheetSessionSummary {
  id: string;
  exam_name?: string | null;
  mistake_id: string;
  created_at: string;
  updated_at: string;
  status: string;
  metadata?: ExamSheetSessionMetadata | null;
  linked_mistake_ids?: string[] | null;
}

export interface ExamSheetSessionDetail {
  summary: ExamSheetSessionSummary;
  preview: ExamSheetPreviewResult;
}

export type ExamSheetProgressEvent =
  | {
      type: 'SessionCreated';
      detail: ExamSheetSessionDetail;
      total_pages?: number;
      total_chunks?: number; // ★ 兼容旧后端
    }
  | {
      type: 'ChunkCompleted';
      detail: ExamSheetSessionDetail;
      chunk_index: number;
      total_chunks: number;
    }
  | {
      type: 'OcrPageCompleted';
      detail: ExamSheetSessionDetail;
      page_index: number;
      total_pages: number;
    }
  | {
      type: 'OcrPhaseCompleted';
      detail: ExamSheetSessionDetail;
      total_pages: number;
    }
  | {
      type: 'ParsePageCompleted';
      detail: ExamSheetSessionDetail;
      page_index: number;
      total_pages: number;
    }
  | {
      type: 'Completed';
      detail: ExamSheetSessionDetail;
    }
  | {
      type: 'Failed';
      session_id?: string | null;
      error: string;
      detail?: ExamSheetSessionDetail | null;
    };

export interface ExamSheetSessionListResponse {
  sessions: ExamSheetSessionSummary[];
}

export interface ExamSheetSessionDetailResponse {
  detail: ExamSheetSessionDetail;
}

export interface ExamSheetSessionLinkResponse {
  success: boolean;
}

export interface DatabaseInfo {
  production_db_path: string;
  test_db_path: string;
  test_db_exists: boolean;
  production_db_exists: boolean;
  active_database: 'production' | 'test';
}

export interface TestDatabaseSwitchResponse {
  success: boolean;
  test_db_path?: string;
  production_db_path?: string;
  message: string;
  deleted_files?: string[];
  active_database?: 'production' | 'test';
}
export interface TranslationHistoryItem {
  id: string;
  source_text: string;
  translated_text: string;
  src_lang: string;
  tgt_lang: string;
  prompt_used?: string | null;
  created_at: string;
  is_favorite: boolean;
  quality_rating?: number | null;
}
