/**
 * QuickChip — 详情面板内联快捷选择 chip（日期/提醒/标签建议等共用）
 *
 * - 选中态走 primary token；未选中态 surface-muted + hover interactive-hover
 * - 按压 0.97 缩放微反馈（motion-reduce 下禁用）
 * - coarse 指针下保证 ≥44px 触控高度
 */

import React from 'react';
import { cn } from '@/lib/utils';

export const QuickChip: React.FC<{
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  icon?: React.ReactNode;
  className?: string;
  /** 建议列表等场景需要 mousedown 拦截（避免触发输入框 blur 提交竞态） */
  onMouseDown?: (e: React.MouseEvent) => void;
}> = ({ active = false, onClick, children, title, icon, className, onMouseDown }) => (
  <button
    type="button"
    title={title}
    aria-pressed={active}
    onClick={onClick}
    onMouseDown={onMouseDown}
    className={cn(
      'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
      'transition-[background-color,color,transform] duration-150 motion-reduce:transition-none',
      'active:scale-[0.97] motion-reduce:active:scale-100',
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:hsl(var(--primary))]',
      '[@media(pointer:coarse)]:min-h-[2.75rem] [@media(pointer:coarse)]:px-3.5',
      active
        ? 'bg-primary text-primary-foreground'
        : 'bg-[color:var(--surface-muted)] text-muted-foreground hover:bg-[color:var(--interactive-hover)] hover:text-foreground',
      className,
    )}
  >
    {icon}
    {children}
  </button>
);

export default QuickChip;
