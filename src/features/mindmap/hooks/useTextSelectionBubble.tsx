/**
 * 文本框选区气泡：mouseup 后若有选区则弹出 BlankActionPopup（加粗 + 标记挖空）。
 */
import { useCallback, useState } from 'react';
import type { BlankRange } from '../types';
import { BlankActionPopup } from '../components/shared/BlankActionPopup';

export interface TextSelectionBubbleState {
  x: number;
  y: number;
  start: number;
  end: number;
  isAlreadyBlanked: boolean;
  overlappingRangeIndex: number;
}

function findOverlappingBlank(
  start: number,
  end: number,
  blankedRanges?: BlankRange[],
): { isAlreadyBlanked: boolean; overlappingRangeIndex: number } {
  if (!blankedRanges?.length) {
    return { isAlreadyBlanked: false, overlappingRangeIndex: -1 };
  }
  for (let i = 0; i < blankedRanges.length; i++) {
    const br = blankedRanges[i];
    if (start < br.end && end > br.start) {
      return { isAlreadyBlanked: true, overlappingRangeIndex: i };
    }
  }
  return { isAlreadyBlanked: false, overlappingRangeIndex: -1 };
}

function selectionPopupPoint(
  el: HTMLTextAreaElement | HTMLInputElement,
  start: number,
  end: number,
): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  // 优先用当前选区 client rect（比字符启发式准）
  try {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      if (el.contains(range.commonAncestorContainer) || el === range.commonAncestorContainer) {
        const r = range.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) {
          return { x: r.left + r.width / 2, y: r.top };
        }
      }
    }
  } catch {
    /* ignore */
  }
  const mid = (start + end) / 2;
  const approx = Math.min(rect.width - 8, Math.max(8, mid * 7));
  return { x: rect.left + approx, y: rect.top };
}

export function useTextSelectionBubble(options: {
  blankedRanges?: BlankRange[];
  isBold?: boolean;
  /** 提交当前编辑框文本（挖空前对齐索引）；应保留已有挖空或由调用方随后写入 */
  onCommitLiveText?: (text: string) => void;
  onAddBlank?: (range: BlankRange) => void;
  onRemoveBlank?: (rangeIndex: number) => void;
  onToggleBold?: () => void;
}) {
  const { blankedRanges, isBold, onCommitLiveText, onAddBlank, onRemoveBlank, onToggleBold } =
    options;
  const [popup, setPopup] = useState<TextSelectionBubbleState | null>(null);

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      if (!onAddBlank && !onToggleBold) return;
      const el = e.currentTarget;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      if (start >= end) {
        setPopup(null);
        return;
      }
      const overlap = findOverlappingBlank(start, end, blankedRanges);
      const point = selectionPopupPoint(el, start, end);
      setPopup({
        x: point.x,
        y: point.y,
        start,
        end,
        ...overlap,
      });
    },
    [blankedRanges, onAddBlank, onToggleBold],
  );

  const close = useCallback(() => setPopup(null), []);

  const bubble =
    popup && (onAddBlank || onToggleBold) ? (
      <BlankActionPopup
        x={popup.x}
        y={popup.y}
        isAlreadyBlanked={popup.isAlreadyBlanked}
        mode="edit"
        isBold={isBold}
        onBlank={() => {
          const active = document.activeElement;
          if (
            active &&
            (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)
          ) {
            onCommitLiveText?.(active.value);
          }
          onAddBlank?.({ start: popup.start, end: popup.end });
          setPopup(null);
        }}
        onUnblank={() => {
          if (popup.overlappingRangeIndex >= 0) {
            onRemoveBlank?.(popup.overlappingRangeIndex);
          }
          setPopup(null);
        }}
        onToggleBold={
          onToggleBold
            ? () => {
                onToggleBold();
                setPopup(null);
              }
            : undefined
        }
        onClose={close}
      />
    ) : null;

  return { handleMouseUp, bubble, close };
}
