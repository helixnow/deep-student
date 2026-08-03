/**
 * useTextSelection - 文本选择状态检测 Hook
 *
 * 桌面：监听 mouseup 事件，检测选中文本并计算选区位置。
 * 触屏（C-8）：mouseup 不可靠（长按选词/拖选择手柄没有 mouseup），
 * 改用 document.selectionchange + 防抖，选区稳定后显示工具栏。
 *
 * 选择策略（与 ChatGPT/Claude 桌面版一致）：
 * - 不限制用户的自由选择行为
 * - 仅当选区完全落在当前容器内时才显示工具栏
 * - 跨消息选择时工具栏不弹出，但不阻止选择本身
 *
 * 设计原则：
 * - 选中文本 < 2 字符时不触发（避免误触）
 * - 滚动时自动隐藏
 * - Escape 键关闭
 */

import { useState, useCallback, useEffect, useRef } from 'react';

/** 触屏 selectionchange 防抖时长：长按/拖手柄期间持续触发，稳定后再弹工具栏 */
const TOUCH_SELECTION_DEBOUNCE_MS = 300;

// 模块级缓存 coarse pointer 查询结果：直渲长列表时每条消息都挂着 scroll 监听，
// 滚动期间每个 handler 都调用本函数，不能每次都重跑 window.matchMedia。
// coarse pointer 在桌面/移动运行期基本不变，缓存后监听 change 事件兜底更新。
let coarsePointerQuery: MediaQueryList | null | undefined;
let coarsePointerMatches = false;

const isTouchPrimaryPointer = (): boolean => {
  if (coarsePointerQuery === undefined) {
    try {
      coarsePointerQuery = window.matchMedia?.('(pointer: coarse)') ?? null;
      if (coarsePointerQuery) {
        coarsePointerMatches = coarsePointerQuery.matches;
        // 老 WebView 可能没有 addEventListener，此时降级为首次结果一次性缓存
        coarsePointerQuery.addEventListener?.('change', (e) => {
          coarsePointerMatches = e.matches;
        });
      }
    } catch {
      coarsePointerQuery = null;
    }
  }
  return coarsePointerQuery ? coarsePointerMatches : false;
};

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
  /** 选中文本前的上下文（容器内最多 200 字符），用于翻译消歧 */
  contextBefore: string;
  /** 选中文本后的上下文（容器内最多 200 字符），用于翻译消歧 */
  contextAfter: string;
  /** 手动清除选择状态 */
  clear: () => void;
}

/** 最小触发字符数 */
const MIN_SELECTION_LENGTH = 2;

/** 上下文窗口字符数（每侧） */
const CONTEXT_WINDOW = 200;

/**
 * 在容器的可见 textContent 中寻找选中文本的位置，并切出前后上下文。
 *
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

    // 优先：先用 selectionStart/cloneContents 计算更精确的偏移
    let startOffset: number;
    try {
      const preRange = range.cloneRange();
      preRange.selectNodeContents(container);
      preRange.setEnd(range.startContainer, range.startOffset);
      startOffset = preRange.toString().length;
    } catch {
      // 回退：直接 indexOf（多次出现时取第一次，可能不准但不会崩）
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

export function useTextSelection(
  containerRef: React.RefObject<HTMLElement | null>
): TextSelectionState {
  const [selectedText, setSelectedText] = useState('');
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [contextBefore, setContextBefore] = useState('');
  const [contextAfter, setContextAfter] = useState('');
  // 防止 mousedown 在工具栏上时清除选择
  const isToolbarInteraction = useRef(false);
  // 用 ref 镜像 isVisible，保证 document 级监听器引用稳定（避免每次显隐都解绑/重绑）
  const isVisibleRef = useRef(false);
  useEffect(() => {
    isVisibleRef.current = isVisible;
  }, [isVisible]);

  const clear = useCallback(() => {
    setSelectedText('');
    setSelectionRect(null);
    setIsVisible(false);
    setContextBefore('');
    setContextAfter('');
  }, []);

  // 评估当前选区并更新工具栏状态（mouseup 与 selectionchange 共用）
  const evaluateSelection = useCallback(() => {
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

    // 确保选区完全在容器内（起点和终点都在容器内）
    const container = containerRef.current;
    if (!container) {
      clear();
      return;
    }

    const range = selection.getRangeAt(0);
    const startInContainer = container.contains(range.startContainer);
    const endInContainer = container.contains(range.endContainer);

    // 只有选区完全在容器内才显示工具栏
    if (!startInContainer || !endInContainer) {
      clear();
      return;
    }

    // 计算选区位置
    const rect = range.getBoundingClientRect();
    const ctx = extractContext(container, range, text);
    setSelectedText(text);
    setSelectionRect({
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      bottom: rect.bottom,
    });
    setContextBefore(ctx.before);
    setContextAfter(ctx.after);
    setIsVisible(true);
  }, [containerRef, clear]);

  // 检测选中文本（桌面鼠标路径）
  const pendingRafRef = useRef<number | null>(null);
  const handleMouseUp = useCallback((e: MouseEvent) => {
    // 仅处理左键（右键/中键不应触发浮动工具栏）
    if (e.button !== 0) {
      return;
    }

    // 如果是工具栏上的交互，不处理
    if (isToolbarInteraction.current) {
      isToolbarInteraction.current = false;
      return;
    }

    // 延迟一帧确保 selection 已更新
    if (pendingRafRef.current !== null) {
      cancelAnimationFrame(pendingRafRef.current);
    }
    pendingRafRef.current = requestAnimationFrame(() => {
      pendingRafRef.current = null;
      evaluateSelection();
    });
  }, [evaluateSelection]);

  // mousedown 时检查是否点击在工具栏上
  const handleMouseDown = useCallback((e: MouseEvent) => {
    // 最速短路：工具栏未显示时无事可做——closest 命中的只可能是别的消息的
    // 工具栏（全局选区唯一，本实例不可见即选区不在本容器内），置不置
    // isToolbarInteraction 都不影响本实例 mouseup 评估的结果（评估后仍是清除态）
    if (!isVisibleRef.current) {
      return;
    }
    const target = e.target as Element;
    if (target.closest('[data-selection-toolbar]')) {
      isToolbarInteraction.current = true;
      return;
    }
    // 点击其他区域时清除
    clear();
  }, [clear]);

  // 滚动/窗口尺寸变化时隐藏（选区 rect 已失效）。
  // P1-10 触屏优化：触屏上系统选区在滚动后依然存在，"一滚就永久消失"会让
  // 工具栏很难点到——先隐藏，滚动停稳后重新评估选区并按新 rect 重新定位。
  const scrollSettleTimerRef = useRef<number | null>(null);
  const handleScroll = useCallback(() => {
    if (isTouchPrimaryPointer()) {
      // 最速短路：工具栏未显示、当前无选区且无待触发的停稳定时器时，
      // 停稳后重评估必然是无事可做的 clear 空转，直接返回避免长列表
      // 滚动时每条消息都做定时器续期。有选区时仍需续期定时器，
      // 保证 P1-10 的"滚动停稳后重新弹出"行为不变
      if (!isVisibleRef.current && scrollSettleTimerRef.current === null) {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
          return;
        }
      }
      if (isVisibleRef.current) {
        clear();
      }
      if (scrollSettleTimerRef.current !== null) {
        window.clearTimeout(scrollSettleTimerRef.current);
      }
      scrollSettleTimerRef.current = window.setTimeout(() => {
        scrollSettleTimerRef.current = null;
        evaluateSelection();
      }, 250);
      return;
    }
    if (isVisibleRef.current) {
      clear();
    }
  }, [clear, evaluateSelection]);

  // Escape 键关闭
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && isVisibleRef.current) {
      clear();
      window.getSelection()?.removeAllRanges();
    }
  }, [clear]);

  // 右键时隐藏浮动工具栏，让右键菜单独占
  const handleContextMenu = useCallback(() => {
    if (isVisibleRef.current) {
      clear();
    }
  }, [clear]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // mouseup 在 document 上监听（用户可能从容器内拖到外面）
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('contextmenu', handleContextMenu);

    // C-8: 触屏路径——长按选词/拖选择手柄不产生 mouseup，
    // 监听 selectionchange 并防抖，选区稳定后评估
    let selectionChangeTimer: number | null = null;
    const handleSelectionChange = () => {
      // ★ M4 修复：快速短路——直渲长列表时每条消息都挂着本监听，
      // 选区折叠（无选区）且工具栏未显示时直接返回，不进防抖/评估；
      // 选区存在但锚点不在本消息容器内（且工具栏未显示）同样跳过
      const sel = window.getSelection();
      const collapsed = !sel || sel.isCollapsed;
      if (!isVisibleRef.current) {
        if (collapsed) {
          if (selectionChangeTimer !== null) {
            window.clearTimeout(selectionChangeTimer);
            selectionChangeTimer = null;
          }
          return;
        }
        if (sel?.anchorNode && !container.contains(sel.anchorNode)) {
          return;
        }
      }
      if (selectionChangeTimer !== null) {
        window.clearTimeout(selectionChangeTimer);
      }
      selectionChangeTimer = window.setTimeout(() => {
        selectionChangeTimer = null;
        evaluateSelection();
      }, TOUCH_SELECTION_DEBOUNCE_MS);
    };
    const touchSelectionEnabled = isTouchPrimaryPointer();
    if (touchSelectionEnabled) {
      document.addEventListener('selectionchange', handleSelectionChange);
    }

    // 滚动监听：捕获阶段监听 document，任何滚动容器（聊天视口、嵌套代码块等）
    // 滚动都会让选区的视口 rect 失效，统一隐藏工具栏
    document.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    // 窗口 resize 时文本会重排，选区 rect 失效，直接隐藏
    window.addEventListener('resize', handleScroll);

    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('contextmenu', handleContextMenu);
      if (touchSelectionEnabled) {
        document.removeEventListener('selectionchange', handleSelectionChange);
        if (selectionChangeTimer !== null) {
          window.clearTimeout(selectionChangeTimer);
        }
      }
      document.removeEventListener('scroll', handleScroll, { capture: true });
      window.removeEventListener('resize', handleScroll);
      if (scrollSettleTimerRef.current !== null) {
        window.clearTimeout(scrollSettleTimerRef.current);
        scrollSettleTimerRef.current = null;
      }
      if (pendingRafRef.current !== null) {
        cancelAnimationFrame(pendingRafRef.current);
        pendingRafRef.current = null;
      }
    };
  }, [containerRef, handleMouseUp, handleMouseDown, handleScroll, handleKeyDown, handleContextMenu, evaluateSelection]);

  return { selectedText, selectionRect, isVisible, contextBefore, contextAfter, clear };
}
