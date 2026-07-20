/**
 * MobileEmptyState — 移动端统一空态。
 *
 * 结构规范（视觉 token 全部消费现有体系）：
 * - 图标盘：56×56 圆盘（rounded-pill + bg-muted），图标 text-muted-foreground；
 * - 标题：18px（text-xl → --font-size-xl）foreground medium；
 * - 描述：14px（text-base → --font-size-base）muted-foreground，最多两三行；
 * - 单 CTA（可选）：primary 实底按钮，min-h 44（--control-height-touch），
 *   自带 .ui-press 按压反馈；
 * - 入场：.ui-slide-up-panel（motion token --m-sheet-*，reduced-motion 自动降级）。
 *
 * 接入示例：
 * ```tsx
 * <MobileEmptyState
 *   icon={<InboxIcon className="h-6 w-6" />}
 *   title="暂无笔记"
 *   description="从右下角新建你的第一篇笔记"
 *   action={{ label: '新建笔记', onClick: createNote }}
 * />
 * ```
 */

import React, { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface MobileEmptyStateAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface MobileEmptyStateProps {
  /** 图标节点（建议 24×24，颜色继承 muted-foreground）。 */
  icon?: ReactNode;
  /** 标题（18px）。 */
  title: string;
  /** 描述文案（14px muted，可选）。 */
  description?: ReactNode;
  /** 单个 CTA（可选；空态保持单一动作，多动作请回到页面层设计）。 */
  action?: MobileEmptyStateAction;
  /** 关闭入场动画（默认开启 .ui-slide-up-panel）。 */
  disableAnimation?: boolean;
  className?: string;
}

export const MobileEmptyState: React.FC<MobileEmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  disableAnimation = false,
  className,
}) => {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-10 text-center',
        !disableAnimation && 'ui-slide-up-panel',
        className,
      )}
    >
      {icon != null && (
        <span
          aria-hidden
          className="flex h-14 w-14 items-center justify-center rounded-pill bg-muted text-muted-foreground"
        >
          {icon}
        </span>
      )}

      <div className="flex max-w-[18rem] flex-col gap-1">
        <p className="text-xl font-medium text-foreground">{title}</p>
        {description != null && (
          <p className="text-base leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>

      {action && (
        <button
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
          className={cn(
            'ui-press mt-2 inline-flex min-h-[var(--control-height-touch,44px)] items-center justify-center',
            'rounded-control bg-primary px-5 text-base font-medium text-primary-foreground',
            'disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          {action.label}
        </button>
      )}
    </div>
  );
};

export default MobileEmptyState;
