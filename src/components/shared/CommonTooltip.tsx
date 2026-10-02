import React from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  type TooltipSide,
  type TooltipTheme,
} from '@/components/ui/shad/Tooltip';

/**
 * CommonTooltip —— Tooltip 的过渡适配层（已废弃，勿在新代码使用）。
 *
 * 2026-10 组件统一：定位 / 延迟 / 动效 / 层级 / 无障碍的唯一实现是
 * `@/components/ui/shad/Tooltip`。本文件只做 props 形状的翻译，把旧的
 * `content` + `children` 配方映射到 `<Tooltip>` 三段式 API，
 * 以便 136 处存量调用点零改动地切到新实现。
 *
 * 新代码请直接写：
 * ```tsx
 * <Tooltip>
 *   <TooltipTrigger asChild><button>…</button></TooltipTrigger>
 *   <TooltipContent side="bottom" shortcut="⌘K">刷新</TooltipContent>
 * </Tooltip>
 * ```
 * 迁移完成前 ESLint 对存量文件放行（见 eslint-rules/common-tooltip.allowlist.json）。
 *
 * @deprecated 直接使用 `@/components/ui/shad/Tooltip`。
 */

export type TooltipPosition = TooltipSide;
export type { TooltipTheme };

export const DEFAULT_TOOLTIP_DELAY_MS = 500;

export interface CommonTooltipProps {
  /** 提示内容 */
  content: React.ReactNode;
  /** 气泡位置 */
  position?: TooltipPosition;
  /** 主题：dark=深色气泡、light=浅色气泡、auto=跟随系统 */
  theme?: TooltipTheme;
  /** 是否禁用 */
  disabled?: boolean;
  /** 偏移距离（px） */
  offset?: number;
  /** 是否显示箭头 */
  showArrow?: boolean;
  /** 延迟显示时间（ms），0为立即显示 */
  delay?: number;
  /** 最大宽度 */
  maxWidth?: number | string;
  /** 自定义className */
  className?: string;
  /** 快捷键角标：在提示文案右侧渲染 kbd 键位（如 "⌘K" 或 ["⌘", "K"]） */
  shortcut?: string | string[];
  /** 子元素 */
  children: React.ReactElement;
}

/**
 * @deprecated 使用 `@/components/ui/shad/Tooltip`。
 */
export const CommonTooltip: React.FC<CommonTooltipProps> = ({
  content,
  position = 'top',
  theme = 'auto',
  disabled = false,
  offset = 8,
  showArrow = true,
  delay = DEFAULT_TOOLTIP_DELAY_MS,
  maxWidth = 300,
  className = '',
  shortcut,
  children,
}) => (
  <Tooltip delayDuration={delay} disabled={disabled}>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent
      side={position}
      sideOffset={offset}
      theme={theme}
      arrow={showArrow}
      maxWidth={maxWidth}
      shortcut={shortcut}
      className={className || undefined}
    >
      {content}
    </TooltipContent>
  </Tooltip>
);

export default CommonTooltip;