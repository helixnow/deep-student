import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useEventRegistry } from '@/hooks/useEventRegistry';

interface TooltipContextValue {
  open: boolean;
  setOpen: (value: boolean) => void;
  triggerRect: DOMRect | null;
  setTriggerRect: (rect: DOMRect | null) => void;
}

const TooltipContext = React.createContext<TooltipContextValue | null>(null);

export const TooltipProvider: React.FC<{
  children: React.ReactNode;
  delayDuration?: number;
}>
  = ({ children }) => <>{children}</>;

export const Tooltip: React.FC<{ children: React.ReactNode }>
  = ({ children }) => {
    const [open, setOpen] = useState(false);
    const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
    return (
      <TooltipContext.Provider value={{ open, setOpen, triggerRect, setTriggerRect }}>
        <span className="relative inline-flex">{children}</span>
      </TooltipContext.Provider>
    );
  };

export const TooltipTrigger: React.FC<React.HTMLAttributes<HTMLElement> & { asChild?: boolean }>
  = ({ children, asChild, onMouseEnter, onMouseLeave, ...props }) => {
    const context = React.useContext(TooltipContext);
    const handleMouseEnter = (event: React.MouseEvent<HTMLElement>) => {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      context?.setTriggerRect(rect);
      context?.setOpen(true);
      onMouseEnter?.(event);
    };
    const handleMouseLeave = (event: React.MouseEvent<HTMLElement>) => {
      context?.setOpen(false);
      context?.setTriggerRect(null);
      onMouseLeave?.(event);
    };

    if (asChild && React.isValidElement(children)) {
      return React.cloneElement(children, {
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleMouseLeave,
        ...props,
      } as any);
    }

    return (
      <span onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} {...props}>
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
const getBaseClasses = () => {
  return 'z-50 rounded-md px-2 py-1.5 text-[13px] shadow-none border border-border/40 bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900 font-medium leading-none ui-tooltip-in';
};

export const TooltipContent: React.FC<TooltipContentProps>
  = ({ children, className, side = 'top', align = 'center', sideOffset = 8, alignOffset = 0, style, ...props }) => {
    const context = React.useContext(TooltipContext);
    const contentRef = React.useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState<TooltipPosition | null>(null);

    const updatePosition = React.useCallback(() => {
      const rect = context?.triggerRect;
      const content = contentRef.current;
      if (!context?.open || !rect || !content) return;

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
    }, [align, alignOffset, context?.open, context?.triggerRect, side, sideOffset]);

    React.useLayoutEffect(() => {
      if (!context?.open) {
        setPosition(null);
        return;
      }
      updatePosition();
    }, [context?.open, updatePosition]);

    useEventRegistry(
      context?.open
        ? [{ target: 'window', type: 'resize', listener: updatePosition as EventListener, options: { passive: true } }]
        : [],
      [context?.open, updatePosition],
    );

    if (!context || !context.open || !context.triggerRect) return null;

    const node = (
      <div
        ref={contentRef}
        className={className ? `${getBaseClasses()} ${className}` : getBaseClasses()}
        role="tooltip"
        data-side={position?.side ?? side}
        style={{
          position: 'fixed',
          top: position?.top ?? -9999,
          left: position?.left ?? -9999,
          visibility: position ? 'visible' : 'hidden',
          pointerEvents: 'none',
          ...(style ?? {}),
        }}
        {...props}
      >
        {children}
      </div>
    );

    return createPortal(node, document.body);
  };
