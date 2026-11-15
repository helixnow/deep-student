import type { Context } from '@deepseek-ai/cordis';
import type { Commands } from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import { mobileLocalRuntime } from '../../../platform/files/mobile-local-runtime.ts';
import { posix } from '../../../platform/util/path.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import type { VfsIndexService } from '../../vfs-index/api.ts';
import type { PortableMediaDeps } from './register-media-portable.ts';
import { buildTranscriptView, exportTranscript, importSubtitle, loadMediaFile } from './media-commands.ts';
import { MAX_SUBTITLE_BYTES } from './subtitle.ts';
import { MediaError } from './errors.ts';

export function registerMobileTranscript(ctx: Context, deps: Pick<PortableMediaDeps, 'vfsDatabase' | 'vfsRepo'>): void {
  const files = () => {
    const service = ctx.reflect.get('files', false) as FilesService | undefined;
    if (!service) throw new Error('移动文件存储服务不可用');
    return service;
  };
  const fail = (error: unknown): never => {
    if (error instanceof CommandError) throw error;
    throw new CommandError(error instanceof MediaError ? error.toPayloadString() : new MediaError('Io',
      error instanceof Error ? error.message : String(error)).toPayloadString());
  };
  const log = ctx.logger('media.transcript');

  ctx.commands.register<Commands['media_transcript_export']['args'], Commands['media_transcript_export']['result']>(
    'media_transcript_export', async ({ resourceId, format, dest }) => {
      try {
        const conn = deps.vfsDatabase().getConnSafe();
        const result = exportTranscript(conn, deps.vfsRepo().mediaTranscripts, loadMediaFile(conn, resourceId), format);
        const directory = posix.join(ctx.paths.appDataDir, 'recovery', 'exports');
        if (posix.dirname(dest) !== directory || !/^[0-9a-f-]{36}\.(srt|vtt|txt)$/i.test(posix.basename(dest))) {
          throw new MediaError('InvalidInput', '字幕必须写入移动端导出暂存区');
        }
        await files().writeText(dest, result.content, { createParents: true, exclusive: true });
        return { path: dest, format: result.format, segments: result.segments, bytes: utf8ByteLength(result.content) };
      } catch (error) { return fail(error); }
    });
  ctx.commands.register<Commands['media_transcript_import']['args'], Commands['media_transcript_import']['result']>(
    'media_transcript_import', async ({ resourceId, path }) => {
      let staged: ReturnType<ReturnType<typeof mobileLocalRuntime>['vfs']['takeStagedUpload']> | undefined;
      try {
        let name = posix.basename(path);
        let bytes: Uint8Array;
        if (path.startsWith('dstu-staged:')) {
          staged = mobileLocalRuntime(ctx).vfs.takeStagedUpload(path.slice('dstu-staged:'.length));
          name = staged.name();
          bytes = staged.readBounded(MAX_SUBTITLE_BYTES);
        } else bytes = await files().readBytes(path, { maxBytes: MAX_SUBTITLE_BYTES });
        const conn = deps.vfsDatabase().getConnSafe();
        const repo = deps.vfsRepo();
        const info = loadMediaFile(conn, resourceId);
        const index = ctx.get('vfsIndex') as VfsIndexService | undefined;
        if (index?.pdf.isRunning(info.fileId)) throw new MediaError('InvalidInput', '请先停止当前转写任务再导入字幕');
        importSubtitle(conn, repo.mediaTranscripts, repo.files, info, name, bytes);
        if (info.resourceId !== null && index) void index.indexing.indexResource(info.resourceId).catch(error =>
          log.warn('字幕已导入，但索引更新失败: %s', String(error)));
        return buildTranscriptView(conn, repo.mediaTranscripts, info, false, true);
      } catch (error) { return fail(error); }
      finally { staged?.dispose(); }
    });
}
