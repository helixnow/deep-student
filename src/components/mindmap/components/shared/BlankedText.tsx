import React, { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { splitTextByRanges } from '../../utils/node/blankRanges';
import type { BlankRange } from '../../types';
import { BlankActionPopup } from './BlankActionPopup';

interface BlankedTextProps {
  text: string;
  blankedRanges?: BlankRange[];
  revealedIndices?: Record<number, boolean>;
  reciteMode: boolean;
  onRevealBlank?: (rangeIndex: number) => void;
  onAddBlank?: (range: BlankRange) => void;
  onRemoveBlank?: (rangeIndex: number) => void;
  className?: string;
  style?: React.CSSProperties;
}

export const BlankedText: React.FC<BlankedTextProps> = ({
  text,
  blankedRanges,
  revealedIndices,
  reciteMode,
  onRevealBlank,
  onAddBlank,
  onRemoveBlank,
  className,
  style,
}) => {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [popup, setPopup] = useState<{
    x: number;
    y: number;
    start: number;
    end: number;
    isAlreadyBlanked: boolean;
    overlappingRangeIndex: number;
  } | null>(null);

  const segments = splitTextByRanges(text, blankedRanges || []);

  const handleMouseUp = useCallback(() => {
    if (!reciteMode || !onAddBlank) return;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !containerRef.current) return;

    const range = sel.getRangeAt(0);
    if (!containerRef.current.contains(range.commonAncestorContainer)) return;

    // Calculate the selection range relative to the full text
    const walker = document.createTreeWalker(
      containerRef.current,
      NodeFilter.SHOW_TEXT,
      null,
    );

    let charOffset = 0;
    let startOffset = -1;
    let endOffset = -1;

    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (node === range.startContainer) {
        startOffset = charOffset + range.startOffset;
      }
      if (node === range.endContainer) {
        endOffset = charOffset + range.endOffset;
      }
      charOffset += node.length;
    }

    if (startOffset < 0 || endOffset < 0 || startOffset >= endOffset) {
      return;
    }

    // Check if the selection overlaps with an existing blank
    let isAlreadyBlanked = false;
    let overlappingRangeIndex = -1;
    if (blankedRanges) {
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.isBlanked && seg.rangeIndex >= 0) {
          const br = blankedRanges[seg.rangeIndex] || { start: 0, end: 0 };
          // Check overlap
          if (startOffset < br.end && endOffset > br.start) {
            isAlreadyBlanked = true;
            overlappingRangeIndex = seg.rangeIndex;
            break;
          }
        }
      }
    }

    // Position popup above selection
    const selRect = range.getBoundingClientRect();
    setPopup({
      x: selRect.left + selRect.width / 2,
      y: selRect.top,
      start: startOffset,
      end: endOffset,
      isAlreadyBlanked,
      overlappingRangeIndex,
    });
  }, [reciteMode, onAddBlank, blankedRanges, segments]);

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

  const handleClosePopup = useCallback(() => {
    setPopup(null);
  }, []);

  // 背诵模式下阻止 mousedown 冒泡，防止 ReactFlow 将文本选择拦截为节点拖拽
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (reciteMode) {
      e.stopPropagation();
    }
  }, [reciteMode]);

  return (
    <>
      <span
        ref={containerRef}
        className={cn(className, reciteMode && 'nopan nodrag')}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        style={{
          ...style,
          cursor: reciteMode ? 'text' : undefined,
          userSelect: reciteMode ? 'text' : undefined,
          WebkitUserSelect: reciteMode ? 'text' : undefined,
        }}
      >
        {segments.map((seg, i) => {
          if (!seg.isBlanked) {
            return <span key={i}>{seg.text}</span>;
          }

          const isRevealed = revealedIndices?.[seg.rangeIndex] ?? false;

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
              title={reciteMode ? undefined : undefined}
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
          onBlank={handleBlank}
          onUnblank={handleUnblank}
          onClose={handleClosePopup}
        />
      )}
    </>
  );
};
