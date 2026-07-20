/**
 * ChatAnki 制卡块 — 小型展示组件集合
 *
 * - AnkiCardSkeleton：生成中骨架占位卡
 * - AnkiInlineUndoBar：单卡删除的内联撤销条（带倒计时进度线）
 * - AnkiCompletionSummary：完成态小结条（张数 / 用时 / 任务中心 / 导出）
 *
 * 全部为纯展示组件，文案与回调由调用方注入（i18n 在块内解析）。
 */

import React from 'react';
import {
  ArrowCounterClockwise,
  CheckCircle,
  CircleNotch,
  DownloadSimple,
  ListChecks,
} from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/utils/cn';
import './chat-anki-cards.css';

export const AnkiCardSkeleton: React.FC<{
  hint?: string;
  className?: string;
}> = ({ hint, className }) => (
  // 有 hint 文案时对读屏可见（role=status），只有装饰性 shimmer 时才整体 aria-hidden，
  // 避免 aria-hidden 容器内嵌可见 hint 的矛盾。
  <div
    className={cn(
      'canki-skeleton canki-card-enter rounded-lg border border-border/60 bg-card p-3',
      className,
    )}
    {...(hint ? { role: 'status' } : { 'aria-hidden': true })}
    data-testid="chatanki-card-skeleton"
  >
    <div className="canki-shimmer h-3.5 w-3/5 rounded" aria-hidden="true" />
    <div className="canki-shimmer mt-2 h-3 w-2/5 rounded" aria-hidden="true" />
    {hint ? <div className="mt-2 text-xs text-muted-foreground">{hint}</div> : null}
  </div>
);

export const AnkiInlineUndoBar: React.FC<{
  message: string;
  undoLabel: string;
  onUndo: () => void;
  durationMs: number;
}> = ({ message, undoLabel, onUndo, durationMs }) => (
  <div
    className="ui-drop-in relative mt-2 flex items-center justify-between gap-2 overflow-hidden rounded-lg border border-border/60 bg-muted/30 py-1 pl-3 pr-1.5"
    role="status"
    data-testid="chatanki-undo-bar"
  >
    <span className="min-w-0 truncate text-xs text-muted-foreground">{message}</span>
    <NotionButton
      type="button"
      size="sm"
      variant="ghost"
      onClick={onUndo}
      className="min-h-8 flex-shrink-0 text-xs"
    >
      <ArrowCounterClockwise size={13} />
      {undoLabel}
    </NotionButton>
    <div
      className="canki-undo-progress absolute inset-x-0 bottom-0 h-0.5 bg-primary/50"
      style={{ animationDuration: `${durationMs}ms` }}
      aria-hidden="true"
    />
  </div>
);

export const AnkiCompletionSummary: React.FC<{
  summaryText: string;
  durationText?: string | null;
  taskCenterLabel: string;
  onOpenTaskCenter: () => void;
  exportLabel: string;
  onExport: () => void;
  exportPending?: boolean;
}> = ({
  summaryText,
  durationText,
  taskCenterLabel,
  onOpenTaskCenter,
  exportLabel,
  onExport,
  exportPending,
}) => (
  <div
    className="ui-rise-in mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-success/25 bg-success/5 py-1.5 pl-3 pr-1.5"
    data-testid="chatanki-completion-summary"
  >
    <CheckCircle size={16} weight="fill" className="flex-shrink-0 text-success" />
    <span className="text-xs font-medium text-foreground">{summaryText}</span>
    {durationText ? (
      <span className="text-xs text-muted-foreground">{durationText}</span>
    ) : null}
    <span className="ml-auto flex flex-shrink-0 items-center gap-1">
      <NotionButton
        type="button"
        size="sm"
        variant="ghost"
        onClick={onOpenTaskCenter}
        className="min-h-8 text-xs"
      >
        <ListChecks size={13} />
        {taskCenterLabel}
      </NotionButton>
      <NotionButton
        type="button"
        size="sm"
        variant="ghost"
        onClick={onExport}
        disabled={exportPending}
        aria-busy={exportPending}
        className="min-h-8 text-xs"
      >
        {exportPending ? (
          <CircleNotch size={13} className="animate-spin" />
        ) : (
          <DownloadSimple size={13} />
        )}
        {exportLabel}
      </NotionButton>
    </span>
  </div>
);
