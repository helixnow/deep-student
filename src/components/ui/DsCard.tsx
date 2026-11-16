import * as React from 'react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/shad/Card';

/** 卡片容器（`@deepstudent/ui` 公共 API）：主题边框、圆角与底色，默认带内边距。 */
export interface DsCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 去掉默认内边距（内容自己排版，如放一组 `DsListItem`）。 */
  flush?: boolean;
}

export const DsCard = React.forwardRef<HTMLDivElement, DsCardProps>(({ flush = false, className, ...props }, ref) => (
  <Card ref={ref} className={cn(!flush && 'p-4', className)} {...props} />
));
DsCard.displayName = 'DsCard';

/** 列表行（`@deepstudent/ui` 公共 API）：标题、说明、前后附加内容；给了 `onClick` 就可聚焦、可点击（Enter/空格），行内的按钮等交互元素不会触发它。 */
export interface DsListItemProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** 标题左侧（图标、序号）。 */
  leading?: React.ReactNode;
  /** 行尾（标签、按钮、数字）。 */
  trailing?: React.ReactNode;
  /** 行下方的补充内容（如公式、预览），在说明之后。 */
  children?: React.ReactNode;
  onClick?: () => void;
  selected?: boolean;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

/** 行内这些元素自己处理点击，不再触发整行的 onClick。 */
const INTERACTIVE = 'button, a[href], input, textarea, select, [role="button"]:not([data-ds-list-item])';

export function DsListItem({
  title, description, leading, trailing, children, onClick, selected = false, disabled = false, className, 'aria-label': ariaLabel,
}: DsListItemProps) {
  const body = (
    <>
      {leading !== undefined && <span className="flex shrink-0 items-center text-muted-foreground">{leading}</span>}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        {description !== undefined && <span className="text-xs text-muted-foreground">{description}</span>}
        {children}
      </span>
      {trailing !== undefined && <span className="flex shrink-0 items-center gap-2">{trailing}</span>}
    </>
  );
  const classes = cn(
    'flex w-full min-w-0 items-start gap-3 rounded-[var(--radius-card)] px-3 py-2.5 text-left transition-colors',
    selected && 'bg-muted',
    className,
  );
  if (!onClick) return <div className={classes} aria-label={ariaLabel}>{body}</div>;
  // 行内可以放任意内容（公式、标签、按钮），因此用 role="button" 的容器而不是 <button>（不能嵌套交互元素、高度随内容）。
  const activate = () => { if (!disabled) onClick(); };
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={selected || undefined}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      className={cn(classes, 'cursor-pointer hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', disabled && 'pointer-events-none opacity-50')}
      onClick={event => {
        const inner = (event.target as Element).closest(INTERACTIVE);
        if (!inner || !event.currentTarget.contains(inner)) activate();
      }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
      }}
      data-ds-list-item=""
    >
      {body}
    </div>
  );
}
