import { useState, useCallback, useEffect, useRef, type RefObject } from 'react';

export interface UseQuestionSwipeGestureOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  isSmallScreen: boolean;
  showSettingsPanel: boolean;
  onShowSettingsPanelChange: (open: boolean) => void;
}

export interface UseQuestionSwipeGestureResult {
  containerWidth: number;
  settingsPanelWidth: number;
  isDragging: boolean;
  dragOffset: number;
  getBaseTranslate: () => number;
  handleDragStart: (clientX: number, clientY: number) => void;
  handleDragMove: (clientX: number, clientY: number, preventDefault: () => void) => void;
  handleDragEnd: () => void;
}

/**
 * 起点位于可横向滚动的内容（宽表格 / 溢出公式等）时放弃面板拖拽手势，
 * 把横向滑动让位给内容自身的横向滚动，避免手势劫持。
 */
export function startsInHorizontalScrollable(
  target: EventTarget | null,
  boundary: Element | null,
): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== boundary) {
    if (
      node instanceof HTMLElement
      && node.scrollWidth > node.clientWidth + 1
    ) {
      const { overflowX } = getComputedStyle(node);
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * 移动端题库编辑器的容器宽度观测与右侧设置抽屉横向滑动状态机。
 */
export function useQuestionSwipeGesture({
  containerRef,
  isSmallScreen,
  showSettingsPanel,
  onShowSettingsPanelChange,
}: UseQuestionSwipeGestureOptions): UseQuestionSwipeGestureResult {
  const [containerWidth, setContainerWidth] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);

  const dragStateRef = useRef({
    isDragging: false,
    startX: 0,
    startY: 0,
    currentTranslate: 0,
    dragOffset: 0,
    axisLocked: null as 'horizontal' | 'vertical' | null,
  });

  // 监听容器宽度
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isSmallScreen) return;

    const updateWidth = () => setContainerWidth(container.clientWidth);
    updateWidth();

    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(updateWidth);
    ro.observe(container);
    return () => ro.disconnect();
  }, [containerRef, isSmallScreen]);

  // 设置面板宽度
  const settingsPanelWidth = Math.max(containerWidth - 60, 280);

  // 计算基础偏移
  const getBaseTranslate = useCallback(() => {
    return showSettingsPanel ? -settingsPanelWidth : 0;
  }, [showSettingsPanel, settingsPanelWidth]);

  // 拖拽处理
  const handleDragStart = useCallback((clientX: number, clientY: number) => {
    dragStateRef.current = {
      isDragging: true,
      startX: clientX,
      startY: clientY,
      currentTranslate: getBaseTranslate(),
      dragOffset: 0,
      axisLocked: null,
    };
    setIsDragging(true);
    setDragOffset(0);
  }, [getBaseTranslate]);

  const handleDragMove = useCallback((clientX: number, clientY: number, preventDefault: () => void) => {
    if (!dragStateRef.current.isDragging) return;

    const deltaX = clientX - dragStateRef.current.startX;
    const deltaY = clientY - dragStateRef.current.startY;

    if (dragStateRef.current.axisLocked === null && (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10)) {
      if (Math.abs(deltaX) > Math.abs(deltaY) * 1.2) {
        dragStateRef.current.axisLocked = 'horizontal';
      } else {
        dragStateRef.current.axisLocked = 'vertical';
        dragStateRef.current.isDragging = false;
        dragStateRef.current.dragOffset = 0;
        setIsDragging(false);
        return;
      }
    }

    if (dragStateRef.current.axisLocked === 'vertical') return;
    if (dragStateRef.current.axisLocked === 'horizontal') preventDefault();

    const minTranslate = -settingsPanelWidth;
    const maxTranslate = 0;
    let newTranslate = dragStateRef.current.currentTranslate + deltaX;
    newTranslate = Math.max(minTranslate, Math.min(maxTranslate, newTranslate));

    const offset = newTranslate - getBaseTranslate();
    dragStateRef.current.dragOffset = offset;
    setDragOffset(offset);
  }, [settingsPanelWidth, getBaseTranslate]);

  const handleDragEnd = useCallback(() => {
    if (!dragStateRef.current.isDragging) {
      dragStateRef.current.axisLocked = null;
      return;
    }

    const threshold = settingsPanelWidth * 0.3;
    const offset = dragStateRef.current.dragOffset;

    if (Math.abs(offset) > threshold) {
      if (offset > 0 && showSettingsPanel) {
        onShowSettingsPanelChange(false);
      } else if (offset < 0 && !showSettingsPanel) {
        onShowSettingsPanelChange(true);
      }
    }

    dragStateRef.current.isDragging = false;
    dragStateRef.current.axisLocked = null;
    dragStateRef.current.dragOffset = 0;
    setIsDragging(false);
    setDragOffset(0);
  }, [showSettingsPanel, settingsPanelWidth, onShowSettingsPanelChange]);

  // 绑定触摸事件
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isSmallScreen) return;

    const onTouchStart = (e: TouchEvent) => {
      if (startsInHorizontalScrollable(e.target, container)) return;
      const touch = e.touches[0];
      if (!touch) return;
      handleDragStart(touch.clientX, touch.clientY);
    };

    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      handleDragMove(touch.clientX, touch.clientY, () => e.preventDefault());
    };

    const onTouchEnd = () => handleDragEnd();

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd);
    container.addEventListener('touchcancel', onTouchEnd);

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [containerRef, isSmallScreen, handleDragStart, handleDragMove, handleDragEnd]);

  return {
    containerWidth,
    settingsPanelWidth,
    isDragging,
    dragOffset,
    getBaseTranslate,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
  };
}
