/**
 * TouchTarget — 触控目标扩区包装（Apple HIG 最小 44×44pt）。
 *
 * 两种模式：
 * - `mode="min-size"`（默认）：套用 .touch-target（responsive-utilities.css），
 *   仅在 coarse pointer 设备上强制 min 44×44，桌面精确指针不受影响；
 * - `mode="extend"`：视觉尺寸不变，用透明 ::before 伪元素在元素中心
 *   扩出 `extendTo`（默认 44px）见方的命中区，不占布局空间。
 *
 * ⚠️ extend 模式下命中区伪元素挂在组件根元素上，因此组件根元素必须
 * 自己就是交互元素——用 `as="button"` 并直接传 onClick / aria-*，
 * 事件 props 会透传；不要在里面再嵌套一个 button。
 *
 * 接入示例：
 * ```tsx
 * // 小图标按钮，视觉 24×24，命中区 44×44
 * <TouchTarget as="button" mode="extend" onClick={close} aria-label="关闭">
 *   <XIcon className="h-4 w-4" />
 * </TouchTarget>
 *
 * // 直接撑大到 44×44（coarse pointer 设备）
 * <TouchTarget as="button" onClick={submit}>确定</TouchTarget>
 * ```
 */

import React, { type ElementType, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface TouchTargetProps extends React.HTMLAttributes<HTMLElement> {
  /**
   * - 'min-size'：coarse pointer 下强制 min 44×44（.touch-target）
   * - 'extend'：保持视觉尺寸，::before 伪元素扩出命中区
   */
  mode?: 'min-size' | 'extend';
  /** extend 模式的命中区边长（px），默认 44。 */
  extendTo?: number;
  /** 渲染的元素标签；交互场景请传 'button' / 'a'，默认 'span'。 */
  as?: ElementType;
  className?: string;
  children: ReactNode;
}

export const TouchTarget: React.FC<TouchTargetProps> = ({
  mode = 'min-size',
  extendTo = 44,
  as: Component = 'span',
  className,
  children,
  style,
  ...rest
}) => {
  if (mode === 'extend') {
    return (
      <Component
        {...rest}
        className={cn(
          'relative inline-flex items-center justify-center',
          // 命中区伪元素：以元素中心为锚，至少 --touch-extend 见方；
          // 元素本身更大时取元素尺寸（max(100%, …)），透明不占布局
          'before:absolute before:left-1/2 before:top-1/2',
          'before:-translate-x-1/2 before:-translate-y-1/2',
          'before:h-[max(100%,var(--touch-extend))]',
          'before:w-[max(100%,var(--touch-extend))]',
          "before:content-['']",
          className,
        )}
        style={
          {
            ...style,
            '--touch-extend': `${extendTo}px`,
          } as React.CSSProperties
        }
      >
        {children}
      </Component>
    );
  }

  return (
    <Component
      {...rest}
      style={style}
      className={cn('touch-target inline-flex items-center justify-center', className)}
    >
      {children}
    </Component>
  );
};

export default TouchTarget;
