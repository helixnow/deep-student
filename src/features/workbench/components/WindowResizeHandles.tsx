/**
 * WindowResizeHandles（P3 / O2）— 四边 + 四角缩放命中区。
 *
 * 视觉完全透明；边 6px、角 12px（O2：角柄命中区 10→12）。
 * 样式走 WindowShell.css 的 wb-shell-rz-* 类；几何由指针引擎负责，
 * 本组件只负责命中区与 cursor，并把 pointerdown 上抛。
 */
import React from 'react';

export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const RESIZE_DIRECTIONS: ResizeDirection[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export interface WindowResizeHandlesProps {
  /** 非 floating（tiled/maximized）时禁用缩放 */
  disabled?: boolean;
  onResizePointerDown: (dir: ResizeDirection, e: React.PointerEvent<HTMLDivElement>) => void;
}

export const WindowResizeHandles: React.FC<WindowResizeHandlesProps> = ({
  disabled = false,
  onResizePointerDown,
}) => {
  if (disabled) return null;
  return (
    <>
      {RESIZE_DIRECTIONS.map((dir) => (
        <div
          key={dir}
          className={`wb-shell-rz wb-shell-rz-${dir}`}
          data-wb-resize={dir}
          aria-hidden
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            onResizePointerDown(dir, e);
          }}
        />
      ))}
    </>
  );
};

export default WindowResizeHandles;
