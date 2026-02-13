/**
 * useSelectionBox - 框选（拖拽选择）Hook
 * 
 * 功能：
 * 1. 鼠标拖拽画出选择框
 * 2. 计算选择框与文件项的交集
 * 3. 支持 Shift 键追加选择
 */

import { useState, useCallback, useRef, useEffect } from 'react';

export interface SelectionBoxRect {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface UseSelectionBoxOptions {
  /** 容器元素 ref */
  containerRef: React.RefObject<HTMLElement>;
  /** 获取所有可选项的边界信息 */
  getItemRects: () => Map<string, DOMRect>;
  /** 选中回调 */
  onSelectionChange: (selectedIds: Set<string>, mode: 'replace' | 'add') => void;
  /** 是否启用框选 */
  enabled?: boolean;
  /** 最小拖拽距离才触发框选（避免误触） */
  minDistance?: number;
}

export interface UseSelectionBoxReturn {
  /** 是否正在框选 */
  isSelecting: boolean;
  /** 选择框矩形（相对于视口） */
  selectionRect: SelectionBoxRect | null;
  /** 鼠标按下事件处理 */
  handleMouseDown: (e: React.MouseEvent) => void;
}

/**
 * 计算两个矩形是否相交
 */
function rectsIntersect(
  rect1: { left: number; top: number; right: number; bottom: number },
  rect2: { left: number; top: number; right: number; bottom: number }
): boolean {
  return !(
    rect1.right < rect2.left ||
    rect1.left > rect2.right ||
    rect1.bottom < rect2.top ||
    rect1.top > rect2.bottom
  );
}

/**
 * 将 SelectionBoxRect 转换为标准矩形格式
 */
function normalizeRect(rect: SelectionBoxRect): { left: number; top: number; right: number; bottom: number } {
  return {
    left: Math.min(rect.startX, rect.endX),
    top: Math.min(rect.startY, rect.endY),
    right: Math.max(rect.startX, rect.endX),
    bottom: Math.max(rect.startY, rect.endY),
  };
}

export function useSelectionBox({
  containerRef,
  getItemRects,
  onSelectionChange,
  enabled = true,
  minDistance = 5,
}: UseSelectionBoxOptions): UseSelectionBoxReturn {
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionRect, setSelectionRect] = useState<SelectionBoxRect | null>(null);
  
  const startPointRef = useRef<{ x: number; y: number } | null>(null);
  const isShiftKeyRef = useRef(false);
  const hasStartedSelectingRef = useRef(false);
  const lastDebugTimeRef = useRef<number | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // 只响应左键
    if (e.button !== 0 || !enabled) return;
    
    // 如果点击的是文件项，不触发框选
    const target = e.target as HTMLElement;
    if (target.closest('[data-finder-item]')) return;
    
    // 记录起始点（相对于视口）
    startPointRef.current = { x: e.clientX, y: e.clientY };
    isShiftKeyRef.current = e.shiftKey;
    hasStartedSelectingRef.current = false;
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!startPointRef.current) return;
      
      const dx = e.clientX - startPointRef.current.x;
      const dy = e.clientY - startPointRef.current.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      // 达到最小距离才开始框选
      if (!hasStartedSelectingRef.current && distance >= minDistance) {
        hasStartedSelectingRef.current = true;
        setIsSelecting(true);
        
        // ★ 调试事件：框选开始
        window.dispatchEvent(new CustomEvent('selection-box-debug', {
          detail: {
            type: 'selection_start',
            timestamp: Date.now(),
            clientX: e.clientX,
            clientY: e.clientY,
            boxStartX: startPointRef.current.x,
            boxStartY: startPointRef.current.y,
          }
        }));
      }
      
      if (hasStartedSelectingRef.current) {
        const newRect: SelectionBoxRect = {
          startX: startPointRef.current.x,
          startY: startPointRef.current.y,
          endX: e.clientX,
          endY: e.clientY,
        };
        setSelectionRect(newRect);
        
        // 计算选中的项
        const itemRects = getItemRects();
        const normalizedSelection = normalizeRect(newRect);
        const selectedIds = new Set<string>();
        
        itemRects.forEach((itemRect, id) => {
          const itemBounds = {
            left: itemRect.left,
            top: itemRect.top,
            right: itemRect.right,
            bottom: itemRect.bottom,
          };
          
          if (rectsIntersect(normalizedSelection, itemBounds)) {
            selectedIds.add(id);
          }
        });
        
        onSelectionChange(selectedIds, isShiftKeyRef.current ? 'add' : 'replace');
        
        // ★ 调试事件：鼠标移动（每 100ms 采样一次，避免过多事件）
        const now = Date.now();
        if (!lastDebugTimeRef.current || now - lastDebugTimeRef.current > 100) {
          lastDebugTimeRef.current = now;
          window.dispatchEvent(new CustomEvent('selection-box-debug', {
            detail: {
              type: 'mouse_move',
              timestamp: now,
              clientX: e.clientX,
              clientY: e.clientY,
              boxStartX: startPointRef.current.x,
              boxStartY: startPointRef.current.y,
              boxEndX: newRect.endX,
              boxEndY: newRect.endY,
              offsetX: newRect.endX - e.clientX,
              offsetY: newRect.endY - e.clientY,
              selectedCount: selectedIds.size,
            }
          }));
        }
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (startPointRef.current) {
        // ★ 调试事件：框选结束
        if (hasStartedSelectingRef.current) {
          window.dispatchEvent(new CustomEvent('selection-box-debug', {
            detail: {
              type: 'selection_end',
              timestamp: Date.now(),
              clientX: e.clientX,
              clientY: e.clientY,
            }
          }));
        }
        
        startPointRef.current = null;
        hasStartedSelectingRef.current = false;
        setIsSelecting(false);
        setSelectionRect(null);
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [enabled, minDistance, getItemRects, onSelectionChange]);

  return {
    isSelecting,
    selectionRect,
    handleMouseDown,
  };
}

/**
 * 选择框渲染组件的样式
 */
export function getSelectionBoxStyle(rect: SelectionBoxRect): React.CSSProperties {
  const normalized = normalizeRect(rect);
  return {
    position: 'fixed',
    left: normalized.left,
    top: normalized.top,
    width: normalized.right - normalized.left,
    height: normalized.bottom - normalized.top,
    backgroundColor: 'hsl(var(--primary) / 0.1)',
    border: '1px solid hsl(var(--primary) / 0.4)',
    borderRadius: '4px',
    pointerEvents: 'none',
    zIndex: 9999,
  };
}
