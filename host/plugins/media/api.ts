/** L18 public service contracts. Wire types remain owned by contracts/ipc. */
import type { Context } from '@deepseek-ai/cordis';
import type { Commands } from '../../../contracts/ipc/generated/L18-media-docs.ts';
import type { SqlExecutor } from '../../platform/storage/api.ts';
import type { JsonValue } from '../../platform/errors/api.ts';
import type {
  ExamSheetPreviewResult, ExamSheetSessionDetail, ExamSheetSessionSummary, RenameExamSheetSessionRequest,
  UpdateExamSheetCardsRequest,
} from '../../../contracts/ipc/generated/L14-qbank.ts';
export type * from '../../../contracts/ipc/generated/L18-media-docs.ts';
export type { ExamSheetPreviewResult };
export type { Context };
export { ExamSheetSessionError, MediaError } from './src/errors.ts';
/** Pure `preview_json` codec (same as `ExamSheetSessionService.decodePreview/encodePreview`). */
export { decodePreview, encodePreview } from './src/exam-sheet-model.ts';
export {
  parseSourceImageUri, formatSourceImageUri, formatSourceImageMarkdown,
  computePermilleCropRegionsForQuestions,
} from './src/source-image-ref.ts';
export type { SourceImageRef, PermilleCropRegion, PageTextItem } from './src/source-image-ref.ts';
export { extractBilibiliTargetFromShareText, classifyBilibiliResolveError } from './src/bilibili-links.ts';
export { selectProgressiveCompatibleVideoTrack } from './src/bilibili-policy.ts';
export * from './src/bilibili-dmview-subtitle.ts';
export * from './src/audio-resilience-and-vad.ts';

export const mediaService = { name: 'media', version: '1.0.0' } as const;
export const docsService = { name: 'docs', version: '1.0.0' } as const;
export const ocrService = { name: 'ocr', version: '1.0.0' } as const;

export interface MediaCourseSummary {
  resourceId: string;
  name: string;
  /** `mm:ss` / `h:mm:ss` */
  position: string;
  positionRef: string;
  duration: string | null;
  watchedMinutes: number;
  finished: boolean;
  lastWatchedAt: number;
  wrongCheckpoints: Array<{ ref: string; question: string; attempts: number }>;
}

export const PDF_PAGE_SEPARATOR = '\f';
export const PDF_ANNOTATIONS_CHANGED_EVENT = 'pdf-annotations:changed';

export interface PlannedSpan {
  start_ms: number;
  end_ms: number;
}

export interface MediaSegmentRow extends PlannedSpan {
  idx: number;
  text: string;
  status: number;
  source: string;
  plan_version: number;
}

export interface PageSlice {
  page_index: number;
  blob_hash: string;
  text_hint: string | null;
  width: number;
  height: number;
}

export interface RasterizerResult {
  pages: PageSlice[];
  source_format: string;
}

/** `document_processing_executor.rs::resolve_file` result. */
export interface ResolvedDocumentFile {
  id: string;
  resourceId: string | null;
  blobHash: string | null;
  sha256: string;
  fileName: string;
  size: number;
  fileType: string;
  mimeType: string | null;
}

/** `office_fidelity_executor.rs::EditPreflight`（serde snake_case）。 */
export interface OfficeEditPreflight {
  format: string;
  risk: string;
  sourceSha256: string;
  featureSetHash: string;
  criticalFeatures: string[];
  highFeatures: string[];
}

/** `office_fidelity_executor.rs::EditGateWording`（serde snake_case）。 */
export interface OfficeEditGateWording {
  writePath: string;
  officeApps: string;
  highFeaturesDropped: boolean;
}

/** `office_output.rs::parse_output_options` result. */
export interface OfficeOutputOptions {
  target: 'vfs' | 'workspace';
  rootId: string | null;
  relativePath: string | null;
  overwritePolicy: 'fail' | 'replace_if_match';
  expectedSha256: string | null;
}

export interface PreparedDocumentImage {
  dataUrl: string;
  sourceIndex: number;
  byteLen: number;
}

export interface PreparedDocumentImages {
  images: PreparedDocumentImage[];
  rejected: Array<[number, string]>;
  omittedByCount: number;
  totalBytes: number;
}

/** `DocumentParser::extract_docx_with_images` result tuple `(text, images)`. */
export interface DocxTextWithImages {
  /** Extracted text with `<<IMG:N>>` markers at image positions. */
  text: string;
  /** `images[N]` holds the raw bytes referenced by `<<IMG:N>>`. */
  images: Uint8Array[];
}

export interface DocsService {
  readonly version: 1;
  /**
   * `DocumentParser::extract_docx_with_images`. Rejects with an `Error` whose
   * message is the Rust `ParsingError` Display (e.g. `DOCX解析错误: ...`).
   */
  extractDocxWithImages(bytes: Uint8Array): Promise<DocxTextWithImages>;
  /** `DocumentParser::extract_text_from_path`. */
  extractTextFromPath(filePath: string): Promise<string>;
  /** `DocumentParser::extract_text_from_bytes`. */
  extractTextFromBytes(fileName: string, bytes: Uint8Array): Promise<string>;
  /** `DocumentParser::extract_text_from_base64`. */
  extractTextFromBase64(fileName: string, base64Content: string): Promise<string>;
  /** `DocumentParser::extract_paged_text_from_bytes`: pptx per slide, epub per chapter, otherwise `null`. */
  extractPagedTextFromBytes(fileName: string, bytes: Uint8Array): Promise<string[] | null>;
  /** `DocumentParser::extract_epub_pages_from_bytes`. */
  extractEpubPagesFromBytes(bytes: Uint8Array): Promise<string[]>;
  isPlainTextCodeExtension(extension: string): boolean;
  checkZipBombBytes(bytes: Uint8Array, fileName: string): void;
  checkOfficeEncryptionBytes(bytes: Uint8Array, fileName: string): void;
  checkPdfEncryptionBytes(bytes: Uint8Array, fileName: string): void;
  /**
   * `DocumentParser::generate_docx_from_spec`: a DocxSpec
   * (`{ title?, blocks: [{ type: 'heading' | 'paragraph' | 'table' | ..., text?, level?, bold?, italic? }] }`)
   * rendered to `.docx` bytes by the F7 office writer. Rejects with the writer's
   * error text when the spec is invalid or `nativeOfficeWriter` is not provided.
   * Used by `qbank_export` format=docx (`render_question_export_docx`, which
   * reports failures as `DOCX 生成失败: …`).
   */
  generateDocxFromSpec(spec: unknown): Promise<Uint8Array>;
  /**
   * `DocumentProcessingExecutor::sanitize_id`: trims whitespace and surrounding
   * quotes/backticks; throws `资源 ID 格式无效: <raw>` unless the rest is
   * `[A-Za-z0-9_-]+`. `qbank_import_document` (`resolve_resource`) applies it
   * before looking the id up as a note, a VFS file or via `resolveFile`.
   */
  sanitizeDocumentId(rawId: string): string;
  /** `DocumentProcessingExecutor::resolve_file`（VFS 数据库来自 `vfsDatabase` 服务）。 */
  resolveFile(rawId: string): ResolvedDocumentFile;
  /** `office_fidelity_executor.rs::inspect_bytes`. */
  inspectOfficeBytes(bytes: Uint8Array): Record<string, unknown>;
  /** `office_fidelity_executor.rs::preflight_for_edit`. */
  preflightOfficeEdit(bytes: Uint8Array): OfficeEditPreflight;
  /** `office_fidelity_executor.rs::enforce_edit_preflight`，critical 特征时抛出结构化错误。 */
  enforceOfficeEditPreflight(preflight: OfficeEditPreflight, wording: OfficeEditGateWording): void;
  /** `office_fidelity_executor.rs::build_edit_fidelity_warning`. */
  buildOfficeEditWarning(
    preflight: OfficeEditPreflight,
    wording: OfficeEditGateWording,
    extraFields: ReadonlyArray<readonly [string, string[]]>,
  ): Record<string, unknown> | null;
  /** `office_output.rs::parse_output_options`. */
  parseOfficeOutputOptions(args: Record<string, unknown>, fileName: string): OfficeOutputOptions;
  /** `office_output.rs::fidelity_manifest`. */
  officeFidelityManifest(format: string, operation: 'create' | 'replace_text' | 'edit_cells'): Record<string, unknown>;
  /** `docx_executor.rs` 等工具的 name gate / sensitivity. */
  officeToolSupported(format: 'docx' | 'xlsx' | 'pptx', toolName: string): boolean;
  officeToolSensitivity(format: 'docx' | 'xlsx' | 'pptx', toolName: string): 'medium' | 'low';
  /** `vlm_grounding_service.rs::prepare_docx_images`。 */
  prepareDocxImages(dataUrls: readonly string[], totalInputCount: number): PreparedDocumentImages;
  /** `vlm_grounding_service.rs::truncate_utf8`. */
  truncateUtf8(value: string, maxBytes: number): string;
  /** `textbook_pdf_executor.rs` 工具敏感度（读取低、写入中）。 */
  textbookPdfSensitivity(toolName: string, args: Record<string, unknown>): 'low' | 'medium';
  /** `textbook_pdf_executor.rs::arguments_object`. */
  textbookPdfArguments(value: unknown, allowed: readonly string[]): Record<string, unknown>;
  /** `pdfium_utils.rs::push_existing_pdfium_in_child_dirs`（Linux 候选目录扫描）。 */
  pdfiumLinuxCandidates(paths: string[], root: string): void;
  /** `docx_handout.rs::decode_image_data`：data URL / 裸 Base64 → 图片字节。 */
  decodeHandoutImage(data: string): Uint8Array | null;
  /** `docx_handout.rs::fit_emu`：按版心宽等比缩放后的 EMU 尺寸。 */
  fitHandoutImage(widthPx: number, heightPx: number, contentWTWips: number): [number, number];
  /** `exam_sheet_service.rs::apply_exam_name_update`（`None` 不重命名，空串清空）。 */
  applyExamSheetNameUpdate(state: ExamSheetNameState, requested: string | null): boolean;
  /** `llm_structurer.rs`：持久化批次结果是否可复用。 */
  parseReusableLlmBatchResult(value: string): unknown[] | null;
  /** `xlsx_executor.rs`：编辑前收集会被覆盖的公式单元格（`Sheet!Cell`）。 */
  overwrittenFormulaCells(
    bytes: Uint8Array,
    edits: ReadonlyArray<readonly [string, string, string]>,
  ): string[];
}

export interface ExamSheetNameState {
  summary: string | null;
  preview: string | null;
}

/** `ExamSheetService::update_exam_sheet_cards` outcome (`updated_mistake_ids` is always empty). */
export interface ExamSheetUpdateOutcome {
  detail: ExamSheetSessionDetail;
  updated_mistake_ids: string[];
}

/**
 * `dstu-vision/src/exam_sheet_service.rs` read/update/rename surface.
 *
 * L14-qbank owns the three commands and calls this service.  Failures carry
 * the `AppError` wire value on `ExamSheetSessionError.appError`.
 */
export interface ExamSheetSessionService {
  readonly version: 1;
  /** `get_exam_sheet_session_detail` + `enrich_session_detail`. */
  getExamSheetSessionDetail(sessionId: string): Promise<ExamSheetSessionDetail>;
  /** `update_exam_sheet_cards`; per-session serialized read-modify-write. */
  updateExamSheetCards(request: UpdateExamSheetCardsRequest): Promise<ExamSheetUpdateOutcome>;
  /** `rename_exam_sheet_session`: missing `exam_name` clears the name. */
  renameExamSheetSession(request: RenameExamSheetSessionRequest): Promise<ExamSheetSessionSummary>;
  /**
   * `serde_json::from_value::<ExamSheetPreviewResult>(exam.preview_json)`: absent
   * fields take their serde defaults; any type mismatch throws an `Error`
   * (`invalid type at <path>: expected <type>`). `qbank_export` and
   * `qbank_generate_variant` read a session's cards through this.
   */
  decodePreview(value: unknown): ExamSheetPreviewResult;
  /** `serde_json::to_value(&ExamSheetPreviewResult)`: the `preview_json` value to persist. */
  encodePreview(preview: ExamSheetPreviewResult): Record<string, JsonValue>;
}

export const examSheetSessionService = { name: 'examSheetSession', version: '1.0.0' } as const;

/**
 * L18 media transcription capability consumed by L12's PDF/media task
 * scheduler. Mirrors `vfs/hooks.rs::MediaTranscriber` +
 * `MediaTranscriptionRequest/Summary`; provider naming is `mediaTranscriber`.
 */
export interface MediaTranscriptionProgressUpdate {
  stage: string;
  percent: number;
  completedSegments?: number | null;
  totalSegments?: number | null;
}

export interface MediaTranscriptionRequest {
  fileId: string;
  tempDir: string;
  /** `false` only for imported subtitles, which skip ASR configuration. */
  imported: boolean;
  signal: AbortSignal;
  onProgress(update: MediaTranscriptionProgressUpdate): void;
}

export interface MediaTranscriptionResult {
  transcriptChars: number;
  doneSegments: number;
  totalSegments: number;
  failedSegments: number;
}

export interface MediaTranscriberService {
  transcribe(request: MediaTranscriptionRequest): Promise<MediaTranscriptionResult>;
}

export const mediaTranscriberService = {
  name: 'mediaTranscriber',
  version: '1.0.0',
} as const;

export interface SpeechFrame {
  energy_db: number;
  zcr: number;
}

export interface SpeechFrames {
  frames: SpeechFrame[];
  total_ms: number;
}

export interface SpeechSegmentParams {
  merge_gap_ms: number;
  max_segment_ms: number;
  min_segment_ms: number;
  min_blip_ms: number;
  pad_before_ms: number;
  pad_after_ms: number;
}

/** `image_generation_executor.rs::ImageApiConfig` 的最小结构。 */
export interface ImageGenerationConfig {
  name: string;
  model: string;
  vendorName?: string | null;
  providerType?: string | null;
  baseUrl?: string;
  isImageGeneration?: boolean;
}

export interface ParsedImageGenerationResponse {
  b64_json: string | null;
  url: string | null;
  revised_prompt: string | null;
}

export interface MediaService {
  readonly version: 1;
  formatTimestamp(ms: number): string;
  parseTimestamp(input: string): number | null;
  buildTranscriptText(segments: readonly MediaSegmentRow[]): string;
  encodeWavMono16k(samples: Int16Array): Uint8Array;
  isAsrModel(model: string, displayName: string): boolean;
  asrProviderSupported(providerId: string | null, apiProtocol: string | null): boolean;
  /** `media_executor.rs::can_handle`。 */
  canHandleMediaTool(toolName: string): boolean;
  /** `media_executor.rs::sensitivity_level`。 */
  mediaToolSensitivity(toolName: string): 'medium' | 'low';
  /** `media_executor.rs::capability`；`asr=null` 表示运行时缺少 ASR 配置。 */
  transcriptionCapability(asr: {
    providerId: string;
    providerName: string;
    model: string;
    configured: boolean;
  } | null): Record<string, unknown>;
  /** `media_executor.rs::media_signature`. */
  mediaSignature(bytes: Uint8Array): string;
  /**
   * `ledger.rs::media_learning_summary`：在 VFS 连接上汇总最近在看的课，
   * 学习概览工具（`learning_overview_executor.rs:250`）以 limit=5 调用。
   */
  mediaLearningSummary(conn: SqlExecutor, limit: number): { recentCourses: MediaCourseSummary[] };
  /** `ledger.rs::parse_handout_chapters`。 */
  chaptersFromHandout(markdown: string, resourceId: string): Array<{
    title: string;
    seconds: number;
  }>;
  /** `vad.rs::plan_segments`：把已提取的帧特征切成语音段。 */
  planSpeechSegments(frames: SpeechFrames, params?: SpeechSegmentParams): Array<[number, number]>;
  /** `resample.rs`：把任意采样率的 mono PCM 重采样为 16 kHz。 */
  resamplePcm16k(inputRate: number, samples: ArrayLike<number>): Int16Array;
  /** `image_generation_executor.rs::image_size_for_config`. */
  imageSizeForConfig(config: ImageGenerationConfig | null, aspectRatio: string): [number, number, string];
  /** `image_generation_executor.rs::build_image_generation_url`. */
  buildImageGenerationUrl(baseUrl: string): string;
  /** `image_generation_executor.rs::parse_image_generation_response`. */
  parseImageGenerationResponse(value: unknown): ParsedImageGenerationResponse;
  /** `image_generation_executor.rs::decode_base64_image_payload`. */
  decodeImagePayload(payload: string): Uint8Array;
  /** `image_generation_executor.rs::is_image_generation_config`. */
  isImageGenerationConfig(config: ImageGenerationConfig): boolean;
  /** `subtitle.rs::parse_subtitle`：srt / vtt / BCC 导入。 */
  parseSubtitleBytes(fileName: string, bytes: Uint8Array): Array<{
    startMs: number;
    endMs: number;
    text: string;
  }>;
  /** `subtitle.rs::export_segments`：srt / vtt / txt 导出。 */
  exportTranscriptText(segments: readonly MediaSegmentRow[], format: 'srt' | 'vtt' | 'txt'): string;
  /** `bilibili_transport/session.rs::select_route`：按出口设置与桥状态选择播放出口。 */
  bilibiliSelectRoute(
    mode: 'auto' | 'native' | 'browser_bridge' | 'proxy',
    bridgeReady: boolean,
    parsingOnly: boolean,
    nativeFirst: boolean,
  ): 'native' | 'browser_bridge' | 'proxy';
}

/**
 * `AppState` PDF OCR session control maps (src/commands.rs:786-871), shared with
 * the `*_pdf_ocr_*` control commands. Session creation is not exposed until the
 * page OCR call exists (BLOCKERS L18-B02).
 */
export interface OcrService {
  readonly version: 1;
  cancelSession(sessionId: string): boolean;
  pauseSession(sessionId: string): boolean;
  resumeSession(sessionId: string): boolean;
  skipPage(sessionId: string, pageIndex: number): boolean;
}

/**
 * `dstu-vision/src/page_rasterizer.rs::PageRasterizer` — question-import Stage 1.
 * Pages/images are written to VFS blobs (L11 `vfsRepo.blobs` on `vfsDatabase`).
 * Failures are `CommandError` carrying the Rust `AppError` (validation/internal/database).
 */
export interface PageRasterizerService {
  readonly version: 1;
  /** `rasterize_pdf_cancellable`: 300 DPI JPEG per page; `signal` is checked before each page. */
  rasterizePdfCancellable(base64Content: string, signal?: AbortSignal | null): Promise<RasterizerResult>;
  /** `rasterize_images`: one Base64/Data URL, or a JSON array of them. */
  rasterizeImages(content: string): Promise<RasterizerResult>;
}

export const pageRasterizerService = { name: 'pageRasterizer', version: '1.0.0' } as const;

/** `[x1, y1, x2, y2]`，归一化 0..1（Rust `[f64; 4]`）。 */
export type Bbox = [number, number, number, number];
/** `vlm_grounding_service.rs::VlmFigure`（serde 字段序）。 */
export interface VlmFigure { bbox: Bbox; fig_label: string }
/** `vlm_grounding_service.rs::VlmQuestion`（serde 字段序；全部 `#[serde(default)]`）。 */
export interface VlmQuestion {
  label: string;
  bbox: Bbox;
  raw_text: string;
  is_group: boolean;
  sub_questions: string[];
  figures: VlmFigure[];
  continues_from_previous: boolean;
  continues_to_next: boolean;
}
/** `vlm_grounding_service.rs::VlmPageAnalysis`（`questions` 必填）。 */
export interface VlmPageAnalysis { questions: VlmQuestion[] }
export interface VlmExtractedOption { key: string; content: string }
/** `vlm_grounding_service.rs::VlmExtractedQuestion`（`image_indices` 已映射回原始图片下标）。 */
export interface VlmExtractedQuestion {
  content: string;
  question_type: string;
  options: VlmExtractedOption[];
  answer: string;
  explanation: string;
  image_indices: number[];
  difficulty: string;
  tags: string[];
}
/** `cross_page_merger.rs::MergedQuestion`（Rust 无 serde，字段名沿用 Rust）。 */
export interface MergedQuestion {
  question: VlmQuestion;
  page_indices: number[];
  figures_with_page: Array<[number, VlmFigure]>;
}
/** `figure_extractor.rs::QuestionWithFigures`. */
export interface QuestionWithFigures {
  merged: MergedQuestion;
  images: import('../vfs-repos/api.ts').QuestionImage[];
}
/** `llm_structurer.rs::StructuredQuestion`（`json` = `serde_json::Value`）。 */
export interface StructuredQuestion {
  json: import('../../platform/errors/api.ts').JsonValue;
  source: QuestionWithFigures;
}

/**
 * `dstu-vision` question-import Stage 2–5 (legacy checkpoint resume in L14 `resume_question_import`):
 * `VlmGroundingService` / `cross_page_merger` / `figure_extractor` / `LlmStructurer`.
 * LLM/VLM calls go through L02 (`llm`, `llmOcrModels`, `llmStreaming`, `llmQuestionParsing`) and L01
 * (`llmAdapters`, `llmCodexAuth`); images through F7 `nativeImage`; blobs/files through L11 `vfsRepo`.
 * Failures are `CommandError` carrying the Rust `AppError` (Display = `message`).
 */
export interface QuestionImportVisionService {
  readonly version: 1;
  /** `VlmGroundingService::analyze_page_by_blob` (vlm_grounding_service.rs:349). */
  analyzePageByBlob(page: PageSlice): Promise<VlmPageAnalysis>;
  /** `VlmGroundingService::analyze_single_page` (:367). */
  analyzeSinglePage(imageDataUrl: string, textHint: string | null): Promise<VlmPageAnalysis>;
  /** `VlmGroundingService::describe_image` (:487). */
  describeImage(imageBytes: Uint8Array): Promise<string>;
  /** `VlmGroundingService::extract_docx_questions_stream` (:596); `onQuestion` returning false stops. */
  extractDocxQuestionsStream(imageDataUrls: readonly string[], extractedText: string,
    onQuestion: (question: VlmExtractedQuestion) => boolean): Promise<number>;
  /** `cross_page_merger::merge_pages` (cross_page_merger.rs:26); `null` = Rust `None` page. */
  mergePages(pageAnalyses: ReadonlyArray<VlmPageAnalysis | null>): MergedQuestion[];
  /** `figure_extractor::extract_figures` (figure_extractor.rs:29); never fails (per-figure skips are logged). */
  extractFigures(mergedQuestions: MergedQuestion[], pages: readonly PageSlice[]): Promise<QuestionWithFigures[]>;
  /** `LlmStructurer::structure_questions` (llm_structurer.rs:63) → `[completed, batchResultJsons, questions]`. */
  structureQuestions(questions: readonly QuestionWithFigures[], modelConfigId: string | null,
    batchesCompleted: number, priorBatchResults: readonly string[]): Promise<[number, string[], StructuredQuestion[]]>;
  /** `page_rasterizer::load_page_image_bytes` (page_rasterizer.rs:443). */
  loadPageImageBytes(blobHash: string): Uint8Array;
  /** `serde_json::from_str::<VlmPageAnalysis>(s).ok()` (checkpoint `vlm_page_results` restore). */
  decodeVlmPageAnalysis(json: string): VlmPageAnalysis | null;
  /** `serde_json::to_string(&VlmPageAnalysis)` (checkpoint persist). */
  encodeVlmPageAnalysis(analysis: VlmPageAnalysis): string;
}

export const questionImportVisionService = { name: 'questionImportVision', version: '1.0.0' } as const;

/** Convenience for consumers of a command-shaped service method. */
export type MediaCommandMethod<K extends keyof Commands> = (args: Commands[K]['args']) => Promise<Commands[K]['result']>;

declare module '@deepseek-ai/cordis' {
  interface Context {
    media: MediaService;
    docs: DocsService;
    ocr: OcrService;
    examSheetSession: ExamSheetSessionService;
    mediaTranscriber: MediaTranscriberService;
    pageRasterizer: PageRasterizerService;
    questionImportVision: QuestionImportVisionService;
  }
}
