import type {} from '@deepseek-ai/cordis';
import type {
  AnkiDocumentGenerationRequest, AnkiSyncReport, CreateTemplateRequest, CustomAnkiTemplate, UpdateTemplateRequest,
} from '../../../contracts/ipc/generated/L16-anki.ts';
import type { AnkiCard, DocumentTask, TaskStatus } from '../../../contracts/ipc/generated/_shared.ts';

export type {
  AnkiDocumentGenerationRequest, AnkiGenerationOptions, AnkiSyncReport, ApkgExportReport, ApkgImportResult,
  ApkgMediaReport, CustomAnkiTemplate, CreateTemplateRequest, UpdateTemplateRequest,
} from '../../../contracts/ipc/generated/L16-anki.ts';
export type { AnkiCard } from '../../../contracts/ipc/generated/_shared.ts';
export type {
  PreferenceStore, PreferenceEntry, PreferenceTimestamp, SessionObservation, ConsolidateOutcome,
} from './src/preference-memory.ts';
import type {
  PreferenceStore, PreferenceTimestamp, SessionObservation, ConsolidateOutcome,
} from './src/preference-memory.ts';
import type {
  AgentReviewStateSnapshot,
  AnkiLibraryCard,
  AnkiLibraryListFilter,
  AnkiLibraryStatusCounts,
} from './src/library.ts';
import type { ApkgImportResult } from './src/apkg-types.ts';
import type { AnkiConnectSyncOptions } from './src/anki-connect.ts';
import type { DetailedSyncInput } from './src/anki-sync.ts';
import type { SqlExecutor } from '../../platform/storage/api.ts';

export type { AnkiConnectMediaMode, AnkiConnectSyncOptions } from './src/anki-connect.ts';
export type { DetailedSyncInput as AnkiDetailedSyncInput } from './src/anki-sync.ts';
import type {
  InsightProjectionCardWrite,
  InsightProjectionTaskUpsert,
} from './repository/insight-projection.ts';

export type {
  InsightProjectionCardWrite,
  InsightProjectionTaskUpsert,
} from './repository/insight-projection.ts';

/** anki_decks owner writes on the caller's connection; L15 wraps raw storage errors. */
export {
  ensureDefaultFsrsDeckWithConn,
  writeFsrsDeckConfigWithConn,
} from './repository/fsrs-decks.ts';

/** dstu-anki::anki::get_template_config 的五元组，顺序保持 Rust。 */
export type TemplateConfig = [string, string[], string, string, string];

/** `commands.rs:4403-4462` deletion result; builtin templates are deactivated. */
export interface AnkiTemplateDeleteResult {
  deleted: boolean;
  deactivated: boolean;
  isBuiltIn: boolean;
  referencingCards: number;
  message: string;
}

/**
 * Template owner facade shared with the five production CRUD commands.
 * Requests are typed/decoded by the caller; fields retain Rust snake_case.
 * Throws kernel CommandError with AppError in `.value` (Validation/Database,
 * original message and details:null). Missing reads return null; update/delete
 * reject missing ids. Update requires expected_version and performs SQL CAS.
 * Each write keeps the Rust statement boundary; builtin user_modified is
 * best-effort after update, and builtin delete preserves the row with a tombstone.
 */
export interface AnkiTemplateService {
  list(): CustomAnkiTemplate[];
  get(templateId: string): CustomAnkiTemplate | null;
  create(request: CreateTemplateRequest): string;
  update(templateId: string, request: UpdateTemplateRequest): null;
  delete(templateId: string): AnkiTemplateDeleteResult;
  /*
   * Raw Rust `Database` / chatanki primitives for consumers that keep their own
   * prefixes, warn-and-continue and ordering (L24 template_executor.rs). Unlike
   * the facade above they throw the unwrapped storage Error (Rust anyhow Display,
   * e.g. `no such table: …`), never CommandError, without facade validation.
   * Each SQL statement autocommits on its own; no method opens a transaction.
   */
  /**
   * `chatanki_executor.rs:11742-11861`: insert every bundled builtin whose id is
   * not already readable, via `create_custom_template_with_id`; insert failures
   * are skipped silently. Returns the inserted count. Throws
   * `Parse builtin templates failed: …` only when the bundled JSON is unusable.
   * Not atomic across templates (one autocommit INSERT each).
   */
  importBuiltinTemplatesIfEmpty(): number;
  /**
   * `database/mod.rs:2552-2622` get_all_custom_templates: the rows, order and decoding of `list()`, without
   * the command's `获取模板列表失败:` AppError wrapper.
   */
  listAll(): CustomAnkiTemplate[];
  /**
   * `database/mod.rs:2713-2836` `update_custom_template`: no existence check,
   * merge or validation. Explicit `version` is written as-is (even when equal to
   * the current one); absent `version` reads the current one (fallback `1.0.0`)
   * and increments it in a separate SELECT. With `expected_version` the single
   * UPDATE is the SQL CAS and affected 0 throws `Error('optimistic_lock_failed')`;
   * without it a missing id is a silent no-op.
   */
  updateIfVersion(templateId: string, request: UpdateTemplateRequest): void;
  /** `database/mod.rs:2907-2916` mark_template_user_modified; non-builtin rows are a no-op. */
  markUserModified(templateId: string): void;
  /** `database/mod.rs:2867-2883` live references (falls back to all rows when `deleted_at` is absent). */
  countReferencingCards(templateId: string): number;
  /** `database/mod.rs:2921-2937`: tombstone; non-builtin/missing throws `builtin_template_not_found: <id>`. */
  softDeleteBuiltin(templateId: string): void;
  /** `database/mod.rs:2839-2846` delete_custom_template: unconditional DELETE, missing id is a no-op. */
  deleteCustom(templateId: string): void;
}

/** L24 chatanki card CAS result (`AnkiCardVersionUpdate`). */
export type AnkiCardVersionUpdate =
  | { kind: 'updated'; card: AnkiCard }
  | { kind: 'conflict'; current: AnkiCard }
  | { kind: 'notFound' };

/** L15/F3 library card locator (`AnkiLibraryCardLocator`). */
export interface AnkiLibraryCardLocator {
  documentId: string;
  sourceSessionId: string | null;
}

/** F3 `AnkiLibraryCardRecord` (`database/mod.rs:112-116`): one live library card plus its task locator. */
export interface AnkiAgentLibraryCardRecord {
  libraryCard: AnkiLibraryCard;
  locator: AnkiLibraryCardLocator;
}

/** F3 `update_anki_card_if_version_for_library` result. */
export type AnkiLibraryCardVersionUpdate =
  | { type: 'updated'; current: AnkiLibraryCard }
  | { type: 'conflict'; current: AnkiLibraryCard }
  | { type: 'notFound' };

/** F3 `delete_anki_card_for_library` result (`AnkiLibraryCardDeleteOutcome`). */
export type AnkiLibraryCardDeleteOutcome =
  | { type: 'deleted'; locator: AnkiLibraryCardLocator }
  | {
    type: 'contentConflict';
    current: AnkiLibraryCard;
    review: AgentReviewStateSnapshot | null;
  }
  | {
    type: 'reviewConflict';
    current: AnkiLibraryCard;
    review: AgentReviewStateSnapshot | null;
  }
  | { type: 'notFound' };

/** F3 agent library page request (`ListAnkiCardsRequest` subset). */
export interface AnkiAgentLibraryListRequest {
  templateId?: string | null;
  search?: string | null;
  filter?: AnkiLibraryListFilter;
  page?: number;
  pageSize?: number;
}

/** F3 agent library page response. */
export interface AnkiAgentLibraryListResult {
  items: AnkiLibraryCard[];
  total: number;
  statusCounts: AnkiLibraryStatusCounts;
}

/** Exact Rust agent-only page; unlike the legacy UI-shaped list above, Due includes new cards. */
export interface AnkiAgentLibraryPageRequest {
  templateId?: string | null;
  search?: string | null;
  schedule?: 'all' | 'due' | 'not_enqueued' | 'suspended' | 'enqueued';
  diagnostic?: 'all' | 'error_only';
  /** u32; normalized to at least 1. */
  page?: number;
  /** u32; normalized to 1..20. */
  pageSize?: number;
}

/** Internal i64 due time, projected only at the consumer's IPC/output boundary. */
export interface AnkiAgentLibraryCard extends Omit<AnkiLibraryCard, 'dueMs'> {
  dueMs: bigint | null;
}

export interface AnkiAgentLibraryRecord {
  libraryCard: AnkiAgentLibraryCard;
  /** Raw immutable provenance from the same SELECT row, not sourceId or a later lookup. */
  locator: { documentId: string; sourceSessionId: string | null };
}

export interface AnkiAgentLibraryPage {
  items: AnkiAgentLibraryRecord[];
  page: number;
  pageSize: number;
  /** SQLite i64 COUNT max(0), retained as a u64 bigint internally. */
  total: bigint;
}

/** L24 chatanki delete CAS result (`AnkiCardVersionDelete`). */
export type AnkiCardVersionDelete =
  | { kind: 'deleted' }
  | { kind: 'conflict'; current: AnkiCard }
  | {
    kind: 'reviewConflict';
    current: AnkiCard;
    review: AgentReviewStateSnapshot | null;
  }
  | { kind: 'notFound' };

/** Template metadata snapshot used by atomic retemplate. */
export interface AnkiRetemplateTarget {
  templateId: string;
  noteType: string;
  fields: string[];
  requiredFields: string[];
}

export interface AnkiRetemplateMissingField {
  field: string;
  required: boolean;
}

export interface AnkiRetemplateCardUpdate {
  documentId: string;
  card: AnkiCard;
  source: AnkiCard;
  missingFields: AnkiRetemplateMissingField[];
}

export interface AnkiRetemplateVersionConflict {
  cardId: string;
  expectedVersion: string;
  currentVersion: string;
}

export type AnkiRetemplateBatchResult =
  | { kind: 'updated'; targetNoteType: string; updates: AnkiRetemplateCardUpdate[] }
  | { kind: 'selectionNotFound'; cardIds: string[] }
  | { kind: 'ownershipRejected' }
  | { kind: 'crossDocumentSelection'; documentIds: string[] }
  | { kind: 'documentSetChanged'; documentIds: string[] }
  | {
    kind: 'expectedVersionsMismatch';
    missingVersionIds: string[];
    unexpectedVersionIds: string[];
  }
  | { kind: 'versionConflict'; conflicts: AnkiRetemplateVersionConflict[] }
  | { kind: 'invalidCloze'; cardIds: string[] };

/**
 * Live mistakes-DB card repository consumed by L24 chatanki.
 *
 * Read methods return `null` instead of leaking whether a document exists when
 * the caller does not own every live task. Mutations repeat ownership and CAS
 * checks inside an immediate transaction.
 */
export interface AnkiCardRepository {
  isDocumentOwnedBySession(documentId: string, sessionId: string): boolean;
  getCardsForDocumentForSession(documentId: string, sessionId: string): AnkiCard[] | null;
  getCardsForDocument(documentId: string): AnkiCard[];
  getCardWithDocument(cardId: string): { card: AnkiCard; documentId: string } | null;
  getCardForSession(cardId: string, sessionId: string): { card: AnkiCard; documentId: string } | null;
  /** Live library cards in request order; throws `library_cards_unavailable: ids`. */
  getLibraryCardsByIds(cardIds: readonly string[]): AnkiCard[];
  loadOwnedCard(cardId: string, sessionId: string): { card: AnkiCard; documentId: string } | null;
  insertCard(card: AnkiCard): boolean;
  insertCardsForDocument(
    documentId: string, sessionId: string, cards: readonly AnkiCard[],
  ): AnkiCard[];
  updateCardIfVersionForSession(
    card: AnkiCard, expectedVersion: string, sessionId: string,
  ): AnkiCardVersionUpdate;
  retemplateCardsForSession(
    selector: { kind: 'document'; documentId: string } | { kind: 'cards'; cardIds: readonly string[] },
    target: AnkiRetemplateTarget,
    expectedVersions: ReadonlyMap<string, string>,
    sessionId: string,
    preflightedDocumentIds: readonly string[],
  ): AnkiRetemplateBatchResult;
  deleteCardForSession(
    cardId: string, expectedVersion: string, expectedReviewVersion: number | bigint | null,
    sessionId: string,
  ): AnkiCardVersionDelete;
}

/** L24 chatanki document/task repository. */
export interface AnkiDocumentTaskRepository {
  getTasksForDocument(documentId: string): DocumentTask[];
  insertDocumentTask(task: DocumentTask): void;
  getDocumentSessionSource(documentId: string): string | null;
  setDocumentSessionSource(documentId: string, sessionId: string): void;
}

/** Tauri `Window::emit` port for `anki_generation_event` payloads. */
export interface AnkiGenerationEventSink {
  emit(event: string, payload: unknown): void;
}

/**
 * `EnhancedAnkiService` run control for L24 `chatanki_run`/`chatanki_start`/`chatanki_control`
 * (`chatanki_executor.rs:6483-6759,8296-8480`), wired exactly like the IPC commands.
 * Events default to the backend bus (Rust `ctx.window_ref()`); pass a sink to
 * redirect them. Failures are the same AppError values the commands wrap.
 */
export interface AnkiDocumentPipeline {
  /**
   * `start_document_processing_with_id`: validates, segments into Pending tasks under
   * `preAllocatedDocumentId`, emits `DocumentProcessingStarted` and schedules them in the
   * background; resolves to that id. Rejects (Configuration) before writing any task when
   * L02 generation is unavailable, like `start_enhanced_document_processing`.
   */
  startDocumentProcessingWithId(
    request: AnkiDocumentGenerationRequest,
    preAllocatedDocumentId: string,
    events?: AnkiGenerationEventSink,
  ): Promise<string>;
  /**
   * `StreamingAnkiService::cancel_streaming` (the `maxCards` limit path, `:8450-8468`):
   * aborts one task's stream; rejects with `任务 {id} 未在运行状态` when it is not streaming.
   */
  cancelStreaming(taskId: string): Promise<void>;
  /** `pause_document_processing`: hard pause; running tasks become `Paused`. */
  pauseDocumentProcessing(documentId: string, events?: AnkiGenerationEventSink): Promise<void>;
  /**
   * `resume_document_processing`: Paused/Pending tasks go back to the stream
   * scheduler; rejects when tasks remain but L02 generation is unavailable.
   */
  resumeDocumentProcessing(documentId: string, events?: AnkiGenerationEventSink): Promise<void>;
  /** `cancel_document_processing`: unfinished tasks become `Cancelled`; generated cards stay. */
  cancelDocumentProcessing(documentId: string, events?: AnkiGenerationEventSink): Promise<void>;
  /**
   * `streaming_anki_service.rs:3493-3600`: inserts one aggregated error-card
   * retry task and marks its cards, or returns null when there is nothing to repair.
   */
  buildRetryTaskForDocument(documentId: string): DocumentTask | null;
  /** `DocumentProcessingService::get_task`; a missing id throws `获取任务失败: …`. */
  getTask(taskId: string): DocumentTask;
  /** `DocumentProcessingService::update_task_status`. */
  updateTaskStatus(taskId: string, status: TaskStatus, errorMessage: string | null): void;
}

/** L16 settings read/write used by preference-memory persistence. */
export interface AnkiSettingsStore {
  getSetting(key: string): string | null;
  saveSetting(key: string, value: string): void;
}

/** Preference observation with the chatanki boundary's camelCase names. */
export interface AnkiPreferenceObservation {
  extraRequirements: string | null;
  edits: Array<{ field: string; before: string; after: string }>;
  deletions: Array<{ front: string; back: string }>;
  generatedCount: number;
  templateUsed: string | null;
}

/** L16 `anki_preference_memory` service surface. */
export interface AnkiPreferenceMemory {
  emptyStore(): PreferenceStore;
  consolidateObservation(
    store: PreferenceStore,
    observation: AnkiPreferenceObservation,
    nowMs: PreferenceTimestamp,
  ): ConsolidateOutcome;
}

/** Minimal L04 block projection used by chatanki mutation UI sync. */
export interface AnkiChatBlock {
  id: string;
  sessionId: string;
  type: string;
  toolOutput: unknown;
  status?: string;
  error?: string | null;
  messageId?: string;
  toolName?: string | null;
  blockIndex?: number;
  startedAt?: number | null;
  firstChunkAt?: number | null;
  endedAt?: number | null;
}

/** `apkg_exporter_service::ApkgExportReport` with every list present (the IPC form omits empty ones). */
export interface AnkiApkgExportMediaReport {
  exportedMedia: number;
  missingMedia: string[];
  warnings: string[];
}

/** L16 APKG exporter for chatanki_export format=apkg (`chatanki_executor.rs:5943-6070`). */
export interface AnkiApkgExporter {
  /**
   * `apkg_exporter_service.rs:2101-2385` export_multi_template_apkg_report: one Anki model per template id,
   * fallback fields for ids missing from `templateMap`, written to `outputPath`. Throws the exporter's own
   * Error (`没有卡片可以导出`, IO/SQLite text), the value Rust maps with `.map_err(|e| e.to_string())`.
   */
  exportMultiTemplateReport(
    cards: readonly AnkiCard[],
    deckName: string,
    outputPath: string,
    templateMap: ReadonlyMap<string, CustomAnkiTemplate>,
  ): AnkiApkgExportMediaReport;
  /** `anki_connect::sanitize_filename_with_extension` with this host's path flavor. */
  sanitizeFilenameWithExtension(raw: string, fallbackName: string, extension: string): string;
}

/** L04-backed chat block read/write adapter. */
export interface AnkiChatBlockStore {
  listSessionBlocks(sessionId: string): AnkiChatBlock[];
  getBlock(blockId: string): AnkiChatBlock | null;
  updateBlock(block: AnkiChatBlock): void;
  upsertBlock(block: AnkiChatBlock): void;
}

/** L11 VFS file row subset required for APKG resource resolution. */
export interface AnkiVfsFile {
  id: string;
  resourceId: string | null;
  fileName: string;
  size: number;
  sha256: string;
  blobHash: string | null;
  originalPath: string | null;
}

export interface AnkiResolvedApkgFile {
  resourceId: string;
  file: AnkiVfsFile;
}

/** L11 VFS-backed APKG byte lookup. */
export interface AnkiApkgVfs {
  resolveApkgFile(rawResourceId: string): AnkiResolvedApkgFile | null;
  readBlob(hash: string): Uint8Array | null;
  statFile(path: string): { size: number } | null;
  isFile(path: string): boolean;
  isVirtualUri(path: string): boolean;
  readFile(path: string): Uint8Array;
}

/** L16 APKG importer as consumed by chatanki (keeps internal `cardIds`). */
export interface AnkiApkgImporter {
  importBytes(
    bytes: Uint8Array, sourceName: string | null, sessionId: string | null,
  ): ApkgImportResult;
  importPath(path: string, sessionId: string | null): ApkgImportResult;
  /** F7 `nativeCompression` zstd path; sync wrappers above remain for L24. */
  importBytesAsync(
    bytes: Uint8Array, sourceName: string | null, sessionId: string | null,
  ): Promise<ApkgImportResult>;
  importPathAsync(path: string, sessionId: string | null): Promise<ApkgImportResult>;
}

/** anki 服务。后续迁移仅增补方法；服务错误与 Rust Result 的 Err 值相同。 */
export const ankiService = { name: 'anki', version: '1.0.0' } as const;

export interface AnkiService {
  /** L24 template CRUD owner; also used by the existing IPC commands. */
  readonly templates: AnkiTemplateService;
  /** L24 chatanki live card repository (real mistakes DB). */
  readonly cards: AnkiCardRepository;
  /** L24 chatanki document/task repository (real mistakes DB). */
  readonly documents: AnkiDocumentTaskRepository;
  /** L04 chat blocks used by chatanki mutation UI sync. */
  readonly chatBlocks: AnkiChatBlockStore;
  /** L16 settings used by chatanki preference persistence. */
  readonly settings: AnkiSettingsStore;
  /** L16 preference-memory pure functions. */
  readonly preferenceMemory: AnkiPreferenceMemory;
  /** L16 APKG importer (import bytes/path into the mistakes DB). */
  readonly apkgImporter: AnkiApkgImporter;
  /** L16 APKG exporter (multi-template report) used by chatanki_export. */
  readonly apkgExporter: AnkiApkgExporter;
  /** L11 VFS file/blob lookup used by chatanki APKG resource imports. */
  readonly apkgVfs: AnkiApkgVfs;
  /** L16 document-processing run control (pause/resume/cancel/retry). */
  readonly pipeline: AnkiDocumentPipeline;
  /** F3 `insert_anki_card`: returns whether the row was inserted. */
  insertAnkiCard(card: AnkiCard): boolean;
  /** F3 `list_anki_library_cards_filtered` page surface. */
  listAnkiAgentLibraryCards(
    request: AnkiAgentLibraryListRequest,
    nowMs?: number,
  ): AnkiAgentLibraryListResult;
  /** `database/mod.rs:7604-7725`: exact cross-session agent read only; does not widen session mutations. */
  listAnkiAgentLibraryPage(
    request: AnkiAgentLibraryPageRequest,
    nowMs?: number | bigint,
  ): AnkiAgentLibraryPage;
  /**
   * F3 `get_anki_agent_library_card` (`database/mod.rs:5330-5341`): the trimmed id's live card, or null.
   * Throws `cardId is required` for a blank id.
   */
  getAnkiAgentLibraryCard(cardId: string, nowMs?: number): AnkiAgentLibraryCardRecord | null;
  /** F3 `update_anki_card_if_version_for_library` content CAS. */
  updateAnkiCardIfVersionForLibrary(
    card: AnkiCard,
    expectedVersion: string,
    nowMs?: number,
  ): AnkiLibraryCardVersionUpdate;
  /** F3 session-scoped content CAS (ownership checked in the transaction). */
  updateAnkiCardIfVersionForSession(
    card: AnkiCard,
    expectedVersion: string,
    sessionId: string,
  ): AnkiCardVersionUpdate;
  /** F3 `get_anki_agent_library_cards_by_ids`; throws on any missing id. */
  getAnkiAgentLibraryCardsByIds(cardIds: readonly string[]): AnkiCard[];
  /** F3 library delete with content + exact i64 review-version CAS (D3). */
  deleteAnkiCardForLibrary(
    cardId: string,
    expectedVersion: string,
    expectedReviewVersion: number | bigint | null,
    nowMs?: number,
  ): AnkiLibraryCardDeleteOutcome;
  getTemplateConfig(templateId: string): TemplateConfig;
  getCustomTemplateById(templateId: string): CustomAnkiTemplate | null;
  checkAnkiConnectAvailability(): Promise<boolean>;
  getDeckNames(): Promise<string[]>;
  getModelNames(): Promise<string[]>;
  createDeckIfNotExists(deckName: string): Promise<void>;
  /** `anki_connect_service::template_model_name`: `Deep Student / <id> / v<version>`. */
  templateModelName(template: Pick<CustomAnkiTemplate, 'id' | 'version'>): string;
  /** `AnkiConnectSyncOptions::from_setting_strings` (unset or invalid values fall back to defaults). */
  syncOptionsFromSettings(
    batchSize: string | null,
    retryTimes: string | null,
    mediaMode: string | null,
  ): AnkiConnectSyncOptions;
  /**
   * The three `anki_connect_*` settings from the mistakes DB through
   * `syncOptionsFromSettings`; an unreadable key counts as unset (Rust `.ok().flatten()`).
   */
  readSyncOptions(): AnkiConnectSyncOptions;
  /** `add_notes_to_anki_detailed`; rejects with the Rust `Err(String)` text. */
  addNotesToAnkiDetailed(input: DetailedSyncInput): Promise<AnkiSyncReport>;
  /**
   * `database/mod.rs:6009-6050` `write_anki_export_receipts`: pairs ids by index,
   * skips null note ids and blank card ids, returns the live rows written.
   */
  writeAnkiExportReceipts(
    cardIds: readonly string[],
    noteIds: readonly (number | null)[],
    exportedAt?: string,
  ): number;
  saveJsonFile(content: string, suggestedName: string): Promise<string>;
  /** `anki_preference_memory.rs`: consolidate one session observation (ADD-only). */
  consolidatePreferenceObservation(
    store: PreferenceStore,
    observation: SessionObservation,
    nowMs: PreferenceTimestamp,
  ): ConsolidateOutcome;
  /** `anki_preference_memory.rs`: render the prompt hint within a token budget. */
  retrievePreferencePrompt(
    store: PreferenceStore,
    goal: string,
    availableTemplates: readonly string[],
    maxTokens: number,
  ): string;
  /**
   * D1 owner seam for L17 insight SRS projection (`dstu-research/src/insight/jobs.rs:651-656`).
   * `conn` is the caller's `mistakes` connection; one autocommit statement, no new transaction.
   */
  tombstoneInsightProjectionCardWithConn(conn: SqlExecutor, cardId: string, now: string): void;
  /** `jobs.rs:685-703`: synthetic `document_tasks` upsert on the caller's connection. */
  upsertInsightProjectionTaskWithConn(conn: SqlExecutor, task: InsightProjectionTaskUpsert): void;
  /**
   * `jobs.rs:706-729`: when the card exists, update only front/back/updated_at and clear
   * deleted_at (FSRS state and review history untouched); otherwise insert an `inspiration` card.
   */
  writeInsightProjectionCardWithConn(
    conn: SqlExecutor,
    card: InsightProjectionCardWrite,
  ): 'updated' | 'inserted';
}

export { sanitizeFilenameComponent, sanitizeFilenameWithExtension } from './src/card-utils.ts';
export {
  OCCLUSION_FIELD, OCCLUSION_TAG, OCCLUSION_DRAFT_PREFIX, OCCLUSION_BOXES_OPEN, OCCLUSION_BOXES_CLOSE,
  defaultOcclusionConfig, validateSpec, pairwiseIou, toPixelBoxes, buildCardFields, parseOcclusionField,
  occlusionImageRefFromFields, formatAnkiIoCloze, parseOcclusionBoxesFromVlm, stripOcclusionBoxesBlocks,
  proposeBoxesFromImageDesc, buildOcclusionDraftMarker, buildOcclusionDraftMarkerFromSpec,
  extractOcclusionDraftFields, stripOcclusionDraftMarkers,
} from './src/image-occlusion.ts';
export type {
  OcclusionConfig, OcclusionBox, OcclusionSpec, ValidatedOcclusionSpec, OcclusionIssue, PixelBox, OcclusionCardFields,
} from './src/image-occlusion.ts';

export type { AgentReviewStateSnapshot } from './src/library.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    anki: AnkiService;
    /** `pending_memory_candidates` writer for memory `knowledge_extract` (`knowledge_executor.rs:104-166`). */
    pendingMemoryCandidates: import('../memory/api.ts').PendingMemoryCandidateWriter;
  }
}
