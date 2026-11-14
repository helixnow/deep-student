/**
 * The plugin's observable surface — commands, protocols, services and tool
 * executors — is frozen here so splitting `apply()` into `src/register-*.ts`
 * modules cannot add, drop or rename anything.
 */
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { AgentToolExecutor } from '../../agent-skills/api.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';

const COMMANDS = [
  'add_ocr_engine', 'cancel_pdf_ocr_session', 'compress_image', 'convert_heic_to_jpeg',
  'get_available_ocr_models', 'get_image_as_base64', 'get_ocr_engine_type', 'get_ocr_engines',
  'get_ocr_prompt_template', 'get_ocr_thinking_enabled', 'get_pdf_ocr_temp_dir',
  'get_recent_document_tasks', 'handout_cancel', 'handout_llm_complete', 'handout_release',
  'handout_vlm_caption', 'infer_ocr_engine_from_model', 'init_pdf_ocr_session',
  'media_bilibili_auth_status', 'media_bilibili_bridge_approve', 'media_bilibili_bridge_disconnect',
  'media_bilibili_bridge_pair', 'media_bilibili_cancel', 'media_bilibili_create',
  'media_bilibili_import_subtitle', 'media_bilibili_link_get', 'media_bilibili_login_qr_poll',
  'media_bilibili_login_qr_start', 'media_bilibili_logout', 'media_bilibili_probe',
  'media_bilibili_stream_quality', 'media_bilibili_transport_configure',
  'media_bilibili_transport_status', 'media_chapters', 'media_checkpoints', 'media_library_list',
  'media_progress_get', 'media_progress_set', 'media_related_notes', 'media_study_ledger',
  'media_transcribe_cancel', 'media_transcribe_estimate', 'media_transcribe_start',
  'media_transcript_export', 'media_transcript_get', 'media_transcript_import', 'notes_export_docx',
  'parse_document_from_base64', 'parse_document_from_path', 'pause_pdf_ocr_session', 'pin_images',
  'process_pdf_ocr', 'remove_ocr_engine', 'resume_pdf_ocr_session', 'save_available_ocr_models',
  'save_pdf_to_temp', 'set_ocr_engine_type', 'set_ocr_thinking_enabled', 'skip_pdf_ocr_page',
  'start_pdf_ocr_backend', 'test_ocr_engine', 'test_pdfium_status', 'textbooks_add',
  'textbooks_relink', 'textbooks_update_bookmarks', 'tts_check_available', 'tts_deepseek', 'tts_speak', 'tts_stop',
  'unpin_images', 'update_ocr_engine_priority', 'upload_pdf_ocr_page', 'validate_ocr_model',
  'vfs_get_file_blob_path', 'voice_input_transcribe',
];

const SERVICES = [
  'media', 'docs', 'ocr', 'examSheetSession', 'mediaTranscriber', 'pageRasterizer', 'questionImportVision',
];

it('declares and registers exactly the frozen command set, protocol, services and executors', async () => {
  expect(COMMANDS).toHaveLength(75);
  expect([...(media.meta.commands ?? [])].sort()).toEqual(COMMANDS);
  expect(media.meta.provides).toEqual(SERVICES);
  expect(media.inject).toEqual(['settings', 'paths', 'storage']);

  const executors: string[] = [];
  const host = await createTestHost({
    plugins: [media],
    provide: {
      storage: unusedStorage(),
      settings: { get: () => null, save: () => undefined },
      paths: { appDataDir: process.cwd() },
      agentTools: {
        registerToolExecutors(list: readonly AgentToolExecutor[]) {
          executors.push(...list.map(executor => executor.name()));
          return { dispose: () => undefined };
        },
      },
    },
  });
  try {
    const entries = (host.ctx.commands as unknown as {
      _entries(): Array<{ name: string; kernel: boolean }>;
    })._entries().filter(entry => !entry.kernel).map(entry => entry.name).sort();
    expect(entries).toEqual(COMMANDS);
    for (const name of COMMANDS) expect(host.ctx.commands.has(name)).toBe(true);
    expect((host.ctx.protocols as unknown as { has(scheme: string): boolean }).has('bilistream')).toBe(true);
    for (const name of SERVICES) expect(host.ctx.get(name)).toBeDefined();
    expect(executors).toEqual([
      'MediaToolExecutor', 'OfficeFidelityExecutor', 'TextbookPdfToolExecutor', 'DocxToolExecutor',
      'PptxToolExecutor', 'XlsxToolExecutor', 'ImageGenerationExecutor', 'DocumentProcessingExecutor',
    ]);
  } finally {
    await host.dispose();
  }
});
