/**
 * ChatAnki APKG 媒体导入报告（tool_output.mediaReport）类型化解析。
 *
 * 后端契约（src-tauri/src/apkg_importer_service.rs，camelCase 序列化）：
 * `{ declared, imported, skipped, skips: [{reason, count, filenames}], mediaDir }`
 * 无媒体包时后端不序列化该字段，前端必须容忍缺失。
 */

export interface AnkiMediaSkip {
  reason: string;
  count: number;
  /** 后端只保留前几个样例文件名。 */
  filenames: string[];
}

export interface AnkiMediaReport {
  declared: number;
  imported: number;
  skipped: number;
  skips: AnkiMediaSkip[];
  mediaDir?: string;
}

/** 后端已知的跳过原因 → i18n key 后缀（未知原因回退展示原文）。 */
export const MEDIA_SKIP_REASON_KEYS: Record<string, string> = {
  media_import_disabled: 'mediaImportDisabled',
  manifest_unparsed: 'manifestUnparsed',
  media_dir_unavailable: 'mediaDirUnavailable',
  unsafe_filename: 'unsafeFilename',
  entry_missing: 'entryMissing',
  entry_oversized: 'entryOversized',
  io_error: 'ioError',
  orphan_entry: 'orphanEntry',
};

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/**
 * 从弱类型 tool_output 解析媒体报告。
 * 返回 null 表示没有可展示的报告（字段缺失或结构不符）。
 */
export function parseAnkiMediaReport(raw: unknown): AnkiMediaReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const declared = readCount(record.declared);
  const imported = readCount(record.imported);
  const skipped = readCount(record.skipped);

  const skips: AnkiMediaSkip[] = Array.isArray(record.skips)
    ? record.skips.flatMap((item): AnkiMediaSkip[] => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const skip = item as Record<string, unknown>;
        const reason = typeof skip.reason === 'string' ? skip.reason.trim() : '';
        if (!reason) return [];
        return [
          {
            reason,
            count: readCount(skip.count),
            filenames: Array.isArray(skip.filenames)
              ? skip.filenames.filter((name): name is string => typeof name === 'string')
              : [],
          },
        ];
      })
    : [];

  // 全零且无 skips：视为无信息量，不渲染
  if (declared === 0 && imported === 0 && skipped === 0 && skips.length === 0) {
    return null;
  }

  return {
    declared,
    imported,
    skipped,
    skips,
    mediaDir: typeof record.mediaDir === 'string' && record.mediaDir.trim()
      ? record.mediaDir
      : undefined,
  };
}
