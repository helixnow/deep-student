import { AppError } from '../../../platform/errors/api.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import { cropSourceImage, type CropSourceImageRequest } from './crop-source-image.ts';
import * as qbankExport from './export-service.ts';
import { cropImageCodecOf, paperImageCodecOf } from './native-image.ts';
import { PaperExportExpiredError } from './paper-export-bridge.ts';
import { exportPaperDocx, type PaperBlockInput } from './paper-docx.ts';
import { inspectPdfText } from './pdf-inspection.ts';
import { QbankServiceError } from './question-service.ts';
import { serviceCall, serviceCallAsync, type QbankPluginDeps } from './plugin-deps.ts';

/** Document/portable/paper export, source image cropping and PDF text inspection. */
export function registerExport(deps: QbankPluginDeps): void {
  const { ctx, log, paperExports } = deps;
  ctx.commands.register<{ examId: string }>('qbank_export_document', ({ examId }) =>
    serviceCall(() => qbankExport.document(deps.exportHost(), examId)));
  ctx.commands.register<{ examId: string }>('qbank_export_portable', ({ examId }) =>
    serviceCall(() => qbankExport.portable(deps.exportHost(), examId)));
  ctx.commands.register<{ title: string; blocks: PaperBlockInput[] }>(
    'qbank_export_paper_docx', ({ title, blocks }) =>
      serviceCallAsync(() => exportPaperDocx(title, blocks, paperImageCodecOf(ctx))));
  ctx.commands.register<{ request: CropSourceImageRequest }>('qbank_crop_source_image',
    ({ request }) => serviceCallAsync(async () => {
      const repos = ctx.get('vfsRepo') as VfsReposService | undefined;
      if (repos === undefined) {
        throw new QbankServiceError(AppError.validation('VFS 数据库未初始化'));
      }
      return cropSourceImage({
        db: ctx.storage.database('vfs'),
        blobsDir: deps.blobsDir(),
        repos,
        nativeImage: cropImageCodecOf(ctx),
        files: (ctx.get('files') as FilesService | undefined) ?? null,
        log,
      }, request);
    }));

  ctx.commands.register<{ requestId: string; data?: string | null; error?: string | null }>(
    'qbank_complete_paper_export', ({ requestId, data, error }) => serviceCallAsync(async () => {
      try {
        return await paperExports.complete(deps.paperExportHost(), requestId, data ?? null, error ?? null);
      } catch (failure) {
        if (failure instanceof PaperExportExpiredError) {
          throw new QbankServiceError(AppError.validation(failure.message));
        }
        throw failure;
      }
    }));

  ctx.commands.register<{ request: { content: string } }>('inspect_pdf_text_for_qbank',
    ({ request }) => serviceCallAsync(async () => {
      const docs = ctx.get('docs');
      if (docs === undefined) throw new QbankServiceError(AppError.configuration('文档解析服务未提供'));
      try {
        const extracted = await docs.extractTextFromBase64('document.pdf', request.content);
        return inspectPdfText(extracted);
      } catch (failure) {
        if (failure instanceof QbankServiceError) throw failure;
        throw new QbankServiceError(AppError.validation(
          `文档解析失败: ${failure instanceof Error ? failure.message : String(failure)}`));
      }
    }));
}
