/**
 * useTextSelection - 文本选择状态检测 Hook
 *
 * 监听 mouseup 事件，检测选中文本并计算选区位置，
 * 用于驱动浮动工具栏的显示和定位。
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

  const clear = useCallback(() => {
    setSelectedText('');
    setSelectionRect(null);
    setIsVisible(false);
    setContextBefore('');
    setContextAfter('');
  }, []);

  // 检测选中文本
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
    requestAnimationFrame(() => {
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
    });
  }, [containerRef, clear]);

  // mousedown 时检查是否点击在工具栏上
  const handleMouseDown = useCallback((e: MouseEvent) => {
    const target = e.target as Element;
    if (target.closest('[data-selection-toolbar]')) {
      isToolbarInteraction.current = true;
      return;
    }
    // 点击其他区域时清除
    if (isVisible) {
      clear();
    }
  }, [isVisible, clear]);

  // 滚动时隐藏
  const handleScroll = useCallback(() => {
    if (isVisible) {
      clear();
    }
  }, [isVisible, clear]);

  // Escape 键关闭
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && isVisible) {
      clear();
      window.getSelection()?.removeAllRanges();
    }
  }, [isVisible, clear]);

  // 右键时隐藏浮动工具栏，让右键菜单独占
  const handleContextMenu = useCallback(() => {
    if (isVisible) {
      clear();
    }
  }, [isVisible, clear]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // mouseup 在 document 上监听（用户可能从容器内拖到外面）
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('contextmenu', handleContextMenu);

    // 滚动监听：找到最近的可滚动父元素
    const scrollParent = container.closest('.chat-history-viewport') || container.parentElement;
    scrollParent?.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('contextmenu', handleContextMenu);
      scrollParent?.removeEventListener('scroll', handleScroll);
    };
  }, [containerRef, handleMouseUp, handleMouseDown, handleScroll, handleKeyDown, handleContextMenu]);

  return { selectedText, selectionRect, isVisible, contextBefore, contextAfter, clear };
}
