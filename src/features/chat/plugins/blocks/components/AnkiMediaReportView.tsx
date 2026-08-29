/**
 * ChatAnki APKG 媒体导入报告展示。
 *
 * 生成进度/完成态下展示 mediaReport 的导入统计与逐原因跳过明细
 * （原因本地化 + 样例文件名）。全部媒体导入成功时收敛为一行摘要。
 * 无障碍：跳过警示用图标 + 文本传达，不只靠颜色。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { ImageSquare, Warning } from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { MEDIA_SKIP_REASON_KEYS, type AnkiMediaReport } from './ankiMediaReport';

export const AnkiMediaReportView: React.FC<{
  report: AnkiMediaReport;
  className?: string;
}> = ({ report, className }) => {
  const { t } = useTranslation('chatV2');
  const hasSkips = report.skipped > 0 || report.skips.length > 0;

  const resolveReasonLabel = (reason: string): string => {
    const keySuffix = MEDIA_SKIP_REASON_KEYS[reason];
    if (!keySuffix) return reason;
    return t(`blocks.ankiCards.progress.media.reasons.${keySuffix}`, { defaultValue: reason });
  };

  return (
    <div
      data-testid="chatanki-media-report"
      className={cn(
        'mt-1.5 rounded-md border px-2 py-1.5 text-xs leading-snug',
        hasSkips
          ? 'border-warning/40 bg-warning/5 text-warning'
          : 'border-border/60 bg-muted/20 text-muted-foreground',
        className,
      )}
    >
      <div className="flex items-start gap-1.5">
        {hasSkips ? (
          <Warning size={13} weight="fill" className="mt-0.5 flex-shrink-0" aria-hidden="true" />
        ) : (
          <ImageSquare size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
        )}
        <span data-testid="chatanki-media-report-summary">
          {t('blocks.ankiCards.progress.media.summary', {
            imported: report.imported,
            declared: report.declared,
            skipped: report.skipped,
          })}
        </span>
      </div>
      {report.skips.length > 0 && (
        <ul className="mt-1 space-y-0.5 pl-5" data-testid="chatanki-media-report-skips">
          {report.skips.map((skip, idx) => (
            <li key={`${skip.reason}-${idx}`} className="list-disc">
              <span data-testid={`chatanki-media-skip-${skip.reason}`}>
                {t('blocks.ankiCards.progress.media.skipReasonLine', {
                  reason: resolveReasonLabel(skip.reason),
                  count: skip.count,
                })}
              </span>
              {skip.filenames.length > 0 && (
                <span className="opacity-80">
                  {' '}
                  {t('blocks.ankiCards.progress.media.filenamesSample', {
                    names: skip.filenames.slice(0, 3).join(', '),
                  })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
