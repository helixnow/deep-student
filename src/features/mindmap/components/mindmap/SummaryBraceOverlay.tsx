/**
 * 归纳总结大括号 `}` SVG 浮层（SummaryBraceOverlay，C7 §3.3）
 *
 * 挂载在 `<ViewportPortal>` 内，直接使用导图布局引擎产出的 flow 坐标绘制确定性三次贝塞尔
 * 大括号与可点击编辑标签胶囊，不引入自由连线画布的混乱状态。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import type { LayoutDirection, MindMapNode, MindMapSummaryBrace } from '../../types';
import {
  computeSummaryBraceGeometry,
  type NodeBoxGeometry,
  type SummaryBraceOrientation,
} from '../../utils/summaryBraces';
import '../../styles/mn5-excerpt.css';

export interface SummaryBraceOverlayProps {
  summaries: readonly MindMapSummaryBrace[] | undefined;
  root: MindMapNode;
  layoutNodeById: ReadonlyMap<
    string,
    { position: { x: number; y: number }; width?: number; height?: number }
  >;
  direction: LayoutDirection;
  readonly?: boolean;
  onUpdateLabel?: (id: string, label: string) => void;
  onRemove?: (id: string) => void;
}

const stopEvent = (e: React.SyntheticEvent) => {
  e.stopPropagation();
};

function labelTransformForOrientation(orientation: SummaryBraceOrientation): string {
  switch (orientation) {
    case 'right':
      return 'translate(0, -50%)';
    case 'left':
      return 'translate(-100%, -50%)';
    case 'down':
      return 'translate(-50%, 0)';
    case 'up':
      return 'translate(-50%, -100%)';
  }
}

export const SummaryBraceOverlay: React.FC<SummaryBraceOverlayProps> = ({
  summaries,
  root,
  layoutNodeById,
  direction,
  readonly = false,
  onUpdateLabel,
  onRemove,
}) => {
  const { t } = useTranslation('mindmap');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef<string | null>(null);

  const boxMap = useMemo(() => {
    const map = new Map<string, NodeBoxGeometry>();
    for (const [id, laid] of layoutNodeById.entries()) {
      map.set(id, {
        x: laid.position.x,
        y: laid.position.y,
        width: laid.width ?? 120,
        height: laid.height ?? 36,
      });
    }
    return map;
  }, [layoutNodeById]);

  const geometries = useMemo(() => {
    if (!summaries?.length) return [];
    return summaries
      .map((item) => computeSummaryBraceGeometry(item, root, boxMap, direction))
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }, [boxMap, direction, root, summaries]);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const commitEdit = useCallback(
    (id: string) => {
      if (editingRef.current !== id) return;
      editingRef.current = null;
      const trimmed = draftLabel.trim();
      if (trimmed) {
        onUpdateLabel?.(id, trimmed);
      }
      setEditingId(null);
    },
    [draftLabel, onUpdateLabel],
  );

  if (geometries.length === 0) return null;

  return (
    <div
      className="pointer-events-none"
      style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible' }}
      data-testid="mm-summary-brace-overlay"
    >
      <svg
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 1,
          height: 1,
          overflow: 'visible',
          pointerEvents: 'none',
        }}
        aria-hidden="true"
      >
        {geometries.map((geom) => (
          <path
            key={geom.id}
            d={geom.path}
            className="mm-mn5-summary-brace-path"
            data-summary-id={geom.id}
          />
        ))}
      </svg>

      {geometries.map((geom) => {
        const isEditing = editingId === geom.id && !readonly;
        return (
          <div
            key={geom.id}
            className={cn('mm-mn5-summary-pill group nodrag nopan')}
            style={{
              left: geom.labelX,
              top: geom.labelY,
              transform: labelTransformForOrientation(geom.orientation),
            }}
            onPointerDown={stopEvent}
            onMouseDown={stopEvent}
            onClick={stopEvent}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (readonly || !onUpdateLabel) return;
              setDraftLabel(geom.label);
              editingRef.current = geom.id;
              setEditingId(geom.id);
            }}
            data-testid="mm-summary-brace-pill"
            data-summary-id={geom.id}
          >
            <span className="mm-mn5-status-dot" aria-hidden="true" />
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={draftLabel}
                onChange={(e) => setDraftLabel(e.target.value)}
                onBlur={() => commitEdit(geom.id)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitEdit(geom.id);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    editingRef.current = null;
                    setEditingId(null);
                  }
                }}
                placeholder={t('mn5.summaryPlaceholder')}
                className="min-w-[96px] max-w-[180px] bg-transparent text-xs text-[var(--mm-text)] outline-none border-b border-[var(--mm-celadon-accent)]"
                data-testid="mm-summary-brace-input"
              />
            ) : (
              <button
                type="button"
                className="text-left text-xs text-[var(--mm-text)] truncate max-w-[190px]"
                onClick={(e) => {
                  e.stopPropagation();
                  if (readonly || !onUpdateLabel) return;
                  setDraftLabel(geom.label);
                  editingRef.current = geom.id;
                  setEditingId(geom.id);
                }}
              >
                {geom.label || t('mn5.summaryDefaultLabel')}
              </button>
            )}
            {!readonly && onRemove && (
              <button
                type="button"
                className="opacity-0 group-hover:opacity-80 hover:!opacity-100 focus:opacity-100 inline-flex items-center justify-center w-4 h-4 rounded text-[var(--mm-text-muted)] hover:text-[var(--mm-text)] transition-opacity"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(geom.id);
                }}
                title={t('mn5.removeSummaryBrace')}
                aria-label={t('mn5.removeSummaryBrace')}
                data-testid="mm-summary-brace-remove"
              >
                <X size={10} weight="bold" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default SummaryBraceOverlay;
