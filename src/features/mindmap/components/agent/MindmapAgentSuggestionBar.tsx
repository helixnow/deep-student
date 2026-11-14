import React, { useCallback, useEffect, useState } from 'react';
import { ArrowCounterClockwise, CaretDown, Check, X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { cn } from '@/utils/cn';
import { getErrorMessage } from '@/utils/errorUtils';
import {
  acceptMindmapSuggestion,
  acceptMindmapSuggestionBranch,
  dismissMindmapSuggestion,
  rejectMindmapSuggestionBranch,
  revertLastAcceptedMindmapSuggestion,
} from '@/stores/mindmapSuggestionStore';
import {
  CHECKPOINT_TTL_MS,
  clearAcceptedMindmapCheckpoint,
  getAcceptedMindmapCheckpoint,
  getMindmapSuggestion,
  subscribeMindmapSuggestions,
  summarizeSuggestionOps,
  type GhostBranchKind,
  type MindmapAgentSuggestion,
} from '@/stores/mindmapSuggestionStore';
import { useMindMapStore } from '../../store';
import '../../styles/ghost-proposal.css';

// ============================================================================
// Props 定义
// ============================================================================

export interface MindmapAgentSuggestionBarProps {
  mindmapId: string;
}

// ============================================================================
// 组件实现
// ============================================================================

export const MindmapAgentSuggestionBar: React.FC<MindmapAgentSuggestionBarProps> = ({
  mindmapId,
}) => {
  const { t } = useTranslation(['mindmap', 'graph_conflict']);
  const [, setVersion] = useState(0);
  const [applying, setApplying] = useState(false);
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);

  const currentView = useMindMapStore((s) => s.currentView);
  const storeMindmapId = useMindMapStore((s) => s.mindmapId);
  const docVersion = useMindMapStore((s) => s._documentVersion);

  useEffect(() => {
    return subscribeMindmapSuggestions((changed) => {
      if (changed === mindmapId) setVersion((v) => v + 1);
    });
  }, [mindmapId]);

  const suggestion: MindmapAgentSuggestion | null = getMindmapSuggestion(mindmapId);
  const rawCheckpoint = getAcceptedMindmapCheckpoint(mindmapId);

  const hasSubsequentManualEdit =
    rawCheckpoint !== null &&
    storeMindmapId === mindmapId &&
    docVersion !== rawCheckpoint.postAcceptDocVersion;

  useEffect(() => {
    if (hasSubsequentManualEdit) {
      clearAcceptedMindmapCheckpoint(mindmapId);
    }
  }, [hasSubsequentManualEdit, mindmapId]);

  useEffect(() => {
    if (!rawCheckpoint || hasSubsequentManualEdit) return undefined;
    const remainingMs = Math.max(0, CHECKPOINT_TTL_MS - (Date.now() - rawCheckpoint.acceptedAt));
    const timer = setTimeout(() => {
      clearAcceptedMindmapCheckpoint(mindmapId);
    }, remainingMs + 10);
    return () => clearTimeout(timer);
  }, [rawCheckpoint, hasSubsequentManualEdit, mindmapId]);

  useEffect(() => {
    setManualExpanded(null);
  }, [suggestion?.id, currentView]);

  const activeCheckpoint = hasSubsequentManualEdit ? null : rawCheckpoint;

  const handleAcceptAll = useCallback(async () => {
    if (!suggestion || applying) return;
    setApplying(true);
    try {
      const result = await acceptMindmapSuggestion(suggestion.id, mindmapId);
      if (!result) return;
      if (result.failed.length > 0) {
        showGlobalNotification(
          'warning',
          t('mindmap:agent.suggestion_bar.accept_partial', {
            applied: result.applied,
            failed: result.failed.length,
          }),
          result.failed.slice(0, 3).join('\n'),
        );
      } else {
        showGlobalNotification(
          'success',
          t('mindmap:agent.suggestion_bar.accepted', {
            count: result.applied,
          }),
        );
      }
      if (!result.saved) {
        showGlobalNotification('warning', t('mindmap:agent.suggestion_bar.save_failed'));
      }
    } finally {
      setApplying(false);
    }
  }, [suggestion, applying, mindmapId, t]);

  const handleDismissPending = useCallback(() => {
    dismissMindmapSuggestion(mindmapId);
  }, [mindmapId]);

  const handleAcceptBranch = useCallback(
    async (branchId: string) => {
      if (!suggestion || applying) return;
      setApplying(true);
      try {
        const result = await acceptMindmapSuggestionBranch(suggestion.id, mindmapId, branchId);
        if (result && !result.saved) {
          showGlobalNotification('warning', t('mindmap:agent.suggestion_bar.save_failed'));
        }
      } finally {
        setApplying(false);
      }
    },
    [suggestion, applying, mindmapId, t],
  );

  const handleRejectBranch = useCallback(
    (branchId: string) => {
      if (!suggestion || applying) return;
      rejectMindmapSuggestionBranch(suggestion.id, mindmapId, branchId);
    },
    [suggestion, applying, mindmapId],
  );

  const handleRevertCheckpoint = useCallback(async () => {
    if (applying) return;
    setApplying(true);
    try {
      const ok = await revertLastAcceptedMindmapSuggestion(mindmapId);
      if (ok) {
        showGlobalNotification('success', t('graph_conflict:mindmapGhost.revertedToast'));
      } else {
        showGlobalNotification(
          'warning',
          t('graph_conflict:mindmapGhost.revertFailedToast', {
            error: t('mindmap:versions.restoreFailed'),
          }),
        );
      }
    } catch (error) {
      showGlobalNotification(
        'warning',
        t('graph_conflict:mindmapGhost.revertFailedToast', {
          error: getErrorMessage(error),
        }),
      );
    } finally {
      setApplying(false);
    }
  }, [applying, mindmapId, t]);

  const handleDismissCheckpoint = useCallback(() => {
    clearAcceptedMindmapCheckpoint(mindmapId);
  }, [mindmapId]);

  const formatBranchKind = (kind: GhostBranchKind): string => {
    switch (kind) {
      case 'add_branch':
        return t('graph_conflict:mindmapGhost.branchAddKind');
      case 'remove_subtree':
        return t('graph_conflict:mindmapGhost.branchRemoveKind');
      case 'move_branch':
        return t('graph_conflict:mindmapGhost.branchMoveKind');
      case 'modify_node':
      default:
        return t('graph_conflict:mindmapGhost.branchModifyKind');
    }
  };

  if (suggestion) {
    const summary = summarizeSuggestionOps(suggestion.ops);
    const parts: string[] = [];
    if (summary.added > 0) {
      parts.push(t('mindmap:agent.suggestion_bar.added', { count: summary.added }));
    }
    if (summary.updated > 0) {
      parts.push(t('mindmap:agent.suggestion_bar.updated', { count: summary.updated }));
    }
    if (summary.removed > 0) {
      parts.push(t('mindmap:agent.suggestion_bar.removed', { count: summary.removed }));
    }
    if (summary.moved > 0) {
      parts.push(t('mindmap:agent.suggestion_bar.moved', { count: summary.moved }));
    }

    const isBranchListExpanded =
      manualExpanded !== null ? manualExpanded : currentView === 'outline';

    return (
      <div
        className="mm-inline-banner border-b border-border/35 bg-[var(--mm-ghost-bar-bg)] text-[var(--mm-text)]"
        role="alert"
        aria-live="polite"
      >
        <div className="flex flex-wrap items-center gap-2 px-3.5 py-1.5">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mm-primary)] animate-pulse motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span className="text-xs font-medium shrink-0">
            {t('mindmap:agent.suggestion_bar.title')}
          </span>
          {parts.length > 0 && (
            <span className="font-mono tabular-nums text-xs text-[var(--mm-text-secondary)] min-w-0 truncate">
              {parts.join(' · ')}
            </span>
          )}
          {suggestion.branches.length > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-border/35 px-2 py-0.5 text-[11px] font-mono tabular-nums text-[var(--mm-text-secondary)] hover:bg-[var(--mm-celadon-pill-bg)] transition-colors"
              aria-expanded={isBranchListExpanded}
              onClick={() => setManualExpanded(!isBranchListExpanded)}
            >
              <span>
                {t('graph_conflict:mindmapGhost.toggleBranchList', {
                  count: suggestion.branches.length,
                })}
              </span>
              <CaretDown
                size={12}
                className={cn(
                  'shrink-0 transition-transform duration-150 motion-reduce:transition-none',
                  isBranchListExpanded && 'rotate-180',
                )}
              />
            </button>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <DsButton
              variant="ghost"
              className="ds-btn h-6 px-2 text-xs shrink-0 text-[var(--mm-primary)] hover:bg-[var(--mm-celadon-pill-bg-hover)]"
              disabled={applying}
              onClick={() => {
                void handleAcceptAll();
              }}
            >
              <Check size={13} className="mr-1 shrink-0" />
              <span>{t('graph_conflict:mindmapGhost.acceptAll')}</span>
            </DsButton>
            <DsButton
              variant="ghost"
              className="ds-btn h-6 px-2 text-xs shrink-0 text-[var(--mm-text-secondary)] hover:bg-[var(--mm-celadon-pill-bg)]"
              disabled={applying}
              onClick={handleDismissPending}
              aria-label={t('graph_conflict:mindmapGhost.revertAll')}
            >
              <X size={13} className="mr-1 shrink-0" />
              <span>{t('graph_conflict:mindmapGhost.revertAll')}</span>
            </DsButton>
          </div>
        </div>

        {isBranchListExpanded && suggestion.branches.length > 0 && (
          <div
            className="border-t border-border/35 divide-y divide-border/35 px-3.5 py-1"
            data-testid="mindmap-ghost-branch-list"
          >
            {suggestion.branches.map((branch) => (
              <div
                key={branch.branchId}
                data-branch-id={branch.branchId}
                className="flex items-center gap-2 py-1 text-xs"
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    branch.kind === 'remove_subtree'
                      ? 'bg-[var(--mm-ghost-remove-fg)]'
                      : 'bg-[var(--mm-ghost-accent)]',
                  )}
                  aria-hidden="true"
                />
                <span className="shrink-0 text-[11px] text-[var(--mm-text-secondary)]">
                  {formatBranchKind(branch.kind)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[var(--mm-text)]">
                  {branch.summaryLabel}
                </span>
                {branch.affectedNodeCount > 1 && (
                  <span className="shrink-0 font-mono tabular-nums text-[11px] text-[var(--mm-text-secondary)]">
                    {branch.kind === 'remove_subtree'
                      ? `-${branch.affectedNodeCount}`
                      : `+${branch.affectedNodeCount}`}
                  </span>
                )}
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    className="mm-ghost-action-btn"
                    disabled={applying}
                    onClick={() => {
                      void handleAcceptBranch(branch.branchId);
                    }}
                  >
                    <Check size={12} weight="bold" className="shrink-0" />
                    <span>{t('graph_conflict:mindmapGhost.acceptBranch')}</span>
                  </button>
                  <button
                    type="button"
                    className="mm-ghost-action-btn mm-ghost-action-btn--reject"
                    disabled={applying}
                    onClick={() => handleRejectBranch(branch.branchId)}
                  >
                    <X size={12} weight="bold" className="shrink-0" />
                    <span>{t('graph_conflict:mindmapGhost.rejectBranch')}</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (activeCheckpoint) {
    return (
      <div
        className="mm-inline-banner flex flex-wrap items-center gap-2 border-b border-border/35 bg-[var(--mm-ghost-bar-bg)] px-3.5 py-1.5 text-[var(--mm-text)]"
        role="status"
        aria-live="polite"
        data-testid="mindmap-ghost-checkpoint-bar"
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mm-primary)]"
          aria-hidden="true"
        />
        <span className="font-mono tabular-nums text-xs">
          {t('graph_conflict:mindmapGhost.checkpointBanner', {
            count: activeCheckpoint.appliedCount,
          })}
        </span>
        <span className="text-xs text-[var(--mm-text-secondary)]">
          {`(${t('graph_conflict:mindmapGhost.checkpointSavedHint')})`}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <DsButton
            variant="ghost"
            className="ds-btn h-6 px-2 text-xs shrink-0 text-[var(--mm-primary)] hover:bg-[var(--mm-celadon-pill-bg-hover)]"
            disabled={applying}
            onClick={() => {
              void handleRevertCheckpoint();
            }}
          >
            <ArrowCounterClockwise size={13} className="mr-1 shrink-0" />
            <span>{t('graph_conflict:mindmapGhost.revertAll')}</span>
          </DsButton>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--mm-text-secondary)] hover:bg-[var(--mm-celadon-pill-bg)] transition-colors"
            disabled={applying}
            onClick={handleDismissCheckpoint}
            aria-label={t('graph_conflict:mindmapGhost.dismissCheckpoint')}
          >
            <X size={13} />
          </button>
        </div>
      </div>
    );
  }

  return null;
};

export default MindmapAgentSuggestionBar;
