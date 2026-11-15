import { charCount } from '../../../platform/util/portable.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { MediaTranscriptionProgressUpdate, MediaTranscriptionResult } from '../api.ts';
import { AIMD_INITIAL, AIMD_MAX, AIMD_MIN, Aimd } from './asr.ts';
import {
  Cancellation, runAsrJobsWith, type AsrBackendLike, type AsrJob, type AsrSink, type AsrSpoolLike,
} from './asr-runner.ts';
import { MediaError } from './errors.ts';
import { isLinkItem, linkOnlyError, loadMediaFile } from './media-commands.ts';
import { buildTranscriptText } from './transcript.ts';

export interface PlannedSpan { startMs: number; endMs: number }
export interface DecodedMedia {
  spool: AsrSpoolLike & { close(): void };
  spans: PlannedSpan[];
  durationMs: number;
  corruptPackets: number;
}

/** 长转写过程中每完成多少段刷新一次转写文本与检索（Rust `PARTIAL_REFRESH_EVERY`）。 */
const PARTIAL_REFRESH_EVERY = 20;

/**
 * `tokio::sync::Mutex<()>` equivalent: one media transcription at a time.
 * A waiter can abort while queued without taking the slot.
 */
export class TranscriptionGate {
  private tail: Promise<void> = Promise.resolve();

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) throw new MediaError('Cancelled', '');
    const previous = this.tail;
    let release = (): void => undefined;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.tail = previous.then(() => current);

    if (signal === undefined) {
      await previous;
      return release;
    }

    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        previous,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new MediaError('Cancelled', ''));
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } catch (error) {
      release();
      throw error;
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted) {
      release();
      throw new MediaError('Cancelled', '');
    }
    return release;
  }
}

export const mediaTranscriptionLock = new TranscriptionGate();

/** `pipeline.rs::write_transcript_text`; returns Rust `chars().count()`. */
function writeTranscriptText(
  database: Pick<VfsDatabase, 'getConnSafe'>,
  repo: VfsReposService,
  fileId: string,
): number {
  const conn = database.getConnSafe();
  const segments = repo.mediaTranscripts.listSegments(conn, fileId).map(segment => ({
    idx: segment.idx,
    start_ms: segment.startMs,
    end_ms: segment.endMs,
    text: segment.text,
    status: segment.status,
    source: segment.source,
    plan_version: segment.planVersion,
  }));
  const text = buildTranscriptText(segments);
  repo.files.setMediaExtractedTextWithConn(conn, fileId, text === '' ? null : text);
  return charCount(text);
}

/** `pipeline.rs::DbSink`: persist each completed segment immediately. */
class DbSink implements AsrSink {
  private done: number;
  private sinceRefresh = 0;
  private readonly database: Pick<VfsDatabase, 'getConnSafe'>;
  private readonly repo: VfsReposService;
  private readonly fileId: string;
  private readonly planVersion: number;
  private readonly total: number;
  private readonly onProgress: (update: MediaTranscriptionProgressUpdate) => void;
  private readonly refreshIndex: (fileId: string) => void;
  private readonly log?: { warn(message: string): void };

  constructor(
    database: Pick<VfsDatabase, 'getConnSafe'>,
    repo: VfsReposService,
    fileId: string,
    planVersion: number,
    total: number,
    done: number,
    onProgress: (update: MediaTranscriptionProgressUpdate) => void,
    refreshIndex: (fileId: string) => void,
    log?: { warn(message: string): void },
  ) {
    this.database = database;
    this.repo = repo;
    this.fileId = fileId;
    this.planVersion = planVersion;
    this.total = total;
    this.done = done;
    this.onProgress = onProgress;
    this.refreshIndex = refreshIndex;
    this.log = log;
  }

  report(): void {
    const ratio = this.total > 0 ? this.done / this.total : 1;
    this.onProgress({
      stage: 'asr',
      percent: 35 + 55 * ratio,
      completedSegments: this.done,
      totalSegments: this.total,
    });
  }

  onDone(job: AsrJob, text: string, bounds: [number, number] | null): void {
    const conn = this.database.getConnSafe();
    this.repo.mediaTranscripts.markDoneWithBounds(
      conn, this.fileId, job.idx, this.planVersion, text, bounds);
    this.done += 1;
    this.sinceRefresh += 1;
    if (this.sinceRefresh >= PARTIAL_REFRESH_EVERY) {
      this.sinceRefresh = 0;
      writeTranscriptText(this.database, this.repo, this.fileId);
      this.refreshIndex(this.fileId);
    }
    this.report();
  }

  onFailed(job: AsrJob, message: string): void {
    this.log?.warn(
      `[media::pipeline] segment ${job.idx} of ${this.fileId} failed: ${message}`);
    const conn = this.database.getConnSafe();
    this.repo.mediaTranscripts.markFailed(conn, this.fileId, job.idx, this.planVersion);
  }
}

export interface TranscribeResourceDeps {
  database: Pick<VfsDatabase, 'getConnSafe' | 'blobsDir'>;
  repos: VfsReposService;
  fileId: string;
  backend: AsrBackendLike;
  decode(info: ReturnType<typeof loadMediaFile>, onProgress: (fraction: number) => void): Promise<DecodedMedia>;
  signal: AbortSignal | undefined;
  onProgress(update: MediaTranscriptionProgressUpdate): void;
  refreshIndex?(fileId: string): void;
  log?: { warn(message: string): void };
  gate?: TranscriptionGate;
}

/**
 * `pipeline.rs::transcribe_resource`: queued → decode → VAD → ASR → transcript
 * text. Imported subtitle plans bypass ASR before taking the single-flight slot.
 */
export async function transcribeResource(
  deps: TranscribeResourceDeps,
): Promise<MediaTranscriptionResult> {
  const { database, repos, fileId, backend, signal } = deps;
  const refreshIndex = deps.refreshIndex ?? (() => undefined);
  const gate = deps.gate ?? mediaTranscriptionLock;
  deps.onProgress({ stage: 'queued', percent: 0 });

  const conn = database.getConnSafe();
  const info = loadMediaFile(conn, fileId);
  const plan = repos.mediaTranscripts.planInfo(conn, info.fileId);
  if (plan !== null && plan[1] === 'import') {
    const chars = writeTranscriptText(database, repos, info.fileId);
    refreshIndex(info.fileId);
    const counts = repos.mediaTranscripts.counts(conn, info.fileId);
    return {
      transcriptChars: chars,
      doneSegments: counts.done,
      totalSegments: counts.total,
      // Rust returns `TranscriptionOutcome::default()` for the failure count.
      failedSegments: 0,
    };
  }
  if (isLinkItem(info)) throw linkOnlyError();

  const release = await gate.acquire(signal);
  try {
    const cancellation = new Cancellation();
    const abort = (): void => { cancellation.cancel(); };
    if (signal?.aborted === true) cancellation.cancel();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      deps.onProgress({ stage: 'decode', percent: 1 });
      let lastPercent = -1;
      const decoded = await deps.decode(info, fraction => {
        const percent = Math.trunc(fraction * 30);
        if (percent === lastPercent) return;
        lastPercent = percent;
        deps.onProgress({ stage: 'decode', percent: 1 + percent });
      });
      if (decoded.corruptPackets > 0) {
        deps.log?.warn(
          `[media::pipeline] ${decoded.corruptPackets} corrupt packets skipped `
          + `(filled with silence) in ${info.fileId}`);
      }

      try {
        deps.onProgress({
          stage: 'vad', percent: 32, completedSegments: null,
          totalSegments: decoded.spans.length,
        });

        const transcripts = repos.mediaTranscripts;
        transcripts.recordDuration(conn, info.fileId, decoded.durationMs);
        const outcome = transcripts.applyPlan(conn, info.fileId, decoded.spans);
        transcripts.resetFailed(conn, info.fileId);
        const jobs: AsrJob[] = transcripts.listUnfinished(conn, info.fileId).map(segment => ({
          idx: segment.idx, startMs: segment.startMs, endMs: segment.endMs,
        }));
        if (outcome.status === 'rebuilt') {
          writeTranscriptText(database, repos, info.fileId);
          refreshIndex(info.fileId);
        }

        const counts = transcripts.counts(conn, info.fileId);
        const sink = new DbSink(
          database, repos, info.fileId, outcome.planVersion, counts.total, counts.done,
          deps.onProgress, refreshIndex, deps.log);
        sink.report();

        let asrError: unknown = null;
        let chars = 0;
        try {
          if (jobs.length > 0) {
            await runAsrJobsWith(
              backend, decoded.spool, jobs, cancellation, sink,
              new Aimd(AIMD_INITIAL, AIMD_MIN, AIMD_MAX));
          }
        } catch (error) {
          asrError = error;
        } finally {
          chars = writeTranscriptText(database, repos, info.fileId);
          refreshIndex(info.fileId);
        }
        if (asrError !== null) throw asrError;

        const finalCounts = transcripts.counts(conn, info.fileId);
        return {
          transcriptChars: chars,
          doneSegments: finalCounts.done,
          totalSegments: finalCounts.total,
          failedSegments: finalCounts.failed,
        };
      } finally {
        try { decoded.spool.close(); }
        catch { // boundary-allow empty-catch: Rust `PcmSpool` drop ignores temp-file removal failures
        }
      }
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  } finally {
    release();
  }
}
