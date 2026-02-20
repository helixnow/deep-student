import React, { useState } from 'react';
import { createPortal } from 'react-dom';

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

interface TooltipContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: TooltipSide;
  align?: TooltipAlign;
  sideOffset?: number;
  alignOffset?: number;
}

// 基础样式 - 最小化，让用户传递的类可以完全覆盖
const getBaseClasses = () => {
  return 'z-50 rounded-md px-2 py-1.5 text-[13px] shadow-sm bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900 font-medium leading-none';
};

export const TooltipContent: React.FC<TooltipContentProps>
  = ({ children, className, side = 'top', align = 'center', sideOffset = 8, alignOffset = 0, style, ...props }) => {
    const context = React.useContext(TooltipContext);
    if (!context || !context.open || !context.triggerRect) return null;

    const rect = context.triggerRect;

    let top = rect.top;
    let left = rect.left;
    let transform = '';

    if (side === 'top') {
      top = rect.top - sideOffset;
      if (align === 'start') {
        left = rect.left + alignOffset;
        transform = 'translateY(-100%)';
      } else if (align === 'end') {
        left = rect.right + alignOffset;
        transform = 'translate(-100%, -100%)';
      } else {
        left = rect.left + rect.width / 2 + alignOffset;
        transform = 'translate(-50%, -100%)';
      }
    } else if (side === 'bottom') {
      top = rect.bottom + sideOffset;
      if (align === 'start') {
        left = rect.left + alignOffset;
        transform = 'translateY(0)';
      } else if (align === 'end') {
        left = rect.right + alignOffset;
        transform = 'translateX(-100%)';
      } else {
        left = rect.left + rect.width / 2 + alignOffset;
        transform = 'translate(-50%, 0)';
      }
    } else if (side === 'left') {
      left = rect.left - sideOffset;
      if (align === 'start') {
        top = rect.top + alignOffset;
        transform = 'translate(-100%, 0)';
      } else if (align === 'end') {
        top = rect.bottom + alignOffset;
        transform = 'translate(-100%, -100%)';
      } else {
        top = rect.top + rect.height / 2 + alignOffset;
        transform = 'translate(-100%, -50%)';
      }
    } else if (side === 'right') {
      left = rect.right + sideOffset;
      if (align === 'start') {
        top = rect.top + alignOffset;
        transform = 'translate(0, 0)';
      } else if (align === 'end') {
        top = rect.bottom + alignOffset;
        transform = 'translate(0, -100%)';
      } else {
        top = rect.top + rect.height / 2 + alignOffset;
        transform = 'translate(0, -50%)';
      }
    }

    const node = (
      <div
        className={className ? `${getBaseClasses()} ${className}` : getBaseClasses()}
        role="tooltip"
        style={{
          position: 'fixed',
          top,
          left,
          transform,
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
