/**
 * iframe 内的文本选区（EPUB 等以 srcdoc iframe 渲染正文的阅读器）。
 *
 * 与 useTextSelection 同形：选区矩形换算到宿主视口坐标（iframe 偏移 + 选区在 iframe 内的矩形），
 * 可直接交给共享 SelectionToolbar 定位。iframe 重新加载（翻章）后自动重新挂监听。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { SelectionRect, TextSelectionState } from './useTextSelection';

const MIN_SELECTION_LENGTH = 2;
const CONTEXT_WINDOW = 200;
const SELECTION_SETTLE_MS = 150;

export function useIframeTextSelection(
  /** iframe 元素本身（用回调 ref 记进 state）：元素挂载 / 重建时自动重新挂监听 */
  frame: HTMLIFrameElement | null,
): TextSelectionState {
  const [selectedText, setSelectedText] = useState('');
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [contextBefore, setContextBefore] = useState('');
  const [contextAfter, setContextAfter] = useState('');
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    setSelectedText('');
    setSelectionRect(null);
    setIsVisible(false);
    setContextBefore('');
    setContextAfter('');
  }, []);

  const clear = useCallback(() => {
    reset();
    try {
      frame?.contentWindow?.getSelection()?.removeAllRanges();
    } catch {
      // 跨源 / 已卸载：忽略
    }
  }, [frame, reset]);

  useEffect(() => {
    if (!frame) return;
    let detach = () => {};

    const evaluate = () => {
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      const selection = win?.getSelection();
      if (!doc || !selection || selection.isCollapsed || selection.rangeCount === 0) {
        reset();
        return;
      }
      const text = selection.toString().trim();
      if (text.length < MIN_SELECTION_LENGTH) {
        reset();
        return;
      }
      const range = selection.getRangeAt(0);
      const inner = range.getBoundingClientRect();
      const outer = frame.getBoundingClientRect();
      setSelectedText(text);
      setSelectionRect({
        top: outer.top + inner.top,
        left: outer.left + inner.left,
        width: inner.width,
        height: inner.height,
        bottom: outer.top + inner.bottom,
      });
      const full = doc.body?.textContent ?? '';
      const index = full.indexOf(text);
      setContextBefore(index > 0 ? full.slice(Math.max(0, index - CONTEXT_WINDOW), index) : '');
      setContextAfter(index >= 0 ? full.slice(index + text.length, index + text.length + CONTEXT_WINDOW) : '');
      setIsVisible(true);
    };

    const schedule = (delay: number) => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(evaluate, delay);
    };

    const attach = () => {
      detach();
      const doc = frame.contentDocument;
      const win = frame.contentWindow;
      if (!doc || !win) return;
      const onPointerUp = () => schedule(0);
      const onSelectionChange = () => schedule(SELECTION_SETTLE_MS);
      // 正文滚动时工具条跟随选区（或在选区滚出后由 evaluate 继续给出新位置）
      const onScroll = () => schedule(0);
      doc.addEventListener('mouseup', onPointerUp);
      doc.addEventListener('keyup', onPointerUp);
      doc.addEventListener('touchend', onPointerUp);
      doc.addEventListener('selectionchange', onSelectionChange);
      win.addEventListener('scroll', onScroll, { passive: true });
      detach = () => {
        doc.removeEventListener('mouseup', onPointerUp);
        doc.removeEventListener('keyup', onPointerUp);
        doc.removeEventListener('touchend', onPointerUp);
        doc.removeEventListener('selectionchange', onSelectionChange);
        win.removeEventListener('scroll', onScroll);
      };
    };

    const onLoad = () => {
      reset();
      attach();
    };
    attach();
    frame.addEventListener('load', onLoad);
    return () => {
      frame.removeEventListener('load', onLoad);
      detach();
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    };
  }, [frame, reset]);

  return { selectedText, selectionRect, isVisible, contextBefore, contextAfter, clear };
}
