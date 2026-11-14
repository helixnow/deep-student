/** Command-facing wrapper for question_export_service/authoring.rs. */
import { AppError, CommandError } from '../../../platform/errors/api.ts';
import { QbankServiceError } from './question-service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { exportDocument, exportPortable, type PortableExport } from '../repository/export.ts';
import { importPortable, type ImportedPortable, type PortableAssetRepos } from '../repository/portable-import.ts';
import { ExportNotFound, ExportValidation } from '../repository/portable-shared.ts';
import type { PathFlavor } from '../repository/portable-zip.ts';

export interface ExportHost { readonly db: DatabaseHandle; readonly blobsDir: string }
export interface ImportHost extends ExportHost {
  readonly vfsRepo: PortableAssetRepos;
  /** `enclosed_name` 按宿主的 `Path::components` 判定；缺省按 POSIX。 */
  readonly platform?: PathFlavor;
}

function mapError(error: unknown): never {
  if (error instanceof ExportNotFound) throw new QbankServiceError(AppError.not_found(error.message));
  if (error instanceof ExportValidation) throw new QbankServiceError(AppError.validation(error.message));
  if (error instanceof QbankServiceError) throw error;
  // `document.validate()?` 的 AppError（validateDocument 以 CommandError 抛出）原样传播。
  if (error instanceof CommandError) throw new QbankServiceError(error.value);
  throw new QbankServiceError(AppError.database(error instanceof Error ? error.message : String(error)));
}

function invoke<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    return mapError(error);
  }
}

export function document(host: ExportHost, examId: string): unknown {
  return invoke(() => exportDocument(host.db, examId));
}

export function portable(host: ExportHost, examId: string): PortableExport {
  return invoke(() => exportPortable(host.db, host.blobsDir, examId));
}

export async function importPackage(host: ImportHost, encoded: string): Promise<ImportedPortable> {
  try {
    return await importPortable(host.db, host.blobsDir, host.vfsRepo, encoded, host.platform ?? 'linux');
  } catch (error) {
    return mapError(error);
  }
}
