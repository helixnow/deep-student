/**
 * useTextSelection - 文本选择状态检测 Hook
 *
 * 行为契约：
 * - 指针按下拖拽选区期间（pointerdown -> pointerup）置 isDraggingSelection = true 并抑制工具栏弹出；
 *   松手后延迟 30ms（SELECTION_RELEASE_DELAY_MS）再定位显示，避开 iOS/Android 原生选区放大镜。
 * - 捕获阶段监听 scroll：一旦滚动开始且本容器选区存在，立即置 isScrolling = true 隐藏工具栏防止抖动；
 *   滚动停止 140ms（SELECTION_SETTLE_DELAY_MS）后重算 range.getBoundingClientRect()，
 *   若选区已滚出容器或视口可视区则保持隐藏，滚回可视区自动恢复。
 * - 选中文本 < 2 字符或选区不完全在本容器内时不弹出；Escape 键关闭。
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { MOBILE_LAYOUT } from '@/config/mobileLayout';

/** 触屏无指针松手路径（如系统菜单扩选/长按自动分词）的 selectionchange 防抖时长 */
const TOUCH_SELECTION_DEBOUNCE_MS = 300;

/** 最小触发字符数 */
const MIN_SELECTION_LENGTH = 2;

/** 上下文窗口字符数（每侧） */
const CONTEXT_WINDOW = 200;

const CLIPPING_OVERFLOW_PATTERN = /auto|scroll|hidden|clip/;

export interface SelectionRect {
  top: number;
  left: number;
  width: number;
  height: number;
  bottom: number;
}

export interface TextSelectionState {
  /** 选中的文本内容 */
  selectedText: string;
  /** 选区的 DOM 矩形位置（相对于视口） */
  selectionRect: SelectionRect | null;
  /** 工具栏是否应该显示 */
  isVisible: boolean;
  /** 是否处于滚动隐藏阶段 */
  isScrolling?: boolean;
  /** 是否处于指针按下拖拽选区阶段 */
  isDraggingSelection?: boolean;
  /** 选中文本前的上下文（容器内最多 200 字符），用于翻译消歧 */
  contextBefore: string;
  /** 选中文本后的上下文（容器内最多 200 字符），用于翻译消歧 */
  contextAfter: string;
  /** 手动清除选择状态 */
  clear: () => void;
}

export type UseTextSelectionResult = TextSelectionState & {
  isScrolling: boolean;
  isDraggingSelection: boolean;
};

/**
 * 在容器的可见 textContent 中寻找选中文本的位置，并切出前后上下文。
 * 失败时返回空字符串（不阻断主流程）。
 */
function extractContext(
  container: HTMLElement,
  range: Range,
  selectedText: string
): { before: string; after: string } {
  try {
    const fullText = container.textContent ?? '';
    if (!fullText || !selectedText) return { before: '', after: '' };

    let startOffset: number;
    try {
      const preRange = range.cloneRange();
      preRange.selectNodeContents(container);
      preRange.setEnd(range.startContainer, range.startOffset);
      startOffset = preRange.toString().length;
    } catch {
      startOffset = fullText.indexOf(selectedText);
      if (startOffset < 0) return { before: '', after: '' };
    }

    const endOffset = startOffset + selectedText.length;
    const before = fullText.slice(Math.max(0, startOffset - CONTEXT_WINDOW), startOffset);
    const after = fullText.slice(endOffset, endOffset + CONTEXT_WINDOW);
    return { before, after };
  } catch {
    return { before: '', after: '' };
  }
}

function isRectIntersectingBox(
  rect: SelectionRect,
  box: { top: number; left: number; right: number; bottom: number; width: number; height: number }
): boolean {
  if (box.width <= 0 || box.height <= 0) {
    return true;
  }
  const rectRight = rect.left + rect.width;
  return (
    rect.bottom > box.top &&
    rect.top < box.bottom &&
    rectRight > box.left &&
    rect.left < box.right
  );
}

/**
 * 判定选区矩形是否仍在视口及容器/滚动祖先的可视区内。
 * 若选区已随滚动离开可视范围则返回 false，保持工具栏隐藏直至滚回。
 */
function isSelectionRectInVisibleBounds(rect: SelectionRect, container: HTMLElement): boolean {
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const rectRight = rect.left + rect.width;

  if (viewportHeight > 0 && (rect.bottom <= 0 || rect.top >= viewportHeight)) {
    return false;
  }
  if (viewportWidth > 0 && (rectRight <= 0 || rect.left >= viewportWidth)) {
    return false;
  }

  const containerBox = container.getBoundingClientRect();
  if (!isRectIntersectingBox(rect, containerBox)) {
    return false;
  }

  let ancestor = container.parentElement;
  while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
    const computed = window.getComputedStyle(ancestor);
    const overflowDesc = `${computed.overflow} ${computed.overflowY} ${computed.overflowX}`;
    if (CLIPPING_OVERFLOW_PATTERN.test(overflowDesc)) {
      const ancestorBox = ancestor.getBoundingClientRect();
      if (!isRectIntersectingBox(rect, ancestorBox)) {
        return false;
      }
    }
    ancestor = ancestor.parentElement;
  }

  return true;
}

export function useTextSelection(
  containerRef: React.RefObject<HTMLElement | null>
): UseTextSelectionResult {
  const [selectedText, setSelectedText] = useState('');
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const [isDraggingSelection, setIsDraggingSelection] = useState(false);
  const [contextBefore, setContextBefore] = useState('');
  const [contextAfter, setContextAfter] = useState('');

  // 防止在工具栏上按下时清除选区或误触发重评估
  const isToolbarInteraction = useRef(false);
  const toolbarInteractionCleanupRef = useRef<number | null>(null);

  // 用 ref 镜像高频状态，保持 document 级监听器引用稳定
  const isVisibleRef = useRef(false);
  const isScrollingRef = useRef(false);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    isVisibleRef.current = isVisible;
  }, [isVisible]);

  useEffect(() => {
    isScrollingRef.current = isScrolling;
  }, [isScrolling]);

  useEffect(() => {
    isDraggingRef.current = isDraggingSelection;
  }, [isDraggingSelection]);

  const releaseTimerRef = useRef<number | null>(null);
  const scrollSettleTimerRef = useRef<number | null>(null);
  const selectionChangeTimerRef = useRef<number | null>(null);

  const cancelPendingEvaluationTimers = useCallback(() => {
    if (releaseTimerRef.current !== null) {
      window.clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
    if (selectionChangeTimerRef.current !== null) {
      window.clearTimeout(selectionChangeTimerRef.current);
      selectionChangeTimerRef.current = null;
    }
  }, []);

  const clear = useCallback(() => {
    cancelPendingEvaluationTimers();
    if (scrollSettleTimerRef.current !== null) {
      window.clearTimeout(scrollSettleTimerRef.current);
      scrollSettleTimerRef.current = null;
    }
    if (isScrollingRef.current) {
      isScrollingRef.current = false;
      setIsScrolling(false);
    }
    isVisibleRef.current = false;
    setSelectedText('');
    setSelectionRect(null);
    setIsVisible(false);
    setContextBefore('');
    setContextAfter('');
  }, [cancelPendingEvaluationTimers]);

  const hasValidContainerSelection = useCallback((): boolean => {
    const container = containerRef.current;
    if (!container) return false;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    if (selection.toString().trim().length < MIN_SELECTION_LENGTH) return false;
    const range = selection.getRangeAt(0);
    return container.contains(range.startContainer) && container.contains(range.endContainer);
  }, [containerRef]);

  // 评估当前选区并更新工具栏状态
  const evaluateSelection = useCallback(() => {
    // 拖拽选区期间或滚动未停稳期间抑制弹出
    if (isDraggingRef.current || isScrollingRef.current) {
      if (isVisibleRef.current) {
        isVisibleRef.current = false;
        setIsVisible(false);
      }
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      clear();
      return;
    }

    const text = selection.toString().trim();
    if (text.length < MIN_SELECTION_LENGTH) {
      clear();
      return;
    }

    const container = containerRef.current;
    if (!container) {
      clear();
      return;
    }

    const range = selection.getRangeAt(0);
    const startInContainer = container.contains(range.startContainer);
    const endInContainer = container.contains(range.endContainer);

    if (!startInContainer || !endInContainer) {
      clear();
      return;
    }

    const rect = range.getBoundingClientRect();
    const nextRect: SelectionRect = {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      bottom: rect.bottom,
    };
    const ctx = extractContext(container, range, text);
    const inVisibleBounds = isSelectionRectInVisibleBounds(nextRect, container);

    setSelectedText(text);
    setSelectionRect(nextRect);
    setContextBefore(ctx.before);
    setContextAfter(ctx.after);
    isVisibleRef.current = inVisibleBounds;
    setIsVisible(inVisibleBounds);
  }, [containerRef, clear]);

  // 松手后延迟 30ms 评估定位，避开 iOS/Android 选区放大镜退场
  const scheduleReleaseEvaluation = useCallback(() => {
    if (releaseTimerRef.current !== null) {
      window.clearTimeout(releaseTimerRef.current);
    }
    releaseTimerRef.current = window.setTimeout(() => {
      releaseTimerRef.current = null;
      evaluateSelection();
    }, MOBILE_LAYOUT.SELECTION_RELEASE_DELAY_MS);
  }, [evaluateSelection]);

  const handlePointerDown = useCallback((e: PointerEvent) => {
    if (toolbarInteractionCleanupRef.current !== null) {
      window.clearTimeout(toolbarInteractionCleanupRef.current);
      toolbarInteractionCleanupRef.current = null;
    }

    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('[data-selection-toolbar]')) {
      if (isVisibleRef.current) {
        isToolbarInteraction.current = true;
      }
      return;
    }

    if (e.pointerType === 'mouse' && e.button !== 0) {
      return;
    }

    isToolbarInteraction.current = false;
    cancelPendingEvaluationTimers();

    const container = containerRef.current;
    if (container && target && !container.contains(target)) {
      isDraggingRef.current = false;
      setIsDraggingSelection(false);
      clear();
      return;
    }

    isDraggingRef.current = true;
    setIsDraggingSelection(true);

    if (isVisibleRef.current) {
      isVisibleRef.current = false;
      setIsVisible(false);
    }
  }, [cancelPendingEvaluationTimers, clear, containerRef]);

  const handlePointerUpOrCancel = useCallback((e: PointerEvent) => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      setIsDraggingSelection(false);
    }

    if (isToolbarInteraction.current) {
      // 兼容触摸端可能不派发 mouseup 的场景：下一宏任务兜底清理标记，
      // 同帧随后触发的 mouseup 仍能正常消费该标记
      if (toolbarInteractionCleanupRef.current !== null) {
        window.clearTimeout(toolbarInteractionCleanupRef.current);
      }
      toolbarInteractionCleanupRef.current = window.setTimeout(() => {
        toolbarInteractionCleanupRef.current = null;
        isToolbarInteraction.current = false;
      }, 0);
      return;
    }

    if (e.type === 'pointerup' && e.pointerType === 'mouse' && e.button !== 0) {
      return;
    }

    scheduleReleaseEvaluation();
  }, [scheduleReleaseEvaluation]);

  // 桌面鼠标路径：兼容未经过 pointer 事件的合成 mouseup/mousedown
  const handleMouseUp = useCallback((e: MouseEvent) => {
    if (toolbarInteractionCleanupRef.current !== null) {
      window.clearTimeout(toolbarInteractionCleanupRef.current);
      toolbarInteractionCleanupRef.current = null;
    }

    // 工具栏交互标记必须先于按键判断消费：右键/中键点工具栏同样会武装该标记
    if (isToolbarInteraction.current) {
      isToolbarInteraction.current = false;
      return;
    }

    if (e.button !== 0) {
      return;
    }

    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      setIsDraggingSelection(false);
    }

    scheduleReleaseEvaluation();
  }, [scheduleReleaseEvaluation]);

  const handleMouseDown = useCallback((e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('[data-selection-toolbar]')) {
      if (isVisibleRef.current) {
        isToolbarInteraction.current = true;
      }
      return;
    }
    if (e.button !== 0) {
      return;
    }
    clear();
  }, [clear]);

  // 捕获阶段监听 scroll：选区存在时立即置 isScrolling = true 隐藏工具栏，
  // 滚动停止 140ms 后重算 range.getBoundingClientRect()，按可视区决定恢复或继续隐藏
  const handleScroll = useCallback(() => {
    if (
      !isVisibleRef.current &&
      !isScrollingRef.current &&
      scrollSettleTimerRef.current === null &&
      !hasValidContainerSelection()
    ) {
      return;
    }

    if (!hasValidContainerSelection()) {
      if (isVisibleRef.current) {
        clear();
      } else if (isScrollingRef.current) {
        isScrollingRef.current = false;
        setIsScrolling(false);
      }
      return;
    }

    cancelPendingEvaluationTimers();
    if (!isScrollingRef.current) {
      isScrollingRef.current = true;
      setIsScrolling(true);
    }
    if (isVisibleRef.current) {
      isVisibleRef.current = false;
      setIsVisible(false);
    }

    if (scrollSettleTimerRef.current !== null) {
      window.clearTimeout(scrollSettleTimerRef.current);
    }
    scrollSettleTimerRef.current = window.setTimeout(() => {
      scrollSettleTimerRef.current = null;
      isScrollingRef.current = false;
      setIsScrolling(false);
      evaluateSelection();
    }, MOBILE_LAYOUT.SELECTION_SETTLE_DELAY_MS);
  }, [clear, cancelPendingEvaluationTimers, evaluateSelection, hasValidContainerSelection]);

  const handleResize = useCallback(() => {
    if (!isVisibleRef.current && !hasValidContainerSelection()) {
      return;
    }
    handleScroll();
  }, [handleScroll, hasValidContainerSelection]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && isVisibleRef.current) {
      clear();
      window.getSelection()?.removeAllRanges();
    }
  }, [clear]);

  const handleContextMenu = useCallback(() => {
    if (isVisibleRef.current) {
      clear();
    }
  }, [clear]);

  const handleSelectionChange = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    // 指针按住拖拽期间或滚动期间抑制防抖弹出
    if (isDraggingRef.current || isScrollingRef.current) {
      if (selectionChangeTimerRef.current !== null) {
        window.clearTimeout(selectionChangeTimerRef.current);
        selectionChangeTimerRef.current = null;
      }
      return;
    }

    const sel = window.getSelection();
    const collapsed = !sel || sel.isCollapsed;
    if (!isVisibleRef.current) {
      if (collapsed) {
        if (selectionChangeTimerRef.current !== null) {
          window.clearTimeout(selectionChangeTimerRef.current);
          selectionChangeTimerRef.current = null;
        }
        return;
      }
      if (sel?.anchorNode && !container.contains(sel.anchorNode)) {
        return;
      }
    }

    if (selectionChangeTimerRef.current !== null) {
      window.clearTimeout(selectionChangeTimerRef.current);
    }
    selectionChangeTimerRef.current = window.setTimeout(() => {
      selectionChangeTimerRef.current = null;
      evaluateSelection();
    }, TOUCH_SELECTION_DEBOUNCE_MS);
  }, [containerRef, evaluateSelection]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const docTarget: EventTarget = document;
    const winTarget: EventTarget = window;
    const bindings: Array<{
      target: EventTarget;
      type: string;
      listener: EventListener;
      options?: AddEventListenerOptions;
    }> = [
      { target: docTarget, type: 'pointerdown', listener: handlePointerDown as EventListener },
      { target: docTarget, type: 'pointerup', listener: handlePointerUpOrCancel as EventListener },
      { target: docTarget, type: 'pointercancel', listener: handlePointerUpOrCancel as EventListener },
      { target: docTarget, type: 'mouseup', listener: handleMouseUp as EventListener },
      { target: docTarget, type: 'mousedown', listener: handleMouseDown as EventListener },
      { target: docTarget, type: 'keydown', listener: handleKeyDown as EventListener },
      { target: docTarget, type: 'contextmenu', listener: handleContextMenu as EventListener },
      { target: docTarget, type: 'selectionchange', listener: handleSelectionChange },
      {
        target: docTarget,
        type: 'scroll',
        listener: handleScroll,
        options: { capture: true, passive: true },
      },
      { target: winTarget, type: 'resize', listener: handleResize },
    ];

    for (const entry of bindings) {
      entry.target.addEventListener(entry.type, entry.listener, entry.options);
    }

    return () => {
      for (const entry of bindings) {
        entry.target.removeEventListener(entry.type, entry.listener, entry.options);
      }
      cancelPendingEvaluationTimers();
      if (scrollSettleTimerRef.current !== null) {
        window.clearTimeout(scrollSettleTimerRef.current);
        scrollSettleTimerRef.current = null;
      }
      if (toolbarInteractionCleanupRef.current !== null) {
        window.clearTimeout(toolbarInteractionCleanupRef.current);
        toolbarInteractionCleanupRef.current = null;
      }
    };
  }, [
    containerRef,
    handlePointerDown,
    handlePointerUpOrCancel,
    handleMouseUp,
    handleMouseDown,
    handleKeyDown,
    handleContextMenu,
    handleSelectionChange,
    handleScroll,
    handleResize,
    cancelPendingEvaluationTimers,
  ]);

  return {
    selectedText,
    selectionRect,
    isVisible,
    isScrolling,
    isDraggingSelection,
    contextBefore,
    contextAfter,
    clear,
  };
}
