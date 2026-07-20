import React from 'react';
import { cn } from '@/utils/cn';
import { ThreadContentShell } from './ThreadContentShell';

export interface ThreadEmptyStateShellProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title: React.ReactNode;
  /** 品牌/图标区，渲染在标题上方（如无会话空态的 Chat 图标） */
  brandIcon?: React.ReactNode;
  /** 标题下方的一句描述文案 */
  description?: React.ReactNode;
  /** CTA 区（按钮组），渲染在描述之后 */
  actions?: React.ReactNode;
  /** 底部辅助提示（如快捷键 hint），最弱视觉层级 */
  hint?: React.ReactNode;
  titleClassName?: string;
  contentClassName?: string;
}

/**
 * Shared empty-state shell for thread-aligned chat landing states.
 *
 * 统一空态内容模型（2026-07 设计基座）：品牌图标 → 标题 → 描述 → CTA → hint。
 * ChatV2Page 无会话空态与 MessageList 空会话空态共用此结构，桌面与移动一致。
 * 注意：空态刻意保持安静，不渲染建议 prompt chips（按产品决策已移除，勿加回）。
 * 所有插槽均可选，向后兼容旧的 title + children 用法。
 */
export const ThreadEmptyStateShell: React.FC<ThreadEmptyStateShellProps> = ({
  title,
  brandIcon,
  description,
  actions,
  hint,
  className,
  titleClassName,
  contentClassName,
  children,
  ...props
}) => {
  return (
    <ThreadContentShell className={cn('flex min-h-full items-center', className)}>
      <section
        data-slot="thread-empty-state"
        className={cn('flex w-full flex-col items-center justify-center gap-4 text-center', contentClassName)}
        {...props}
      >
        {brandIcon ? (
          <div
            aria-hidden="true"
            data-slot="thread-empty-brand"
            className="flex h-14 w-14 items-center justify-center rounded-[var(--radius-shell-panel)] border border-border/60 bg-card text-primary shadow-[var(--shadow-shell-soft)]"
          >
            {brandIcon}
          </div>
        ) : null}
        <h2
          data-slot="thread-empty-primary-action"
          className={cn('text-balance text-xl font-medium text-foreground', titleClassName)}
        >
          {title}
        </h2>
        {description ? (
          <p
            data-slot="thread-empty-description"
            className="mx-auto -mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground"
          >
            {description}
          </p>
        ) : null}
        {children}
        {actions ? (
          <div
            data-slot="thread-empty-actions"
            className="flex flex-wrap items-center justify-center gap-2"
          >
            {actions}
          </div>
        ) : null}
        {hint ? (
          <p data-slot="thread-empty-hint" className="text-xs text-muted-foreground/60">
            {hint}
          </p>
        ) : null}
      </section>
    </ThreadContentShell>
  );
};
