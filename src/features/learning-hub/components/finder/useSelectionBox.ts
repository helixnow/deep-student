/**
 * useSelectionBox - 框选（拖拽选择）Hook
 *
 * 功能：
 * 1. 鼠标拖拽画出选择框
 * 2. 通过 hitTest 回调计算命中项（几何 / 虚拟列表均可）
 * 3. Shift：mousedown 冻结 baseline，每帧 baseline ∪ hit（缩回时去掉离开框的项）
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
  /**
   * 几何命中：输入选择框（viewport client 坐标），返回命中 id。
   * 优先于 getItemRects。
   */
  hitTest?: (box: SelectionBoxRect) => Set<string>;
  /** @deprecated 使用 hitTest；保留兼容 DOM rect 扫描 */
  getItemRects?: () => Map<string, DOMRect>;
  /**
   * Shift 框选基线。mousedown 时若按住 Shift 则冻结；
   * 缺省为空集。
   */
  getBaselineSelection?: () => ReadonlySet<string>;
  /** 选中回调；Shift 时 hook 已合并 baseline，调用方勿再二次 union */
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

function hitTestViaRects(
  box: SelectionBoxRect,
  getItemRects: () => Map<string, DOMRect>,
): Set<string> {
  const itemRects = getItemRects();
  const normalizedSelection = normalizeRect(box);
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

  return selectedIds;
}

export function useSelectionBox({
  containerRef: _containerRef,
  hitTest,
  getItemRects,
  getBaselineSelection,
  onSelectionChange,
  enabled = true,
  minDistance = 5,
}: UseSelectionBoxOptions): UseSelectionBoxReturn {
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionRect, setSelectionRect] = useState<SelectionBoxRect | null>(null);

  const startPointRef = useRef<{ x: number; y: number } | null>(null);
  const isShiftKeyRef = useRef(false);
  const baselineRef = useRef<Set<string>>(new Set());
  const hasStartedSelectingRef = useRef(false);
  const lastDebugTimeRef = useRef<number | null>(null);
  const hitTestRef = useRef(hitTest);
  const getItemRectsRef = useRef(getItemRects);
  const getBaselineSelectionRef = useRef(getBaselineSelection);
  const onSelectionChangeRef = useRef(onSelectionChange);

  hitTestRef.current = hitTest;
  getItemRectsRef.current = getItemRects;
  getBaselineSelectionRef.current = getBaselineSelection;
  onSelectionChangeRef.current = onSelectionChange;

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

    // Shift：冻结 mousedown 时的选中基线
    if (e.shiftKey) {
      const baseline = getBaselineSelectionRef.current?.() ?? new Set<string>();
      baselineRef.current = new Set(baseline);
    } else {
      baselineRef.current = new Set();
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    const resolveHit = (box: SelectionBoxRect): Set<string> => {
      if (hitTestRef.current) {
        return hitTestRef.current(box);
      }
      if (getItemRectsRef.current) {
        return hitTestViaRects(box, getItemRectsRef.current);
      }
      return new Set();
    };

    // WebView2 高刷鼠标（125Hz+）下 per-event setState + 命中计算会逐帧触发 layout 与选中集重建，
    // mousemove 只缓存最新坐标，rAF 每帧消费一次（pendingPoint 模式，同 pointerEngine）
    let rafId = 0;
    let pendingPoint: { x: number; y: number } | null = null;

    const processPoint = (point: { x: number; y: number }) => {
      if (!startPointRef.current) return;

      const dx = point.x - startPointRef.current.x;
      const dy = point.y - startPointRef.current.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // 达到最小距离才开始框选
      if (!hasStartedSelectingRef.current && distance >= minDistance) {
        hasStartedSelectingRef.current = true;
        setIsSelecting(true);

        window.dispatchEvent(new CustomEvent('selection-box-debug', {
          detail: {
            type: 'selection_start',
            timestamp: Date.now(),
            clientX: point.x,
            clientY: point.y,
            boxStartX: startPointRef.current.x,
            boxStartY: startPointRef.current.y,
          }
        }));
      }

      if (hasStartedSelectingRef.current) {
        const newRect: SelectionBoxRect = {
          startX: startPointRef.current.x,
          startY: startPointRef.current.y,
          endX: point.x,
          endY: point.y,
        };
        setSelectionRect(newRect);

        const hit = resolveHit(newRect);
        let selectedIds: Set<string>;
        if (isShiftKeyRef.current) {
          selectedIds = new Set(baselineRef.current);
          hit.forEach((id) => selectedIds.add(id));
        } else {
          selectedIds = hit;
        }

        onSelectionChangeRef.current(
          selectedIds,
          isShiftKeyRef.current ? 'add' : 'replace',
        );

        const now = Date.now();
        if (!lastDebugTimeRef.current || now - lastDebugTimeRef.current > 100) {
          lastDebugTimeRef.current = now;
          window.dispatchEvent(new CustomEvent('selection-box-debug', {
            detail: {
              type: 'mouse_move',
              timestamp: now,
              clientX: point.x,
              clientY: point.y,
              boxStartX: startPointRef.current.x,
              boxStartY: startPointRef.current.y,
              boxEndX: newRect.endX,
              boxEndY: newRect.endY,
              offsetX: newRect.endX - point.x,
              offsetY: newRect.endY - point.y,
              selectedCount: selectedIds.size,
            }
          }));
        }
      }
    };

    const processFrame = () => {
      rafId = 0;
      const point = pendingPoint;
      pendingPoint = null;
      if (point) processPoint(point);
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!startPointRef.current) return;
      pendingPoint = { x: e.clientX, y: e.clientY };
      if (rafId === 0) {
        rafId = requestAnimationFrame(processFrame);
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (startPointRef.current) {
        // 冲刷尚未消费的最后一个点，保证最终选中集与松手位置一致
        if (rafId !== 0) {
          cancelAnimationFrame(rafId);
        }
        processFrame();

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
        baselineRef.current = new Set();
        setIsSelecting(false);
        setSelectionRect(null);
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      pendingPoint = null;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [enabled, minDistance]);

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
