import { join } from '../../platform/util/path.ts';
import { definePlugin } from '../../kernel/api.ts';
import type {} from '../../platform/settings/api.ts';
import type { VfsDatabase } from '../vfs/api.ts';
import { HttpAsrBackend } from './src/asr-backend.ts';
import { createAutoTranscribeHook } from './src/auto-transcribe.ts';
import { ExamSheetSessionCordisService } from './src/exam-sheet-service.ts';
import { MediaTranscriberCordisService } from './src/media-transcriber.ts';
import { createMediaPluginDeps } from './src/plugin-deps.ts';
import { QuestionImportVisionCordisService } from './src/question-import-vision.ts';
import { registerBilibiliCommands } from './src/register-bilibili.ts';
import { registerFileCommands } from './src/register-files.ts';
import { registerHandoutCommands } from './src/register-handout.ts';
import { registerMediaCommands } from './src/register-media.ts';
import { registerOcrCommands } from './src/register-ocr.ts';
import { registerTextbookCommands } from './src/register-textbooks.ts';
import { registerMediaToolExecutors } from './src/register-tools.ts';
import { registerVoiceCommands } from './src/register-voice.ts';
import {
  DocsCordisService, MediaCordisService, OcrCordisService, PageRasterizerCordisService,
  createDocumentParser,
} from './src/service.ts';
import { resolveAsrEndpoint, resolveSiliconflowKey } from './src/voice-input.ts';

export default definePlugin({
  meta: {
    id: 'dstu.media', lane: 'L18-media-docs',
    provides: ['media', 'docs', 'ocr', 'examSheetSession', 'mediaTranscriber', 'pageRasterizer', 'questionImportVision'],
    commands: ['tts_check_available', 'tts_deepseek', 'tts_speak', 'tts_stop', 'get_ocr_engine_type',
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
      'test_ocr_engine'],
  },
  // WP-279: get_recent_document_tasks, ASR usage and voice usage all write through
  // ctx.storage.database(...) (mistakes / llm_usage), so storage is a hard dependency.
  inject: ['settings', 'paths', 'storage'],
  apply(ctx) {
    new MediaCordisService(ctx);
    const docs = new DocsCordisService(ctx);
    new PageRasterizerCordisService(ctx);
    // dstu-vision Stage 2–5 for L14 resume_question_import (legacy checkpoints).
    new QuestionImportVisionCordisService(ctx);
    const ocr = new OcrCordisService(ctx);
    const plugin = createMediaPluginDeps(ctx);
    new ExamSheetSessionCordisService(ctx, {
      db: () => plugin.vfsDatabase().getConnSafe(),
      exams: () => plugin.vfsRepo().exams,
      questions: () => plugin.vfsRepo().questions,
      nativeImage: plugin.nativeImage,
      encodePng: plugin.encodePng,
      imagesDir: () => join(ctx.paths.appDataDir, 'images'),
      log: ctx.logger('media.exam_sheet'),
    });
    new MediaTranscriberCordisService(ctx, {
      database: () => plugin.vfsDatabase(),
      repos: () => plugin.vfsRepo(),
      audio: () => plugin.nativeAudio(),
      backend: async () => {
        const endpoint = await resolveAsrEndpoint(
          plugin.llm(), await resolveSiliconflowKey(ctx.settings));
        return new HttpAsrBackend(endpoint, null, plugin.asrFetch, plugin.recordMediaAsrUsage);
      },
      refreshIndex: fileId => { plugin.refreshTranscriptIndexL13(fileId); },
      log: ctx.logger('media.commands'),
    });

    ctx.inject(['vfs'], child => {
      const hooks = child.vfs.resourceCreatedHooks;      if (hooks === undefined) return;
      const dispose = hooks.register(createAutoTranscribeHook({
        database: () => ctx.get('vfsDatabase') as VfsDatabase | undefined,
        repos: () => plugin.vfsRepo(),
        pipeline: () => plugin.pdfService(),
        services: () => plugin.llm() ?? undefined,
        audio: () => plugin.nativeAudio(),
        resolveAsr: async () => resolveAsrEndpoint(plugin.llm(), await resolveSiliconflowKey(ctx.settings)),
        log: ctx.logger('media.commands'),
      }));
      child.effect(() => dispose);
    });

    registerVoiceCommands(ctx, plugin);
    registerOcrCommands(ctx, { ocr, plugin });
    registerFileCommands(ctx, { docs, plugin });
    registerMediaCommands(ctx, plugin);
    registerTextbookCommands(ctx, { docs, plugin });
    registerBilibiliCommands(ctx, plugin);
    registerHandoutCommands(ctx);
    registerMediaToolExecutors(ctx, {
      parser: createDocumentParser(ctx), recordVoiceUsage: plugin.recordVoiceUsage, asrFetch: plugin.asrFetch,
    });
  },
});
