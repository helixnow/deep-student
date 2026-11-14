import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import {
  acceptMindmapSuggestionBranch,
  rejectMindmapSuggestionBranch,
} from '@/stores/mindmapSuggestionStore';
import {
  getMindmapSuggestion,
  subscribeMindmapSuggestions,
} from '@/stores/mindmapSuggestionStore';
import { useMindMapStore } from '../../store';
import { computeGhostCanvasProjection, type RenderedNodeBox } from './ghostProjection';
import '../../styles/ghost-proposal.css';

// ============================================================================
// Props 定义
// ============================================================================

export interface MindMapGhostProposalLayerProps {
  hostRef: React.RefObject<HTMLElement | null>;
}

interface BranchActionCapsuleProps {
  branchId: string;
  acceptLabel: string;
  rejectLabel: string;
  disabled: boolean;
  onAccept: (branchId: string) => void;
  onReject: (branchId: string) => void;
}

function stopCanvasPropagation(e: React.SyntheticEvent): void {
  e.stopPropagation();
}

const BranchActionCapsule: React.FC<BranchActionCapsuleProps> = ({
  branchId,
  acceptLabel,
  rejectLabel,
  disabled,
  onAccept,
  onReject,
}) => (
  <span
    className="mm-ghost-action-capsule nodrag nopan pointer-events-auto"
    onPointerDown={stopCanvasPropagation}
    onMouseDown={stopCanvasPropagation}
    onDoubleClick={stopCanvasPropagation}
    onClick={stopCanvasPropagation}
  >
    <button
      type="button"
      className="mm-ghost-action-btn nodrag nopan pointer-events-auto"
      disabled={disabled}
      onPointerDown={stopCanvasPropagation}
      onMouseDown={stopCanvasPropagation}
      onDoubleClick={stopCanvasPropagation}
      onClick={(e) => {
        e.stopPropagation();
        onAccept(branchId);
      }}
      aria-label={acceptLabel}
    >
      <Check size={12} weight="bold" className="shrink-0" />
      <span>{acceptLabel}</span>
    </button>
    <button
      type="button"
      className="mm-ghost-action-btn mm-ghost-action-btn--reject nodrag nopan pointer-events-auto"
      disabled={disabled}
      onPointerDown={stopCanvasPropagation}
      onMouseDown={stopCanvasPropagation}
      onDoubleClick={stopCanvasPropagation}
      onClick={(e) => {
        e.stopPropagation();
        onReject(branchId);
      }}
      aria-label={rejectLabel}
    >
      <X size={12} weight="bold" className="shrink-0" />
      <span>{rejectLabel}</span>
    </button>
  </span>
);

function extractRenderedPositions(
  reactFlowGetter: (() => { getNodes: () => unknown[] }) | null,
): Map<string, RenderedNodeBox> {
  const map = new Map<string, RenderedNodeBox>();
  if (!reactFlowGetter) return map;
  try {
    const rawNodes = reactFlowGetter()?.getNodes?.();
    if (!Array.isArray(rawNodes)) return map;
    for (const raw of rawNodes) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as {
        id?: unknown;
        position?: { x?: unknown; y?: unknown };
        measured?: { width?: unknown; height?: unknown };
        width?: unknown;
        height?: unknown;
      };
      if (typeof item.id !== 'string') continue;
      const x = item.position?.x;
      const y = item.position?.y;
      const width =
        typeof item.measured?.width === 'number' && item.measured.width > 0
          ? item.measured.width
          : typeof item.width === 'number' && item.width > 0
            ? item.width
            : undefined;
      const height =
        typeof item.measured?.height === 'number' && item.measured.height > 0
          ? item.measured.height
          : typeof item.height === 'number' && item.height > 0
            ? item.height
            : undefined;
      if (
        typeof x === 'number' &&
        Number.isFinite(x) &&
        typeof y === 'number' &&
        Number.isFinite(y) &&
        width !== undefined &&
        height !== undefined
      ) {
        map.set(item.id, { x, y, width, height });
      }
    }
  } catch {
    // 忽略卸载期 getter 异常
  }
  return map;
}

// ============================================================================
// 组件实现
// ============================================================================

export const MindMapGhostProposalLayer: React.FC<MindMapGhostProposalLayerProps> = ({
  hostRef,
}) => {
  const { t } = useTranslation('graph_conflict');
  const markerUid = useId().replace(/:/g, '');
  const arrowMarkerId = `mm-ghost-arrow-${markerUid}`;

  const mindmapId = useMindMapStore((s) => s.mindmapId);
  const root = useMindMapStore((s) => s.document.root);
  const viewRootId = useMindMapStore((s) => s.viewRootId);
  const layoutId = useMindMapStore((s) => s.layoutId);
  const layoutDirection = useMindMapStore((s) => s.layoutDirection);
  const measuredNodeHeights = useMindMapStore((s) => s.measuredNodeHeights);
  const reciteMode = useMindMapStore((s) => s.reciteMode);
  const reactFlowGetter = useMindMapStore((s) => s._reactFlowGetter);

  const [suggestionVersion, setSuggestionVersion] = useState(0);
  const [busyBranchId, setBusyBranchId] = useState<string | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!mindmapId) return undefined;
    return subscribeMindmapSuggestions((changedId) => {
      if (changedId === mindmapId) {
        setSuggestionVersion((v) => v + 1);
      }
    });
  }, [mindmapId]);

  const suggestion = useMemo(() => {
    void suggestionVersion;
    return mindmapId ? getMindmapSuggestion(mindmapId) : null;
  }, [mindmapId, suggestionVersion]);

  const syncPortalTarget = useCallback(() => {
    if (!mindmapId || reciteMode || !suggestion) {
      setPortalTarget((prev) => (prev === null ? prev : null));
      return;
    }
    const hostEl = hostRef.current;
    if (!hostEl) {
      setPortalTarget((prev) => (prev === null ? prev : null));
      return;
    }
    const vp = hostEl.querySelector('.react-flow__viewport') as HTMLElement | null;
    const next = vp ?? hostEl;
    setPortalTarget((prev) => (prev === next ? prev : next));
  }, [hostRef, mindmapId, reciteMode, suggestion]);

  useLayoutEffect(() => {
    syncPortalTarget();
  }, [syncPortalTarget, reactFlowGetter]);

  useEffect(() => {
    syncPortalTarget();
  }, [syncPortalTarget, reactFlowGetter]);

  const handleAcceptBranch = useCallback(
    (branchId: string) => {
      if (!mindmapId || !suggestion || busyBranchId) return;
      setBusyBranchId(branchId);
      void acceptMindmapSuggestionBranch(suggestion.id, mindmapId, branchId).finally(() => {
        setBusyBranchId(null);
      });
    },
    [mindmapId, suggestion, busyBranchId],
  );

  const handleRejectBranch = useCallback(
    (branchId: string) => {
      if (!mindmapId || !suggestion || busyBranchId) return;
      rejectMindmapSuggestionBranch(suggestion.id, mindmapId, branchId);
    },
    [mindmapId, suggestion, busyBranchId],
  );

  const projection = useMemo(() => {
    if (!mindmapId || reciteMode || !suggestion) return null;
    const realPositions = extractRenderedPositions(reactFlowGetter);
    return computeGhostCanvasProjection({
      root,
      viewRootId,
      suggestion,
      layoutId,
      layoutDirection,
      measuredNodeHeights,
      realRenderedNodePositions: realPositions,
    });
  }, [
    mindmapId,
    reciteMode,
    suggestion,
    root,
    viewRootId,
    layoutId,
    layoutDirection,
    measuredNodeHeights,
    reactFlowGetter,
  ]);

  if (!mindmapId || reciteMode || !suggestion || !projection) {
    return null;
  }

  if (
    projection.ghostNodes.length === 0 &&
    projection.ghostEdges.length === 0 &&
    projection.annotations.length === 0
  ) {
    return null;
  }

  const acceptLabel = t('mindmapGhost.acceptBranch');
  const rejectLabel = t('mindmapGhost.rejectBranch');
  const aiBadgeLabel = t('mindmapGhost.aiBadge');

  const overlay = (
    <div
      className="mm-ghost-proposal-layer pointer-events-none"
      data-testid="mindmap-ghost-proposal-layer"
    >
      <svg className="mm-ghost-edges-svg pointer-events-none" aria-hidden="true">
        <defs>
          <marker
            id={arrowMarkerId}
            viewBox="0 0 8 8"
            refX="6"
            refY="4"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 7 4 L 0 7 z" fill="var(--mm-ghost-stroke)" />
          </marker>
        </defs>
        {projection.ghostEdges.map((edge) => (
          <path
            key={edge.edgeId}
            d={edge.pathD}
            fill="none"
            stroke="var(--mm-ghost-stroke)"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            markerEnd={edge.kind === 'move_branch' ? `url(#${arrowMarkerId})` : undefined}
            className="pointer-events-none"
          />
        ))}
      </svg>

      {projection.ghostNodes.map((gNode) => (
        <div
          key={gNode.ghostId}
          data-ghost-id={gNode.ghostId}
          data-branch-id={gNode.branchId}
          className={cn(
            'mm-ghost-node border border-dashed pointer-events-none rounded-[10px] px-3 py-1.5',
          )}
          style={{
            left: gNode.x,
            top: gNode.y,
            minWidth: gNode.width,
          }}
        >
          {gNode.isBranchEntry && (
            <div className="mb-1 flex items-center justify-between gap-2 pointer-events-none">
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[var(--mm-ghost-accent)]">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mm-ghost-accent)]"
                  aria-hidden="true"
                />
                <span>{aiBadgeLabel}</span>
              </span>
              <BranchActionCapsule
                branchId={gNode.branchId}
                acceptLabel={acceptLabel}
                rejectLabel={rejectLabel}
                disabled={busyBranchId !== null}
                onAccept={handleAcceptBranch}
                onReject={handleRejectBranch}
              />
            </div>
          )}
          <div className="text-[13px] leading-snug text-[var(--mm-text)] break-words pointer-events-none">
            {gNode.text}
          </div>
          {gNode.note && (
            <div className="mt-0.5 text-[11px] text-[var(--mm-text-secondary)] line-clamp-2 pointer-events-none">
              {gNode.note}
            </div>
          )}
        </div>
      ))}

      {projection.annotations.map((ann) => {
        if (ann.kind === 'modify_node') {
          const textDiffers =
            ann.afterText !== undefined && ann.afterText !== ann.beforeText;
          return (
            <React.Fragment key={`ann_${ann.branchId}`}>
              <div
                className="mm-ghost-diff-halo border border-dashed pointer-events-none"
                style={{
                  left: ann.x - 2,
                  top: ann.y - 2,
                  width: ann.width + 4,
                  height: ann.height + 4,
                }}
              />
              <div
                data-annotation-kind="modify_node"
                data-branch-id={ann.branchId}
                className="mm-ghost-diff-pill pointer-events-none text-[11px]"
                style={{
                  left: ann.x,
                  top: ann.y - 28,
                }}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mm-ghost-accent)]"
                  aria-hidden="true"
                />
                {textDiffers ? (
                  <>
                    <span className="line-through opacity-60 max-w-[120px] truncate text-[var(--mm-text)]">
                      {ann.beforeText}
                    </span>
                    <ArrowRight
                      size={11}
                      className="shrink-0 text-[var(--mm-ghost-accent)]"
                      aria-hidden="true"
                    />
                    <span className="font-medium text-[var(--mm-ghost-accent)] max-w-[160px] truncate">
                      {ann.afterText}
                    </span>
                  </>
                ) : (
                  <span className="font-medium text-[var(--mm-ghost-accent)]">
                    {ann.noteChanged
                      ? t('mindmapGhost.noteModified')
                      : t('mindmapGhost.styleModified')}
                  </span>
                )}
                <BranchActionCapsule
                  branchId={ann.branchId}
                  acceptLabel={acceptLabel}
                  rejectLabel={rejectLabel}
                  disabled={busyBranchId !== null}
                  onAccept={handleAcceptBranch}
                  onReject={handleRejectBranch}
                />
              </div>
            </React.Fragment>
          );
        }

        if (ann.kind === 'remove_subtree') {
          const subtreeCount = ann.removedSubtreeCount ?? 1;
          return (
            <React.Fragment key={`ann_${ann.branchId}`}>
              <div
                data-annotation-kind="remove_subtree"
                data-branch-id={ann.branchId}
                className="mm-ghost-remove-overlay border border-dashed pointer-events-none flex items-center px-2"
                style={{
                  left: ann.x - 2,
                  top: ann.y - 2,
                  width: ann.width + 4,
                  height: ann.height + 4,
                }}
              >
                {ann.beforeText && (
                  <span className="line-through opacity-75 text-[12px] truncate text-[var(--mm-ghost-remove-fg)] pointer-events-none">
                    {ann.beforeText}
                  </span>
                )}
              </div>
              <div
                className="mm-ghost-remove-badge pointer-events-none text-[11px]"
                style={{
                  left: ann.x,
                  top: ann.y - 28,
                }}
                title={
                  subtreeCount > 1
                    ? t('mindmapGhost.removeSubtreeCount', { count: subtreeCount })
                    : undefined
                }
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mm-ghost-remove-fg)]"
                  aria-hidden="true"
                />
                <span className="font-medium">{t('mindmapGhost.removeBadge')}</span>
                {subtreeCount > 1 && (
                  <span className="font-mono tabular-nums text-[10px] opacity-85">
                    {`· -${subtreeCount}`}
                  </span>
                )}
                <BranchActionCapsule
                  branchId={ann.branchId}
                  acceptLabel={acceptLabel}
                  rejectLabel={rejectLabel}
                  disabled={busyBranchId !== null}
                  onAccept={handleAcceptBranch}
                  onReject={handleRejectBranch}
                />
              </div>
            </React.Fragment>
          );
        }

        return (
          <React.Fragment key={`ann_${ann.branchId}`}>
            <div
              className="mm-ghost-diff-halo border border-dashed pointer-events-none"
              style={{
                left: ann.x - 2,
                top: ann.y - 2,
                width: ann.width + 4,
                height: ann.height + 4,
              }}
            />
            <div
              data-annotation-kind="move_branch"
              data-branch-id={ann.branchId}
              className="mm-ghost-diff-pill pointer-events-none text-[11px]"
              style={{
                left: ann.x,
                top: ann.y - 28,
              }}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mm-ghost-accent)]"
                aria-hidden="true"
              />
              <span className="font-medium text-[var(--mm-ghost-accent)] max-w-[180px] truncate">
                {t('mindmapGhost.moveBadge', { target: ann.moveTargetParentText ?? '' })}
              </span>
              <BranchActionCapsule
                branchId={ann.branchId}
                acceptLabel={acceptLabel}
                rejectLabel={rejectLabel}
                disabled={busyBranchId !== null}
                onAccept={handleAcceptBranch}
                onReject={handleRejectBranch}
              />
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );

  const resolvedPortalTarget =
    (hostRef.current?.querySelector('.react-flow__viewport') as HTMLElement | null) ??
    portalTarget ??
    hostRef.current;

  return resolvedPortalTarget ? createPortal(overlay, resolvedPortalTarget) : overlay;
};

export default MindMapGhostProposalLayer;
