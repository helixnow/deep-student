import type {} from '@deepseek-ai/cordis';
import type { JsonNode } from '../../platform/util/index.ts';

/** commands.rs:655-666. This is command-layer state, not a database handle. */
export type ActiveDatabaseKind = 'production' | 'test';

/** AppState is split by ownership; consumers inject the owner's published service.
 * The aggregate must not create second instances of shared services (commands.rs:669-719).
 * Values name owning lanes, not invented Cordis service identifiers.
 */
export const APP_STATE_OWNERS = {
  database: 'F3-storage',
  database_manager: 'F3-storage',
  anki_database: 'F3-storage',
  notes_database: 'F3-storage',
  vfs_db: 'L13-vfs-api',
  custom_mode_manager: 'L02-llm-manager',
  file_manager: 'F3-storage',
  exam_sheet_service: 'L18-media-docs',
  question_bank_service: 'L14-qbank',
  pdf_ocr_service: 'L18-media-docs',
  pdf_processing_service: 'L12-vfs-index',
  temp_sessions: 'L22-app-commands',
  llm_manager: 'L02-llm-manager',
  notes_manager: 'L10-notes',
  crypto_service: 'F4-security',
  pdf_ocr_cancellations: 'L18-media-docs',
  pdf_ocr_pauses: 'L18-media-docs',
  pdf_ocr_sessions: 'L18-media-docs',
  pdf_ocr_skip_pages: 'L18-media-docs',
  csv_import_cancellations: 'L14-qbank',
  question_import_cancellations: 'L14-qbank',
  app_handle: 'F1-kernel',
  active_database: 'L22-app-commands',
} as const;

/** Identity part of StreamContext used by the memory cap (commands.rs:185-200). */
export interface TempSessionIdentity {
  temp_id: string;
  /** chrono DateTime<Utc>, including its original fractional precision. */
  created_at: string;
}

/** The only residual command-layer state; domain control maps stay with their owners. */
export interface AppCommandState {
  activeDatabase: ActiveDatabaseKind;
  /** Synchronous access corresponds to holding temp_sessions.lock(), never across await. */
  withTempSessions<R>(operation: (sessions: Map<string, StreamContext>) => R): R;
  /**
   * commands.rs:248-285 `modify_temp_session`: mutate the cached session, or load it from
   * `temp_sessions` (absent → NotFound "临时会话不存在"; read failure → Database
   * "读取临时会话失败: …"), cache it under the memory cap, then persist (failure → Database
   * "持久化临时会话失败: …"). Errors are thrown as `CommandError(AppError)`. Resolves to the
   * updated session (a copy).
   */
  modifyTempSession(tempId: string, mutator: (session: StreamContext) => void): Promise<StreamContext>;
}

/** models.rs:141-149, `rename_all = "snake_case"`, `#[default] InProgress`. */
export type TempStreamState = 'in_progress' | 'completed' | 'failed';

/** models.rs:212-223. */
export interface ChatMetadata {
  title: string;
  summary: string | null;
  tags: string[];
  attributes: JsonNode | null;
  note: string | null;
}

/** models.rs:9-57 (`null` = `None`). */
export interface StreamChatMessage {
  role: string;
  content: string;
  /** chrono `DateTime<Utc>` in serde form. */
  timestamp: string;
  thinking_content: string | null;
  thought_signature: string | null;
  rag_sources: JsonNode | null;
  memory_sources: JsonNode | null;
  graph_sources: JsonNode | null;
  web_search_sources: JsonNode | null;
  image_paths: string[] | null;
  image_base64: string[] | null;
  doc_attachments: JsonNode | null;
  multimodal_content: JsonNode | null;
  tool_call: JsonNode | null;
  tool_result: JsonNode | null;
  overrides: JsonNode | null;
  relations: JsonNode | null;
  persistent_stable_id: string | null;
  metadata: JsonNode | null;
}

/** models.rs:180-210 (`null` = `None`). */
export interface StreamContext extends TempSessionIdentity {
  temp_id: string;
  question_images: string[];
  analysis_images: string[];
  user_question: string;
  ocr_text: string;
  ocr_note: string | null;
  tags: string[];
  mistake_type: string;
  chat_category: string;
  chat_metadata: ChatMetadata | null;
  chat_history: StreamChatMessage[];
  initial_doc_attachments: JsonNode | null;
  pinned_images: string[] | null;
  /** chrono `DateTime<Utc>` in serde form (`…Z`, AutoSi fraction). */
  created_at: string;
  exam_sheet: JsonNode | null;
  stream_state: TempStreamState;
  bridge_context: JsonNode | null;
  last_error: string | null;
}

/** Version descriptor required by docs/plugins/ARCHITECTURE.md. */
export const appCommandStateService = { name: 'appCommandState', version: '1.1.0' } as const;

/** Wire types already extracted from commands.rs:8215-8240 (camelCase serde). */
export type { DailyActivityDetails, LearningActivity } from '../../../contracts/ipc/generated/L14-qbank.ts';

// Template rules, connection-probe helpers and default adapter options are
// command-owner logic. They stay with L16 anki / L02 llm; duplicating those
// implementations here would create two sources of truth for the same Rust
// functions (quality.md §二.1).

declare module '@deepseek-ai/cordis' {
  interface Context {
    appCommandState: AppCommandState;
  }
}
