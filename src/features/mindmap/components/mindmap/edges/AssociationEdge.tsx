import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { isOutlineCompositionActive } from '../../../utils/outlineCaret';
import './associationEdge.css';

export type AssociationEdgeData = {
  kind: 'association';
  associationId: string;
  label?: string;
  editing?: boolean;
  onLabelChange?: (associationId: string, label: string) => void;
  onLabelEditEnd?: (associationId: string) => void;
  onLabelEditStart?: (associationId: string) => void;
};

/**
 * Xmind 式跨分支关联线：虚线贝塞尔，色弱于树边，支持居中标签与选中加粗。
 */
export const AssociationEdge: React.FC<EdgeProps> = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  selected,
  data,
  markerEnd,
  interactionWidth,
}) => {
  const { t } = useTranslation('mindmap');
  const edgeData = data as AssociationEdgeData | undefined;
  const associationId = edgeData?.associationId ?? id;
  const label = edgeData?.label ?? '';
  const isEditing = !!edgeData?.editing;

  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      setDraft(label);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isEditing, label]);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const commit = useCallback(() => {
    edgeData?.onLabelChange?.(associationId, draft);
    edgeData?.onLabelEditEnd?.(associationId);
  }, [associationId, draft, edgeData]);

  const cancel = useCallback(() => {
    setDraft(label);
    edgeData?.onLabelEditEnd?.(associationId);
  }, [associationId, edgeData, label]);

  const stroke =
    (style?.stroke as string | undefined) ??
    'var(--mm-association-stroke, var(--mm-text-muted))';
  const strokeWidth = selected
    ? Math.max(Number(style?.strokeWidth ?? 1.5) + 1, 2.5)
    : Number(style?.strokeWidth ?? 1.5);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth ?? 20}
        className={selected ? 'mm-association-edge is-selected' : 'mm-association-edge'}
        style={{
          ...style,
          stroke,
          strokeWidth,
          strokeDasharray: (style?.strokeDasharray as string | undefined) ?? '6 4',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          fill: 'none',
          opacity: selected ? 1 : (typeof style?.opacity === 'number' ? style.opacity : 0.72),
        }}
      />
      {(isEditing || !!label || selected) && (
        <EdgeLabelRenderer>
          <div
            className={`mm-association-label${selected ? ' is-selected' : ''}${isEditing ? ' is-editing' : ''}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              edgeData?.onLabelEditStart?.(associationId);
            }}
          >
            {isEditing ? (
              <input
                ref={inputRef}
                className="mm-association-label-input"
                value={draft}
                placeholder={t('association.labelPlaceholder', { defaultValue: '标签' })}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  // IME 组字中 Enter/Escape 属于输入法按键，不提交标签
                  if (isOutlineCompositionActive(e.nativeEvent)) return;
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commit();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancel();
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className={label ? undefined : 'mm-association-label-empty'}>
                {label || t('association.doubleClickHint', { defaultValue: '双击编辑' })}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
};
