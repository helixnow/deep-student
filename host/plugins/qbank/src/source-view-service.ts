/** Command wrappers for qbank_source_view.rs and qbank_get_source_images. */
import { AppError } from '../../../platform/errors/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { QbankServiceError } from './question-service.ts';
import {
  SourceViewNotFound, SourceViewValidation, getSourceImages, getSourcePage,
  type SourceImageInfo, type SourceImageFileSystem, type SourcePageView,
} from '../repository/source-view.ts';

export interface SourceViewHost {
  readonly db: DatabaseHandle;
  readonly blobsDir: string;
}

function mapError(error: unknown): never {
  if (error instanceof SourceViewNotFound) throw new QbankServiceError(AppError.not_found(error.message));
  if (error instanceof SourceViewValidation) throw new QbankServiceError(AppError.validation(error.message));
  if (error instanceof QbankServiceError) throw error;
  throw new QbankServiceError(AppError.database(error instanceof Error ? error.message : String(error)));
}

export function sourcePage(host: SourceViewHost, examId: string, sourceId: string,
  page: number | null): SourcePageView {
  try {
    return getSourcePage(host.db, examId, sourceId, page);
  } catch (error) {
    mapError(error);
  }
}

/** `files` 为 `ctx.files`；未装配时按配置错误报出（桌面与移动端 profile 都提供）。 */
export async function sourceImages(host: SourceViewHost, files: SourceImageFileSystem | null,
  examId: string): Promise<SourceImageInfo[]> {
  if (files === null) throw new QbankServiceError(AppError.configuration('文件服务不可用: files 未提供'));
  try {
    return await getSourceImages(host.db, host.blobsDir, files, examId);
  } catch (error) {
    mapError(error);
  }
}
