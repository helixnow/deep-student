import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Z_INDEX } from '@/config/zIndex';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { readCssDurationMs, useMotionPresence } from '@/hooks/useMotionPresence';

/**
 * 轻量 Tooltip（shadcn 兼容 API）。
 *
 * 2026-07 移动端审计 M-2 修复：
 * - 触屏：tap 会切换显示（纯提示元素），带自身点击行为的触发器 tap 不再
 *   sticky 打开 tooltip；外部 pointerdown / 滚动关闭；
 * - 键盘：focus/blur 可达（WCAG 1.4.13）；
 * - 层级：改用 Z_INDEX.tooltip（曾为 z-50，弹窗内不可见）；
 * - TooltipProvider 的 delayDuration 真正生效（曾被丢弃，所有 tooltip 零延迟）。
 *
 * 新代码优先考虑 `@/components/shared/CommonTooltip`（功能更全）。
 */

const DEFAULT_DELAY_MS = 500;

const TooltipDelayContext = React.createContext<number>(DEFAULT_DELAY_MS);

interface TooltipContextValue {
  open: boolean;
  setOpen: (value: boolean) => void;
  triggerRect: DOMRect | null;
  setTriggerRect: (rect: DOMRect | null) => void;
  triggerElRef: React.MutableRefObject<HTMLElement | null>;
  delayDuration: number;
}

const TooltipContext = React.createContext<TooltipContextValue | null>(null);

export const TooltipProvider: React.FC<{
  children: React.ReactNode;
  delayDuration?: number;
}>
  = ({ children, delayDuration = DEFAULT_DELAY_MS }) => (
    <TooltipDelayContext.Provider value={delayDuration}>{children}</TooltipDelayContext.Provider>
  );

export const Tooltip: React.FC<{ children: React.ReactNode }>
  = ({ children }) => {
    const [open, setOpen] = useState(false);
    const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
    const triggerElRef = React.useRef<HTMLElement | null>(null);
    const delayDuration = React.useContext(TooltipDelayContext);
    const value = React.useMemo(
      () => ({ open, setOpen, triggerRect, setTriggerRect, triggerElRef, delayDuration }),
      [open, triggerRect, delayDuration],
    );
    return (
      <TooltipContext.Provider value={value}>
        <span className="relative inline-flex">{children}</span>
      </TooltipContext.Provider>
    );
  };

export const TooltipTrigger: React.FC<React.HTMLAttributes<HTMLElement> & { asChild?: boolean }>
  = ({ children, asChild, onMouseEnter, onMouseLeave, onPointerDown, onClick, onFocus, onBlur, ...props }) => {
    const context = React.useContext(TooltipContext);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    // 触屏 tap 会合成 mouseenter/mouseleave，需要按 pointerType 分流
    const lastPointerTypeRef = React.useRef('');

    const clearTimer = React.useCallback(() => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }, []);
    React.useEffect(() => clearTimer, [clearTimer]);

    const show = React.useCallback((el: HTMLElement) => {
      if (!context) return;
      context.triggerElRef.current = el;
      context.setTriggerRect(el.getBoundingClientRect());
      context.setOpen(true);
    }, [context]);

    const hide = React.useCallback(() => {
      clearTimer();
      context?.setOpen(false);
      context?.setTriggerRect(null);
    }, [clearTimer, context]);

    // asChild 时子元素自身可能已有点击行为；触屏上此类触发器不做 tap 切换
    const childOwnProps = asChild && React.isValidElement(children)
      ? (children.props as React.HTMLAttributes<HTMLElement>)
      : undefined;
    const childHasOwnClick = typeof childOwnProps?.onClick === 'function';

    const handleMouseEnter = (event: React.MouseEvent<HTMLElement>) => {
      if (lastPointerTypeRef.current !== 'touch') {
        const el = event.currentTarget as HTMLElement;
        clearTimer();
        const delay = context?.delayDuration ?? DEFAULT_DELAY_MS;
        if (delay > 0) {
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            show(el);
          }, delay);
        } else {
          show(el);
        }
      }
      (onMouseEnter ?? childOwnProps?.onMouseEnter)?.(event);
    };
    const handleMouseLeave = (event: React.MouseEvent<HTMLElement>) => {
      if (lastPointerTypeRef.current !== 'touch') hide();
      (onMouseLeave ?? childOwnProps?.onMouseLeave)?.(event);
    };
    const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
      lastPointerTypeRef.current = event.pointerType;
      (onPointerDown ?? childOwnProps?.onPointerDown)?.(event);
    };
    const handleClick = (event: React.MouseEvent<HTMLElement>) => {
      if (lastPointerTypeRef.current === 'touch') {
        if (childHasOwnClick) {
          // 触发器有自身动作：tap 执行动作即可，别让 tooltip sticky 打开
          hide();
        } else if (context?.open) {
          hide();
        } else {
          show(event.currentTarget as HTMLElement);
        }
      }
      (onClick ?? childOwnProps?.onClick)?.(event);
    };
    const handleFocus = (event: React.FocusEvent<HTMLElement>) => {
      // 键盘可达性：仅 :focus-visible（键盘焦点）立即显示，不套用 hover 延迟。
      // 指针（触屏/鼠标）点按引发的 focus 不在此显示——否则触屏 tap 的
      // focus→click 序列会先 show 再被 handleClick 的 toggle 分支 hide，
      // 导致"点一下看提示"永远失效（M-2 残留缺陷）。
      const el = event.currentTarget as HTMLElement;
      let isKeyboardFocus = true;
      try {
        isKeyboardFocus = el.matches(':focus-visible');
      } catch {
        // 旧内核不支持 :focus-visible 选择器时退回"总是显示"
      }
      if (isKeyboardFocus) show(el);
      (onFocus ?? childOwnProps?.onFocus)?.(event);
    };
    const handleBlur = (event: React.FocusEvent<HTMLElement>) => {
      hide();
      (onBlur ?? childOwnProps?.onBlur)?.(event);
    };

    const handlers = {
      onMouseEnter: handleMouseEnter,
      onMouseLeave: handleMouseLeave,
      onPointerDown: handlePointerDown,
      onClick: handleClick,
      onFocus: handleFocus,
      onBlur: handleBlur,
    };

    if (asChild && React.isValidElement(children)) {
      return React.cloneElement(children, {
        ...props,
        ...handlers,
      } as any);
    }

    return (
      <span {...props} {...handlers}>
        {children}
      </span>
    );
  };

type TooltipSide = 'top' | 'bottom' | 'left' | 'right';
type TooltipAlign = 'start' | 'center' | 'end';

interface TooltipPosition {
  top: number;
  left: number;
  side: TooltipSide;
}

const VIEWPORT_PADDING = 8;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

interface TooltipContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: TooltipSide;
  align?: TooltipAlign;
  sideOffset?: number;
  alignOffset?: number;
}

// 基础样式 - 最小化，让用户传递的类可以完全覆盖
// ui-tooltip-in：ui-motion 入场（fade + scale 0.97 + 朝最终位置 2px 漂移，方向随 data-side）
const getBaseClasses = (exiting: boolean) => {
  return `rounded-md px-2 py-1.5 text-ui shadow-none border border-border/40 bg-[var(--tooltip-surface)] text-[var(--tooltip-foreground)] font-medium leading-none ${exiting ? 'ui-tooltip-out' : 'ui-tooltip-in'}`;
};

export const TooltipContent: React.FC<TooltipContentProps>
  = ({ children, className, side = 'top', align = 'center', sideOffset = 8, alignOffset = 0, style, ...props }) => {
    const context = React.useContext(TooltipContext);
    const contentRef = React.useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState<TooltipPosition | null>(null);
    const lastRectRef = React.useRef(context?.triggerRect ?? null);
    if (context?.triggerRect) lastRectRef.current = context.triggerRect;

    const presence = useMotionPresence(!!context?.open, {
      exitMs: readCssDurationMs('--dropdown-close-dur', 150),
      enter: 'animation',
    });

    const updatePosition = React.useCallback(() => {
      const rect = context?.triggerRect ?? lastRectRef.current;
      const content = contentRef.current;
      if (!rect || !content) return;

      const width = content.offsetWidth;
      const height = content.offsetHeight;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      let resolvedSide = side;
      let top: number;
      let left: number;

      if (side === 'top' || side === 'bottom') {
        const above = rect.top - height - sideOffset;
        const below = rect.bottom + sideOffset;
        const fitsAbove = above >= VIEWPORT_PADDING;
        const fitsBelow = below + height <= viewportHeight - VIEWPORT_PADDING;
        if (side === 'top') resolvedSide = fitsAbove || !fitsBelow ? 'top' : 'bottom';
        else resolvedSide = fitsBelow || !fitsAbove ? 'bottom' : 'top';
        top = resolvedSide === 'top' ? above : below;
        if (align === 'start') left = rect.left + alignOffset;
        else if (align === 'end') left = rect.right - width + alignOffset;
        else left = rect.left + rect.width / 2 - width / 2 + alignOffset;
      } else {
        const before = rect.left - width - sideOffset;
        const after = rect.right + sideOffset;
        const fitsBefore = before >= VIEWPORT_PADDING;
        const fitsAfter = after + width <= viewportWidth - VIEWPORT_PADDING;
        if (side === 'left') resolvedSide = fitsBefore || !fitsAfter ? 'left' : 'right';
        else resolvedSide = fitsAfter || !fitsBefore ? 'right' : 'left';
        left = resolvedSide === 'left' ? before : after;
        if (align === 'start') top = rect.top + alignOffset;
        else if (align === 'end') top = rect.bottom - height + alignOffset;
        else top = rect.top + rect.height / 2 - height / 2 + alignOffset;
      }

      const next = {
        top: clamp(top, VIEWPORT_PADDING, viewportHeight - height - VIEWPORT_PADDING),
        left: clamp(left, VIEWPORT_PADDING, viewportWidth - width - VIEWPORT_PADDING),
        side: resolvedSide,
      };
      setPosition((current) => (
        current?.top === next.top && current.left === next.left && current.side === next.side
          ? current
          : next
      ));
    }, [align, alignOffset, context?.triggerRect, side, sideOffset]);

    React.useLayoutEffect(() => {
      if (!presence.mounted) return;
      updatePosition();
    }, [presence.mounted, updatePosition]);

    const closeTooltip = React.useCallback(() => {
      context?.setOpen(false);
      context?.setTriggerRect(null);
    }, [context]);

    useEventRegistry(
      context?.open
        ? [
            { target: 'window', type: 'resize', listener: updatePosition as EventListener, options: { passive: true } },
            // triggerRect 在滚动后失效，诚实地关闭而非悬浮在旧位置（M-2）
            { target: 'window', type: 'scroll', listener: closeTooltip as EventListener, options: { capture: true, passive: true } },
            // 触屏：点按触发器以外的任意位置关闭（tooltip 自身 pointer-events: none）
            {
              target: 'window',
              type: 'pointerdown',
              listener: ((event: PointerEvent) => {
                const target = event.target as Node | null;
                if (target && context?.triggerElRef.current?.contains(target)) return;
                closeTooltip();
              }) as EventListener,
            },
          ]
        : [],
      [context?.open, updatePosition, closeTooltip],
    );

    if (!context || !presence.mounted || !lastRectRef.current) return null;

    const node = (
      <div
        ref={contentRef}
        className={className ? `${getBaseClasses(presence.exiting)} ${className}` : getBaseClasses(presence.exiting)}
        data-state={presence.exiting ? 'closed' : 'open'}
        role="tooltip"
        data-side={position?.side ?? side}
        style={{
          position: 'fixed',
          top: position?.top ?? -9999,
          left: position?.left ?? -9999,
          visibility: position ? 'visible' : 'hidden',
          pointerEvents: 'none',
          // 曾为 z-50：弹窗(3000)内使用时 tooltip 被盖住（M-2/H-2）
          zIndex: Z_INDEX.tooltip,
          ...(style ?? {}),
        }}
        {...props}
      >
        {children}
      </div>
    );

    return createPortal(node, document.body);
  };
