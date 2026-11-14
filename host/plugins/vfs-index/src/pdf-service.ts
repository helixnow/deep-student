/**
 * PDF/image processing service state machine from
 * `crates/dstu-vfs/src/vfs/pdf_processing_service.rs`.
 *
 * Stage execution itself needs F7 Pdfium and the image codec; those are injected
 * as `PdfStageRuntime` (native blocker). This module owns the parts that do not
 * need native code: media-type detection, task generation/racing, status
 * persistence, cancel/retry/recovery and the seven frontend events.
 */
import { rustTrim } from '../../../platform/util/portable.ts';
import * as path from '../../../platform/util/path.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { ProcessingProgress, ProcessingStage } from '../api.ts';
import type { MediaError } from '../../media/api.ts';
import {
  cancelMediaRow, getMediaMetadata, getProcessingRow, listFilesWithStatuses,
  recoveredPendingWriter, setProcessingErrorRow, updateProcessingStatusRow,
} from '../repository/pdf.ts';
import { hasRetriableFailure, parseProcessingProgress, processingProgressSnapshot, processingStageFromString, serializeProcessingProgress } from './pdf-processing.ts';
import type { LaneLogger } from './logger.ts';

export type MediaType = 'pdf' | 'image' | 'audio' | 'video';

export interface PdfEventSink {
  emit(channel: string, payload: unknown): void;
}

export interface MediaSegmentProgress {
  completedSegments?: number | null;
  totalSegments?: number | null;
}

export interface PdfProgressCallbacks {
  /** `emit_progress`: persists status + progress and emits the progress events. */
  progress(stage: ProcessingStage, progress: ProcessingProgress, segments?: MediaSegmentProgress): void;
  /** `update_processing_status`: persists only, no event. */
  status(stage: ProcessingStage, progress?: ProcessingProgress | null): void;
}

/** A handled transcriber failure ends the pipeline without a completion event. */
export interface MediaPipelineFailure {
  error: MediaError;
  stage: string;
}

export interface PdfStageRuntime {
  /** Runs the actual native stages; the service owns status/events around it. */
  run(fileId: string, startStage: ProcessingStage, signal: AbortSignal, callbacks: PdfProgressCallbacks): Promise<{
    readyModes: string[];
    /** Rust `completed_with_issues`: the pipeline finished but recorded stage issues. */
    completedWithIssues?: boolean;
    failedStages?: import('../api.ts').ProcessingIssue[];
    /** AV transcription counts for `MediaTranscriptionCompletedEvent`. */
    completedSegments?: number;
    totalSegments?: number;
    transcriptionFailure?: MediaPipelineFailure;
    /** Page fields of the completion `ProcessingProgress` (PDF: `total_pages`; image: 1/1). */
    currentPage?: number | bigint;
    totalPages?: number | bigint;
  }>;
  mediaTempDir(): string;
  backfillMissingPreviews(limit: number, scope?: BackfillScope): number;
}

/** Lets the service's `dispose()` stop and await the background preview render. */
export interface BackfillScope {
  readonly signal: AbortSignal;
  track(task: Promise<void>): void;
}

export interface PdfServiceDeps {
  readonly db: SqlExecutor;
  readonly events: PdfEventSink;
  readonly appDataDir: string;
  readonly runtime?: PdfStageRuntime;
  /** Cordis logger (`ctx.logger('vfs-index')`); diagnostics only. */
  readonly logger?: LaneLogger;
}

export class PdfServiceError extends Error {
  readonly code: string;
  constructor(message: string, code = 'VFS_INTERNAL') {
    super(message);
    this.name = 'PdfServiceError';
    this.code = code;
  }
}

const STUCK_STAGES = [
  'text_extraction', 'page_rendering', 'page_compression', 'image_compression',
  'ocr_processing', 'vector_indexing', 'queued', 'decode', 'vad', 'asr', 'indexing',
];

/** Rust ProcessingStage's derived Debug names, distinct from serde snake_case. */
const STAGE_DEBUG: Record<ProcessingStage, string> = {
  pending: 'Pending', text_extraction: 'TextExtraction', page_rendering: 'PageRendering',
  page_compression: 'PageCompression', image_compression: 'ImageCompression',
  ocr_processing: 'OcrProcessing', vector_indexing: 'VectorIndexing',
  completed: 'Completed', completed_with_issues: 'CompletedWithIssues', error: 'Error',
  queued: 'Queued', decode: 'Decode', vad: 'Vad', asr: 'Asr', indexing: 'Indexing',
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'm4b', 'flac', 'aac', 'opus', 'wma', 'aiff', 'aif',
  'caf', 'weba',
]);
const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', '3gp', 'ts', 'mts', 'm2ts',
]);
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'];

/** `std::path::Path::extension`, lowercased (`media_types.rs::extension_of`). */
function extensionOf(fileName: string): string | null {
  const trimmed = rustTrim(fileName);
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return null;
  return trimmed.slice(dot + 1).toLowerCase();
}

/**
 * `PdfProcessingService::detect_media_type` (pdf_processing_service.rs:1123):
 * exact MIME prefix first, then `media_kind`, then PDF/image extensions.
 */
export function parseMediaType(mime: string, fileName: string | null): MediaType | null {
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';

  const lowerMime = rustTrim(mime).toLowerCase();
  const extension = extensionOf(fileName ?? '');
  if (lowerMime === 'video/x-bilibili' || extension === 'bilibili') return 'video';
  if (lowerMime.startsWith('audio/') || (extension !== null && AUDIO_EXTENSIONS.has(extension))) {
    return 'audio';
  }
  if (lowerMime.startsWith('video/') || (extension !== null && VIDEO_EXTENSIONS.has(extension))) {
    return 'video';
  }

  const name = (fileName ?? '').toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  if (IMAGE_EXTENSIONS.some((suffix) => name.endsWith(suffix))) return 'image';
  return null;
}

export class PdfProcessingService {
  private readonly db: SqlExecutor;
  private readonly events: PdfEventSink;
  private readonly appDataDir: string;
  private runtime: PdfStageRuntime | undefined;
  private readonly logger: LaneLogger | undefined;
  private readonly running = new Map<string, { controller: AbortController; generation: bigint }>();
  // A cancelled generation can still be releasing a native/OCR resource.
  private readonly tasks = new Set<Promise<void>>();
  private readonly lifetime = new AbortController();
  private generationCounter = 0n;

  constructor(deps: PdfServiceDeps) {
    this.db = deps.db;
    this.events = deps.events;
    this.appDataDir = deps.appDataDir;
    this.runtime = deps.runtime;
    this.logger = deps.logger;
  }

  /** Rebind when a stage runtime provider loads, unloads or is replaced. */
  setRuntime(runtime: PdfStageRuntime | undefined): void {
    this.runtime = runtime;
  }

  mediaTempDir(): string {
    return this.runtime?.mediaTempDir() ?? path.join(this.appDataDir, 'tmp', 'media');
  }

  isRunning(fileId: string): boolean {
    return this.running.has(fileId);
  }

  runningCount(): number {
    return this.running.size;
  }

  getStatus(fileId: string): import('../api.ts').ProcessingStatus | null {
    const row = getProcessingRow(this.db, fileId);
    if (row === null) return null;
    // Rust deserializes through serde: malformed or missing required fields
    // become `ProcessingProgress::default()`; aliases keep old persisted rows.
    const progress = parseProcessingProgress(row.progressJson);
    const status: import('../api.ts').ProcessingStatus = {
      fileId,
      stage: row.status ?? 'pending',
      progress: processingProgressSnapshot(progress),
    };
    // `skip_serializing_if = "Option::is_none"` omits absent optional fields.
    if (row.error !== null) status.error = row.error;
    if (row.startedAt !== null) status.startedAt = row.startedAt;
    if (row.completedAt !== null) status.completedAt = row.completedAt;
    return status;
  }

  detectMediaType(fileId: string): MediaType {
    let metadata: ReturnType<typeof getMediaMetadata>;
    try {
      metadata = getMediaMetadata(this.db, fileId);
    } catch (error) {
      throw new PdfServiceError(
        `Database error: Failed to get media metadata: ${messageOf(error)}`,
        'VFS_STORAGE',
      );
    }
    if (metadata === null) {
      // rusqlite `QueryReturnedNoRows` Display text, wrapped by detect_media_type.
      throw new PdfServiceError(
        'Database error: Failed to get media metadata: Query returned no rows',
        'VFS_STORAGE',
      );
    }
    const mediaType = parseMediaType(metadata.mimeType, metadata.fileName);
    if (mediaType === null) {
      throw new PdfServiceError(
        `Invalid argument 'mime_type': Unsupported media type: ${metadata.mimeType} for file: ${fileId}`,
        'VFS_INVALID_ARGUMENT',
      );
    }
    return mediaType;
  }

  async startPipeline(fileId: string, startFromStage: ProcessingStage | null = null): Promise<void> {
    const mediaType = this.detectMediaType(fileId);
    const startStage = mediaType === 'audio' || mediaType === 'video'
      ? 'queued'
      : startFromStage ?? (mediaType === 'pdf' ? 'ocr_processing' : 'image_compression');
    const controller = new AbortController();
    const generation = this.generationCounter;
    this.generationCounter = BigInt.asUintN(64, generation + 1n);
    if (this.running.has(fileId)) {
      this.logger?.warn(`[MediaProcessingService] Pipeline already running for file: ${fileId}`);
      return;
    }
    this.running.set(fileId, { controller, generation });
    this.updateStatus(fileId, startStage, null, null);

    // Rust :724-735 writes the start stage, then `tokio::spawn`s the task: the
    // caller returns and builds its view from that row before any stage runs.
    const task = new Promise<void>((resolve) => { setTimeout(resolve, 0); })
      .then(() => this.runTask(fileId, mediaType, startStage, controller, generation))
      .catch((error: unknown) => {
        // A detached Tokio task isolates panics; observe unexpected host errors too.
        this.logger?.error(`[MediaProcessingService] Pipeline task failed for file ${fileId}: ${messageOf(error)}`);
      }).finally(() => { this.tasks.delete(task); });
    this.tasks.add(task);
  }

  private async runTask(
    fileId: string,
    mediaType: MediaType,
    startStage: ProcessingStage,
    controller: AbortController,
    generation: bigint,
  ): Promise<void> {
    try {
      if (this.runtime === undefined) {
        throw new PdfServiceError('PDF stage runtime (F7 pdfium/image codec) is not available');
      }
      const result = await this.runtime.run(fileId, startStage, controller.signal, {
        progress: (stage, progress, segments) => {
          if (!this.isCurrent(fileId, generation)) return;
          this.updateStatus(fileId, stage, progress, null);
          this.emitProgress(fileId, mediaType, progress, segments);
        },
        status: (stage, progress) => {
          if (!this.isCurrent(fileId, generation)) return;
          this.updateStatus(fileId, stage, progress ?? null, null);
        },
      });
      if (result.transcriptionFailure !== undefined) {
        const { error, stage } = result.transcriptionFailure;
        // Rust :999-1030: transcriber failures are handled inside the media
        // pipeline and return Ok, unlike unexpected errors in the outer catch.
        if (error.code === 'cancelled') {
          this.logger?.info(`[MediaProcessingService] Media transcription cancelled: ${fileId}`);
        } else {
          const payload = error.toPayloadString();
          this.logger?.warn(`[MediaProcessingService] Media transcription failed for ${fileId} at ${stage}: ${error.message}`);
          if (this.isCurrent(fileId, generation)) {
            try {
              this.setError(fileId, payload, processingStageFromString(stage));
            } catch (dbError) {
              this.logger?.error(`[MediaProcessingService] Failed to set media error status: ${messageOf(dbError)}`);
            }
          }
          if (this.isCurrent(fileId, generation)) {
            this.events.emit('media-processing-error', { fileId, error: payload, stage, mediaType });
          }
        }
        this.logger?.info(`[MediaProcessingService] Pipeline completed for file: ${fileId} (type: ${mediaType === 'audio' ? 'Audio' : 'Video'})`);
        return;
      }
      if (!this.isCurrent(fileId, generation)) return;
      const completed: ProcessingProgress = {
        stage: 'completed',
        ...(result.currentPage === undefined ? {} : { currentPage: result.currentPage }),
        ...(result.totalPages === undefined ? {} : { totalPages: result.totalPages }),
        percent: 100,
        readyModes: [...result.readyModes],
        mediaType,
        ...(result.failedStages !== undefined && result.failedStages.length > 0
          ? { failedStages: [...result.failedStages] }
          : {}),
      };
      // Rust uses `completed_with_issues` whenever the pipeline recorded an
      // issue; a runtime that only returns retriable failures is still an
      // issue-bearing completion (the same predicate handlers use for resume).
      const completedWithIssues = result.completedWithIssues === true
        || (result.failedStages !== undefined && result.failedStages.length > 0)
        || hasRetriableFailure(completed);
      const finalStage: ProcessingStage = completedWithIssues ? 'completed_with_issues' : 'completed';
      completed.stage = finalStage;
      this.updateStatus(fileId, finalStage, completed, Date.now());
      const payload = {
        fileId,
        readyModes: [...result.readyModes],
        stage: finalStage,
        mediaType,
        ...(result.completedSegments === undefined
          ? {}
          : { completedSegments: result.completedSegments }),
        ...(result.totalSegments === undefined
          ? {}
          : { totalSegments: result.totalSegments }),
      };
      this.events.emit('media-processing-completed', payload);
      if (mediaType === 'pdf') this.events.emit('pdf-processing-completed', payload);
    } catch (error) {
      if (!this.isCurrent(fileId, generation)) return;
      const text = messageOf(error);
      this.logger?.error(`[MediaProcessingService] Pipeline failed for file ${fileId} (type: ${mediaType === 'pdf' ? 'Pdf' : mediaType === 'image' ? 'Image' : mediaType === 'audio' ? 'Audio' : 'Video'}): ${text}`);
      try {
        this.setError(fileId, text, startStage);
      } catch (dbError) {
        // Rust :812-822 logs the failed status write and still emits the original error.
        this.logger?.error(`[MediaProcessingService] Failed to set error status: ${messageOf(dbError)}`);
      }
      const payload = { fileId, error: text, stage: startStage, mediaType };
      this.events.emit('media-processing-error', payload);
      if (mediaType === 'pdf') this.events.emit('pdf-processing-error', payload);
    } finally {
      const current = this.running.get(fileId);
      if (current?.generation === generation) this.running.delete(fileId);
    }
  }

  private isCurrent(fileId: string, generation: bigint): boolean {
    const current = this.running.get(fileId);
    return current !== undefined && current.generation === generation && !current.controller.signal.aborted;
  }

  private emitProgress(
    fileId: string,
    mediaType: MediaType,
    progress: ProcessingProgress,
    segments?: MediaSegmentProgress,
  ): void {
    // Rust persists the raw progress but adds `media_type` only to the event
    // clone (pdf_processing_service.rs:3177-3200). Transcription updates are a
    // `MediaTranscriptionProgressEvent` (:387-398, :923-930): event-only `stage`
    // (same value as `status.stage`) and segment counts.
    const payload = {
      fileId,
      status: { ...processingProgressSnapshot(progress), mediaType },
      mediaType,
      ...(segments === undefined ? {} : { stage: progress.stage }),
      ...(segments?.completedSegments !== undefined && segments.completedSegments !== null
        ? { completedSegments: segments.completedSegments }
        : {}),
      ...(segments?.totalSegments !== undefined && segments.totalSegments !== null
        ? { totalSegments: segments.totalSegments }
        : {}),
    };
    this.events.emit('media-processing-progress', payload);
    if (mediaType === 'pdf') this.events.emit('pdf-processing-progress', payload);
  }

  cancel(fileId: string): boolean {
    const entry = this.running.get(fileId);
    if (entry === undefined) return false;
    this.running.delete(fileId);
    entry.controller.abort();
    return true;
  }

  cancelMedia(fileId: string): boolean {
    const wasRunning = this.cancel(fileId);
    cancelMediaRow(this.db, fileId);
    return wasRunning;
  }

  /**
   * Keep the owner alive until every accepted future has released its resources,
   * including cancelled generations no longer present in the running map.
   * Rust's spawned future retains Arc<Self> until its CleanupOnDrop runs.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort();
    for (const entry of this.running.values()) entry.controller.abort();
    this.running.clear();
    await Promise.all(this.tasks);
  }

  async retry(fileId: string): Promise<void> {
    const status = this.getStatus(fileId);
    if (status === null) {
      throw new PdfServiceError(`File not found: ${fileId}`, 'VFS_NOT_FOUND');
    }
    if (!['error', 'completed_with_issues', 'pending', 'cancelled'].includes(status.stage)
      || this.isRunning(fileId)) {
      // pdf_processing_service.rs:3002-3007 warns for every non-retriable
      // state, including an already-running task.
      this.logger?.warn(
        `[PdfProcessingService] Cannot retry file ${fileId} in stage: ${status.stage}`,
      );
      return;
    }
    const mediaType = this.detectMediaType(fileId);
    const startStage: ProcessingStage = mediaType === 'pdf'
      ? 'ocr_processing'
      : mediaType === 'image' ? 'image_compression' : 'queued';
    this.updateStatus(fileId, 'pending', null, null);
    await this.startPipeline(fileId, startStage);
  }

  /** pdf_processing_service.rs:3034-3090; resuming is vfs-index startup recovery's scoped loop. */
  recoverStuckTasks(): string[] {
    // Rust `get_conn_safe()?` (:3035) runs before the stuck query: a missing owner fails the whole
    // recovery even when nothing is stuck, and before the "Found N stuck tasks" log.
    const markRecovered = recoveredPendingWriter(this.db);
    const stuckIds = listFilesWithStatuses(this.db, STUCK_STAGES);
    if (stuckIds.length === 0) {
      this.logger?.debug('[MediaProcessingService] No stuck tasks found at startup');
      return [];
    }
    this.logger?.info(`[MediaProcessingService] Found ${stuckIds.length} stuck tasks at startup, resetting to pending`);
    const recovered: string[] = [];
    for (const fileId of stuckIds) {
      let affected = 0;
      // pdf_processing_service.rs:3078 `.unwrap_or(0)`: a row that fails to reset is skipped and the rest are still reset.
      try { affected = markRecovered(fileId); } catch { affected = 0; }
      if (affected > 0) {
        this.logger?.info(`[MediaProcessingService] Reset stuck file ${fileId} to pending`);
        recovered.push(fileId);
      }
    }
    return recovered;
  }

  backfillMissingPreviews(): number {
    if (this.runtime === undefined) {
      throw new PdfServiceError('PDF preview backfill requires F7 pdfium');
    }
    return this.runtime.backfillMissingPreviews(5, {
      signal: this.lifetime.signal,
      track: (task) => {
        this.tasks.add(task);
        void task.finally(() => { this.tasks.delete(task); });
      },
    });
  }

  private setError(fileId: string, error: string, stage: ProcessingStage): void {
    setProcessingErrorRow(this.db, fileId, error, Date.now());
    // Rust `set_error` only writes status/error/completed_at; it never rewrites
    // `processing_progress`, so the last published progress stays visible.
    this.logger?.error(
      `[PdfProcessingService] Set error for file ${fileId}: ${error} (stage: ${STAGE_DEBUG[stage]})`,
    );
  }

  private updateStatus(
    fileId: string,
    stage: ProcessingStage,
    progress: ProcessingProgress | null,
    completedAt: number | null,
  ): void {
    const progressJson = progress === null ? null : serializeProcessingProgress(progress);
    const summary = progress?.failedStages?.map((issue) => `${issue.stage}: ${issue.message}`).join('; ');
    updateProcessingStatusRow(
      this.db, fileId, stage, progressJson, completedAt, Date.now(),
      summary === '' || summary === undefined ? null : summary,
    );
  }
}
