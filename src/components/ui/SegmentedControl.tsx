import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

import { cn } from '@/lib/utils';

/**
 * Single option inside a {@link SegmentedControl}.
 */
export interface SegmentedControlOption<T extends string> {
  value: T;
  label: React.ReactNode;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  ariaLabel: string;
  value: T;
  onValueChange: (value: T) => void;
  options: Array<SegmentedControlOption<T>>;
  size?: 'default' | 'compact';
  stretch?: boolean;
  className?: string;
  itemClassName?: string;
}

const rootClassNames = {
  default:
    'w-full max-w-full flex-wrap rounded-[var(--radius-shell-toolbar)] bg-[color:var(--surface-muted)] p-1 sm:w-auto sm:flex-nowrap',
  compact:
    'rounded-[var(--radius-shell-control)] bg-[color:var(--surface-muted)] p-[3px]',
} as const;

// [@media(pointer:coarse)]:!min-h-11：触屏统一 ≥44px 命中高度。必须带 important：
// app.css 的 .study-shell-segmented-button { min-height: 0 } 会压掉非 important
// 的同名工具类（min-height 与调用点的 !h-auto/!py-* 覆写正交，桌面 fine 指针不受影响）
const itemClassNames = {
  default:
    'h-9 rounded-[var(--radius-shell-control)] px-3.5 text-sm font-medium sm:px-4 [@media(pointer:coarse)]:!min-h-11',
  compact:
    'h-7 rounded-[calc(var(--radius-shell-control)-2px)] px-2.5 text-xs font-medium [@media(pointer:coarse)]:!min-h-11',
} as const;

function getNextEnabledIndex<T extends string>(
  options: Array<SegmentedControlOption<T>>,
  startIndex: number,
  direction: 1 | -1
) {
  if (!options.length) return -1;
  for (let step = 1; step <= options.length; step += 1) {
    const nextIndex = (startIndex + direction * step + options.length) % options.length;
    if (!options[nextIndex]?.disabled) return nextIndex;
  }
  return -1;
}

type RectLike = { left: number; top: number; width: number; height: number };

/**
 * 滑块相对根元素的几何（未变换的布局坐标）。
 *
 * getBoundingClientRect 量的是变换后的屏幕坐标：学习桌面窗口平铺 / 最大化动画期间
 * 祖先带 scale，量出来的宽度和位移都被缩放；动画结束后没有尺寸变化触发重测，滑块就停在
 * 错误位置（曾盖住导图工具栏的撤销 / 重做）。用根元素的布局尺寸把缩放换算回去。
 */
export function segmentedThumbGeometry(
  rootRect: RectLike,
  targetRect: RectLike,
  rootLayoutSize: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const sx = rootLayoutSize.width > 0 && rootRect.width > 0 ? rootRect.width / rootLayoutSize.width : 1;
  const sy = rootLayoutSize.height > 0 && rootRect.height > 0 ? rootRect.height / rootLayoutSize.height : 1;
  return {
    x: (targetRect.left - rootRect.left) / sx,
    y: (targetRect.top - rootRect.top) / sy,
    width: targetRect.width / sx,
    height: targetRect.height / sy,
  };
}

export function SegmentedControl<T extends string>({
  ariaLabel,
  value,
  onValueChange,
  options,
  size = 'default',
  stretch = false,
  className,
  itemClassName,
}: SegmentedControlProps<T>) {
  const prefersReducedMotion = useReducedMotion();
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const optionRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const selectedIndex = options.findIndex((o) => o.value === value && !o.disabled);
  const firstEnabledIndex = options.findIndex((o) => !o.disabled);
  const focusableIndex =
    selectedIndex >= 0
      ? selectedIndex
      : firstEnabledIndex >= 0
        ? firstEnabledIndex
        : options.length > 0
          ? 0
          : -1;

  // Measure thumb position relative to root's padding box using
  // getBoundingClientRect — immune to padding/border/scroll offset issues.
  const [thumbStyle, setThumbStyle] = React.useState<{
    x: number;
    y: number;
    width: number;
    height: number;
    ready: boolean;
  }>({ x: 0, y: 0, width: 0, height: 0, ready: false });

  const measure = React.useCallback(() => {
    const root = rootRef.current;
    const target = selectedIndex >= 0 ? optionRefs.current[selectedIndex] : null;
    if (!root || !target) {
      setThumbStyle((prev) => (prev.ready ? { ...prev, ready: false } : prev));
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const { x, y, width, height } = segmentedThumbGeometry(rootRect, targetRect, {
      width: root.offsetWidth,
      height: root.offsetHeight,
    });
    setThumbStyle((prev) => {
      if (prev.ready && prev.x === x && prev.y === y && prev.width === width && prev.height === height) return prev;
      return { x, y, width, height, ready: true };
    });
  }, [selectedIndex]);

  React.useLayoutEffect(() => {
    measure();
  }, [measure]);

  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(root);
    return () => ro.disconnect();
  }, [measure]);

  const selectIndex = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    optionRefs.current[index]?.focus();
    if (option.value !== value) onValueChange(option.value);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!options.length) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      const next = getNextEnabledIndex(options, index, 1);
      if (next >= 0) selectIndex(next);
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = getNextEnabledIndex(options, index, -1);
      if (next >= 0) selectIndex(next);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      if (firstEnabledIndex >= 0) selectIndex(firstEnabledIndex);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      const last = [...options]
        .map((o, i) => ({ o, i }))
        .reverse()
        .find(({ o }) => !o.disabled)?.i ?? -1;
      if (last >= 0) selectIndex(last);
    }
  };

  return (
    <div
      ref={rootRef}
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn('study-shell-segmented', rootClassNames[size], className)}
      data-size={size}
    >
      {/* Thumb — sibling of buttons, positioned absolutely in the root.
          Only translates on X axis; width/height jump instantly to the
          target button's dimensions. No width interpolation = no "expand"
          feeling. */}
      {thumbStyle.ready && (
        <motion.span
          aria-hidden="true"
          className="study-shell-segmented-thumb"
          animate={{ x: thumbStyle.x, y: thumbStyle.y, width: thumbStyle.width, height: thumbStyle.height }}
          transition={
            prefersReducedMotion
              ? { duration: 0 }
              : { x: { type: 'tween', duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }, y: { duration: 0 }, width: { duration: 0 }, height: { duration: 0 } }
          }
        />
      )}
      {options.map((option, index) => {
        const isSelected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => { optionRefs.current[index] = node; }}
            type="button"
            role="radio"
            title={option.title}
            aria-label={option.ariaLabel}
            aria-checked={isSelected}
            aria-disabled={option.disabled || undefined}
            data-selected={isSelected ? 'true' : 'false'}
            disabled={option.disabled}
            tabIndex={index === focusableIndex ? 0 : -1}
            onClick={() => selectIndex(index)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              'study-shell-segmented-button',
              itemClassNames[size],
              stretch && size === 'default' && 'flex-1 sm:flex-none',
              'text-foreground',
              itemClassName
            )}
          >
            <span className="study-shell-segmented-label">
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
