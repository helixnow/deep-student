import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { createPortal } from 'react-dom';
import { cn } from '../../../lib/utils';
import { Z_INDEX } from '@/config/zIndex';

interface PopoverContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  containerRef: React.RefObject<HTMLDivElement>;
  contentRef: React.RefObject<HTMLDivElement>;
}

const PopoverContext = React.createContext<PopoverContextValue | null>(null);

interface PopoverProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

export function Popover({ open, onOpenChange, children }: PopoverProps) {
  const isControlled = open !== undefined;
  const [internalOpen, setInternalOpen] = React.useState(false);
  const actualOpen = isControlled ? !!open : internalOpen;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange]
  );

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!actualOpen) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (containerRef.current && containerRef.current.contains(target)) return;
      if (contentRef.current && contentRef.current.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [actualOpen, setOpen]);

  return (
    <PopoverContext.Provider value={{ open: actualOpen, setOpen, containerRef, contentRef }}>
      <div ref={containerRef} className="relative inline-flex">
        {children}
      </div>
    </PopoverContext.Provider>
  );
}

interface PopoverTriggerProps {
  asChild?: boolean;
  children: React.ReactNode;
}

export function PopoverTrigger({ asChild, children }: PopoverTriggerProps) {
  const ctx = React.useContext(PopoverContext);
  if (!ctx) return <>{children}</>;
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      type={asChild ? undefined : 'button'}
      aria-expanded={ctx.open}
      onClick={() => ctx.setOpen(!ctx.open)}
    >
      {children}
    </Comp>
  );
}

interface PopoverContentProps extends React.HTMLAttributes<HTMLDivElement> {
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom'; // 弹出方向，默认 bottom
  sideOffset?: number; // 与触发器的间距，默认 8
  portal?: boolean; // 是否通过 portal/fixed 定位渲染，默认 true
  collisionPadding?: number; // 与屏幕边缘的最小距离，默认 8
}

export function PopoverContent({ className, align = 'center', side = 'bottom', sideOffset = 8, portal = true, collisionPadding = 8, style, ...rest }: PopoverContentProps) {
  const ctx = React.useContext(PopoverContext);
  const [position, setPosition] = React.useState<{ left: number; top: number; translateX: number } | null>(null);
  const localContentRef = React.useRef<HTMLDivElement | null>(null);

  const assignContentRef = (node: HTMLDivElement | null) => {
    localContentRef.current = node;
    if (ctx?.contentRef) {
      (ctx.contentRef as any).current = node;
    }
  };

  // 计算位置并处理边界碰撞
  React.useLayoutEffect(() => {
    if (!ctx?.open || !portal || typeof window === 'undefined' || !ctx.containerRef.current) {
      setPosition(null);
      return;
    }

    const rect = ctx.containerRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;

    // 初始计算水平对齐
    let left = rect.left;
    let translateX = 0;
    if (align === 'center') {
      left = rect.left + rect.width / 2;
      translateX = -50;
    } else if (align === 'end') {
      left = rect.right;
      translateX = -100;
    }
    // 根据 side 计算垂直位置（初始值，后续会根据内容高度调整）
    const top = side === 'top' ? rect.top - sideOffset : rect.bottom + sideOffset;

    // 需要等内容渲染后检测边界碰撞
    requestAnimationFrame(() => {
      if (!localContentRef.current) return;
      const contentRect = localContentRef.current.getBoundingClientRect();
      const contentWidth = contentRect.width;

      // 计算实际的 left 位置（考虑 translateX）
      let actualLeft = left + (contentWidth * translateX / 100);

      // 边界碰撞检测
      if (actualLeft < collisionPadding) {
        // 超出左边界，调整到左边距位置
        left = collisionPadding;
        translateX = 0;
      } else if (actualLeft + contentWidth > viewportWidth - collisionPadding) {
        // 超出右边界，调整到右边距位置
        left = viewportWidth - collisionPadding;
        translateX = -100;
      }

      // 对于 side="top"，需要根据内容高度调整 top 值
      let finalTop = top;
      if (side === 'top') {
        const contentHeight = contentRect.height;
        finalTop = rect.top - contentHeight - sideOffset;
      }

      setPosition({ left, top: finalTop, translateX });
    });
  }, [ctx?.open, portal, align, side, sideOffset, collisionPadding]);

  if (!ctx || !ctx.open) return null;

  // 当通过 portal/fixed 定位渲染时
  if (portal && typeof window !== 'undefined' && ctx.containerRef.current) {
    // 使用计算后的位置，或默认初始位置
    const rect = ctx.containerRef.current.getBoundingClientRect();
    const defaultLeft = align === 'center' ? rect.left + rect.width / 2 : align === 'end' ? rect.right : rect.left;
    const defaultTranslateX = align === 'center' ? -50 : align === 'end' ? -100 : 0;
    const defaultTop = side === 'top' ? rect.top - sideOffset - 200 : rect.bottom + sideOffset; // 200 是估计的内容高度

    const finalLeft = position?.left ?? defaultLeft;
    const finalTop = position?.top ?? defaultTop;
    const finalTranslateX = position?.translateX ?? defaultTranslateX;

    const node = (
      <div
        role="dialog"
        ref={assignContentRef}
        className={cn(
          'fixed min-w-[200px] rounded-lg border border-border bg-popover p-1.5 text-sm shadow-xl outline-none animate-in fade-in-0 zoom-in-95',
          className
        )}
        style={{
          zIndex: Z_INDEX.popover,
          left: finalLeft,
          top: finalTop,
          transform: `translateX(${finalTranslateX}%)`,
          ...style,
        }}
        {...rest}
      />
    );
    return createPortal(node, document.body);
  }

  // 回退：不使用 portal 时仍采用绝对定位（可能会被裁剪）
  const alignmentClass = align === 'start' ? 'left-0' : align === 'end' ? 'right-0' : 'left-1/2 -translate-x-1/2';
  return (
    <div
      role="dialog"
      ref={assignContentRef}
      className={cn(
        'absolute mt-2 min-w-[200px] rounded-lg border border-border bg-popover p-1.5 text-sm shadow-xl outline-none animate-in fade-in-0 zoom-in-95',
        alignmentClass,
        className
      )}
      style={{ zIndex: Z_INDEX.inputBarInner, ...style }}
      {...rest}
    />
  );
}
