import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { splitTextByRanges } from '../../utils/node/blankRanges';
import type { BlankRange } from '../../types';
import { BlankActionPopup } from './BlankActionPopup';

function getSelectionOffsets(container: HTMLElement, range: Range): { start: number; end: number } | null {
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return null;
  }

  // WebKit may expose element-boundary containers for a visual text selection.
  // Measuring the prefix ranges works for both element and text-node boundaries.
  const startRange = document.createRange();
  startRange.selectNodeContents(container);
  startRange.setEnd(range.startContainer, range.startOffset);

  const endRange = document.createRange();
  endRange.selectNodeContents(container);
  endRange.setEnd(range.endContainer, range.endOffset);

  const start = startRange.toString().length;
  const end = endRange.toString().length;
  return start < end ? { start, end } : null;
}

/** 遮盖态挖空需在视口内驻留多久才算「实际呈现」（防滚动扫过误计成功样本） */
const BLANK_PRESENT_DWELL_MS = 500;

interface BlankedTextProps {
  text: string;
  blankedRanges?: BlankRange[];
  revealedIndices?: Record<number, boolean>;
  reciteMode: boolean;
  /** 非背诵时也允许选区弹出「加粗 | 标记挖空」 */
  allowSelectionActions?: boolean;
  isBold?: boolean;
  onRevealBlank?: (rangeIndex: number) => void;
  /**
   * 背诵会话统计的「实际呈现」信号：遮盖态挖空渲染进视口并驻留
   * BLANK_PRESENT_DWELL_MS 后，上报当前仍处于遮盖态的区间索引。
   * 只有呈现过的空才会在退出背诵时作为作答样本提交。
   */
  onBlanksPresented?: (rangeIndices: number[]) => void;
  onAddBlank?: (range: BlankRange) => void;
  onRemoveBlank?: (rangeIndex: number) => void;
  onToggleBold?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export const BlankedText: React.FC<BlankedTextProps> = ({
  text,
  blankedRanges,
  revealedIndices,
  reciteMode,
  allowSelectionActions = false,
  isBold = false,
  onRevealBlank,
  onBlanksPresented,
  onAddBlank,
  onRemoveBlank,
  onToggleBold,
  className,
  style,
}) => {
  const containerRef = useRef<HTMLSpanElement>(null);
  const selectionFrameRef = useRef<number | null>(null);
  const [popup, setPopup] = useState<{
    x: number;
    y: number;
    start: number;
    end: number;
    isAlreadyBlanked: boolean;
    overlappingRangeIndex: number;
  } | null>(null);

  const segments = splitTextByRanges(text, blankedRanges || []);

  // 「实际呈现」信号：遮盖态挖空在视口内稳定驻留后上报一次。
  // 用逗号串做依赖键，避免每次渲染新数组导致 effect 反复重挂。
  const coveredIndicesKey = reciteMode && onBlanksPresented
    ? segments
      .filter((seg) => seg.isBlanked && !(revealedIndices?.[seg.rangeIndex] ?? false))
      .map((seg) => seg.rangeIndex)
      .join(',')
    : '';
  const onBlanksPresentedRef = useRef(onBlanksPresented);
  onBlanksPresentedRef.current = onBlanksPresented;
  useEffect(() => {
    if (!reciteMode || coveredIndicesKey === '') return;
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const indices = coveredIndicesKey.split(',').map(Number);
    let dwellTimer: number | null = null;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (visible && dwellTimer == null) {
        dwellTimer = window.setTimeout(() => {
          dwellTimer = null;
          onBlanksPresentedRef.current?.(indices);
        }, BLANK_PRESENT_DWELL_MS);
      } else if (!visible && dwellTimer != null) {
        window.clearTimeout(dwellTimer);
        dwellTimer = null;
      }
    }, { threshold: 0.5 });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (dwellTimer != null) window.clearTimeout(dwellTimer);
    };
  }, [reciteMode, coveredIndicesKey]);

  const selectionEnabled = !!onAddBlank && (reciteMode || allowSelectionActions);
  const selectableTextStyle: React.CSSProperties | undefined = selectionEnabled
    ? { userSelect: 'text', WebkitUserSelect: 'text' }
    : undefined;

  const openPopupForCurrentSelection = useCallback((anchor?: { x: number; y: number }): boolean => {
    selectionFrameRef.current = null;
    if (!selectionEnabled || !onAddBlank) return false;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !containerRef.current) return false;

    const range = sel.getRangeAt(0);
    const offsets = getSelectionOffsets(containerRef.current, range);
    if (!offsets) return false;
    const { start: startOffset, end: endOffset } = offsets;

    let isAlreadyBlanked = false;
    let overlappingRangeIndex = -1;
    if (blankedRanges) {
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.isBlanked && seg.rangeIndex >= 0) {
          const br = blankedRanges[seg.rangeIndex] || { start: 0, end: 0 };
          if (startOffset < br.end && endOffset > br.start) {
            isAlreadyBlanked = true;
            overlappingRangeIndex = seg.rangeIndex;
            break;
          }
        }
      }
    }

    const selRect = range.getBoundingClientRect();
    setPopup({
      x: anchor?.x ?? selRect.left + selRect.width / 2,
      y: anchor?.y ?? selRect.top,
      start: startOffset,
      end: endOffset,
      isAlreadyBlanked,
      overlappingRangeIndex,
    });
    return true;
  }, [selectionEnabled, onAddBlank, blankedRanges, segments]);

  const scheduleSelectionPopup = useCallback(() => {
    if (!selectionEnabled) return;
    if (selectionFrameRef.current != null) {
      window.cancelAnimationFrame(selectionFrameRef.current);
    }
    selectionFrameRef.current = window.requestAnimationFrame(() => {
      openPopupForCurrentSelection();
    });
  }, [selectionEnabled, openPopupForCurrentSelection]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!selectionEnabled) return;
    if (selectionFrameRef.current != null) {
      window.cancelAnimationFrame(selectionFrameRef.current);
      selectionFrameRef.current = null;
    }
    if (openPopupForCurrentSelection({ x: e.clientX, y: e.clientY })) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, [selectionEnabled, openPopupForCurrentSelection]);

  useEffect(() => () => {
    if (selectionFrameRef.current != null) {
      window.cancelAnimationFrame(selectionFrameRef.current);
    }
  }, []);

  const handleBlank = useCallback(() => {
    if (!popup || !onAddBlank) return;
    onAddBlank({ start: popup.start, end: popup.end });
    setPopup(null);
    window.getSelection()?.removeAllRanges();
  }, [popup, onAddBlank]);

  const handleUnblank = useCallback(() => {
    if (!popup || popup.overlappingRangeIndex < 0 || !onRemoveBlank) return;
    onRemoveBlank(popup.overlappingRangeIndex);
    setPopup(null);
    window.getSelection()?.removeAllRanges();
  }, [popup, onRemoveBlank]);

  const handleToggleBold = useCallback(() => {
    onToggleBold?.();
    setPopup(null);
    window.getSelection()?.removeAllRanges();
  }, [onToggleBold]);

  const handleClosePopup = useCallback(() => {
    setPopup(null);
  }, []);

  // 选区模式下阻止 mousedown 冒泡，防止 ReactFlow 将文本选择拦截为节点拖拽
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (selectionEnabled) {
      e.stopPropagation();
    }
  }, [selectionEnabled]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (selectionEnabled) {
      e.stopPropagation();
    }
  }, [selectionEnabled]);

  return (
    <>
      <span
        ref={containerRef}
        className={cn(className, selectionEnabled && 'nopan nodrag')}
        onPointerDown={handlePointerDown}
        onPointerUp={scheduleSelectionPopup}
        onMouseDown={handleMouseDown}
        onMouseUp={scheduleSelectionPopup}
        onContextMenu={handleContextMenu}
        style={{
          ...style,
          cursor: selectionEnabled ? 'text' : undefined,
          userSelect: selectionEnabled ? 'text' : undefined,
          WebkitUserSelect: selectionEnabled ? 'text' : undefined,
        }}
      >
        {segments.map((seg, i) => {
          if (!seg.isBlanked) {
            return (
              <span
                key={i}
                className="mm-blankable-text-segment"
                style={selectableTextStyle}
              >
                {seg.text}
              </span>
            );
          }

          const isRevealed = revealedIndices?.[seg.rangeIndex] ?? false;

          // 非背诵：挖空区间用下划虚线标记，不遮挡正文
          if (!reciteMode) {
            return (
              <span
                key={i}
                className="border-b border-dashed border-amber-500/70 rounded-sm px-0.5"
                title={seg.text}
              >
                {seg.text}
              </span>
            );
          }

          if (isRevealed) {
            return (
              <span
                key={i}
                className="bg-emerald-100 dark:bg-emerald-900/30 rounded-sm px-0.5 transition-colors duration-300"
              >
                {seg.text}
              </span>
            );
          }

          return (
            <span
              key={i}
              className="bg-current rounded-sm px-0.5 cursor-pointer select-none"
              style={{ color: 'var(--mm-text)', WebkitTextFillColor: 'transparent' }}
              onClick={(e) => {
                e.stopPropagation();
                onRevealBlank?.(seg.rangeIndex);
              }}
            >
              {seg.text}
            </span>
          );
        })}
      </span>

      {popup && (
        <BlankActionPopup
          x={popup.x}
          y={popup.y}
          isAlreadyBlanked={popup.isAlreadyBlanked}
          mode={reciteMode ? 'recite' : 'edit'}
          isBold={isBold}
          onBlank={handleBlank}
          onUnblank={handleUnblank}
          onToggleBold={!reciteMode && onToggleBold ? handleToggleBold : undefined}
          onClose={handleClosePopup}
        />
      )}
    </>
  );
};
