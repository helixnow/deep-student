import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { createPortal } from 'react-dom';
import { cn } from '../../../lib/utils';
import { Z_INDEX } from '@/config/zIndex';
import { useOverlayCoordinator } from '../../shared/OverlayCoordinator';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

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
  const { dismissTooltips, registerInteractiveOverlay } = useOverlayCoordinator();
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (next) {
        dismissTooltips();
      }
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [dismissTooltips, isControlled, onOpenChange]
  );

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!actualOpen) return;
    return registerInteractiveOverlay();
  }, [actualOpen, registerInteractiveOverlay]);

  // 📱 Android 返回键：Popover 是自绘浮层（role=dialog 但无 data-state="open"），
  // 协调器的 Radix Escape 兜底探测不到它；打开时注册 overlay 级 handler，
  // 返回键与 Escape 走同一关闭路径（setOpen(false) → onOpenChange(false)）。
  // 桌面端注册无副作用（handleAndroidBack 仅由 Android native 桥调用）。
  React.useEffect(() => {
    if (!actualOpen) return;
    return registerBackHandler(() => {
      setOpen(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [actualOpen, setOpen]);

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

interface PopoverTriggerProps extends React.HTMLAttributes<HTMLElement> {
  asChild?: boolean;
  children: React.ReactNode;
}

export const PopoverTrigger = React.forwardRef<HTMLElement, PopoverTriggerProps>(
  ({ asChild, children, onClick, ...rest }, ref) => {
  const ctx = React.useContext(PopoverContext);
  if (!ctx) return <>{children}</>;
  const Comp = (asChild ? Slot : 'button') as React.ElementType;
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : 'button'}
      aria-expanded={ctx.open}
      onClick={(event: React.MouseEvent<HTMLElement>) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        ctx.setOpen(!ctx.open);
      }}
      {...rest}
    >
      {children}
    </Comp>
  );
  }
);
PopoverTrigger.displayName = 'PopoverTrigger';

interface PopoverContentProps extends React.HTMLAttributes<HTMLDivElement> {
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom'; // 弹出方向，默认 bottom
  sideOffset?: number; // 与触发器的间距，默认 8
  portal?: boolean; // 是否通过 portal/fixed 定位渲染，默认 true
  collisionPadding?: number; // 与屏幕边缘的最小距离，默认 8
}

export interface PopoverPositionInput {
  triggerRect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width'>;
  contentWidth: number;
  contentHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  align: 'start' | 'center' | 'end';
  side: 'top' | 'bottom';
  sideOffset: number;
  collisionPadding: number;
}

export interface PopoverPosition {
  left: number;
  top: number;
  translateX: number;
}

const clampToViewport = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

/** Resolves placement once, including the case where neither side can fully fit. */
export function resolvePopoverPosition({
  triggerRect,
  contentWidth,
  contentHeight,
  viewportWidth,
  viewportHeight,
  align,
  side,
  sideOffset,
  collisionPadding,
}: PopoverPositionInput): PopoverPosition {
  let anchoredLeft = triggerRect.left;
  if (align === 'center') {
    anchoredLeft = triggerRect.left + triggerRect.width / 2 - contentWidth / 2;
  } else if (align === 'end') {
    anchoredLeft = triggerRect.right - contentWidth;
  }

  const left = clampToViewport(
    anchoredLeft,
    collisionPadding,
    viewportWidth - collisionPadding - contentWidth,
  );

  const above = triggerRect.top - contentHeight - sideOffset;
  const below = triggerRect.bottom + sideOffset;
  const fitsAbove = above >= collisionPadding;
  const fitsBelow = below + contentHeight <= viewportHeight - collisionPadding;
  const anchoredTop = side === 'bottom'
    ? (fitsBelow || !fitsAbove ? below : above)
    : (fitsAbove || !fitsBelow ? above : below);

  return {
    left,
    top: clampToViewport(
      anchoredTop,
      collisionPadding,
      viewportHeight - collisionPadding - contentHeight,
    ),
    // `left` is already the visible content edge, not an anchor point.
    translateX: 0,
  };
}

export const PopoverContent = React.forwardRef<HTMLDivElement, PopoverContentProps>(function PopoverContent(
  { className, align = 'center', side = 'bottom', sideOffset = 8, portal = true, collisionPadding = 8, style, ...rest },
  forwardedRef,
) {
  const ctx = React.useContext(PopoverContext);
  const [position, setPosition] = React.useState<PopoverPosition | null>(null);
  const localContentRef = React.useRef<HTMLDivElement | null>(null);

  const assignContentRef = React.useCallback((node: HTMLDivElement | null) => {
    localContentRef.current = node;
    if (ctx?.contentRef) {
      (ctx.contentRef as any).current = node;
    }
    if (typeof forwardedRef === 'function') {
      forwardedRef(node);
    } else if (forwardedRef) {
      forwardedRef.current = node;
    }
  }, [ctx?.contentRef, forwardedRef]);

  // 计算位置并处理边界碰撞
  const updatePosition = React.useCallback(() => {
    if (!ctx?.containerRef.current || !localContentRef.current) return;

    const rect = ctx.containerRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // offset* is unaffected by ui-zoom-fade-in scale/translate. Using the
    // transformed rect here makes overflow collision placement visibly jump.
    const nextPosition = resolvePopoverPosition({
      triggerRect: rect,
      contentWidth: localContentRef.current.offsetWidth,
      contentHeight: localContentRef.current.offsetHeight,
      viewportWidth,
      viewportHeight,
      align,
      side,
      sideOffset,
      collisionPadding,
    });

    setPosition((current) => (
      current
      && current.left === nextPosition.left
      && current.top === nextPosition.top
      && current.translateX === nextPosition.translateX
        ? current
        : nextPosition
    ));
  }, [ctx?.containerRef, align, side, sideOffset, collisionPadding]);

  // 初始定位 + 滚动/resize 跟随
  React.useLayoutEffect(() => {
    if (!ctx?.open || !portal || typeof window === 'undefined') {
      setPosition(null);
      return;
    }

    // 监听滚动和 resize，让 popover 跟随触发器
    const handleScroll = () => updatePosition();
    const handleResize = () => updatePosition();
    const scrollParents: EventTarget[] = [];
    let resizeObserver: ResizeObserver | null = null;

    // Portal 子树的 ref 可能晚于父层 layout effect 就绪，因此在下一帧统一
    // 连接定位、滚动祖先和尺寸监听。
    const frameId = requestAnimationFrame(() => {
      updatePosition();

      const contentNode = localContentRef.current;
      const triggerNode = ctx.containerRef.current;
      if (!contentNode || !triggerNode) return;

      scrollParents.push(window);
      let el: HTMLElement | null = triggerNode;
      while (el) {
        if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) {
          scrollParents.push(el);
        }
        el = el.parentElement;
      }
      scrollParents.forEach((parent) => {
        parent.addEventListener('scroll', handleScroll, { passive: true });
      });

      // 折叠、异步内容和字体加载都会改变尺寸；变化后必须重新锚定。
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => updatePosition());
        resizeObserver.observe(contentNode);
        resizeObserver.observe(triggerNode);
      }
    });
    window.addEventListener('resize', handleResize, { passive: true });

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      scrollParents.forEach((parent) => parent.removeEventListener('scroll', handleScroll));
      window.removeEventListener('resize', handleResize);
    };
  }, [ctx?.open, ctx?.containerRef, portal, updatePosition]);

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
            'fixed min-w-[200px] rounded-lg border border-border/40 bg-popover p-1.5 text-sm outline-none ui-zoom-fade-in shadow-none',
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
        'absolute mt-2 min-w-[200px] rounded-lg border border-border/40 bg-popover p-1.5 text-sm outline-none ui-zoom-fade-in shadow-none',
        alignmentClass,
        className
      )}
      style={{ zIndex: Z_INDEX.inputBarInner, ...style }}
      {...rest}
    />
  );
});
PopoverContent.displayName = 'PopoverContent';
