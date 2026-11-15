/** Android Host reuses the media commands and binds browser/OPFS adapters for platform operations. */
import { CommandError, definePlugin } from '../../kernel/api.ts';
import { AppError } from '../../platform/errors/api.ts';
import { registerUnsupportedCommands } from '../../platform/errors/unsupported-commands.ts';
import type { JsonValue } from '../vfs-repos/api.ts';
import type { VfsReposService } from '../vfs-repos/api.ts';
import type { VfsDatabase } from '../vfs/api.ts';
import type { LLMManager } from '../llm/api.ts';
import type { LlmHttp } from '../llm/api.ts';
import { MediaError } from './src/errors.ts';
import { registerOcrSettingsCommands } from './src/register-ocr-settings.ts';
import { registerPortableMediaCommands } from './src/register-media-portable.ts';
import { registerMobileBilibili } from './src/register-mobile-bilibili.ts';
import { registerMobileTranscription } from './src/register-mobile-transcription.ts';
import { registerMobileTranscript } from './src/register-mobile-transcript.ts';
import { registerMobileDocuments } from './src/register-mobile-documents.ts';
import { registerMobileTextbooks } from './src/register-mobile-textbooks.ts';
import { registerVoiceInputCommand } from './src/register-voice-input.ts';
import type { AsrFetch, VoiceInputUsageRecorder } from './src/voice-input.ts';
import { recordVoiceInputUsage } from './src/voice-input.ts';
import { synthesizeDeepseek } from './src/deepseek-tts.ts';

/** 桌面 `index.ts` 声明的全部 L18 命令；移动端必须全部注册（ACL 表按 `meta.commands` 生成）。 */
const COMMANDS = [
  'tts_check_available', 'tts_deepseek', 'tts_speak', 'tts_stop', 'get_ocr_engine_type',
  'set_ocr_thinking_enabled', 'save_available_ocr_models',
  'get_ocr_thinking_enabled', 'get_ocr_engines', 'get_ocr_prompt_template',
  'infer_ocr_engine_from_model', 'validate_ocr_model', 'set_ocr_engine_type',
  'remove_ocr_engine', 'update_ocr_engine_priority', 'add_ocr_engine',
  'get_available_ocr_models', 'media_library_list', 'media_related_notes',
  'media_chapters', 'media_checkpoints', 'media_study_ledger',
  'media_progress_get', 'media_progress_set',
  'media_transcript_get', 'media_transcript_export', 'media_transcript_import',
  'media_transcribe_cancel', 'media_transcribe_estimate', 'media_transcribe_start',
  'textbooks_update_bookmarks', 'textbooks_relink', 'textbooks_add',
  'get_image_as_base64', 'convert_heic_to_jpeg', 'compress_image', 'get_recent_document_tasks',
  'test_pdfium_status',
  'cancel_pdf_ocr_session', 'pause_pdf_ocr_session', 'resume_pdf_ocr_session',
  'skip_pdf_ocr_page', 'get_pdf_ocr_temp_dir', 'save_pdf_to_temp',
  'vfs_get_file_blob_path',
  'media_bilibili_auth_status', 'media_bilibili_logout',
  'media_bilibili_login_qr_poll', 'media_bilibili_login_qr_start',
  'media_bilibili_cancel', 'media_bilibili_link_get',
  'media_bilibili_probe', 'media_bilibili_create',
  'media_bilibili_import_subtitle', 'media_bilibili_stream_quality',
  'media_bilibili_transport_status', 'media_bilibili_transport_configure',
  'media_bilibili_bridge_pair',
  'media_bilibili_bridge_approve', 'media_bilibili_bridge_disconnect',
  'voice_input_transcribe',
  'handout_cancel', 'handout_release', 'notes_export_docx', 'pin_images', 'unpin_images',
  'handout_llm_complete', 'handout_vlm_caption',
  'parse_document_from_path', 'parse_document_from_base64',
  'init_pdf_ocr_session', 'upload_pdf_ocr_page', 'process_pdf_ocr', 'start_pdf_ocr_backend',
  'test_ocr_engine',
] as const;

/** 移动端真实可用的命令（其余见 {@link UNSUPPORTED}）。 */
const PORTABLE = [
  'media_library_list', 'media_related_notes', 'media_progress_get', 'media_progress_set',
  'media_transcript_get', 'media_transcript_import', 'media_transcript_export', 'media_chapters', 'media_checkpoints', 'media_study_ledger',
  'textbooks_update_bookmarks', 'textbooks_add', 'textbooks_relink', 'vfs_get_file_blob_path', 'voice_input_transcribe',
  'tts_deepseek',
  'parse_document_from_path', 'parse_document_from_base64', 'test_pdfium_status', 'test_ocr_engine',
  'get_image_as_base64', 'compress_image', 'get_recent_document_tasks',
  'get_pdf_ocr_temp_dir', 'save_pdf_to_temp', 'init_pdf_ocr_session', 'upload_pdf_ocr_page',
  'start_pdf_ocr_backend', 'process_pdf_ocr', 'cancel_pdf_ocr_session', 'pause_pdf_ocr_session', 'resume_pdf_ocr_session',
  'handout_cancel', 'handout_release', 'notes_export_docx', 'pin_images', 'unpin_images',
  'handout_llm_complete', 'handout_vlm_caption',
  'media_transcribe_estimate', 'media_transcribe_start', 'media_transcribe_cancel',
  'media_bilibili_probe', 'media_bilibili_create', 'media_bilibili_import_subtitle', 'media_bilibili_link_get', 'media_bilibili_cancel',
  'media_bilibili_auth_status', 'media_bilibili_logout', 'media_bilibili_login_qr_start', 'media_bilibili_login_qr_poll',
  'get_ocr_engine_type', 'set_ocr_thinking_enabled', 'save_available_ocr_models',
  'get_ocr_thinking_enabled', 'get_ocr_engines', 'get_ocr_prompt_template',
  'infer_ocr_engine_from_model', 'validate_ocr_model', 'set_ocr_engine_type',
  'remove_ocr_engine', 'update_ocr_engine_priority', 'add_ocr_engine', 'get_available_ocr_models',
] as const;

const portableSet = new Set<string>(PORTABLE);

/** 移动端没有实现、按能力降级的命令。 */
const UNSUPPORTED = COMMANDS.filter(name => !portableSet.has(name));

export default definePlugin({
  meta: {
    id: 'dstu.media', lane: 'L18-media-docs', platforms: ['mobile'],
    provides: ['docs', 'mediaTranscriber'],
    commands: [...COMMANDS],
  },
  // 与桌面一致：设置、路径与 storage（`llm_usage` / `mistakes`）是硬依赖。
  inject: ['settings', 'paths', 'storage', 'crypto'],
  apply(ctx) {
    const vfsDatabase = (): VfsDatabase => {
      const database = ctx.get('vfsDatabase') as VfsDatabase | undefined;
      if (database === undefined) {
        // 与桌面 `createMediaPluginDeps.vfsDatabase` 同一错误形状（MediaError::Database）。
        throw new CommandError(new MediaError('Database', 'VFS database not configured').toPayloadString());
      }
      return database;
    };
    const vfsRepo = (): VfsReposService => {
      const repo = ctx.get('vfsRepo') as VfsReposService | undefined;
      if (repo === undefined) throw new CommandError(AppError.configuration('VFS repository service not configured'));
      return repo;
    };
    registerPortableMediaCommands(ctx, {
      vfsDatabase,
      vfsRepo,
      pdfService: () => (ctx.get('vfsIndex') as { pdf?: { isRunning(fileId: string): boolean } } | undefined)?.pdf,
    });
    registerMobileBilibili(ctx, { vfsDatabase, vfsRepo });
    registerMobileTranscript(ctx, { vfsDatabase, vfsRepo });
    const docs = registerMobileDocuments(ctx);
    registerMobileTextbooks(ctx, { vfsDatabase, vfsRepo }, docs);
    registerOcrSettingsCommands(ctx, { llm: () => (ctx.get('llm') as LLMManager | undefined) ?? null });
    // 语音输入：音频以 base64 随请求传入，ASR 走 `llmHttp`（移动端 `ctx.http` → 主线程 Capacitor HTTP），
    // 不需要 nativeAudio 解码。用量写 `llm_usage`（与桌面同一仓储）。
    const asrFetch: AsrFetch = async (input, init) => {
      const http = ctx.get('llmHttp') as LlmHttp | undefined;
      if (http === undefined) throw new CommandError(AppError.configuration('LLM HTTP 服务不可用（需要 llmHttp）'));
      return await http.fetch(input, init);
    };
    const recordVoiceUsage: VoiceInputUsageRecorder = usage => {
      try {
        recordVoiceInputUsage(ctx.storage.database('llm_usage'), usage);
      } catch (error) {
        // `UsageCollector::record` never propagates a database failure to the ASR command.
        ctx.logger('media.voice_input').warn(`记录语音输入用量失败: ${
          error instanceof Error ? error.message : String(error)}`);
      }
    };
    registerMobileTranscription(ctx, { vfsDatabase, vfsRepo, fetch: asrFetch, recordUsage: recordVoiceUsage });
    registerVoiceInputCommand(ctx, {
      llm: () => (ctx.get('llm') as LLMManager | undefined) ?? null,
      asrFetch,
      recordVoiceUsage,
    });
    ctx.commands.register<{text: string; voiceId?: string | null}, string>('tts_deepseek', ({ text, voiceId }) =>
      synthesizeDeepseek((ctx.get('llm') as LLMManager | undefined) ?? null, asrFetch, text, voiceId));
    // `vfs_get_file_blob_path`：移动端没有磁盘 blob（blobs 在 VFS 库里，不在 `blobsDir` 路径上），
    // 与 Rust「文件不存在」一致返回 null；前端的 pdfstream 预览回退到 base64 / 附件字节。
    ctx.commands.register('vfs_get_file_blob_path', () => null);
    // `textbooks_update_bookmarks`：纯 SQL（vfs 库），与桌面同一仓储。
    ctx.commands.register<{ id: string; bookmarks: unknown[] }, boolean>(
      'textbooks_update_bookmarks',
      ({ id, bookmarks }) => {
        try {
          vfsRepo().textbooks.updateBookmarks(vfsDatabase().getConnSafe(), id, bookmarks as JsonValue[]);
          return true;
        } catch (error) {
          throw new CommandError(AppError.database(
            `VFS 更新书签失败: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
    registerUnsupportedCommands(ctx, UNSUPPORTED);
  },
});

export { COMMANDS as MEDIA_COMMANDS, PORTABLE as MEDIA_PORTABLE_COMMANDS, UNSUPPORTED as MEDIA_UNSUPPORTED_COMMANDS };
