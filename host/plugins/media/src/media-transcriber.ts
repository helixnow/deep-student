/**
 * `dstu-media/src/media/transcriber_hook.rs` + `pipeline.rs::transcribe_resource`:
 * the L18 media transcriber consumed by L12's shared task scheduler.
 *
 * L18 owns decoding, VAD planning, ASR, persistence and the project transcript
 * text; L12 owns task status/events and the post-transcript vector-index hop.
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from '../../../platform/util/path.ts';
import { Service, type Context } from '@deepseek-ai/cordis';
import type { NativeAudio } from '../../../platform/native/audio/api.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type {
  MediaTranscriberService, MediaTranscriptionProgressUpdate, MediaTranscriptionRequest,
  MediaTranscriptionResult,
} from '../api.ts';
import { AsrConfigError, type AsrHttpError } from './asr.ts';
import type { AsrBackendLike } from './asr-runner.ts';
import { MediaError } from './errors.ts';
import { mediaTranscriptionLock, transcribeResource } from './pipeline.ts';

/** `transcriber_hook.rs::UnavailableBackend`: imported subtitles never run ASR. */
const unavailableBackend: AsrBackendLike = {
  async transcribe(): Promise<never> {
    const error: AsrHttpError = {
      kind: 'status', status: 401, retryAfterSeconds: null, body: 'ASR backend unavailable',
    };
    throw error;
  },
  modelLabel: () => 'unavailable',
};

/**
 * `transcriber_hook.rs` mpsc channel + `select!` loop: updates reach the
 * consumer only once `transcribe_resource` suspends, and leftovers are drained
 * after it settles. An imported plan finishes in its first poll, so its
 * `Queued` update is persisted after the transcript text and index refresh.
 */
class ProgressChannel {
  private readonly queue: MediaTranscriptionProgressUpdate[] = [];
  private scheduled = false;
  private readonly consumer: (update: MediaTranscriptionProgressUpdate) => void;

  constructor(consumer: (update: MediaTranscriptionProgressUpdate) => void) {
    this.consumer = consumer;
  }

  send(update: MediaTranscriptionProgressUpdate): void {
    this.queue.push(update);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  drain(): void {
    for (let update = this.queue.shift(); update !== undefined; update = this.queue.shift()) {
      this.consumer(update);
    }
  }
}

/** Remove stale `media-pcm-*` spool files older than 24 hours. */
function sweepStaleMediaTemp(dir: string): void {
  let entries: string[];
  try { entries = readdirSync(dir); }
  catch { // boundary-allow empty-catch: Rust `read_dir` failure is ignored
    return;
  }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const name of entries) {
    if (!name.startsWith('media-pcm-')) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
    } catch { // boundary-allow empty-catch: Rust ignores spool metadata/remove failures
    }
  }
}

export interface MediaTranscriberDeps {
  database(): VfsDatabase;
  repos(): VfsReposService;
  audio(): NativeAudio;
  /** `build_backend`: resolve the managed ASR endpoint and construct the HTTP backend. */
  backend(): Promise<AsrBackendLike>;
  /** L13 `vfs.mediaIndex.refreshTranscriptIndex`; L12 owns the final vector-index hop. */
  refreshIndex?(fileId: string): void;
  log: { warn(message: string): void };
}

export class MediaTranscriberCordisService extends Service implements MediaTranscriberService {
  readonly version = 1 as const;
  private readonly deps: MediaTranscriberDeps;

  constructor(ctx: Context, deps: MediaTranscriberDeps) {
    super(ctx, 'mediaTranscriber');
    this.deps = deps;
  }

  async transcribe(request: MediaTranscriptionRequest): Promise<MediaTranscriptionResult> {
    let backend: AsrBackendLike;
    if (request.imported) {
      backend = unavailableBackend;
    } else {
      try {
        backend = await this.deps.backend();
      } catch (error) {
        if (error instanceof AsrConfigError) {
          throw new MediaError('AsrFatal', error.message, error.code);
        }
        throw error;
      }
    }
    sweepStaleMediaTemp(request.tempDir);
    const progress = new ProgressChannel(request.onProgress);
    try {
      return await transcribeResource({
        database: this.deps.database(),
        repos: this.deps.repos(),
        audio: this.deps.audio(),
        fileId: request.fileId,
        backend,
        tempDir: request.tempDir,
        signal: request.signal,
        onProgress: update => { progress.send(update); },
        refreshIndex: fileId => { this.deps.refreshIndex?.(fileId); },
        log: this.deps.log,
        gate: mediaTranscriptionLock,
      });
    } finally {
      progress.drain();
    }
  }
}
