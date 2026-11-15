/**
 * `dstu-media/src/media/pipeline.rs`: decode → VAD planning, duration probing and
 * the exact/heuristic transcription estimate. The symphonia decoder itself is
 * provided by F7 as `nativeAudio` (same Rust code compiled to WASI); this module
 * keeps the Rust pipeline semantics: mono 16 kHz spool, VAD spans and the
 * "existing plan wins" estimate shortcut.
 */
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from '../../../platform/util/path.ts';
import { AudioDecodeError, type NativeAudio } from '../../../platform/native/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { MediaTranscriptRepository, VfsReposService } from '../../vfs-repos/api.ts';
import { decodeBase64Standard } from './base64.ts';
import { MediaError } from './errors.ts';
import {
  isLinkItem, kindOf, linkOnlyError, loadMediaFile, type MediaFileInfo,
} from './media-commands.ts';
import { defaultVadParams, planSegments, VadAnalyzer } from './vad.ts';
import { PcmSpoolWriter, type PcmSpool } from './wav.ts';
import { transcribeResource as transcribe, type DecodedMedia, type TranscribeResourceDeps as CoreDeps } from './pipeline-core.ts';
export { mediaTranscriptionLock, TranscriptionGate, type PlannedSpan } from './pipeline-core.ts';

/** 精确估算（解码 + VAD）的时长上限；更长的媒体走容器头快速探测 + 经验段长。 */
export const EXACT_ESTIMATE_MAX_MS = 20 * 60 * 1000;
/** 快速估算时每段平均时长（经验值：讲课语速下 VAD 段约 8–10 s）。 */
export const HEURISTIC_SEGMENT_MS = 9_000;
/** 无时长头（部分 MP3/MKV）时，小于该体积才实测。 */
export const HEADLESS_PROBE_MAX_BYTES = 30 * 1024 * 1024;

/** 媒体文件内容：磁盘文件或需要临时落盘的内联 base64。 */
export interface MediaSource {
  path: string;
  cleanup(): void;
}

function mediaErrorFromAudio(error: unknown): MediaError {
  if (error instanceof MediaError) return error;
  if (error instanceof AudioDecodeError) {
    switch (error.code) {
      case 'cancelled': return new MediaError('Cancelled', error.message);
      case 'media-unsupported': return new MediaError('Unsupported', error.message);
      case 'media-no-audio-track': return new MediaError('NoAudioTrack', error.message);
      case 'media-decode-failed': return new MediaError('Decode', error.message);
      case 'io-failed': return new MediaError('Io', error.message);
      default: return new MediaError('Decode', error.message);
    }
  }
  return new MediaError('Decode', error instanceof Error ? error.message : String(error));
}

/** `pipeline.rs::resolve_media_source`：blob / resource / original_path，内联内容落临时文件。 */
export function resolveMediaSource(
  database: { getConnSafe(): SqlExecutor; blobsDir(): string },
  repo: Pick<VfsReposService, 'attachments'>,
  fileId: string,
): MediaSource {
  const conn = database.getConnSafe();
  const source = repo.attachments.getContentSource(conn, database.blobsDir(), fileId);
  if (source === null) throw new MediaError('NotFound', `媒体文件内容缺失: ${fileId}`);
  if (source.kind === 'file') return { path: source.path, cleanup: () => undefined };

  const payload = source.data.startsWith('data:') && source.data.includes(',')
    ? source.data.slice(source.data.indexOf(',') + 1)
    : source.data;
  let bytes: Uint8Array;
  try { bytes = decodeBase64Standard(payload.trim()); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MediaError('Decode', `媒体内容解码失败: ${message}`);
  }
  const path = join(tmpdir(), `dstu-media-${globalThis.crypto.randomUUID()}.bin`);
  try { writeFileSync(path, bytes); }
  catch (error) {
    throw new MediaError('Io', error instanceof Error ? error.message : String(error));
  }
  return {
    path,
    cleanup: () => {
      try { unlinkSync(path); }
      catch (cleanupError) { // boundary-allow empty-catch: Rust `NamedTempFile` drop 忽略临时文件删除失败
      }
    },
  };
}

/** `media/mod.rs::AUTO_TRANSCRIBE_MAX_DURATION_MS`：短音频导入后自动转写。 */
export const AUTO_TRANSCRIBE_MAX_DURATION_MS = 10 * 60 * 1000;
/** 无时长头时按体积判断自动转写的上限（`commands.rs`：10 MB）。 */
export const AUTO_TRANSCRIBE_HEADLESS_MAX_BYTES = 10 * 1024 * 1024;

/**
 * `commands.rs::auto_transcribe_eligible`：仅音频、尚无字幕段、时长
 * < 10 分钟（无时长头时按 ≤ 10 MB 判断）；解码器不认识的文件返回 false。
 */
export async function autoTranscribeEligible(
  database: Pick<VfsDatabase, 'getConnSafe' | 'blobsDir'>,
  repo: VfsReposService,
  info: MediaFileInfo,
  audio: NativeAudio,
): Promise<boolean> {
  if (kindOf(info) !== 'Audio') return false;
  const conn: SqlExecutor = database.getConnSafe();
  if (repo.mediaTranscripts.counts(conn, info.fileId).total > 0) return false;
  const source = resolveMediaSource(database, repo, info.fileId);
  try {
    let duration: number | null;
    try {
      duration = (await audio.probe(source.path, mediaExtension(info.fileName))).duration_ms;
    } catch {
      // Rust `Err(_) => return Ok(false)`：probe 失败不算自动转写候选。
      return false;
    }
    return duration !== null
      ? duration < AUTO_TRANSCRIBE_MAX_DURATION_MS
      : info.size <= AUTO_TRANSCRIBE_HEADLESS_MAX_BYTES;
  } finally {
    source.cleanup();
  }
}

/** 文件扩展名小写（Rust `MediaFileInfo::extension`）。 */
export function mediaExtension(fileName: string): string | null {
  const index = fileName.lastIndexOf('.');
  if (index < 0 || index === fileName.length - 1) return null;
  return fileName.slice(index + 1).toLowerCase();
}

/** `pipeline.rs::decode_and_plan`（阻塞线程内完成解码 + VAD + PCM 落盘）。 */
export async function decodeAndPlan(
  audio: NativeAudio,
  sourcePath: string,
  extensionHint: string | null,
  tempDir: string | null,
  signal: AbortSignal | undefined,
  onProgress: (fraction: number) => void,
): Promise<DecodedMedia & { spool: PcmSpool }> {
  const spoolWriter = new PcmSpoolWriter(tempDir);
  const vad = new VadAnalyzer();
  try {
    const report = await audio.decodeToMono16k(sourcePath, {
      extensionHint,
      ...(signal !== undefined ? { signal } : {}),
      onProgress,
      sink: (pcm) => {
        vad.push(pcm);
        spoolWriter.write(pcm);
      },
    });
    const spool = spoolWriter.finish();
    const spans = planSegments(vad.finish(), defaultVadParams())
      .map(([startMs, endMs]) => ({ startMs, endMs }));
    return {
      spool,
      spans,
      durationMs: report.duration_ms,
      corruptPackets: report.corrupt_packets,
    };
  } catch (error) {
    spoolWriter.close();
    throw mediaErrorFromAudio(error);
  }
}

/** `pipeline.rs::estimate_segments`：只解码 + VAD 估算段数（不写库、不落盘）。 */
export async function estimateSegments(
  audio: NativeAudio,
  sourcePath: string,
  extensionHint: string | null,
  signal: AbortSignal | undefined,
): Promise<[number, number]> {
  const vad = new VadAnalyzer();
  try {
    const report = await audio.decodeToMono16k(sourcePath, {
      extensionHint,
      ...(signal !== undefined ? { signal } : {}),
      onProgress: () => undefined,
      sink: (pcm) => { vad.push(pcm); },
    });
    return [report.duration_ms, planSegments(vad.finish(), defaultVadParams()).length];
  } catch (error) {
    throw mediaErrorFromAudio(error);
  }
}

/**
 * `commands.rs::estimate_impl`：已有计划 → 直接返回；短媒体解码 + VAD；
 * 长媒体容器头探测 + 经验段长。返回 `[durationMs, plannedSegments, exact]`。
 */
export async function estimateImpl(
  database: Pick<VfsDatabase, 'getConnSafe' | 'blobsDir'>,
  repo: VfsReposService,
  info: MediaFileInfo,
  audio: NativeAudio,
  signal: AbortSignal | undefined = undefined,
): Promise<[number | null, number | null, boolean]> {
  const conn: SqlExecutor = database.getConnSafe();
  const transcripts: MediaTranscriptRepository = repo.mediaTranscripts;
  const counts = transcripts.counts(conn, info.fileId);
  if (counts.total > 0) {
    const duration = transcripts.getProgress(conn, info.fileId)?.durationMs ?? null;
    return [duration, counts.total, true];
  }
  if (isLinkItem(info)) throw linkOnlyError();

  const source = resolveMediaSource(database, repo, info.fileId);
  try {
    const extension = mediaExtension(info.fileName);
    const probed = await audio.probe(source.path, extension);
    const shortEnough = probed.duration_ms !== null
      ? probed.duration_ms <= EXACT_ESTIMATE_MAX_MS
      : info.size <= HEADLESS_PROBE_MAX_BYTES;
    if (shortEnough) {
      const [duration, planned] = await estimateSegments(audio, source.path, extension, signal);
      return [duration, planned, true];
    }
    const planned = probed.duration_ms === null
      ? null
      : Math.trunc((probed.duration_ms + HEURISTIC_SEGMENT_MS - 1) / HEURISTIC_SEGMENT_MS);
    return [probed.duration_ms, planned, false];
  } catch (error) {
    throw mediaErrorFromAudio(error);
  } finally {
    source.cleanup();
  }
}

export interface TranscribeResourceDeps extends Omit<CoreDeps, 'decode'> {
  audio: NativeAudio;
  tempDir: string | null;
}

export async function transcribeResource(deps: TranscribeResourceDeps) {
  return transcribe({ ...deps, async decode(info, progress) {
    const source = resolveMediaSource(deps.database, deps.repos, info.fileId);
    try {
      return await decodeAndPlan(deps.audio, source.path, mediaExtension(info.fileName), deps.tempDir, deps.signal, progress);
    } finally { source.cleanup(); }
  } });
}
