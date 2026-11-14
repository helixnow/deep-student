/** Media library, progress, transcript, transcription and study-ledger commands (`src/media/*.rs`). */
import { readFileSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { extractFileName } from '../../../platform/storage/file-names.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import { AsrConfigError } from './asr.ts';
import { MediaError } from './errors.ts';
import {
  buildTranscriptView,
  exportTranscript, importSubtitle, isLinkItem, linkOnlyError,
  loadMediaFile, toTranscriptStatusView,
} from './media-commands.ts';
import type { MediaBlobReader } from './media-library.ts';
import { estimateImpl } from './pipeline.ts';
import type { MediaPluginDeps } from './plugin-deps.ts';
import { cancelMedia, mediaFailure, mediaFileIo } from './plugin-deps.ts';
import { registerPortableMediaCommands } from './register-media-portable.ts';
import { MAX_SUBTITLE_BYTES } from './subtitle.ts';
import { readAllBytesBounded, writeTextFile } from './textbooks.ts';
import { resolveAsrEndpoint, resolveSiliconflowKey } from './voice-input.ts';
import { getFileBlobPath } from './vfs-blob-path.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';

/**
 * 桌面链接条目封面的字节来源：`vfs_get_file_blob_path` 解析出的磁盘 blob。
 * 移动端没有磁盘 blob（见 `media-library.ts` 的 `MediaBlobReader`），不注入。
 */
const readBlobFromDisk: MediaBlobReader = (database, id) => {
  const path = getFileBlobPath(database, id);
  return path === null ? null : readFileSync(path);
};

export function registerMediaCommands(ctx: Context, deps: MediaPluginDeps): void {
  const { vfsDatabase, vfsRepo } = deps;
  const importLog = ctx.logger('media.commands');

  // 与移动端共用：库列表 / 进度 / 字幕视图 / 章节 / 台账（数据面只经 ctx.storage 与 L11 仓储）。
  registerPortableMediaCommands(ctx, {
    vfsDatabase,
    vfsRepo,
    pdfService: () => deps.pdfService(),
    readBlob: readBlobFromDisk,
  });

  ctx.commands.register<Commands['media_transcript_export']['args'], Commands['media_transcript_export']['result']>(
    'media_transcript_export',
    async ({ resourceId, format, dest }) => {
      try {
        const conn = vfsDatabase().getConnSafe();
        const info = loadMediaFile(conn, resourceId);
        const result = exportTranscript(conn, vfsRepo().mediaTranscripts, info, format);
        await mediaFileIo(() => writeTextFile(dest, result.content));
        return {
          path: dest,
          format: result.format,
          segments: result.segments,
          bytes: utf8ByteLength(result.content),
        };
      } catch (error) { return mediaFailure(error); }
    });
  ctx.commands.register<Commands['media_transcript_import']['args'],
    Commands['media_transcript_import']['result']>('media_transcript_import',
    async ({ resourceId, path }) => {
      try {
        const database = vfsDatabase();
        const conn = database.getConnSafe();
        const info = loadMediaFile(conn, resourceId);
        const bytes = await mediaFileIo(() => readAllBytesBounded(path, MAX_SUBTITLE_BYTES));
        const vfsIndex = deps.vfsIndex();
        const pdf = vfsIndex?.pdf;
        if (pdf?.isRunning(info.fileId) === true) cancelMedia(pdf, info.fileId);
        const count = importSubtitle(conn, vfsRepo().mediaTranscripts, vfsRepo().files,
          info, extractFileName(path), bytes);
        deps.scheduleMediaIndex(vfsIndex, info);
        importLog.info('[media::commands] imported %d subtitle cues for %s', count, info.fileId);
        await deps.startMediaPipeline(pdf, info, true);
        return buildTranscriptView(
          conn, vfsRepo().mediaTranscripts, info, pdf?.isRunning(info.fileId) ?? false, true);
      } catch (error) { return mediaFailure(error); }
    });
  ctx.commands.register<Commands['media_transcribe_estimate']['args'],
    Commands['media_transcribe_estimate']['result']>('media_transcribe_estimate',
    async ({ resourceId }) => {
      try {
        const database = vfsDatabase();
        const conn = database.getConnSafe();
        const info = loadMediaFile(conn, resourceId);
        let asrModel = '';
        let asrConfigured = false;
        try {
          const endpoint = await resolveAsrEndpoint(
            deps.llm(), await resolveSiliconflowKey(ctx.settings));
          asrModel = endpoint.model;
          asrConfigured = true;
        } catch (error) {
          if (!(error instanceof AsrConfigError)) throw error;
          asrModel = error.model;
        }
        const [durationMs, plannedSegments, exact] = await estimateImpl(
          database, vfsRepo(), info, deps.nativeAudio());
        return { durationMs, plannedSegments, asrModel, asrConfigured, exact };
      } catch (error) { return mediaFailure(error); }
    });
  ctx.commands.register<Commands['media_transcribe_start']['args'],
    Commands['media_transcribe_start']['result']>('media_transcribe_start',
    async ({ resourceId }) => {
      try {
        const database = vfsDatabase();
        const conn = database.getConnSafe();
        const info = loadMediaFile(conn, resourceId);
        const pdf = deps.pdfService();
        if (pdf === undefined) {
          throw new CommandError(AppError.configuration(
            'VFS 索引服务未配置：需要 L12 vfsIndex'));
        }
        const transcripts = vfsRepo().mediaTranscripts;
        if (pdf.isRunning(info.fileId)) {
          return toTranscriptStatusView(
            buildTranscriptView(conn, transcripts, info, true, false));
        }
        const current = buildTranscriptView(conn, transcripts, info, false, false);
        if (current.status === 'completed') return toTranscriptStatusView(current);
        if (current.progress.source !== 'import') {
          if (isLinkItem(info)) throw linkOnlyError();
          try {
            await resolveAsrEndpoint(deps.llm(), await resolveSiliconflowKey(ctx.settings));
          } catch (error) {
            if (!(error instanceof AsrConfigError)) throw error;
            throw new MediaError('AsrFatal', error.message, error.code);
          }
        }
        try { await pdf.startPipeline(info.fileId, null); }
        catch (error) {
          throw new MediaError('Database',
            error instanceof Error ? error.message : String(error));
        }
        const running = pdf.isRunning(info.fileId);
        return toTranscriptStatusView(
          buildTranscriptView(conn, transcripts, info, running, false));
      } catch (error) { return mediaFailure(error); }
    });
  ctx.commands.register<Commands['media_transcribe_cancel']['args'],
    Commands['media_transcribe_cancel']['result']>('media_transcribe_cancel',
    ({ resourceId }) => {
      try {
        const database = vfsDatabase();
        const conn = database.getConnSafe();
        const info = loadMediaFile(conn, resourceId);
        const pdf = deps.pdfService();
        if (pdf !== undefined) cancelMedia(pdf, info.fileId);
        return toTranscriptStatusView(
          buildTranscriptView(conn, vfsRepo().mediaTranscripts, info, false, false));
      } catch (error) { return mediaFailure(error); }
    });
}
