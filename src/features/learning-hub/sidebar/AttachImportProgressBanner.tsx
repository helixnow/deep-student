import { CircleNotch } from '@phosphor-icons/react';
import type { SidebarT } from './sidebarConstants';

/** ★ 2026-06-12（审阅问题 FE-M5）：附件批量导入进度横幅（非模态，不阻塞操作） */
export function AttachImportProgressBanner({
  t,
  attachImportProgress,
}: {
  t: SidebarT;
  attachImportProgress: { done: number; total: number };
}) {
  return (
    <div
      data-wb-blur-surface
      className="absolute left-1/2 z-50 flex max-w-[calc(100%_-_1rem)] -translate-x-1/2 items-center gap-2.5 rounded-lg border bg-background/95 px-3.5 py-2 shadow-card-lg backdrop-blur-lg"
      style={{
        bottom: 'calc(3rem + var(--mobile-safe-area-bottom, env(safe-area-inset-bottom, 0px)))',
      }}
    >
      <CircleNotch className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />
      <span className="max-w-[60vw] truncate text-xs">
        {t('finder.dragDrop.importing', {
          done: attachImportProgress.done,
          total: attachImportProgress.total,
        })}
      </span>
      <div className="w-24 h-1 rounded-full bg-muted overflow-hidden shrink-0">
        <div
          className="h-full bg-primary transition-[width] duration-200"
          style={{ width: `${Math.round((attachImportProgress.done / Math.max(1, attachImportProgress.total)) * 100)}%` }}
        />
      </div>
    </div>
  );
}
