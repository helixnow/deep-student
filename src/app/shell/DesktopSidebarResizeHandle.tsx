import React, { useRef } from 'react';

interface DesktopSidebarResizeHandleProps {
  label: string;
  width: number;
  minWidth: number;
  maxWidth: number;
  onResizeStart?: () => void;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
}

const KEYBOARD_RESIZE_STEP = 8;

export function DesktopSidebarResizeHandle({
  label,
  width,
  minWidth,
  maxWidth,
  onResizeStart,
  onResize,
  onResizeEnd,
}: DesktopSidebarResizeHandleProps) {
  const activePointerIdRef = useRef<number | null>(null);

  const finishPointerResize = (
    event: React.PointerEvent<HTMLDivElement>,
    finalWidth: number
  ) => {
    if (activePointerIdRef.current !== event.pointerId) return;

    activePointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onResizeEnd(finalWidth);
  };

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      className="desktop-shell-sidebar-resize-handle"
      onPointerDown={(event) => {
        if (typeof event.button === 'number' && event.button > 0) return;

        event.preventDefault();
        activePointerIdRef.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        onResizeStart?.();
      }}
      onPointerMove={(event) => {
        if (activePointerIdRef.current !== event.pointerId) return;
        onResize(event.clientX);
      }}
      onPointerUp={(event) => finishPointerResize(event, event.clientX)}
      onPointerCancel={(event) => finishPointerResize(event, width)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') {
          return;
        }

        event.preventDefault();
        const nextWidth = event.key === 'Home'
          ? 0
          : width + (event.key === 'ArrowLeft' ? -KEYBOARD_RESIZE_STEP : KEYBOARD_RESIZE_STEP);
        onResize(nextWidth);
        onResizeEnd(nextWidth);
      }}
    >
      <span aria-hidden="true" className="desktop-shell-sidebar-resize-indicator" />
    </div>
  );
}
