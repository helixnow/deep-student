/** PDF OCR sessions and the OCR engine probe (`src/commands.rs:726-871`); settings commands live in
 * `register-ocr-settings.ts` (portable, shared with the mobile entry). */
import { join } from '../../../platform/util/path.ts';
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { NativeImage } from '../../../platform/native/image/api.ts';
import type { NativePdfium } from '../../../platform/native/pdfium/api.ts';
import type { FileManagerPathsService } from '../../../platform/storage/api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import type { LlmOcrPages } from '../../llm/api.ts';
import { testOcrEngine } from './ocr-engine-test.ts';
import {
  LLM_OCR_PAGES_SERVICE, PdfOcrService, type PdfOcrModelsPort, type PdfOcrSession,
} from './pdf-ocr-service.ts';
import { getPdfOcrTempDir, savePdfToTemp } from './pdf-ocr-sessions.ts';
import type { MediaPluginDeps } from './plugin-deps.ts';
import { registerOcrSettingsCommands } from './register-ocr-settings.ts';
import type { OcrCordisService } from './service.ts';

export { registerOcrSettingsCommands } from './register-ocr-settings.ts';

export interface OcrCommandDeps {
  ocr: OcrCordisService;
  plugin: MediaPluginDeps;
}

export function registerOcrCommands(ctx: Context, deps: OcrCommandDeps): void {
  registerOcrSettingsCommands(ctx, { llm: () => deps.plugin.llm() });
  registerPdfOcrCommands(ctx, deps);
}


/** src/commands.rs:786-871: one `AppState` map set, shared with the `ocr` service. */
export function registerPdfOcrCommands(ctx: Context, { ocr }: OcrCommandDeps): void {
  ctx.commands.register<Commands['cancel_pdf_ocr_session']['args'], boolean>('cancel_pdf_ocr_session',
    ({ sessionId }) => ocr.cancelSession(sessionId));
  ctx.commands.register<Commands['pause_pdf_ocr_session']['args'], boolean>('pause_pdf_ocr_session',
    ({ sessionId }) => ocr.pauseSession(sessionId));
  ctx.commands.register<Commands['resume_pdf_ocr_session']['args'], boolean>('resume_pdf_ocr_session',
    ({ sessionId }) => ocr.resumeSession(sessionId));
  ctx.commands.register<Commands['skip_pdf_ocr_page']['args'], boolean>('skip_pdf_ocr_page',
    ({ sessionId, pageIndex }) => ocr.skipPage(sessionId, pageIndex));
  // src/commands.rs:726-871 + dstu-vision pdf_ocr_service.rs; page OCR via L02 llmOcrPages.
  const pdfOcrSessions = new Map<string, PdfOcrSession>();
  const pdfOcr = new PdfOcrService({
    appDataDir: () => ctx.paths.appDataDir,
    imagesDir: () => join(ctx.paths.appDataDir, 'images'),
    ocrModels: () => ctx.get('llmOcrModels') as PdfOcrModelsPort | undefined,
    ocrPages: () => ctx.get(LLM_OCR_PAGES_SERVICE) as LlmOcrPages | undefined,
    pdfium: () => ctx.get('nativePdfium') as NativePdfium | undefined,
    image: () => ctx.get('nativeImage') as NativeImage | undefined,
    emit: (payload) => ctx.backendEvents.emit('pdf_ocr_progress', payload),
    log: ctx.logger('media.pdf_ocr'),
  });
  ctx.commands.register<Commands['init_pdf_ocr_session']['args'], string>('init_pdf_ocr_session',
    async ({ pdfName, pdfBase64, totalPages }) => {
      const [sessionId, session] = await pdfOcr.startSession(pdfBase64, pdfName ?? null, totalPages);
      pdfOcrSessions.set(sessionId, session);
      return sessionId;
    });
  ctx.commands.register<Commands['upload_pdf_ocr_page']['args'], null>('upload_pdf_ocr_page',
    async ({ sessionId, page }) => {
      const session = pdfOcrSessions.get(sessionId);
      if (session === undefined) throw new CommandError(AppError.new('NotFound', `Session ${sessionId} not found`));
      await pdfOcr.addPage(session.pageTx, sessionId, page);
      return null;
    });
  ctx.commands.register<Commands['process_pdf_ocr']['args'], Commands['process_pdf_ocr']['result']>('process_pdf_ocr',
    ({ request }) => pdfOcr.processPdf(request));
  ctx.commands.register<Commands['start_pdf_ocr_backend']['args'], string>('start_pdf_ocr_backend',
    async ({ pdfPath, pdfName, renderDpi }) => {
      const [sessionId, cancelTx, pauseTx] = await pdfOcr.startBackendSession(
        pdfPath, pdfName ?? null, renderDpi ?? null);
      ocr.state.cancellations.set(sessionId, cancelTx);
      ocr.state.pauses.set(sessionId, pauseTx);
      return sessionId;
    });
  ctx.commands.register<Commands['test_ocr_engine']['args'], Commands['test_ocr_engine']['result']>('test_ocr_engine',
    ({ request }) => testOcrEngine({
      settings: ctx.settings,
      appDataDir: () => ctx.paths.appDataDir,
      ocrPages: () => ctx.get(LLM_OCR_PAGES_SERVICE) as LlmOcrPages | undefined,
      platform: ctx.app.platform,
    }, request));
  // commands.rs:876-900: `file_manager.get_writable_app_data_dir()` (active slot, then the temp fallback chain).
  const tempAppDataDir = (): string => {
    const paths = ctx.get('fileManagerPaths') as Pick<FileManagerPathsService, 'getTempAppDataDir'> | undefined;
    if (paths === undefined) throw new CommandError(AppError.configuration('PDF OCR 临时目录需要 F3 fileManagerPaths 服务'));
    return paths.getTempAppDataDir();
  };
  ctx.commands.register('get_pdf_ocr_temp_dir', () => getPdfOcrTempDir(tempAppDataDir()));
  ctx.commands.register<Commands['save_pdf_to_temp']['args'], string>('save_pdf_to_temp',
    ({ pdfBase64, fileName }) => savePdfToTemp(tempAppDataDir(), pdfBase64, fileName));
}
