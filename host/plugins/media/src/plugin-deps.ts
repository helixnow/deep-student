/**
 * Service accessors and error mappings shared by the `register-*.ts` modules.
 * Optional services are resolved per call: a missing required service is an
 * explicit configuration error, never an empty result.
 */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { NativeAudio } from '../../../platform/native/api.ts';
import type { NativeImage } from '../../../platform/native/image/api.ts';
import { CallerType } from '../../../platform/storage/llm-usage.ts';
import type { LLMManager, LlmHttp } from '../../llm/api.ts';
import type { VfsDatabase, VfsService } from '../../vfs/api.ts';
import type { PdfProcessingService, VfsIndexService } from '../../vfs-index/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { AsrUsageRecorder } from './asr-backend.ts';
import { BiliRequestError } from './bilibili-policy.ts';
import { MediaError } from './errors.ts';
import { buildTranscriptView, type MediaFileInfo } from './media-commands.ts';
import { TextbookFileError } from './textbooks.ts';
import {
  recordAsrUsage, recordVoiceInputUsage, type AsrFetch, type VoiceInputUsageRecorder,
} from './voice-input.ts';

export { ocrFailure } from './register-ocr-settings.ts';

export function mediaFailure(error: unknown): never {
  if (error instanceof MediaError) throw new CommandError(error.toPayloadString());
  if (error instanceof BiliRequestError) {
    throw new CommandError(
      new MediaError('Transport', error.message, error.payload).toPayloadString());
  }
  throw error;
}

/** `ledger.rs:255-257,466-476`: ledger commands return `e.to_string()` as a plain string. */
export function ledgerFailure(error: unknown): never {
  throw new CommandError(error instanceof Error ? error.message : String(error));
}

/** `commands.rs:374-376,450-455`: cancellation failures are Database errors. */
export function cancelMedia(pdf: PdfProcessingService, fileId: string): void {
  try { pdf.cancelMedia(fileId); }
  catch (error) {
    throw new MediaError('Database', error instanceof Error ? error.message : String(error));
  }
}

/** `commands.rs:433-435,523-524`: file manager failures become `MediaError::Io(e.message)`. */
export async function mediaFileIo<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof TextbookFileError) throw new MediaError('Io', error.appError.message);
    throw error;
  }
}

/** L13 `vfs.mediaIndex`/`unitIndex` are branch candidates until that lane merges. */
interface VfsMediaIndexApi {
  refreshTranscriptIndex(database: VfsDatabase, index: unknown, fileId: string): number;
}
type VfsWithMediaIndex = VfsService & {
  mediaIndex?: VfsMediaIndexApi;
  unitIndex?: unknown;
};

export interface MediaPluginDeps {
  llm(): LLMManager | null;
  /** ASR HTTP goes through `llmHttp`, resolved per request; absent → the request fails as a network error. */
  asrFetch: AsrFetch;
  /** `MediaError::Database("VFS database not configured")` when vfs is not loaded. */
  vfsDatabase(): VfsDatabase;
  vfsRepo(): VfsReposService;
  nativeImage(): NativeImage;
  nativeAudio(): NativeAudio;
  encodePng(input: { width: number; height: number; rgba: Uint8Array }): Promise<Uint8Array>;
  vfsIndex(): VfsIndexService | undefined;
  pdfService(): PdfProcessingService | undefined;
  /** L13 transcript time-window refresh; returns whether it ran. */
  refreshTranscriptIndexL13(fileId: string): boolean;
  /** Rust `pipeline::refresh_index`: L13 refresh, else schedule resource indexing. */
  scheduleMediaIndex(vfsIndex: VfsIndexService | undefined, info: MediaFileInfo): void;
  startMediaPipeline(pdf: PdfProcessingService | undefined, info: MediaFileInfo, warn: boolean): Promise<void>;
  transcriptViewOf(
    database: VfsDatabase, repos: VfsReposService, info: MediaFileInfo, pdf: PdfProcessingService | undefined,
  ): ReturnType<typeof buildTranscriptView>;
  recordMediaAsrUsage: AsrUsageRecorder;
  recordVoiceUsage: VoiceInputUsageRecorder;
}

export function createMediaPluginDeps(ctx: Context): MediaPluginDeps {
  const importLog = ctx.logger('media.commands');
  const voiceUsageLog = ctx.logger('media.voice_input');
  const vfsDatabase = (): VfsDatabase => {
    const database = ctx.get('vfsDatabase') as VfsDatabase | undefined;
    if (database === undefined) {
      throw new CommandError(new MediaError('Database', 'VFS database not configured').toPayloadString());
    }
    return database;
  };
  const vfsRepo = (): VfsReposService => {
    const repo = ctx.get('vfsRepo') as VfsReposService | undefined;
    if (repo === undefined) {
      throw new CommandError(AppError.configuration('VFS repository service not configured'));
    }
    return repo;
  };
  const nativeImage = (): NativeImage => {
    const service = ctx.get('nativeImage') as NativeImage | undefined;
    if (service === undefined) {
      throw new CommandError(AppError.configuration(
        '媒体图片服务未提供：需要 F7 nativeImage'));
    }
    return service;
  };
  const nativeAudio = (): NativeAudio => {
    const service = ctx.get('nativeAudio') as NativeAudio | undefined;
    if (service === undefined) {
      throw new CommandError(AppError.configuration(
        '媒体解码服务未提供：需要 F7 nativeAudio'));
    }
    return service;
  };
  const vfsIndex = (): VfsIndexService | undefined => ctx.get('vfsIndex') as VfsIndexService | undefined;
  /**
   * Rust `pipeline::refresh_index`: update time-window units immediately and
   * leave vectors pending.  Prefer L13 `vfs.mediaIndex`; current main only
   * exposes the older indexing schedule, kept as a fallback until L13 merges.
   */
  const refreshTranscriptIndexL13 = (fileId: string): boolean => {
    const vfs = ctx.get('vfs') as VfsWithMediaIndex | undefined;
    if (vfs?.mediaIndex === undefined || vfs.unitIndex === undefined) return false;
    try {
      vfs.mediaIndex.refreshTranscriptIndex(vfs.database, vfs.unitIndex, fileId);
    } catch (error) {
      importLog.warn('[media::pipeline] refresh transcript index failed for %s: %s',
        fileId, error instanceof Error ? error.message : String(error));
    }
    return true;
  };
  return {
    llm: () => (ctx.get('llm') as LLMManager | undefined) ?? null,
    asrFetch: async (input, init) => {
      const http = ctx.get('llmHttp') as LlmHttp | undefined;
      if (http === undefined) throw new Error('LLM HTTP 服务不可用（需要 llmHttp）');
      return await http.fetch(input, init);
    },
    vfsDatabase,
    vfsRepo,
    nativeImage,
    nativeAudio,
    encodePng: async input => await nativeImage().encode(input, { format: 'png' }),
    vfsIndex,
    pdfService: () => vfsIndex()?.pdf,
    refreshTranscriptIndexL13,
    scheduleMediaIndex: (index, info) => {
      if (refreshTranscriptIndexL13(info.fileId)) return;
      if (index === undefined || info.resourceId === null) return;
      void index.indexing.indexResource(info.resourceId).catch((error: unknown) => {
        importLog.warn('[media::commands] failed to schedule indexing for %s: %s',
          info.fileId, error instanceof Error ? error.message : String(error));
      });
    },
    startMediaPipeline: async (pdf, info, warn) => {
      if (pdf === undefined) return;
      try { await pdf.startPipeline(info.fileId, null); }
      catch (error) {
        if (!warn) return;
        importLog.warn('[media::commands] failed to schedule indexing for %s: %s',
          info.fileId, error instanceof Error ? error.message : String(error));
      }
    },
    transcriptViewOf: (database, repos, info, pdf) => buildTranscriptView(
      database.getConnSafe(), repos.mediaTranscripts, info,
      pdf?.isRunning(info.fileId) ?? false, true),
    recordMediaAsrUsage: usage => {
      try {
        recordAsrUsage(ctx.storage.database('llm_usage'), CallerType.MediaTranscription, usage);
      } catch (error) {
        // `UsageCollector::record` swallows database failures; the clip result stands.
        importLog.warn(`记录媒体转写用量失败: ${
          error instanceof Error ? error.message : String(error)}`);
      }
    },
    recordVoiceUsage: usage => {
      try {
        recordVoiceInputUsage(ctx.storage.database('llm_usage'), usage);
      } catch (error) {
        // `UsageCollector::record` never propagates a database failure to the
        // ASR command; keep the transcription result and only log.
        voiceUsageLog.warn(`记录语音输入用量失败: ${
          error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
