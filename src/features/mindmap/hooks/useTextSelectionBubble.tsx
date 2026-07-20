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

/** 镜像 div 需要复制的排版相关样式（决定换行与字符定位） */
const MIRROR_STYLE_PROPS = [
  'boxSizing',
  'width',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
  'lineHeight', 'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent',
  'whiteSpace', 'wordBreak', 'overflowWrap', 'tabSize', 'direction', 'textAlign',
] as const;

/**
 * 镜像 div 测量选区矩形：把 textarea/input 的排版样式复制到隐藏 div，
 * 选区部分用 span 包裹后测量其相对位置，再映射回控件视口坐标。
 * 比字符宽度启发式准确（正确处理换行、CJK/西文混排、字号样式）。
 */
function measureSelectionByMirror(
  el: HTMLTextAreaElement | HTMLInputElement,
  start: number,
  end: number,
): { x: number; y: number } | null {
  const doc = el.ownerDocument;
  const computed = window.getComputedStyle(el);
  const mirror = doc.createElement('div');
  const mirrorStyle = mirror.style;

  mirrorStyle.position = 'fixed';
  mirrorStyle.top = '0';
  mirrorStyle.left = '-9999px';
  mirrorStyle.visibility = 'hidden';
  mirrorStyle.pointerEvents = 'none';
  mirrorStyle.overflow = 'hidden';
  for (const prop of MIRROR_STYLE_PROPS) {
    mirrorStyle[prop as 'width'] = computed[prop as 'width'];
  }
  const isInput = el instanceof HTMLInputElement;
  if (isInput) {
    // 单行输入框不换行
    mirrorStyle.whiteSpace = 'pre';
  } else if (mirrorStyle.whiteSpace === 'normal' || !mirrorStyle.whiteSpace) {
    // textarea 内容按 pre-wrap 排版
    mirrorStyle.whiteSpace = 'pre-wrap';
  }

  const value = el.value;
  mirror.textContent = value.slice(0, start);
  const marker = doc.createElement('span');
  marker.textContent = value.slice(start, end) || '\u200b';
  mirror.appendChild(marker);
  // 选区后的文本也要保留，避免最后一行排版差异
  mirror.appendChild(doc.createTextNode(value.slice(end)));

  doc.body.appendChild(mirror);
  try {
    const mirrorRect = mirror.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    if (markerRect.width === 0 && markerRect.height === 0) return null;
    const elRect = el.getBoundingClientRect();
    // 镜像内偏移 → 控件视口坐标（扣除控件自身滚动）
    const x = elRect.left + (markerRect.left - mirrorRect.left) + markerRect.width / 2
      - (isInput ? el.scrollLeft : (el as HTMLTextAreaElement).scrollLeft);
    const y = elRect.top + (markerRect.top - mirrorRect.top) - el.scrollTop;
    // 钳位到控件可视范围内，滚出可视区时贴边
    return {
      x: Math.min(Math.max(x, elRect.left + 4), elRect.right - 4),
      y: Math.min(Math.max(y, elRect.top), elRect.bottom),
    };
  } finally {
    doc.body.removeChild(mirror);
  }
}

function selectionPopupPoint(
  el: HTMLTextAreaElement | HTMLInputElement,
  start: number,
  end: number,
): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  // 优先用当前选区 client rect（部分浏览器可直接拿到 textarea 内部选区）
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
  // 镜像 div 测量（准确处理换行与混排）
  try {
    const measured = measureSelectionByMirror(el, start, end);
    if (measured) return measured;
  } catch {
    /* ignore */
  }
  // 最终兜底：控件顶部中点
  return { x: rect.left + rect.width / 2, y: rect.top };
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

  // mouseup / touchend 共用：触屏上 selection 在 touchend 后一拍才稳定，
  // 统一延迟到下一宏任务读取，两种输入都取到最终选区。
  const handleMouseUp = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      if (!onAddBlank && !onToggleBold) return;
      const el = e.currentTarget;
      window.setTimeout(() => {
        if (!el.isConnected) return;
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
      }, 0);
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
