import type { Context } from '@deepseek-ai/cordis';
import type { Commands } from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import { CommandError } from '../../../kernel/api.ts';
import { fromBase64 } from '../../../platform/crypto/encoding.ts';
import { mobileLocalRuntime } from '../../../platform/files/mobile-local-runtime.ts';
import type { LLMManager } from '../../llm/api.ts';
import type { VfsIndexService } from '../../vfs-index/api.ts';
import { AsrConfigError } from './asr.ts';
import { HttpAsrBackend } from './asr-backend.ts';
import { MediaError } from './errors.ts';
import { buildTranscriptView, isLinkItem, linkOnlyError, loadMediaFile, toTranscriptStatusView,
  type MediaFileInfo } from './media-commands.ts';
import { transcribeResource } from './pipeline-core.ts';
import type { PortableMediaDeps } from './register-media-portable.ts';
import { defaultVadParams, planSegments, VadAnalyzer } from './vad.ts';
import { resolveAsrEndpoint, resolveSiliconflowKey, type AsrFetch, type VoiceInputUsageRecorder } from './voice-input.ts';

const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
const MAX_PCM_SAMPLES = 20 * 60 * 16_000;

export function registerMobileTranscription(ctx: Context, deps: Pick<PortableMediaDeps, 'vfsDatabase' | 'vfsRepo'> & {
  fetch: AsrFetch;
  recordUsage: VoiceInputUsageRecorder;
}): void {
  const { vfsDatabase, vfsRepo } = deps;
  const llm = () => (ctx.get('llm') as LLMManager | undefined) ?? null;
  const endpoint = async () => resolveAsrEndpoint(llm(), await resolveSiliconflowKey(ctx.settings));
  const pdf = () => (ctx.get('vfsIndex') as VfsIndexService | undefined)?.pdf;
  const asMediaError = (error: unknown, kind: 'Decode' | 'Database') => error instanceof MediaError ? error
    : error instanceof AsrConfigError ? new MediaError('AsrFatal', error.message, error.code)
      : new MediaError(kind, error instanceof Error ? error.message : String(error));
  const fail = (error: unknown): never => { throw new CommandError(asMediaError(error, 'Database').toPayloadString()); };

  async function decode(info: MediaFileInfo, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (isLinkItem(info)) throw linkOnlyError();
    if (info.size > MAX_MEDIA_BYTES) throw new MediaError('Unsupported', '移动端一次最多解码 32 MB 的媒体，请缩小文件或导入字幕');
    try {
      const db = vfsDatabase(), conn = db.getConnSafe();
      const source = vfsRepo().attachments.getContentSource(conn, db.blobsDir(), info.fileId);
      if (!source) throw new MediaError('NotFound', '找不到媒体文件内容');
      let bytes: Uint8Array;
      if (source.kind === 'file') bytes = await mobileLocalRuntime(ctx).vfs.readFileBounded(source.path, MAX_MEDIA_BYTES);
      else {
        const content = source.data.startsWith('data:') ? source.data.slice(source.data.indexOf(',') + 1) : source.data;
        if (content.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4) throw new MediaError('Unsupported', '媒体超过 32 MB');
        bytes = fromBase64(content);
      }
      if (bytes.length > MAX_MEDIA_BYTES) throw new MediaError('Unsupported', '媒体超过 32 MB');
      signal?.throwIfAborted();
      const { pcm } = await ctx.shell.request<{ pcm: Int16Array }>('mobile:decode-media', { bytes });
      signal?.throwIfAborted();
      if (!(pcm instanceof Int16Array) || pcm.length === 0 || pcm.length > MAX_PCM_SAMPLES) {
        throw new MediaError('Decode', '无法解码媒体或媒体超过 20 分钟');
      }
      const vad = new VadAnalyzer();
      for (let i = 0; i < pcm.length; i += 16_000) vad.push(pcm.subarray(i, i + 16_000));
      const durationMs = Math.floor(pcm.length / 16);
      const spans = planSegments(vad.finish(), defaultVadParams()).map(([startMs, endMs]) => ({ startMs, endMs }));
      return { durationMs, spans, corruptPackets: 0,
        spool: { durationMs: () => durationMs, readMs: (start: number, end: number) =>
          pcm.subarray(Math.max(0, Math.floor(start * 16)), Math.min(pcm.length, Math.floor(end * 16))), close() {} } };
    } catch (error) {
      if (signal?.aborted) throw new MediaError('Cancelled', '已取消转写');
      throw asMediaError(error, 'Decode');
    }
  }

  ctx.provide('mediaTranscriber', {
    async transcribe(request) {
      try {
        const signal = request.signal;
        const backend = request.imported
          ? { modelLabel: () => '', async transcribe(): Promise<never> { throw new Error('Imported captions do not use ASR'); } }
          : new HttpAsrBackend(await endpoint(), null, (input, init) => deps.fetch(input, {
            ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
          }), deps.recordUsage);
        return await transcribeResource({
          database: vfsDatabase(), repos: vfsRepo(), fileId: request.fileId, backend,
          signal, onProgress: request.onProgress, log: ctx.logger('media.transcription'),
          async decode(info, progress) { const decoded = await decode(info, signal); progress(1); return decoded; },
        });
      } catch (error) { throw asMediaError(error, 'Database'); }
    },
  });

  ctx.commands.register<Commands['media_transcribe_estimate']['args'], Commands['media_transcribe_estimate']['result']>(
    'media_transcribe_estimate', async ({ resourceId }) => {
      try {
        const db = vfsDatabase(), conn = db.getConnSafe(), repo = vfsRepo().mediaTranscripts;
        const info = loadMediaFile(conn, resourceId);
        let asrModel: string, asrConfigured: boolean;
        try { asrModel = (await endpoint()).model; asrConfigured = true; }
        catch (error) {
          if (!(error instanceof AsrConfigError)) throw error;
          asrModel = error.model; asrConfigured = false;
        }
        const counts = repo.counts(conn, info.fileId);
        if (counts.total > 0) return { asrModel, asrConfigured, exact: true, plannedSegments: counts.total,
          durationMs: repo.getProgress(conn, info.fileId)?.durationMs ?? null };
        const decoded = await decode(info);
        return { asrModel, asrConfigured, exact: true, plannedSegments: decoded.spans.length, durationMs: decoded.durationMs };
      } catch (error) { return fail(error); }
    });
  ctx.commands.register<Commands['media_transcribe_start']['args'], Commands['media_transcribe_start']['result']>(
    'media_transcribe_start', async ({ resourceId }) => {
      try {
        const conn = vfsDatabase().getConnSafe(), repo = vfsRepo().mediaTranscripts;
        const info = loadMediaFile(conn, resourceId), tasks = pdf();
        if (!tasks) throw new MediaError('Database', '媒体任务调度服务不可用');
        const current = buildTranscriptView(conn, repo, info, tasks.isRunning(info.fileId), false);
        if (current.status === 'completed' || tasks.isRunning(info.fileId)) return toTranscriptStatusView(current);
        if (current.progress.source !== 'import') {
          if (isLinkItem(info)) throw linkOnlyError();
          await endpoint();
        }
        await tasks.startPipeline(info.fileId, null);
        return toTranscriptStatusView(buildTranscriptView(conn, repo, info, tasks.isRunning(info.fileId), false));
      } catch (error) { return fail(error); }
    });
  ctx.commands.register<Commands['media_transcribe_cancel']['args'], Commands['media_transcribe_cancel']['result']>(
    'media_transcribe_cancel', ({ resourceId }) => {
      try {
        const conn = vfsDatabase().getConnSafe(), info = loadMediaFile(conn, resourceId);
        pdf()?.cancelMedia(info.fileId);
        return toTranscriptStatusView(buildTranscriptView(conn, vfsRepo().mediaTranscripts, info, false, false));
      } catch (error) { return fail(error); }
    });
}
