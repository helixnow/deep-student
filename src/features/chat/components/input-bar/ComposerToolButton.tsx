/**
 * ComposerToolButton - 输入栏工具按钮
 *
 * 收敛 InputBar 底部工具按钮（模型 / 生图 / 技能 / MCP / 对话控制）的视觉
 * 与交互。三态走 design token：
 *
 *   idle   : 透明底，--button-utility-foreground
 *   hover  : --button-utility-hover 底，--text-primary
 *   active : --button-primary-surface 底 + --button-primary-border 边框
 *            + --button-primary-foreground 图标（fill）
 *
 * 业界参考：ChatGPT / Linear / Cursor / Vercel composer 的 "tinted chip + filled
 * glyph" 范式，让被选中的工具有强一致的视觉信号。
 */
import * as React from 'react';
import type { Icon } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { CommonTooltip } from '@/components/shared/CommonTooltip';

export interface ComposerToolButtonProps {
  /** Phosphor 图标组件 */
  icon: Icon;
  /** 无障碍标签（默认也会作为 tooltip 内容） */
  label: string;
  /** 自定义 tooltip 内容；留空则使用 label */
  tooltipContent?: React.ReactNode;
  /** 高亮态 */
  active: boolean;
  onClick?: () => void;
  disabled?: boolean;
  /** 移动端等场景禁用 tooltip */
  tooltipDisabled?: boolean;
  /** 图标尺寸 */
  iconSize?: number;
  /** 右上角数字角标（>0 时显示） */
  badge?: number;
  /** 角标小圆点：'active' 走强调色，'loaded' 走中性色 */
  indicator?: 'active' | 'loaded' | null;
  /** aria-pressed，缺省取 active */
  ariaPressed?: boolean;
  className?: string;
  'data-testid'?: string;
}

export const ComposerToolButton: React.FC<ComposerToolButtonProps> = ({
  icon: IconComponent,
  label,
  tooltipContent,
  active,
  onClick,
  disabled,
  tooltipDisabled,
  iconSize = 18,
  badge,
  indicator,
  ariaPressed,
  className,
  'data-testid': dataTestId,
}) => {
  const showBadge = typeof badge === 'number' && badge > 0;
  const badgeText = showBadge ? (badge > 9 ? '9+' : String(badge)) : undefined;
  const isPressed = ariaPressed ?? active;

  const button = (
    <NotionButton
      data-testid={dataTestId}
      variant="ghost"
      size="icon"
      iconOnly
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={isPressed}
      className={cn(
        // 基础几何：与原 iconButtonClass 保持一致
        'relative inline-flex h-9 w-9 items-center justify-center',
        'rounded-[var(--radius-shell-control)] transition-colors',
        // 状态色：active 走 --button-primary-* 强调色 token（无边框）
        active
          ? [
              'bg-[color:var(--button-primary-surface)]',
              'text-[color:var(--button-primary-foreground)]',
              'hover:bg-[color:var(--button-primary-hover)]',
              'active:bg-[color:var(--button-primary-active)]',
            ]
          : [
              'text-[color:var(--button-utility-foreground)]',
              'hover:bg-[color:var(--button-utility-hover)] hover:text-[color:var(--text-primary)]',
              'active:bg-[color:var(--button-utility-active)]',
            ],
        className
      )}
    >
      <span className="relative inline-flex items-center justify-center">
        <IconComponent
          size={iconSize}
          weight={active ? 'fill' : 'regular'}
          aria-hidden="true"
        />
        {showBadge ? (
          <span
            className={cn(
              'absolute -right-2 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1',
              'border border-[color:var(--button-primary-border)]',
              'bg-[color:var(--button-primary-surface)]',
              'text-[10px] font-semibold text-[color:var(--button-primary-foreground)]',
              'shadow-sm'
            )}
            aria-hidden="true"
          >
            {badgeText}
          </span>
        ) : indicator === 'active' ? (
          <span
            className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-[color:var(--button-primary-foreground)]"
            aria-hidden="true"
          />
        ) : indicator === 'loaded' ? (
          <span
            className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[color:var(--text-secondary)]"
            aria-hidden="true"
          />
        ) : null}
      </span>
    </NotionButton>
  );

  return (
    <CommonTooltip
      content={tooltipContent ?? label}
      position="top"
      disabled={tooltipDisabled}
    >
      {button}
    </CommonTooltip>
  );
};

export default ComposerToolButton;
