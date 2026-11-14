/**
 * APKG 导入结果类型与序列化（`dstu-anki/src/apkg_importer_service.rs:100-175`、
 * `src/cmd/apkg_import.rs:15-75`）。字段名与 serde `rename_all = "camelCase"` 一致。
 */
import type { ApkgImportResult as WireApkgImportResult } from '../../../../contracts/ipc/generated/L16-anki.ts';

/** `ApkgMediaSkip`。 */
export interface ApkgMediaSkip {
  reason: string;
  count: number;
  filenames: string[];
}

/** `ApkgMediaReport`。 */
export interface ApkgMediaReport {
  declared: number;
  imported: number;
  skipped: number;
  skips: ApkgMediaSkip[];
  mediaDir: string | null;
}

/** `ApkgReviewEnqueueReport`。 */
export interface ApkgReviewEnqueueReport {
  enqueued: number;
  withHistory: number;
  suspended: number;
}

/** `ApkgImportResult`（`card_ids` 不序列化）。 */
export interface ApkgImportResult {
  documentId: string;
  importedCards: number;
  importedTemplates: number;
  mediaSkipped: number;
  mediaImported: number;
  mediaReport: ApkgMediaReport;
  warnings: string[];
  cardIds: string[];
  reviewEnqueue: ApkgReviewEnqueueReport | null;
}

export function emptyApkgMediaReport(): ApkgMediaReport {
  return { declared: 0, imported: 0, skipped: 0, skips: [], mediaDir: null };
}

/** `ApkgMediaReport::is_empty`。 */
export function isApkgMediaReportEmpty(report: ApkgMediaReport): boolean {
  return report.declared === 0 && report.imported === 0 && report.skipped === 0 && report.skips.length === 0;
}

/** `serde_json::to_value(&ApkgImportResult)`（`card_ids` 被 `#[serde(skip)]` 丢弃）。 */
export function serializeApkgImportResult(result: ApkgImportResult): WireApkgImportResult {
  const value: WireApkgImportResult = {
    documentId: result.documentId,
    importedCards: result.importedCards,
    importedTemplates: result.importedTemplates,
    mediaSkipped: result.mediaSkipped,
    mediaImported: result.mediaImported,
  };
  if (!isApkgMediaReportEmpty(result.mediaReport)) {
    value.mediaReport = {
      declared: result.mediaReport.declared,
      imported: result.mediaReport.imported,
      skipped: result.mediaReport.skipped,
      ...(result.mediaReport.skips.length ? {
        skips: result.mediaReport.skips.map((skip) => ({
          reason: skip.reason,
          count: skip.count,
          ...(skip.filenames.length ? { filenames: [...skip.filenames] } : {}),
        })),
      } : {}),
      ...(result.mediaReport.mediaDir !== null ? { mediaDir: result.mediaReport.mediaDir } : {}),
    };
  }
  if (result.warnings.length) value.warnings = [...result.warnings];
  if (result.reviewEnqueue !== null) value.reviewEnqueue = { ...result.reviewEnqueue };
  return value;
}

/** `build_import_changed_payload`（`src/cmd/apkg_import.rs:61-68`）。 */
export function buildImportChangedPayload(result: ApkgImportResult): Record<string, unknown> {
  return {
    source: 'user',
    action: 'import',
    documentId: result.documentId,
    entityIds: [...result.cardIds],
  };
}
