/**
 * Chat V2 - 检索块共享外壳组件
 *
 * 为 rag / memory / web_search / academic_search / multimodal_rag / insight_recall
 * 提供与 mcpTool / subagentEmbed / sleepBlock 一致的现代卡片外壳、头部微动画与折叠控制。
 */

import React from 'react';
import { cn } from '@/utils/cn';
import {
  CaretDown,
  CaretRight,
  CheckCircle,
  MagnifyingGlass,
  WarningCircle,
} from '@phosphor-icons/react';
import { TextShimmer } from '../../../components/ui/TextShimmer';
import { ToolActivitySweep } from '../../../components/ui/ToolActivitySweep';
import { formatToolDurationShort } from '@/features/chat/utils/toolDuration';

export interface RetrievalBlockShellProps {
  /** 块图标组件 */
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  /** 块标题 */
  title: string;
  /** 副标题/状态文本（进行中走 TextShimmer） */
  statusText?: string | null;
  /** 可选头部徽章（如来源/类型/披露级别） */
  badge?: React.ReactNode;
  /** 是否处于进行中状态（pending / running） */
  isActive: boolean;
  /** 是否处于错误状态 */
  isError: boolean;
  /** 是否处于成功状态 */
  isSuccess: boolean;
  /** 耗时（毫秒） */
  durationMs?: number;
  /** 当前是否有可折叠展开的内容 */
  collapsible?: boolean;
  /** 是否展开 */
  isExpanded?: boolean;
  /** 切换折叠状态回调 */
  onToggleExpand?: () => void;
  /** 展开区内容 */
  children?: React.ReactNode;
  /** 容器底部额外挂载（如编辑弹窗） */
  footer?: React.ReactNode;
  /** 自定义类名 */
  className?: string;
}

/**
 * RetrievalBlockShell - 检索类工具块统一外壳
 */
export const RetrievalBlockShell: React.FC<RetrievalBlockShellProps> = ({
  icon: Icon,
  title,
  statusText,
  badge,
  isActive,
  isError,
  isSuccess,
  durationMs,
  collapsible = false,
  isExpanded = true,
  onToggleExpand,
  children,
  footer,
  className,
}) => {
  const showBody = Boolean(children) && (!collapsible || isExpanded);

  const headerContent = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <ToolActivitySweep
          active={isActive}
          className="h-7 w-7 shrink-0 justify-center rounded-md bg-muted/70 dark:bg-muted/40"
        >
          <Icon size={16} className="text-muted-foreground" />
        </ToolActivitySweep>

        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <ToolActivitySweep active={isActive} className="min-w-0 max-w-full leading-4">
              <span className="block truncate text-xs font-medium leading-4 text-muted-foreground">
                {title}
              </span>
            </ToolActivitySweep>
            {badge}
          </div>

          {statusText && (
            isActive ? (
              <TextShimmer
                className="text-xs leading-4 text-muted-foreground"
                duration={1.5}
                spread={3}
              >
                {statusText}
              </TextShimmer>
            ) : (
              <span
                className={cn(
                  'truncate text-xs leading-4',
                  isError ? 'text-destructive' : 'text-muted-foreground'
                )}
              >
                {statusText}
              </span>
            )
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {durationMs !== undefined && (isSuccess || isError) && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatToolDurationShort(durationMs)}
          </span>
        )}
        {isSuccess && (
          <CheckCircle
            weight="fill"
            className="h-4 w-4 shrink-0 text-success"
            aria-hidden="true"
          />
        )}
        {isError && (
          <WarningCircle
            className="h-4 w-4 shrink-0 text-destructive"
            aria-hidden="true"
          />
        )}
        {collapsible && (
          isExpanded ? (
            <CaretDown size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <CaretRight size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          )
        )}
      </div>
    </>
  );

  return (
    <div
      className={cn(
        'rounded-lg border overflow-hidden bg-card dark:bg-card/80 transition-colors',
        isError ? 'border-destructive/30' : 'border-border/50',
        className
      )}
    >
      {collapsible && onToggleExpand ? (
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={isExpanded}
          className={cn(
            'flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left',
            'cursor-pointer transition-colors hover:bg-muted/20 [@media(pointer:coarse)]:min-h-11',
            showBody && 'border-b border-border/30'
          )}
        >
          {headerContent}
        </button>
      ) : (
        <div
          className={cn(
            'flex items-center justify-between gap-2 px-3 py-2.5',
            showBody && 'border-b border-border/30'
          )}
        >
          {headerContent}
        </div>
      )}

      {showBody && (
        <div className="p-3 space-y-2.5">
          {children}
        </div>
      )}

      {footer}
    </div>
  );
};

/** 检索查询词展示行 */
export const RetrievalQueryRow: React.FC<{ query: string }> = ({ query }) => (
  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
    <MagnifyingGlass size={14} className="shrink-0" aria-hidden="true" />
    <span className="truncate" title={query}>
      {query}
    </span>
  </div>
);

/** 检索错误提示条 */
export const RetrievalErrorNotice: React.FC<{ message: string }> = ({ message }) => (
  <div
    className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
    role="alert"
  >
    <WarningCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
    <span className="min-w-0 break-words">{message}</span>
  </div>
);
