import React, { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Z_INDEX } from '@/config/zIndex';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { readCssDurationMs, useMotionPresence } from '@/hooks/useMotionPresence';
import { useOverlayCoordinator } from '../../shared/OverlayCoordinator';
import './Tooltip.css';

/**
 * 统一 Tooltip 实现（shadcn 兼容 API）。
 *
 * 2026-10 组件统一：CommonTooltip 已并入本文件，二者共用同一套
 * 定位 / 延迟 / 动效 / 层级 / 无障碍逻辑。
 * - `Tooltip` 只提供 context，不再包 `<span class="relative inline-flex">`：
 *   气泡走 `position: fixed` + portal 定位，包裹层既无用又会打乱调用点的
 *   flex / grid 排布（工具栏密集布局尤其明显）。
 * - 保留 2026-07 移动端审计 M-2 修复：触屏 tap 切换、键盘 focus 可见、
 *   层级用 Z_INDEX.tooltip、Provider 的 delayDuration 真正生效。
 * - 滚动改为跟随重定位（与 Popover / 菜单一致，也和旧的 CommonTooltip 一致），
 *   需要"滚动即关"时传 `closeOnScroll`。
 *
 * @example
 * ```tsx
 * <Tooltip>
 *   <TooltipTrigger asChild><DsButton iconOnly aria-label="刷新" /></TooltipTrigger>
 *   <TooltipContent side="bottom" shortcut="⌘R">刷新</TooltipContent>
 * </Tooltip>
 * ```
 */

const DEFAULT_DELAY_MS = 500;

const TooltipDelayContext = React.createContext<number>(DEFAULT_DELAY_MS);

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';
export type TooltipAlign = 'start' | 'center' | 'end';
export type TooltipTheme = 'dark' | 'light' | 'auto';

export const TooltipProvider: React.FC<{
  children: React.ReactNode;
  delayDuration?: number;
}>
  = ({ children, delayDuration = DEFAULT_DELAY_MS }) => (
    <TooltipDelayContext.Provider value={delayDuration}>{children}</TooltipDelayContext.Provider>
  );

interface TooltipContextValue {
  open: boolean;
  setOpen: (value: boolean) => void;
  /** 主动收起（Escape / 浮层打开 / 触发器激活时由内容与触发器共用）。 */
  dismiss: () => void;
  triggerRect: DOMRect | null;
  setTriggerRect: (rect: DOMRect | null) => void;
  triggerElRef: React.MutableRefObject<HTMLElement | null>;
  delayDuration: number;
  /** 气泡 id：触发器用它写 aria-describedby。 */
  contentId: string;
}

const TooltipContext = React.createContext<TooltipContextValue | null>(null);

export interface TooltipProps {
  children: React.ReactNode;
  /** 单例覆盖 Provider 的 delayDuration。 */
  delayDuration?: number;
  /** 整体关闭提示（菜单展开等场景可由调用方显式关掉）。 */
  disabled?: boolean;
}

export const Tooltip: React.FC<TooltipProps>
  = ({ children, delayDuration, disabled = false }) => {
    const [open, setOpenState] = useState(false);
    const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
    const triggerElRef = useRef<HTMLElement | null>(null);
    const inheritedDelay = useContext(TooltipDelayContext);
    const resolvedDelay = delayDuration ?? inheritedDelay;
    const contentId = useId();
    const { tooltipsSuppressed, tooltipDismissVersion } = useOverlayCoordinator();

    const setOpen = useCallback((value: boolean) => {
      setOpenState(value);
      if (!value) setTriggerRect(null);
    }, []);

    const dismiss = useCallback(() => {
      setOpenState(false);
      setTriggerRect(null);
    }, []);

    // 交互浮层（AppMenu / Popover）打开时抑制提示，并在抑制期间拒绝打开：
    // 提示盖在菜单上方既挡视线也抢层级。
    useEffect(() => {
      if (tooltipsSuppressed) dismiss();
    }, [dismiss, tooltipsSuppressed]);

    // 响应浮层侧的主动收起（AppMenu / Popover 打开会 bump dismissTooltips）。
    // 这里只消费不回调：调用 dismissTooltips 会再次 bump version，形成死循环。
    useEffect(() => {
      dismiss();
    }, [dismiss, tooltipDismissVersion]);

    const effectiveOpen = open && !disabled && !tooltipsSuppressed;

    const value = useMemo(
      () => ({
        open: effectiveOpen,
        setOpen,
        dismiss,
        triggerRect,
        setTriggerRect,
        triggerElRef,
        delayDuration: resolvedDelay,
        contentId,
      }),
      [contentId, dismiss, effectiveOpen, resolvedDelay, setOpen, triggerRect],
    );
    return <TooltipContext.Provider value={value}>{children}</TooltipContext.Provider>;
  };

export interface TooltipTriggerProps extends React.HTMLAttributes<HTMLElement> {
  asChild?: boolean;
}

export const TooltipTrigger: React.FC<TooltipTriggerProps>
  = ({ children, asChild, onMouseEnter, onMouseLeave, onPointerDown, onClick, onFocus, onBlur, ...props }) => {
    const context = useContext(TooltipContext);
    const { dismissTooltips } = useOverlayCoordinator();
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 触屏 tap 会合成 mouseenter/mouseleave，需要按 pointerType 分流
    const lastPointerTypeRef = useRef('');

    const clearTimer = useCallback(() => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }, []);
    useEffect(() => clearTimer, [clearTimer]);

    const show = useCallback((el: HTMLElement) => {
      if (!context) return;
      context.triggerElRef.current = el;
      context.setTriggerRect(el.getBoundingClientRect());
      context.setOpen(true);
    }, [context]);

    const hide = useCallback(() => {
      clearTimer();
      context?.setOpen(false);
    }, [clearTimer, context]);

    // asChild 时子元素自身可能已有点击行为；触屏上此类触发器不做 tap 切换
    const childOwnProps = asChild && React.isValidElement(children)
      ? (children.props as React.HTMLAttributes<HTMLElement>)
      : undefined;
    const childHasOwnClick = typeof childOwnProps?.onClick === 'function';

    // 触发器被激活（按下 / 键盘确认）时立刻收起提示：气泡是指路用的，
    // 用户已经动手就不该继续挂在操作目标上。同时广播关闭，清掉别处的提示。
    const activate = useCallback(() => {
      context?.dismiss();
      dismissTooltips();
    }, [context, dismissTooltips]);

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
      // 触屏点击纯提示元素时不立即关闭（交由 click 切换显示）
      if (!(event.pointerType === 'touch' && !childHasOwnClick)) {
        activate();
      }
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
      // 键盘激活（按钮 Enter/Space、菜单 ArrowDown）同样视为"已经动手"。
      if (event.detail === 0) activate();
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
        'aria-describedby': context?.open ? context.contentId : undefined,
      } as any);
    }

    return (
      <span
        {...props}
        {...handlers}
        aria-describedby={context?.open ? context.contentId : undefined}
      >
        {children}
      </span>
    );
  };

interface TooltipPosition {
  top: number;
  left: number;
  side: TooltipSide;
}

const VIEWPORT_PADDING = 8;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

export interface TooltipContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: TooltipSide;
  align?: TooltipAlign;
  sideOffset?: number;
  alignOffset?: number;
  /** 快捷键角标：在文案右侧渲染 kbd 键位（如 "⌘K" 或 ["⌘", "K"]）。 */
  shortcut?: string | string[];
  /** 箭头朝向气泡外侧；默认显示。 */
  arrow?: boolean;
  /** 气泡主题；默认与 shad 气泡同源的 dark（反色）外观。 */
  theme?: TooltipTheme;
  /** 最大宽度（px 或任意 CSS 长度）。 */
  maxWidth?: number | string;
  /** 滚动时直接关闭，而不是跟随重定位。 */
  closeOnScroll?: boolean;
}

// 着色 / 圆角 / 字号走 utility，动效走 ui-motion 的 data-side 感知类。
// ds-tooltip-* 结构层见同目录 Tooltip.css。
const getBaseClasses = (exiting: boolean) =>
  `ds-tooltip rounded-md border border-border/40 font-medium leading-none text-ui shadow-none ui-tooltip-${
    exiting ? 'out' : 'in'
  }`;

export const TooltipContent: React.FC<TooltipContentProps>
  = ({
    children,
    className,
    side = 'top',
    align = 'center',
    sideOffset = 8,
    alignOffset = 0,
    shortcut,
    arrow = true,
    theme = 'dark',
    maxWidth,
    closeOnScroll = false,
    style,
    ...props
  }) => {
    const context = useContext(TooltipContext);
    const contentRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState<TooltipPosition | null>(null);
    const lastRectRef = useRef(context?.triggerRect ?? null);
    if (context?.triggerRect) lastRectRef.current = context.triggerRect;

    const presence = useMotionPresence(!!context?.open, {
      exitMs: readCssDurationMs('--dropdown-close-dur', 150),
      enter: 'animation',
    });

    const updatePosition = useCallback(() => {
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

    // 在浏览器绘制前定位，避免气泡先闪现在 (-9999, -9999)。
    useLayoutEffect(() => {
      if (!presence.mounted) return;
      updatePosition();
    }, [presence.mounted, updatePosition]);

    const closeTooltip = useCallback(() => {
      context?.setOpen(false);
    }, [context]);

    useEventRegistry(
      context?.open
        ? [
            { target: 'window', type: 'resize', listener: updatePosition as EventListener, options: { passive: true } },
            // 跟随滚动重定位；若 triggerRect 失效则如实关闭，避免悬浮在旧位置。
            {
              target: 'window',
              type: 'scroll',
              listener: (closeOnScroll ? closeTooltip : updatePosition) as EventListener,
              options: { capture: true, passive: true },
            },
            // 键盘可达性：Esc 收起当前提示。
            {
              target: 'window',
              type: 'keydown',
              listener: ((event: KeyboardEvent) => {
                if (event.key === 'Escape') closeTooltip();
              }) as EventListener,
            },
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
      [closeOnScroll, closeTooltip, context?.open, updatePosition],
    );

    if (!context || !presence.mounted || !lastRectRef.current) return null;

    const resolvedSide = position?.side ?? side;
    const shellClassName = [
      getBaseClasses(presence.exiting),
      theme === 'light' ? 'ds-tooltip-light' : '',
      className ?? '',
    ]
      .filter(Boolean)
      .join(' ');

    const body = (
      <div className="ds-tooltip-viewport">
        {shortcut ? (
          <span className="ds-tooltip-row">
            <span>{children}</span>
            <span className="ds-tooltip-shortcut" aria-hidden="true">
              {(Array.isArray(shortcut) ? shortcut : [shortcut]).map((key, index) => (
                <kbd key={index} className="ds-tooltip-kbd">{key}</kbd>
              ))}
            </span>
          </span>
        ) : (
          children
        )}
      </div>
    );

    const node = (
      <div
        ref={contentRef}
        className={shellClassName}
        data-state={presence.exiting ? 'closed' : 'open'}
        role="tooltip"
        id={context.contentId}
        data-side={resolvedSide}
        // 退场动画期间对 AT 立即隐藏：视觉上还在淡出，但不该再被读屏播报。
        aria-hidden={presence.exiting}
        style={{
          position: 'fixed',
          top: position?.top ?? -9999,
          left: position?.left ?? -9999,
          visibility: position ? 'visible' : 'hidden',
          pointerEvents: 'none',
          ...(maxWidth === undefined
            ? null
            : { maxWidth: typeof maxWidth === 'number' ? `${maxWidth}px` : maxWidth }),
          // 曾为 z-50：弹窗(3000)内使用时 tooltip 被盖住（M-2/H-2）
          zIndex: Z_INDEX.tooltip,
          ...(style ?? {}),
        }}
        {...props}
      >
        {body}
        {arrow && <div className="ds-tooltip-arrow" />}
      </div>
    );

    return createPortal(node, document.body);
  };