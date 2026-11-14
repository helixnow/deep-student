/** Content collection contracts: textbooks, pomodoros, attachments, mindmaps, exams, essays, reviews, translations and media. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { JsonValue } from './common.ts';
import type { ResourceLocation } from './core.ts';

/** VfsTextbook mirrors vfs/types.rs `VfsTextbook` (skip_serializing_if fields omitted). */
export interface VfsTextbook {
  id: string; resourceId?: string; blobHash?: string; sha256: string; fileName: string;
  originalPath?: string; size: number; pageCount?: number; tags: string[];
  isFavorite: boolean; lastOpenedAt?: string; lastPage?: number;
  bookmarks: JsonValue[]; highlights: JsonValue[]; coverKey?: string;
  status: string; createdAt: string; updatedAt: string;
}
export interface PageIndexMeta {
  pageIndex: number; blobHash: string; embeddingDim: number;
  indexingMode: string; indexedAt: string;
}
export interface TextbookRepository {
  createTextbook(conn: SqlExecutor, sha256: string, fileName: string, size: number,
    blobHash: string | null, originalPath: string | null): VfsTextbook;
  createTextbookWithPreview(conn: SqlExecutor, sha256: string, fileName: string, size: number,
    blobHash: string | null, originalPath: string | null, previewJson: string | null,
    extractedText: string | null, pageCount: number | null): VfsTextbook;
  copyTextbook(conn: SqlExecutor, srcTextbookId: string, newFileName: string): VfsTextbook;
  getTextbook(conn: SqlExecutor, textbookId: string): VfsTextbook | null;
  getBySha256(conn: SqlExecutor, sha256: string): VfsTextbook | null;
  listTextbooks(conn: SqlExecutor, limit: number, offset: number): VfsTextbook[];
  searchTextbooks(conn: SqlExecutor, search: string, limit: number, offset: number): VfsTextbook[];
  updateReadingProgress(conn: SqlExecutor, textbookId: string, lastPage: number): void;
  updatePageCount(conn: SqlExecutor, textbookId: string, pageCount: number): void;
  updateFileName(conn: SqlExecutor, textbookId: string, newName: string): VfsTextbook;
  setFavorite(conn: SqlExecutor, textbookId: string, favorite: boolean): void;
  updateBookmarks(conn: SqlExecutor, textbookId: string, bookmarks: readonly JsonValue[]): void;
  replaceBookmarksIfVersion(conn: SqlExecutor, textbookId: string,
    bookmarks: readonly JsonValue[], expectedUpdatedAt: string): VfsTextbook;
  replaceHighlightsIfVersion(conn: SqlExecutor, textbookId: string,
    highlights: readonly JsonValue[], expectedUpdatedAt: string): VfsTextbook;
  deleteTextbook(conn: SqlExecutor, textbookId: string): void;
  restoreTextbook(conn: SqlExecutor, textbookId: string): void;
  renameTextbook(conn: SqlExecutor, textbookId: string, newFileName: string): boolean;
  /**
   * cmd/textbooks.rs:747-754 `textbooks_relink` write: only `original_path` + `updated_at`, no
   * transaction, 0 rows not checked (returns the change count). SQL errors propagate unwrapped.
   * `updated_at` is generated here as `%Y-%m-%dT%H:%M:%S%.3fZ`, matching Rust's `now` taken
   * immediately before the UPDATE; it is L18's relink owner entry (no separate files setter).
   */
  setOriginalPathWithConn(conn: SqlExecutor, textbookId: string, originalPath: string): number;
  /**
   * cmd/textbooks.rs:631-641 `textbooks_add` pptx/epub page text: only `ocr_pages_json`
   * (no `updated_at`), caller's connection, 0 rows unchecked. SQL errors propagate unwrapped;
   * the caller keeps Rust's `[Textbooks] Failed to write ocr_pages_json for {id}: {e}` warn.
   */
  updateTextbookOcrPagesJson(conn: SqlExecutor, textbookId: string, pagesJson: string): void;
  /**
   * cmd/textbooks.rs:644-654 `textbooks_add` PDF render failure: only
   * `processing_status = 'error'` + `processing_error` (no `processing_completed_at`/`updated_at`).
   * SQL errors propagate unwrapped; the caller keeps Rust's
   * `[Textbooks] Failed to write render failure status for {id}: {e}` warn.
   */
  markTextbookRenderError(conn: SqlExecutor, textbookId: string, renderError: string): void;
  attachBlobIfMissing(conn: SqlExecutor, blobsDir: string, textbookId: string,
    data: Uint8Array, mimeType: string | null, extension: string | null): boolean;
  purgeTextbook(conn: SqlExecutor, blobsDir: string, textbookId: string): void;
  purgeTextbookWithConn(conn: SqlExecutor, textbookId: string, blobsDir: string): void;
  listDeletedTextbooks(conn: SqlExecutor, limit: number, offset: number): VfsTextbook[];
  purgeDeletedTextbooks(conn: SqlExecutor, blobsDir: string): number;
  createTextbookInFolder(conn: SqlExecutor, sha256: string, fileName: string, size: number,
    blobHash: string | null, originalPath: string | null, folderId: string | null): VfsTextbook;
  deleteTextbookWithFolderItem(conn: SqlExecutor, textbookId: string): void;
  purgeTextbookWithFolderItem(conn: SqlExecutor, blobsDir: string, textbookId: string): void;
  listTextbooksByFolder(conn: SqlExecutor, folderId: string | null, limit: number, offset: number): VfsTextbook[];
  getTextbookLocation(conn: SqlExecutor, textbookId: string): ResourceLocation | null;
  listAllTextbooks(conn: SqlExecutor, limit: number, offset: number): VfsTextbook[];
  savePageOcr(conn: SqlExecutor, textbookId: string, pageIndex: number, ocrText: string): void;
  saveOcrPages(conn: SqlExecutor, textbookId: string, ocrPages: readonly (string | null)[]): void;
  getPageOcr(conn: SqlExecutor, textbookId: string, pageIndex: number): string | null;
  getAllOcrPages(conn: SqlExecutor, textbookId: string): (string | null)[];
  hasPageOcr(conn: SqlExecutor, textbookId: string, pageIndex: number): boolean;
  savePageMmIndex(conn: SqlExecutor, textbookId: string, meta: PageIndexMeta): void;
  getMmIndexedPages(conn: SqlExecutor, textbookId: string): PageIndexMeta[];
  getMmIndexedBlobHashes(conn: SqlExecutor, textbookId: string): Record<number, string>;
  clearMmIndex(conn: SqlExecutor, textbookId: string): void;
  getMmIndexState(conn: SqlExecutor, textbookId: string): string | null;
  setMmIndexState(conn: SqlExecutor, textbookId: string, state: string, error: string | null): void;
}
/** PomodoroRecord mirrors vfs/types.rs `PomodoroRecord` (skip_serializing_if fields omitted). */
export interface PomodoroRecord {
  id: string; todoItemId?: string; startTime: string; endTime?: string;
  duration: number; actualDuration: number; type: string; status: string;
  createdAt: string; updatedAt?: string; deletedAt?: string;
}
export interface CreatePomodoroRecordParams {
  todoItemId?: string | null; startTime: string; endTime?: string | null;
  duration: number; actualDuration: number; type: string; status: string;
}
export interface PomodoroTodayStats {
  completedCount: number; totalFocusSeconds: number; interruptedCount: number;
  completedFocusSeconds: number;
}
export interface PomodoroDailyStat {
  date: string; completedCount: number; focusSeconds: number; interruptedCount: number;
}
export interface PomodoroStreakStats { currentStreakDays: number; longestStreakDays: number }
export interface PomodoroHourlyStat { hour: number; completedCount: number; focusSeconds: number }
export interface PomodoroTodoStat {
  todoItemId: string; todoTitle?: string; completedCount: number; focusSeconds: number;
}
export interface PomodoroWeeklyStat {
  weekStart: string; completedCount: number; focusSeconds: number;
  interruptedCount: number; activeDays: number;
}
export interface PomodoroStatsOverview {
  today: PomodoroTodayStats; streak: PomodoroStreakStats;
  daily: PomodoroDailyStat[]; weekly: PomodoroWeeklyStat[];
}
export interface PomodoroFocusDay {
  date: string; focusSeconds: number; completedCount: number; interruptedCount: number;
}
export interface PomodoroTodoFocusSummary {
  todoItemId: string; todoTitle?: string; totalFocusSeconds: number;
  completedCount: number; interruptedCount: number;
  firstFocusAt?: string; lastFocusAt?: string; daily: PomodoroFocusDay[];
}
export interface PomodoroRepository {
  createRecord(conn: SqlExecutor, params: CreatePomodoroRecordParams): PomodoroRecord;
  deleteRecord(conn: SqlExecutor, recordId: string): void;
  recountCompletedPomodorosCache(conn: SqlExecutor, todoItemId: string, now: string): void;
  /**
   * S04/TD-02 表所有者入口：在同步 apply 的 `BEGIN IMMEDIATE` 事务内、所有单条
   * SAVEPOINT 之后、提交之前调用。`changedTables` 是本批变更涉及的表名；只有包含
   * `pomodoro_records` / `todo_items` 时才重算。调用方不得拆分/另开事务，也不得
   * 直接写 `todo_items.completed_pomodoros`。
   */
  recomputeCompletedPomodorosForSyncBatch(conn: SqlExecutor, changedTables: readonly string[]): void;
  getRecord(conn: SqlExecutor, recordId: string): PomodoroRecord | null;
  listByTodoItem(conn: SqlExecutor, todoItemId: string): PomodoroRecord[];
  getTodayStats(conn: SqlExecutor): PomodoroTodayStats;
  focusSecondsByLocalDate(conn: SqlExecutor, startDate: string, endDateExclusive: string): Record<string, number>;
  getDailyStats(conn: SqlExecutor, days: number): PomodoroDailyStat[];
  listTodayRecords(conn: SqlExecutor): PomodoroRecord[];
  listRange(conn: SqlExecutor, startDate: string, endDate: string): PomodoroRecord[];
  getStreakStats(conn: SqlExecutor): PomodoroStreakStats;
  getHourlyStats(conn: SqlExecutor, days: number): PomodoroHourlyStat[];
  getStatsByTodo(conn: SqlExecutor, startDate: string | null, endDate: string | null, limit: number): PomodoroTodoStat[];
  getStatsOverview(conn: SqlExecutor, days: number): PomodoroStatsOverview;
  getTodoFocusSummary(conn: SqlExecutor, todoItemId: string): PomodoroTodoFocusSummary;
}
/** VfsAttachment mirrors types.rs `VfsAttachment` (camelCase, `type` wire key). */
export interface VfsAttachment {
  id: string; resourceId?: string; blobHash?: string; type: string; name: string;
  mimeType: string; size: number; contentHash: string; isFavorite: boolean;
  createdAt: string; updatedAt: string; previewJson?: string; extractedText?: string;
  pageCount?: number; deletedAt?: string;
}
export interface VfsUploadAttachmentParams {
  name: string; mimeType: string; base64Content: string; type?: string | null;
}
export interface VfsUploadAttachmentResult {
  sourceId: string; resourceHash: string; isNew: boolean; attachment: VfsAttachment;
  processingStatus?: string; processingPercent?: number; readyModes?: string[];
  contentKind?: string;
}
export type VfsAttachmentContentSource =
  | { kind: 'base64'; data: string }
  | { kind: 'file'; path: string };
/** Rust `render_pdf_preview_with_progress` callback: `(current_page, total_pages)`. */
export type PdfRenderProgress = (currentPage: number, totalPages: number) => void;
/** Native document/PDF processing used by attachment uploads. */
export interface AttachmentProcessingAdapter {
  checkPdfEncryption(bytes: Uint8Array, name: string): void;
  /**
   * F7 pdfium/image rendering is async; same stage/order as Rust pdf_preview.
   * `config` omitted = Rust `PdfPreviewConfig::default()`. `progress` is Rust
   * `render_pdf_preview_with_progress`'s callback (pdf_preview.rs:82-225): called with
   * `(pageIndex + 1, renderPages)` before each page render, never for encrypted/non-PDF input.
   */
  renderPdf(conn: SqlExecutor, blobsDir: string, bytes: Uint8Array,
    config?: import('../repository/pdf-preview.ts').PdfPreviewConfig,
    progress?: PdfRenderProgress): Promise<import('../repository/pdf-preview.ts').PdfPreviewResult>;
  extractPagedText(name: string, bytes: Uint8Array): Promise<string[] | null>;
  extractText(name: string, bytes: Uint8Array): Promise<string | null>;
  buildZipManifest(name: string, bytes: Uint8Array): string | null;
}
export interface AttachmentRepository {
  maxUploadSizeBytes(mimeType: string): number;
  isSupportedUploadType(name: string, mimeType: string): boolean;
  isSafeOriginalPath(blobsDir: string, path: string): boolean;
  isProbablyBase64(input: string): boolean;
  resolveOriginalPath(blobsDir: string, id: string, rawPath: string): string | null;
  buildOriginalPathCandidates(blobsDir: string, rawPath: string): string[];
  extractRelativeFromSlotPath(path: string): string | null;
  decodeBase64(input: string): Uint8Array;
  decodeBase64Bounded(input: string, maxBytes: number): Uint8Array;
  computeHash(data: Uint8Array): string;
  inferTypeFromMime(mimeType: string): string;
  inferExtension(mimeType: string, name: string): string | null;
  validateArchiveContent(name: string, mimeType: string, data: Uint8Array): void;
  readFileBounded(path: string, maxBytes: number): Uint8Array;
  getProcessingStatus(conn: SqlExecutor, attachmentId: string): [string | null, number | null, string[] | null];
  getById(conn: SqlExecutor, id: string): VfsAttachment | null;
  resolveFileId(conn: SqlExecutor, rawId: string): string | null;
  list(conn: SqlExecutor, typeFilter: string | null, limit: number, offset: number): VfsAttachment[];
  getByHash(conn: SqlExecutor, contentHash: string): VfsAttachment | null;
  getContent(conn: SqlExecutor, blobsDir: string, id: string): string | null;
  getContentBounded(conn: SqlExecutor, blobsDir: string, id: string, maxBytes: number): string | null;
  getContentSource(conn: SqlExecutor, blobsDir: string, id: string): VfsAttachmentContentSource | null;
  /**
   * attachment_stage_executor.rs:1350-1362 原文读取：`COALESCE(r.data, '')`，不解码、不trim。
   * 缺失或已删除文件返回 null；资源缺失或无 data 返回 ''。SQL 错误原样抛出（不包装）。
   */
  getInlineDataWithConn(conn: SqlExecutor, fileId: string): string | null;
  setFavorite(conn: SqlExecutor, attachmentId: string, favorite: boolean): void;
  purgeAttachment(conn: SqlExecutor, blobsDir: string, id: string): void;
  purgeAttachmentWithConn(conn: SqlExecutor, id: string): void;
  deleteAttachment(conn: SqlExecutor, id: string): void;
  restoreAttachment(conn: SqlExecutor, id: string): void;
  listDeletedAttachments(conn: SqlExecutor, limit: number, offset: number): VfsAttachment[];
  purgeDeletedAttachments(conn: SqlExecutor, blobsDir: string): number;
  saveOcrPages(conn: SqlExecutor, attachmentId: string, ocrPages: readonly (string | null)[]): void;
  savePageOcr(conn: SqlExecutor, attachmentId: string, pageIndex: number, ocrText: string): void;
  getOcrPages(conn: SqlExecutor, attachmentId: string): (string | null)[];
  getPageOcr(conn: SqlExecutor, attachmentId: string, pageIndex: number): string | null;
  getMmIndexState(conn: SqlExecutor, attachmentId: string): string | null;
  setMmIndexState(conn: SqlExecutor, attachmentId: string, state: string, error: string | null): void;
  saveMmIndexedPages(conn: SqlExecutor, attachmentId: string, indexedPagesJson: string): void;
  uploadWithConn(conn: SqlExecutor, blobsDir: string, params: VfsUploadAttachmentParams): Promise<VfsUploadAttachmentResult>;
  uploadBytesWithConn(conn: SqlExecutor, blobsDir: string, params: VfsUploadAttachmentParams,
    data: Uint8Array): Promise<VfsUploadAttachmentResult>;
  uploadWithFolderConn(conn: SqlExecutor, blobsDir: string, params: VfsUploadAttachmentParams,
    folderId: string | null): Promise<VfsUploadAttachmentResult>;
  uploadBytesWithFolderConn(conn: SqlExecutor, blobsDir: string, params: VfsUploadAttachmentParams,
    data: Uint8Array, folderId: string | null): Promise<VfsUploadAttachmentResult>;
  uploadMediaStreamFinalized(conn: SqlExecutor, blobsDir: string, params: VfsUploadAttachmentParams,
    chunks: Iterable<Uint8Array>, folderId: string | null,
    finalize?: (conn: SqlExecutor, result: VfsUploadAttachmentResult) => void): VfsUploadAttachmentResult;
}
/** VfsMindMap mirrors types.rs `VfsMindMap` (camelCase, absent optional fields). */
export interface VfsMindMap {
  id: string; resourceId: string; title: string; description?: string; isFavorite: boolean;
  defaultView: string; theme?: string; settings?: JsonValue; createdAt: string;
  updatedAt: string; contentUpdatedAt: string; deletedAt?: string;
}
/** VfsMindMapVersion mirrors types.rs `VfsMindMapVersion` (camelCase). */
export interface VfsMindMapVersion {
  versionId: string; mindmapId: string; resourceId: string; title: string;
  label?: string; source?: string; createdAt: string;
}
export interface VfsCreateMindMapParams {
  title: string; description?: string | null; content?: string;
  defaultView?: string; theme?: string | null;
}
export interface VfsUpdateMindMapParams {
  title?: string | null; description?: string | null; content?: string | null;
  defaultView?: string | null; theme?: string | null; settings?: JsonValue | null;
  expectedUpdatedAt?: string | null; versionSource?: string | null;
}
export interface MindmapRepository {
  normalizeContent(content: string): string;
  createMindmap(conn: SqlExecutor, params: VfsCreateMindMapParams): VfsMindMap;
  createMindmapWithConn(conn: SqlExecutor, params: VfsCreateMindMapParams): VfsMindMap;
  createMindmapInFolder(conn: SqlExecutor, params: VfsCreateMindMapParams,
    folderId: string | null): VfsMindMap;
  createMindmapInFolderWithConn(conn: SqlExecutor, params: VfsCreateMindMapParams,
    folderId: string | null): VfsMindMap;
  updateMindmap(conn: SqlExecutor, mindmapId: string,
    params: VfsUpdateMindMapParams): VfsMindMap;
  updateMindmapWithConn(conn: SqlExecutor, mindmapId: string,
    params: VfsUpdateMindMapParams): VfsMindMap;
  updateMindmapReturningVersion(conn: SqlExecutor, mindmapId: string,
    params: VfsUpdateMindMapParams, snapshotAfter: boolean):
    [VfsMindMap, VfsMindMapVersion | null];
  updateMindmapReturningVersionWithConn(conn: SqlExecutor, mindmapId: string,
    params: VfsUpdateMindMapParams, snapshotAfter: boolean):
    [VfsMindMap, VfsMindMapVersion | null];
  countActiveMindmapsByResourceId(conn: SqlExecutor, resourceId: string): number;
  countActiveMindmapsByResourceIdWithConn(conn: SqlExecutor, resourceId: string): number;
  getMindmap(conn: SqlExecutor, mindmapId: string): VfsMindMap | null;
  getMindmapWithConn(conn: SqlExecutor, mindmapId: string): VfsMindMap | null;
  getMindmapContent(conn: SqlExecutor, mindmapId: string): string | null;
  getMindmapContentWithConn(conn: SqlExecutor, mindmapId: string): string | null;
  listMindmaps(conn: SqlExecutor): VfsMindMap[];
  listMindmapsWithConn(conn: SqlExecutor): VfsMindMap[];
  listMindmapsByFolder(conn: SqlExecutor, folderId: string | null, limit: number,
    offset: number): VfsMindMap[];
  listMindmapsByFolderWithConn(conn: SqlExecutor, folderId: string | null, limit: number,
    offset: number): VfsMindMap[];
  deleteMindmap(conn: SqlExecutor, mindmapId: string): void;
  deleteMindmapWithConn(conn: SqlExecutor, mindmapId: string): void;
  restoreMindmap(conn: SqlExecutor, mindmapId: string): VfsMindMap;
  restoreMindmapWithConn(conn: SqlExecutor, mindmapId: string): VfsMindMap;
  purgeMindmap(conn: SqlExecutor, mindmapId: string): void;
  purgeMindmapWithConn(conn: SqlExecutor, mindmapId: string): void;
  setFavorite(conn: SqlExecutor, mindmapId: string, isFavorite: boolean): void;
  setFavoriteWithConn(conn: SqlExecutor, mindmapId: string, isFavorite: boolean): void;
  listDeletedMindmaps(conn: SqlExecutor, limit: number, offset: number): VfsMindMap[];
  listDeletedMindmapsWithConn(conn: SqlExecutor, limit: number, offset: number): VfsMindMap[];
  purgeDeletedMindmaps(conn: SqlExecutor): number;
  purgeDeletedMindmapsWithConn(conn: SqlExecutor): number;
  createVersion(conn: SqlExecutor, mindmapId: string, content: string, title: string,
    label: string | null, source: string | null): VfsMindMapVersion;
  createVersionWithConn(conn: SqlExecutor, mindmapId: string, content: string, title: string,
    label: string | null, source: string | null): VfsMindMapVersion;
  getVersions(conn: SqlExecutor, mindmapId: string): VfsMindMapVersion[];
  getVersionsWithConn(conn: SqlExecutor, mindmapId: string): VfsMindMapVersion[];
  getVersionsPaged(conn: SqlExecutor, mindmapId: string, limit: number): VfsMindMapVersion[];
  getVersionsPagedWithConn(conn: SqlExecutor, mindmapId: string,
    limit: number): VfsMindMapVersion[];
  getVersion(conn: SqlExecutor, versionId: string): VfsMindMapVersion | null;
  getVersionWithConn(conn: SqlExecutor, versionId: string): VfsMindMapVersion | null;
  getVersionContent(conn: SqlExecutor, versionId: string): string | null;
  getVersionContentWithConn(conn: SqlExecutor, versionId: string): string | null;
  restoreVersion(conn: SqlExecutor, versionId: string): VfsMindMap;
  restoreVersionWithConn(conn: SqlExecutor, versionId: string): VfsMindMap;
}
/** VfsExamSheet mirrors types.rs `VfsExamSheet` (camelCase, absent optional fields). */
export interface VfsExamSheet {
  id: string; resourceId?: string; examName?: string; status: string; tempId: string;
  metadataJson: JsonValue; previewJson: JsonValue; linkedMistakeIds?: string[];
  isFavorite: boolean; createdAt: string; updatedAt: string;
}
export interface VfsCreateExamSheetParams {
  examName?: string | null; tempId: string; metadataJson: JsonValue; previewJson: JsonValue;
  status?: string; folderId?: string | null;
}
/** ImportingSession mirrors exam_repo.rs (snake_case fields). */
export interface ImportingSession {
  session_id: string; exam_name: string | null; import_state_json: string | null;
  existing_question_count: number;
}
export interface ExamRepository {
  listExamSheets(conn: SqlExecutor, search: string | null, limit: number, offset: number): VfsExamSheet[];
  countExamSheets(conn: SqlExecutor, search: string | null): number;
  getExamSheet(conn: SqlExecutor, examId: string): VfsExamSheet | null;
  getExamSheetContent(conn: SqlExecutor, examId: string): string | null;
  searchExamSheets(conn: SqlExecutor, query: string, limit: number): VfsExamSheet[];
  createExamSheet(conn: SqlExecutor, params: VfsCreateExamSheetParams): VfsExamSheet;
  copyExamSheet(conn: SqlExecutor, srcExamId: string, folderId: string | null): VfsExamSheet;
  createExamSheetLegacy(conn: SqlExecutor, examName: string | null, tempId: string, status: string,
    metadataJson: JsonValue, previewJson: JsonValue): VfsExamSheet;
  upsertExamSheet(conn: SqlExecutor, params: VfsCreateExamSheetParams, examId: string | null): VfsExamSheet;
  updateLinkedMistakes(conn: SqlExecutor, examId: string, linkedMistakeIds: readonly string[] | null): void;
  updateExamName(conn: SqlExecutor, examId: string, newName: string): VfsExamSheet;
  setFavorite(conn: SqlExecutor, examId: string, favorite: boolean): void;
  updateStatus(conn: SqlExecutor, examId: string, status: string): void;
  deleteExamSheet(conn: SqlExecutor, examId: string): void;
  purgeExamSheet(conn: SqlExecutor, blobsDir: string, examId: string): void;
  purgeExamSheetWithConn(conn: SqlExecutor, examId: string): void;
  restoreExam(conn: SqlExecutor, examId: string): void;
  listDeletedExams(conn: SqlExecutor, limit: number, offset: number): VfsExamSheet[];
  listAllExamSheets(conn: SqlExecutor): VfsExamSheet[];
  updatePreviewJson(conn: SqlExecutor, examId: string, previewJson: JsonValue): void;
  updatePreviewJsonIfUnchanged(conn: SqlExecutor, examId: string, previewJson: JsonValue,
    expectedUpdatedAt: string): boolean;
  updateImportState(conn: SqlExecutor, examId: string, importStateJson: JsonValue): void;
  clearImportState(conn: SqlExecutor, examId: string): void;
  /** qbank legacy reparse resolve: writes the stored text verbatim and keeps `updated_at`. */
  setImportStateRaw(conn: SqlExecutor, examId: string, importStateJson: string | null): void;
  /** qbank draft commit: `question_document_version=2`, `status='completed'`, import state cleared. */
  markQuestionDocumentCompleted(conn: SqlExecutor, examId: string): void;
  listImportingSessions(conn: SqlExecutor): ImportingSession[];
  getImportState(conn: SqlExecutor, examId: string): string | null;
  createExamSheetInFolder(conn: SqlExecutor, params: VfsCreateExamSheetParams,
    folderId: string | null): VfsExamSheet;
  deleteExamSheetWithFolderItem(conn: SqlExecutor, examId: string): void;
  listExamSheetsByFolder(conn: SqlExecutor, folderId: string | null, limit: number, offset: number): VfsExamSheet[];
  getExamSheetLocation(conn: SqlExecutor, examId: string): ResourceLocation | null;
  saveOcrPages(conn: SqlExecutor, examId: string, ocrPages: readonly (string | null)[]): void;
  savePageOcr(conn: SqlExecutor, examId: string, pageIndex: number, ocrText: string): void;
  getOcrPages(conn: SqlExecutor, examId: string): (string | null)[];
  getPageOcr(conn: SqlExecutor, examId: string, pageIndex: number): string | null;
  getMmIndexState(conn: SqlExecutor, examId: string): string | null;
  setMmIndexState(conn: SqlExecutor, examId: string, state: string, error: string | null): void;
  /** `multimodal_service.rs` business-table state write for `exam_sheets` rows. */
  applyMultimodalIndexState(conn: SqlExecutor, examId: string, state: string,
    indexedPagesJsonOrError: string | null, embeddingDim: number): void;
  saveMmIndexMetadata(conn: SqlExecutor, examId: string, indexedPagesJson: string,
    embeddingDim: number, indexingMode: string): void;
}
/** VfsEssay mirrors types.rs `VfsEssay` (camelCase, absent optional fields). */
export interface VfsEssay {
  id: string; resourceId: string; title?: string; essayType?: string;
  gradingResult?: JsonValue; score?: number; sessionId?: string; roundNumber: number;
  gradeLevel?: string; customPrompt?: string; isFavorite: boolean;
  dimensionScores?: JsonValue; createdAt: string; updatedAt: string;
}
/** VfsEssaySession mirrors serde output (snake_case; essay_type/grade_level always strings). */
export interface VfsEssaySession {
  id: string; title: string; essay_type: string; grade_level: string;
  custom_prompt: string | null; total_rounds: number; latest_score?: number;
  is_favorite: boolean; created_at: string; updated_at: string; deleted_at?: string;
}
export interface VfsCreateEssayParams {
  title?: string | null; essayType?: string | null; content: string;
  gradingResult?: JsonValue | null; score?: number | null; sessionId?: string | null;
  roundNumber?: number; gradeLevel?: string | null; customPrompt?: string | null;
  dimensionScores?: JsonValue | null;
}
export interface VfsCreateEssaySessionParams {
  title: string; essayType?: string | null; gradeLevel?: string | null; customPrompt?: string | null;
}
export interface EssayRepository {
  listEssays(conn: SqlExecutor, search: string | null, limit: number, offset: number): VfsEssay[];
  listEssaysBySession(conn: SqlExecutor, sessionId: string): VfsEssay[];
  getEssay(conn: SqlExecutor, essayId: string): VfsEssay | null;
  getEssayContent(conn: SqlExecutor, essayId: string): string | null;
  searchEssays(conn: SqlExecutor, query: string, limit: number): VfsEssay[];
  createEssay(conn: SqlExecutor, params: VfsCreateEssayParams): VfsEssay;
  createEssayWithConn(conn: SqlExecutor, params: VfsCreateEssayParams): VfsEssay;
  updateGradingResult(conn: SqlExecutor, essayId: string, gradingResult: JsonValue,
    score: number | null): void;
  updateTitle(conn: SqlExecutor, essayId: string, title: string): void;
  deleteEssay(conn: SqlExecutor, essayId: string): void;
  purgeEssay(conn: SqlExecutor, essayId: string): void;
  purgeEssayWithConn(conn: SqlExecutor, essayId: string): void;
  restoreEssay(conn: SqlExecutor, essayId: string): void;
  listDeletedEssays(conn: SqlExecutor, limit: number, offset: number): VfsEssay[];
  createSession(conn: SqlExecutor, params: VfsCreateEssaySessionParams): VfsEssaySession;
  createSessionWithConn(conn: SqlExecutor, params: VfsCreateEssaySessionParams): VfsEssaySession;
  createSessionInFolder(conn: SqlExecutor, params: VfsCreateEssaySessionParams,
    folderId: string | null): VfsEssaySession;
  getSession(conn: SqlExecutor, sessionId: string): VfsEssaySession | null;
  listSessions(conn: SqlExecutor, limit: number, offset: number): VfsEssaySession[];
  countSessions(conn: SqlExecutor): number;
  updateSession(conn: SqlExecutor, sessionId: string, title: string | null,
    isFavorite: boolean | null, essayType: string | null, gradeLevel: string | null,
    customPrompt: string | null): void;
  purgeSession(conn: SqlExecutor, sessionId: string): number;
  purgeSessionWithConn(conn: SqlExecutor, sessionId: string): number;
  deleteSession(conn: SqlExecutor, sessionId: string): void;
  deleteSessionWithFolderItem(conn: SqlExecutor, sessionId: string): void;
  restoreSession(conn: SqlExecutor, sessionId: string): void;
  listDeletedSessions(conn: SqlExecutor, limit: number, offset: number): VfsEssaySession[];
  getRoundsBySession(conn: SqlExecutor, sessionId: string): VfsEssay[];
  countRoundsBySession(conn: SqlExecutor, sessionId: string): number;
  listRoundsBySession(conn: SqlExecutor, sessionId: string, limit: number, offset: number): VfsEssay[];
  getLatestRoundNumber(conn: SqlExecutor, sessionId: string): number;
  getRound(conn: SqlExecutor, sessionId: string, roundNumber: number): VfsEssay | null;
  toggleSessionFavorite(conn: SqlExecutor, sessionId: string): boolean;
  createEssayInFolder(conn: SqlExecutor, params: VfsCreateEssayParams,
    folderId: string | null): VfsEssay;
  deleteEssayWithFolderItem(conn: SqlExecutor, essayId: string): void;
  listEssaysByFolder(conn: SqlExecutor, folderId: string | null, limit: number, offset: number): VfsEssay[];
  getEssayLocation(conn: SqlExecutor, essayId: string): ResourceLocation | null;
  listAllEssays(conn: SqlExecutor, search: string | null, limit: number, offset: number): VfsEssay[];
}
/** ReviewPlan mirrors review_plan_repo.rs serde output (snake_case fields). */
export type ReviewPlanStatus = 'new' | 'learning' | 'reviewing' | 'graduated' | 'suspended';
export interface ReviewPlan {
  id: string; question_id: string; exam_id: string; ease_factor: number;
  interval_days: number; repetitions: number; next_review_date: string;
  last_review_date: string | null; status: ReviewPlanStatus; total_reviews: number;
  total_correct: number; consecutive_failures: number; is_difficult: boolean;
  created_at: string; updated_at: string;
}
export interface ReviewHistory {
  id: string; plan_id: string; question_id: string; quality: number; passed: boolean;
  ease_factor_before: number; ease_factor_after: number; interval_before: number;
  interval_after: number; repetitions_before: number; repetitions_after: number;
  reviewed_at: string; user_answer: string | null; time_spent_seconds: number | null;
}
export interface CreateReviewPlanParams {
  question_id: string; exam_id: string; initial_ease_factor?: number | null;
}
export interface UpdateReviewPlanParams {
  ease_factor: number; interval_days: number; repetitions: number;
  next_review_date: string; last_review_date: string; status: ReviewPlanStatus;
  total_reviews: number; total_correct: number; consecutive_failures: number;
  is_difficult: boolean; expected_updated_at: string;
}
export interface CalendarHeatmapData { date: string; count: number; passed: number; failed: number }
export interface RecordReviewHistoryParams {
  plan_id: string; question_id: string; quality: number; passed: boolean;
  ease_factor_before: number; ease_factor_after: number; interval_before: number;
  interval_after: number; repetitions_before: number; repetitions_after: number;
  user_answer?: string | null; time_spent_seconds?: number | null;
}
export interface DueReviewsFilter {
  exam_id?: string | null; until_date?: string | null; status?: readonly ReviewPlanStatus[] | null;
  difficult_only?: boolean | null; limit?: number | null; offset?: number | null;
}
export interface DueReviewsResult { plans: ReviewPlan[]; total: number; has_more: boolean }
export interface ReviewStats {
  exam_id: string | null; total_plans: number; new_count: number; learning_count: number;
  reviewing_count: number; graduated_count: number; suspended_count: number;
  due_today: number; overdue_count: number; difficult_count: number;
  total_reviews: number; total_correct: number; avg_correct_rate: number;
  avg_ease_factor: number; updated_at: string;
}
export interface ReviewPlanRepository {
  createPlan(conn: SqlExecutor, params: CreateReviewPlanParams): ReviewPlan;
  getPlan(conn: SqlExecutor, planId: string): ReviewPlan | null;
  getPlanByQuestion(conn: SqlExecutor, questionId: string): ReviewPlan | null;
  listDueReviews(conn: SqlExecutor, filter: DueReviewsFilter): DueReviewsResult;
  listPlansByExam(conn: SqlExecutor, examId: string, limit?: number | null, offset?: number | null): DueReviewsResult;
  updatePlan(conn: SqlExecutor, planId: string, params: UpdateReviewPlanParams): ReviewPlan;
  suspendPlan(conn: SqlExecutor, planId: string): ReviewPlan;
  suspendPlanIfUnchanged(conn: SqlExecutor, planId: string, expectedUpdatedAt: string): ReviewPlan;
  resumePlan(conn: SqlExecutor, planId: string): ReviewPlan;
  resumePlanIfUnchanged(conn: SqlExecutor, planId: string, expectedUpdatedAt: string): ReviewPlan;
  deletePlan(conn: SqlExecutor, planId: string): void;
  deletePlanIfUnchanged(conn: SqlExecutor, planId: string, expectedUpdatedAt: string): void;
  deletePlanByQuestion(conn: SqlExecutor, questionId: string): void;
  recordHistory(conn: SqlExecutor, params: RecordReviewHistoryParams): ReviewHistory;
  getHistory(conn: SqlExecutor, planId: string, limit?: number | null): ReviewHistory[];
  getStats(conn: SqlExecutor, examId: string | null): ReviewStats;
  refreshStats(conn: SqlExecutor, examId: string | null): ReviewStats;
  getCalendarData(conn: SqlExecutor, startDate: string | null, endDate: string | null,
    examId: string | null): CalendarHeatmapData[];
}
/** VfsTranslation mirrors types.rs `VfsTranslation` (skip_serializing_if fields omitted). */
export interface VfsTranslation {
  id: string; resourceId: string; title?: string; srcLang: string; tgtLang: string;
  engine?: string; model?: string; isFavorite: boolean; qualityRating?: number;
  createdAt: string; updatedAt?: string; metadata?: JsonValue;
  sourceText?: string; translatedText?: string;
}
export interface VfsCreateTranslationParams {
  title?: string | null; source: string; translated: string;
  srcLang: string; tgtLang: string; engine?: string | null; model?: string | null;
}
export interface TranslationRepository {
  listTranslations(conn: SqlExecutor, search: string | null, limit: number, offset: number): VfsTranslation[];
  listTranslationsLight(conn: SqlExecutor, search: string | null, limit: number, offset: number): VfsTranslation[];
  getTranslation(conn: SqlExecutor, translationId: string): VfsTranslation | null;
  getTranslationIncludingDeleted(conn: SqlExecutor, translationId: string): VfsTranslation | null;
  getTranslationContent(conn: SqlExecutor, translationId: string): string | null;
  searchTranslations(conn: SqlExecutor, query: string, limit: number): VfsTranslation[];
  createTranslation(conn: SqlExecutor, params: VfsCreateTranslationParams): VfsTranslation;
  createTranslationLegacy(conn: SqlExecutor, sourceText: string, translatedText: string,
    srcLang: string, tgtLang: string, engine: string | null, model: string | null): VfsTranslation;
  setFavorite(conn: SqlExecutor, translationId: string, favorite: boolean): void;
  setQualityRating(conn: SqlExecutor, translationId: string, rating: number): void;
  deleteTranslation(conn: SqlExecutor, translationId: string): void;
  purgeTranslation(conn: SqlExecutor, translationId: string): void;
  updateTranslationContent(conn: SqlExecutor, translationId: string, source: string, translated: string): void;
  restoreTranslation(conn: SqlExecutor, translationId: string): void;
  /**
   * translation_executor.rs:1293-1311: `UPDATE translations SET metadata_json = ?1` only (no
   * updated_at/version change). 0 rows throws `translation row {id} not found for metadata update`;
   * SQL errors propagate unwrapped. The caller serializes the JSON (serde `Value::to_string`).
   */
  setMetadataJsonOnlyWithConn(conn: SqlExecutor, translationId: string, metadataJson: string): void;
  listDeletedTranslations(conn: SqlExecutor, limit: number, offset: number): VfsTranslation[];
  updateTitle(conn: SqlExecutor, translationId: string, newTitle: string): VfsTranslation;
  createTranslationInFolder(conn: SqlExecutor, params: VfsCreateTranslationParams,
    folderId: string | null): VfsTranslation;
  deleteTranslationWithFolderItem(conn: SqlExecutor, translationId: string): void;
  listTranslationsByFolder(conn: SqlExecutor, folderId: string | null, limit: number, offset: number): VfsTranslation[];
  getTranslationLocation(conn: SqlExecutor, translationId: string): ResourceLocation | null;
}
/** MediaSegmentRow mirrors media_transcript_repo.rs. */
export interface MediaSegmentRow {
  idx: number; startMs: number; endMs: number; text: string; status: number;
  source: string; planVersion: number;
}
export interface PlannedSpan { startMs: number; endMs: number }
export type PlanOutcomeStatus = 'created' | 'reused' | 'rebuilt';
export interface PlanOutcome { status: PlanOutcomeStatus; planVersion: number }
export interface SegmentCounts { total: number; done: number; failed: number; pending: number }
/**
 * Wire projection of {@link MediaProgressRowExact} (D3): each i64 goes through `Number(bigint)`,
 * the same IEEE-754 rounding as Rust serde_json → frontend `JSON.parse`. Not the stored value
 * above 2^53; read/compute/persist with the exact row.
 */
export interface MediaProgressRow {
  resourceId: string; lastPositionMs: number; durationMs: number | null;
  watchedMs: number; finished: boolean; updatedAt: number;
}
/** media_transcript_repo.rs MediaProgressRow with every i64 column kept exact. */
export interface MediaProgressRowExact {
  resourceId: string; lastPositionMs: bigint; durationMs: bigint | null;
  watchedMs: bigint; finished: boolean; updatedAt: bigint;
}
/** Rust `Option<i64>` fields; `bigint` carries values beyond 2^53 without rounding. */
export interface MediaProgressUpdate {
  positionMs?: number | bigint | null; durationMs?: number | bigint | null;
  watchedDeltaMs?: number | bigint | null; finished?: boolean | null;
}
export interface MediaTranscriptRepository {
  planNeedsRebuild(existingCount: number, newCount: number): boolean;
  listSegments(conn: SqlExecutor, resourceId: string): MediaSegmentRow[];
  listSegmentsInRange(conn: SqlExecutor, resourceId: string, startMs: number, endMs: number): MediaSegmentRow[];
  listUnfinished(conn: SqlExecutor, resourceId: string): MediaSegmentRow[];
  counts(conn: SqlExecutor, resourceId: string): SegmentCounts;
  planInfo(conn: SqlExecutor, resourceId: string): [number, string] | null;
  applyPlan(conn: SqlExecutor, resourceId: string, spans: readonly PlannedSpan[]): PlanOutcome;
  markDone(conn: SqlExecutor, resourceId: string, idx: number, planVersion: number, text: string): boolean;
  markDoneWithBounds(conn: SqlExecutor, resourceId: string, idx: number, planVersion: number,
    text: string, bounds: readonly [number, number] | null): boolean;
  markFailed(conn: SqlExecutor, resourceId: string, idx: number, planVersion: number): boolean;
  resetFailed(conn: SqlExecutor, resourceId: string): number;
  setImportedSegments(conn: SqlExecutor, resourceId: string,
    segments: readonly (readonly [PlannedSpan, string])[]): number;
  deleteSegments(conn: SqlExecutor, resourceId: string): number;
  /** {@link getProgressExact} projected to the wire row. */
  getProgress(conn: SqlExecutor, resourceId: string): MediaProgressRow | null;
  /** {@link setProgressExact} (same exact read/merge/write) projected to the wire row. */
  setProgress(conn: SqlExecutor, resourceId: string, update: MediaProgressUpdate): MediaProgressRow;
  /** media_transcript_repo.rs:454-475 `get_progress_with_conn`, i64 columns read as bigint. */
  getProgressExact(conn: SqlExecutor, resourceId: string): MediaProgressRowExact | null;
  /**
   * media_transcript_repo.rs:482-535 `set_progress_with_conn` in i64: position `max(0)`,
   * duration only when `> 0`, delta clamped to 0..=120000, `saturating_add` at i64::MAX,
   * auto-finish compares `position as f64 >= duration as f64 * 0.95`; binds bigint.
   */
  setProgressExact(conn: SqlExecutor, resourceId: string, update: MediaProgressUpdate): MediaProgressRowExact;
  recordDuration(conn: SqlExecutor, resourceId: string, durationMs: number | bigint): void;
}
