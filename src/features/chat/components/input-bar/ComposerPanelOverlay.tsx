import React from 'react';
import { createPortal } from 'react-dom';
import { Z_INDEX } from '@/config/zIndex';
import { cn } from '@/lib/utils';
import { useOverlayCoordinator } from '@/components/shared/OverlayCoordinator';

const VIEWPORT_PADDING_PX = 8;
const DEFAULT_PANEL_GAP_PX = 8;
const MIN_PANEL_HEIGHT_PX = 160;

export type ComposerPanelMotion = 'closed' | 'opening' | 'open' | 'closing';

export interface ComposerPanelOverlayProps {
  panelKey: string;
  anchorRef: React.RefObject<HTMLElement>;
  overlayRef?: React.MutableRefObject<HTMLDivElement | null>;
  motionState: ComposerPanelMotion;
  maxHeight?: number;
  widthMode?: 'anchor' | 'wide';
  preferredWidth?: number;
  heightMode?: 'content' | 'available';
  /** 与锚点（输入栏）的间距，默认 8px。设为 0 可让面板贴齐锚点形成"长出来"效果 */
  gap?: number;
  /** Placement 变化时回调（用于让锚点根据 placement 调整自身样式，例如方角接缝） */
  onPlacementChange?: (placement: 'top' | 'bottom') => void;
  className?: string;
  children: React.ReactNode;
}

interface ComposerPanelPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: 'top' | 'bottom';
}

function assignRef(
  ref: React.MutableRefObject<HTMLDivElement | null> | undefined,
  node: HTMLDivElement | null
): void {
  if (ref) {
    ref.current = node;
  }
}

export function ComposerPanelOverlay({
  panelKey,
  anchorRef,
  overlayRef,
  motionState,
  maxHeight = 420,
  widthMode = 'anchor',
  preferredWidth = 860,
  heightMode = 'content',
  gap = DEFAULT_PANEL_GAP_PX,
  onPlacementChange,
  className,
  children,
}: ComposerPanelOverlayProps) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = React.useState<ComposerPanelPosition | null>(null);
  const { dismissTooltips, registerInteractiveOverlay } = useOverlayCoordinator();

  const setPanelRef = React.useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    assignRef(overlayRef, node);
  }, [overlayRef]);

  const updatePosition = React.useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === 'undefined') return;

    const anchorRect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const safeWidth = Math.max(0, viewportWidth - VIEWPORT_PADDING_PX * 2);
    const desiredWidth = widthMode === 'wide'
      ? Math.max(anchorRect.width, preferredWidth)
      : anchorRect.width;
    const width = Math.min(desiredWidth, safeWidth);
    const desiredLeft = widthMode === 'wide'
      ? anchorRect.left + anchorRect.width / 2 - width / 2
      : anchorRect.left;
    const left = Math.min(
      Math.max(desiredLeft, VIEWPORT_PADDING_PX),
      Math.max(VIEWPORT_PADDING_PX, viewportWidth - VIEWPORT_PADDING_PX - width)
    );
    const availableAbove = Math.max(0, anchorRect.top - gap - VIEWPORT_PADDING_PX);
    const availableBelow = Math.max(0, viewportHeight - anchorRect.bottom - gap - VIEWPORT_PADDING_PX);
    // Placement 偏好上方（popover 看起来"从输入栏长出"），但在两种情况下翻转到下方：
    //   1. 上方不够 MIN_PANEL_HEIGHT（如移动端键盘弹起把输入栏推到顶部）
    //   2. 上方放不下 maxHeight 完整高度，但下方比上方更宽裕（空状态：输入栏居中，下方反而更大）
    const shouldPlaceBelow =
      availableAbove < MIN_PANEL_HEIGHT_PX
      || (availableAbove < maxHeight && availableBelow > availableAbove);
    const availableSpace = shouldPlaceBelow ? availableBelow : availableAbove;
    const resolvedMaxHeight = Math.min(maxHeight, availableSpace, Math.max(0, viewportHeight - VIEWPORT_PADDING_PX * 2));
    const measuredHeight = panelRef.current?.getBoundingClientRect().height;
    const panelHeight = Math.min(
      heightMode === 'available'
        ? resolvedMaxHeight
        : measuredHeight && measuredHeight > 0 ? measuredHeight : resolvedMaxHeight,
      resolvedMaxHeight
    );
    const top = shouldPlaceBelow
      ? Math.min(viewportHeight - VIEWPORT_PADDING_PX - panelHeight, anchorRect.bottom + gap)
      : Math.max(VIEWPORT_PADDING_PX, anchorRect.top - gap - panelHeight);

    const nextPlacement: 'top' | 'bottom' = shouldPlaceBelow ? 'bottom' : 'top';
    setPosition((prev) => {
      if (
        prev
        && prev.left === left
        && prev.top === top
        && prev.width === width
        && prev.maxHeight === resolvedMaxHeight
        && prev.placement === nextPlacement
      ) {
        return prev;
      }
      return { left, top, width, maxHeight: resolvedMaxHeight, placement: nextPlacement };
    });
  }, [anchorRef, heightMode, maxHeight, preferredWidth, widthMode, gap]);

  React.useEffect(() => {
    dismissTooltips();
    return registerInteractiveOverlay();
  }, [dismissTooltips, registerInteractiveOverlay]);

  React.useEffect(() => {
    if (position?.placement) {
      onPlacementChange?.(position.placement);
    }
  }, [position?.placement, onPlacementChange]);

  React.useLayoutEffect(() => {
    if (typeof window === 'undefined') return;

    updatePosition();
    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      updatePosition();
      secondFrame = window.requestAnimationFrame(updatePosition);
    });

    const handleViewportChange = () => updatePosition();
    window.addEventListener('resize', handleViewportChange, { passive: true });
    window.addEventListener('scroll', handleViewportChange, { capture: true, passive: true });

    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(handleViewportChange)
      : null;
    if (resizeObserver) {
      if (anchorRef.current) resizeObserver.observe(anchorRef.current);
      if (panelRef.current) resizeObserver.observe(panelRef.current);
    }

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) {
        window.cancelAnimationFrame(secondFrame);
      }
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
      resizeObserver?.disconnect();
    };
  }, [anchorRef, updatePosition]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={setPanelRef}
      role="dialog"
      aria-modal="false"
      data-composer-panel-overlay={panelKey}
      data-composer-panel-placement={position?.placement ?? 'top'}
      data-panel-motion={motionState}
      className={cn(
        'fixed rounded-[var(--radius-shell-panel)] border border-[color:var(--composer-panel-border)] bg-[color:var(--composer-panel-surface)] bg-clip-padding p-3 text-[color:var(--composer-panel-foreground)] shadow-[var(--composer-panel-shadow)]',
        heightMode === 'available'
          ? 'flex min-h-0 flex-col overflow-hidden'
          : 'overflow-y-auto overscroll-contain',
        'outline-none',
        'transition-[opacity,transform] duration-200 ease-out will-change-transform motion-reduce:transition-none motion-reduce:duration-0',
        motionState === 'open' || motionState === 'opening'
          ? 'translate-y-0 opacity-100 pointer-events-auto'
          : 'translate-y-4 opacity-0 pointer-events-none',
        className
      )}
      style={{
        zIndex: Z_INDEX.popover,
        left: position?.left ?? VIEWPORT_PADDING_PX,
        top: position?.top ?? VIEWPORT_PADDING_PX,
        width: position?.width ?? 0,
        height: heightMode === 'available' ? (position?.maxHeight ?? maxHeight) : undefined,
        maxHeight: position?.maxHeight ?? maxHeight,
        visibility: position ? 'visible' : 'hidden',
        backdropFilter: 'var(--composer-panel-backdrop-filter)',
        WebkitBackdropFilter: 'var(--composer-panel-backdrop-filter)',
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  );
}
