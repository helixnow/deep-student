import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowCounterClockwise,
  Check,
  PencilSimple,
  Robot,
  X,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { cn } from '@/utils/cn';
import { isMacOS } from '@/utils/platform';
import type { AIEditState, CanvasEditOperation, DiffLine } from './hooks/useAIEditState';
import type { AIEditCheckpoint } from './hooks/useCanvasAIEditHandler';
import { isReviewShortcut, type AIReviewDecision, type AIReviewSession } from './aiReviewModel';
import {
  acceptAllPendingHunks,
  buildHunkDocumentPlan,
  composeMarkdownFromHunkPlan,
  updateHunkDecision,
  type HunkDecisionState,
  type HunkDocumentPlan,
  type ReviewableHunk,
} from './hunkReviewModel';
import { OfficialDiffReview, type OfficialDiffReviewProps } from './OfficialDiffReview';
import type { AIReviewLanding, AIReviewScope } from './officialDiffContract';

export interface AIDiffPanelProps {
  state: AIEditState;
  onAccept: () => void;
  onReject: () => void;
  onSuspend: () => void;
  onCopy?: () => void;
  onApplySelected?: () => void;
  onApplyComposedContent?: (markdown: string) => void | Promise<void>;
  latestCheckpoint?: AIEditCheckpoint | null;
  onRollbackCheckpoint?: () => void | Promise<void>;
  review?: AIReviewSession | null;
  onDecideGroup?: (id: number, decision: AIReviewDecision) => void;
  onReviewDecision?: OfficialDiffReviewProps['onReviewDecision'];
  onReviewReady?: OfficialDiffReviewProps['onReviewReady'];
  onReviewError?: OfficialDiffReviewProps['onReviewError'];
  onScopeChange?: (kind: AIReviewScope['kind']) => void;
  onLandingChange?: (landing: AIReviewLanding) => void;
  canResolveScope?: boolean;
  canSaveAs?: boolean;
  readOnly?: boolean;
  canHandleShortcut?: () => boolean;
  isApplying?: boolean;
  className?: string;
  /**
   * 宿主可在其他面板（如查找替换）拥有 Esc 语义时暂停本面板的
   * 全局快捷键，避免两个 Esc 监听互相抢占。按钮操作不受影响。
   */
  suspendShortcuts?: boolean;
}

function DiffLineView({ line }: { line: DiffLine }) {
  const bgClass = {
    unchanged: '',
    added: 'bg-[hsl(var(--success)/0.12)]',
    removed: 'bg-[hsl(var(--destructive)/0.10)]',
  }[line.type];

  const prefixChar = {
    unchanged: ' ',
    added: '+',
    removed: '-',
  }[line.type];

  const prefixClass = {
    unchanged: 'text-muted-foreground',
    added: 'text-[hsl(var(--success))]',
    removed: 'text-[hsl(var(--destructive))]',
  }[line.type];

  return (
    <div className={cn('flex font-mono text-xs leading-5', bgClass)}>
      <span className="w-8 select-none pr-2 text-right font-mono tabular-nums text-muted-foreground/60">
        {line.lineNumber.old || line.lineNumber.new || ''}
      </span>
      <span className={cn('w-4 select-none text-center', prefixClass)}>
        {prefixChar}
      </span>
      <span className="flex-1 whitespace-pre-wrap break-all pr-2">
        {line.content || '\u00A0'}
      </span>
    </div>
  );
}

type DiffHunk = {
  kind: 'context' | 'change';
  lines: DiffLine[];
  /** diffLines 中的起始下标（渲染 key 用，行内容可能重复） */
  startIndex: number;
};

/** 把整份行级 diff 切成「上下文段 / 变更段」交替的 hunk 序列，供视觉分组 */
export function groupDiffHunks(lines: readonly DiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const kind: DiffHunk['kind'] = line.type === 'unchanged' ? 'context' : 'change';
    const last = hunks[hunks.length - 1];
    if (last && last.kind === kind) {
      last.lines.push(line);
    } else {
      hunks.push({ kind, lines: [line], startIndex: index });
    }
  }
  return hunks;
}

/**
 * 只读 hunk 级 diff 渲染层。
 * AI 编辑面板与保存冲突「对比」（NotesCrepeEditor）共用，
 * 仅负责渲染，不带操作条/快捷键。
 */
export function DiffHunksView({ lines }: { lines: readonly DiffLine[] }) {
  return (
    <div className="flex flex-col px-1">
      {groupDiffHunks(lines).map((hunk) => (
        <div
          key={hunk.startIndex}
          className={cn(
            hunk.kind === 'change' &&
              'my-0.5 overflow-hidden rounded-[var(--notes-radius-row,6px)] border-l-2 border-[hsl(var(--primary)/0.35)]',
          )}
        >
          {hunk.lines.map((line, offset) => (
            <DiffLineView key={hunk.startIndex + offset} line={line} />
          ))}
        </div>
      ))}
    </div>
  );
}

const STATUS_DOT_CLASS: Record<HunkDecisionState, string> = {
  pending: 'bg-[hsl(var(--warning))]',
  accepted: 'bg-[hsl(var(--success))]',
  rejected: 'bg-muted-foreground/45',
  tweaked: 'bg-primary',
};

interface HunkCardProps {
  hunk: ReviewableHunk;
  totalHunks: number;
  disabled: boolean;
  onDecision: (hunkId: number, decision: HunkDecisionState, tweakedText?: string) => void;
}

function HunkReviewCard({ hunk, totalHunks, disabled, onDecision }: HunkCardProps) {
  const { t } = useTranslation(['notes', 'forms']);
  const [isEditing, setIsEditing] = useState(false);
  const composing = useRef(false);
  const [draftText, setDraftText] = useState<string>(() => hunk.tweakedText ?? hunk.addedLines.join('\n'));

  useEffect(() => {
    if (!isEditing) {
      setDraftText(hunk.tweakedText ?? hunk.addedLines.join('\n'));
    }
  }, [hunk.addedLines, hunk.tweakedText, isEditing]);

  const statusLabel = {
    pending: t('forms:ai_hunk_review.status_pending', '待审阅'),
    accepted: t('forms:ai_hunk_review.status_accepted', '已采纳'),
    rejected: t('forms:ai_hunk_review.status_rejected', '已拒绝'),
    tweaked: t('forms:ai_hunk_review.status_tweaked', '已微调'),
  }[hunk.status];

  const handleOpenTweak = () => {
    setDraftText(hunk.tweakedText ?? hunk.addedLines.join('\n'));
    setIsEditing(true);
  };

  const handleConfirmTweak = () => {
    if (disabled || composing.current) return;
    onDecision(hunk.id, 'tweaked', draftText);
    setIsEditing(false);
  };

  const handleCancelTweak = () => {
    setDraftText(hunk.tweakedText ?? hunk.addedLines.join('\n'));
    setIsEditing(false);
  };

  const displayedAddedLines =
    hunk.status === 'tweaked'
      ? (hunk.tweakedText === '' ? [] : (hunk.tweakedText ?? '').split('\n'))
      : hunk.addedLines;

  return (
    <div
      data-testid={`ai-diff-hunk-card-${hunk.id}`}
      className="rounded-lg border border-border/35 bg-card/60"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/35 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT_CLASS[hunk.status])}
          />
          <span className="font-mono text-xs tabular-nums text-foreground">
            {hunk.id + 1} / {totalHunks}
          </span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            L{hunk.oldStartLine}
          </span>
          <span className="text-xs text-muted-foreground">{statusLabel}</span>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DsButton
            variant={hunk.status === 'accepted' ? 'secondary' : 'ghost'}
            size="sm"
            disabled={disabled}
            onClick={() => {
              setIsEditing(false);
              onDecision(hunk.id, 'accepted');
            }}
            className="h-6 px-2 text-xs"
          >
            <Check size={13} className="mr-1" />
            {t('forms:ai_hunk_review.accept_hunk', '采纳')}
          </DsButton>
          <DsButton
            variant={hunk.status === 'rejected' ? 'secondary' : 'ghost'}
            size="sm"
            disabled={disabled}
            onClick={() => {
              setIsEditing(false);
              onDecision(hunk.id, 'rejected');
            }}
            className="h-6 px-2 text-xs"
          >
            <X size={13} className="mr-1" />
            {t('forms:ai_hunk_review.reject_hunk', '拒绝')}
          </DsButton>
          <DsButton
            variant={hunk.status === 'tweaked' || isEditing ? 'secondary' : 'ghost'}
            size="sm"
            disabled={disabled}
            onClick={handleOpenTweak}
            className="h-6 px-2 text-xs"
          >
            <PencilSimple size={13} className="mr-1" />
            {t('forms:ai_hunk_review.tweak_hunk', '微调')}
          </DsButton>
        </div>
      </div>

      <div className="px-2 py-1.5 font-mono text-xs leading-5">
        {hunk.contextBefore.map((ctx, idx) => (
          <div key={`before-${idx}`} className="flex text-muted-foreground/70">
            <span className="w-4 select-none text-center"> </span>
            <span className="flex-1 whitespace-pre-wrap break-all">{ctx || '\u00A0'}</span>
          </div>
        ))}
        {hunk.removedLines.map((line, idx) => (
          <div
            key={`rm-${idx}`}
            className={cn(
              'flex bg-[hsl(var(--destructive)/0.10)]',
              hunk.status === 'accepted' && 'opacity-55 line-through',
            )}
          >
            <span className="w-4 select-none text-center text-[hsl(var(--destructive))]">-</span>
            <span className="flex-1 whitespace-pre-wrap break-all">{line || '\u00A0'}</span>
          </div>
        ))}
        {displayedAddedLines.map((line, idx) => (
          <div
            key={`add-${idx}`}
            className={cn(
              'flex bg-[hsl(var(--success)/0.12)]',
              hunk.status === 'rejected' && 'opacity-45 line-through',
            )}
          >
            <span className="w-4 select-none text-center text-[hsl(var(--success))]">+</span>
            <span className="flex-1 whitespace-pre-wrap break-all">{line || '\u00A0'}</span>
          </div>
        ))}
        {hunk.contextAfter.map((ctx, idx) => (
          <div key={`after-${idx}`} className="flex text-muted-foreground/70">
            <span className="w-4 select-none text-center"> </span>
            <span className="flex-1 whitespace-pre-wrap break-all">{ctx || '\u00A0'}</span>
          </div>
        ))}
      </div>

      {isEditing && (
        <div className="border-t border-border/35 bg-muted/20 p-2.5">
          <textarea
            aria-label={t('forms:ai_hunk_review.tweak_aria', {
              defaultValue: `微调变更块 ${hunk.id + 1}`,
              index: hunk.id + 1,
            })}
            value={draftText}
            disabled={disabled}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onChange={(e) => setDraftText(e.target.value)}
            rows={Math.min(8, Math.max(2, draftText.split('\n').length))}
            placeholder={t(
              'forms:ai_hunk_review.tweak_placeholder',
              '编辑当前变更块正文（留空即删除该段）',
            )}
            className="w-full rounded-md border border-border/35 bg-background px-2.5 py-1.5 font-mono text-xs leading-5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <DsButton variant="ghost" size="sm" disabled={disabled} onClick={handleCancelTweak} className="h-6 px-2 text-xs">
              {t('forms:ai_hunk_review.cancel_tweak', '取消')}
            </DsButton>
            <DsButton size="sm" disabled={disabled} onClick={handleConfirmTweak} className="h-6 px-2 text-xs">
              <Check size={13} className="mr-1" />
              {t('forms:ai_hunk_review.confirm_tweak', '确认微调')}
            </DsButton>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * AI 编辑建议 diff 面板。
 *
 * 内联呈现（非全屏遮罩）：作为编辑器上方的有界卡片区参与布局，
 * 编辑器正文保持可见、可滚动；Accept/Reject 操作条固定在 diff 区顶部。
 */
export function AIDiffPanel({
  state,
  onAccept,
  onReject,
  onSuspend,
  onCopy,
  onApplyComposedContent,
  latestCheckpoint,
  onRollbackCheckpoint,
  review,
  onReviewDecision,
  onReviewReady,
  onReviewError,
  onScopeChange,
  onLandingChange,
  canResolveScope = false,
  canSaveAs = false,
  readOnly = false,
  canHandleShortcut,
  isApplying = false,
  className,
  suspendShortcuts = false,
}: AIDiffPanelProps) {
  const { t } = useTranslation(['notes', 'forms']);
  const { request, diffLines, originalContent, proposedContent } = state;

  const hasOfficialReview = Boolean(review && onReviewDecision && onReviewReady && onReviewError);
  const [viewMode, setViewMode] = useState<'hunks' | 'official'>('hunks');
  const revision = useMemo(() => ({ requestId: request?.requestId, originalContent, proposedContent,
    generation: review?.generation }), [request?.requestId, originalContent, proposedContent, review?.generation]);
  const initialPlan = useMemo(() => buildHunkDocumentPlan(diffLines, {
    original: originalContent, proposed: proposedContent,
  }), [revision]);
  const [hunkState, setHunkState] = useState(() => ({ revision, plan: initialPlan, cardRevision: 0 }));
  if (hunkState.revision !== revision) {
    setHunkState({ revision, plan: initialPlan, cardRevision: hunkState.cardRevision + 1 });
  }
  const hunkPlan = hunkState.revision === revision ? hunkState.plan : initialPlan;
  const setHunkPlan = useCallback((plan: HunkDocumentPlan | ((prev: HunkDocumentPlan) => HunkDocumentPlan)) => {
    setHunkState((prev) => ({ ...prev, revision, plan: typeof plan === 'function'
      ? plan(prev.revision === revision ? prev.plan : initialPlan) : plan }));
  }, [revision, initialPlan]);

  const handleHunkDecision = useCallback(
    (hunkId: number, decision: HunkDecisionState, tweakedText?: string) => {
      setHunkPlan((prev) => updateHunkDecision(prev, hunkId, decision, tweakedText));
    },
    [setHunkPlan],
  );

  const finalizeComposedMarkdown = useCallback(
    (plan: HunkDocumentPlan): { markdown: string; acceptedOrTweakedCount: number } => {
      const composed = composeMarkdownFromHunkPlan(plan);
      return { markdown: composed.markdown, acceptedOrTweakedCount: composed.acceptedOrTweakedCount };
    },
    [],
  );

  const handleAcceptAll = useCallback(() => {
    if (isApplying || readOnly) return;
    if (review?.retryDecision) {
      onAccept();
      return;
    }

    const total = hunkPlan.hunks.length;
    const hasCustomHunkDecisions = hunkPlan.hunks.some((h) => h.status !== 'pending');

    if (total > 0 && onApplyComposedContent && (hasCustomHunkDecisions || !review?.decisions.length)) {
      const acceptedPlan = acceptAllPendingHunks(hunkPlan);
      setHunkPlan(acceptedPlan);
      const { markdown, acceptedOrTweakedCount } = finalizeComposedMarkdown(acceptedPlan);
      if (acceptedOrTweakedCount === 0) {
        onReject();
        return;
      }
      void (async () => {
        try { await onApplyComposedContent(markdown); }
        catch (error) { onReviewError?.(error); }
      })();
      return;
    }

    onAccept();
  }, [
    finalizeComposedMarkdown,
    hunkPlan,
    isApplying,
    onAccept,
    onApplyComposedContent,
    onReject,
    onReviewError,
    setHunkPlan,
    readOnly,
    review?.decisions.length,
    review?.retryDecision,
  ]);

  const handleRevertAll = useCallback(() => {
    if (isApplying || readOnly) return;
    setHunkPlan(initialPlan);
    if (latestCheckpoint && !latestCheckpoint.stale && onRollbackCheckpoint) {
      void (async () => {
        try { await onRollbackCheckpoint(); }
        catch (error) { onReviewError?.(error); }
      })();
      return;
    }
    onReject();
  }, [initialPlan, setHunkPlan, isApplying, readOnly, latestCheckpoint, onReject, onRollbackCheckpoint, onReviewError]);

  const operationLabels: Record<CanvasEditOperation, string> = {
    append: t('aiDiff.operation_append'),
    replace: t('aiDiff.operation_replace'),
    set: t('aiDiff.operation_set'),
  };

  const acceptShortcutLabel = isMacOS() ? 'Cmd+Enter' : 'Ctrl+Enter';

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
      if (activeTag === 'TEXTAREA' && e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        return;
      }
      if (e.isComposing || e.keyCode === 229 || isApplying || !isReviewShortcut(e) || suspendShortcuts || canHandleShortcut?.() === false) {
        return;
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        if (readOnly) return;
        e.preventDefault();
        handleAcceptAll();
        return;
      }
      if (e.key === 'Escape') {
        if (suspendShortcuts) return;
        e.preventDefault();
        e.stopPropagation();
        onSuspend();
      }
    },
    [isApplying, suspendShortcuts, handleAcceptAll, onSuspend, readOnly, canHandleShortcut],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const hasChanges = diffLines.some((line) => line.type !== 'unchanged');
  const addedCount = diffLines.filter((line) => line.type === 'added').length;
  const removedCount = diffLines.filter((line) => line.type === 'removed').length;
  const totalHunks = hunkPlan.hunks.length;
  const resolvedHunks = hunkPlan.hunks.filter((h) => h.status !== 'pending').length;

  if (!request) return null;

  return (
    <section
      aria-label={t('aiDiff.title')}
      className={cn(
        'notes-ai-diff-inline relative z-20 flex max-h-[min(45vh,420px)] flex-shrink-0 flex-col',
        'border-b border-border/35 bg-background ui-drop-in',
        className,
      )}
    >
      <div className="notes-column flex min-h-0 flex-col py-2">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-shell-control,12px)] border border-border/35 bg-card shadow-[0_1px_3px_hsl(var(--shadow-base)/0.08)]">
          {/* 操作条：贴住 diff 区顶部，不随 diff 内容滚动 */}
          <div className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-border/35 bg-muted/40 px-3 py-2">
            <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary/10">
              <Robot size={14} className="text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <h3 className="truncate text-sm font-medium leading-tight">{t('aiDiff.title')}</h3>
                {totalHunks > 0 && (
                  <span
                    data-testid="ai-diff-hunk-counter"
                    className="rounded-full border border-border/35 bg-background/80 px-2 py-0.5 font-mono text-xs tabular-nums text-muted-foreground"
                  >
                    {resolvedHunks} / {totalHunks}
                  </span>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {operationLabels[request.operation]}
                {hasChanges && (
                  <span className="ml-2 font-mono tabular-nums">
                    <span className="text-[hsl(var(--success))]">+{addedCount}</span>
                    {' / '}
                    <span className="text-[hsl(var(--destructive))]">-{removedCount}</span>
                  </span>
                )}
              </p>
            </div>
            <div className="hidden items-center text-xs text-muted-foreground sm:flex">
              <kbd className="rounded border border-border/35 bg-muted px-1.5 py-0.5 font-mono text-xs">
                {acceptShortcutLabel}
              </kbd>
              <span className="mx-1">{t('aiDiff.accept')}</span>
              <span className="mx-0.5">/</span>
              <kbd className="rounded border border-border/35 bg-muted px-1.5 py-0.5 font-mono text-xs">
                Esc
              </kbd>
              <span className="ml-1">{t('aiDiff.suspend', '收起')}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {hasOfficialReview && totalHunks > 0 && (
                <div className="mr-1 inline-flex items-center rounded-md border border-border/35 bg-background/70 p-0.5">
                  <button
                    type="button"
                    aria-pressed={viewMode === 'hunks'}
                    onClick={() => setViewMode('hunks')}
                    className={cn(
                      'rounded px-2 py-0.5 text-xs transition-colors',
                      viewMode === 'hunks'
                        ? 'bg-primary/10 font-medium text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t('forms:ai_hunk_review.mode_hunks', 'Hunk 微调')}
                  </button>
                  <button
                    type="button"
                    aria-pressed={viewMode === 'official'}
                    onClick={() => setViewMode('official')}
                    className={cn(
                      'rounded px-2 py-0.5 text-xs transition-colors',
                      viewMode === 'official'
                        ? 'bg-primary/10 font-medium text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t('forms:ai_hunk_review.mode_rich', '富文本逐组')}
                  </button>
                </div>
              )}
              <DsButton variant="ghost" size="sm" onClick={onCopy}>
                {t('aiDiff.copy_candidate', '复制候选')}
              </DsButton>
              <DsButton variant="ghost" size="sm" onClick={onSuspend}>
                {t('aiDiff.suspend', '收起')}
              </DsButton>
              <DsButton
                variant="ghost"
                size="sm"
                onClick={onReject}
                disabled={isApplying}
              >
                {t('aiDiff.discard', '丢弃建议')}
              </DsButton>
              <DsButton
                variant="outline"
                size="sm"
                onClick={handleRevertAll}
                disabled={isApplying || readOnly}
                className="h-7 [@media(pointer:coarse)]:!min-h-11 ui-press transition-colors duration-150 ease-[var(--dropdown-ease,cubic-bezier(0.22,1,0.36,1))] hover:border-[hsl(var(--destructive)/0.4)] hover:text-[hsl(var(--destructive))] motion-reduce:transition-none"
              >
                <ArrowCounterClockwise size={13} className="mr-1" />
                {t('forms:ai_hunk_review.revert_all', '全部撤回')}
              </DsButton>
              <DsButton
                size="sm"
                onClick={handleAcceptAll}
                disabled={isApplying || readOnly}
                aria-busy={isApplying}
                className="h-7 [@media(pointer:coarse)]:!min-h-11 ui-press transition-colors duration-150 ease-[var(--dropdown-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none"
              >
                <Check size={13} className="mr-1" />
                {review?.error
                  ? t('aiDiff.retry', '重试应用')
                  : t('forms:ai_hunk_review.accept_all', '全部采纳')}
              </DsButton>
            </div>
          </div>

          {review?.error && (
            <p role="alert" className="border-b border-border/35 px-3 py-2 text-sm text-destructive">
              {review.error}
            </p>
          )}
          {review && onScopeChange && onLandingChange && (
            <div className="flex flex-wrap items-center gap-3 border-b border-border/35 px-3 py-2 text-xs text-muted-foreground">
              <label className="inline-flex items-center gap-1.5">
                {t('aiDiff.scope.label', '范围')}
                <select
                  className="notes-ai-diff-select"
                  aria-label={t('aiDiff.scope.aria', 'AI 编辑范围')}
                  value={review.request.scope?.kind ?? 'page'}
                  disabled={isApplying || !!review.decisions.length || !!review.retryDecision}
                  onChange={(event) => onScopeChange(event.target.value as AIReviewScope['kind'])}
                >
                  <option value="selection" disabled={!canResolveScope}>
                    {t('aiDiff.scope.selection', '选区')}
                  </option>
                  <option value="block" disabled={!canResolveScope}>
                    {t('aiDiff.scope.block', '当前块')}
                  </option>
                  <option value="section" disabled={!canResolveScope}>
                    {t('aiDiff.scope.section', '当前章节')}
                  </option>
                  <option value="page">{t('aiDiff.scope.page', '整页')}</option>
                </select>
              </label>
              <label className="inline-flex items-center gap-1.5">
                {t('aiDiff.landing.label', '落点')}
                <select
                  className="notes-ai-diff-select"
                  aria-label={t('aiDiff.landing.aria', 'AI 结果落点')}
                  value={review.request.landing ?? 'replace'}
                  disabled={isApplying || !!review.decisions.length || !!review.retryDecision}
                  onChange={(event) => onLandingChange(event.target.value as AIReviewLanding)}
                >
                  <option value="replace">{t('aiDiff.landing.replace', '替换')}</option>
                  <option value="insert_below" hidden>
                    insert_below
                  </option>
                  <option value="insert-below">{t('aiDiff.landing.insert_below', '插入下方')}</option>
                  <option value="save-as" disabled={!canSaveAs}>
                    {t('aiDiff.landing.save_as', '另存结果')}
                  </option>
                </select>
              </label>
            </div>
          )}
          {review && (
            <p className="border-b border-border/35 px-3 py-1 text-xs text-muted-foreground">
              {t(
                'aiDiff.review_hint',
                '接受此组会立即保存到笔记；其余建议保留。表格、折叠块和提示块按块审阅。',
              )}
            </p>
          )}

          <CustomScrollArea className="min-h-0 flex-1" viewportClassName="py-1.5">
            {hasOfficialReview && review && onReviewDecision && onReviewReady && onReviewError && (
              <div className={cn(viewMode !== 'official' && totalHunks > 0 && 'hidden')}>
                <OfficialDiffReview
                  review={review}
                  onReviewDecision={onReviewDecision}
                  onReviewReady={onReviewReady}
                  onReviewError={onReviewError}
                />
              </div>
            )}

            {(!hasOfficialReview || viewMode === 'hunks') && (
              totalHunks > 0 ? (
                <div className="flex flex-col gap-2 px-2">
                  {hunkPlan.hunks.map((hunk) => (
                    <HunkReviewCard
                      key={`${hunkState.cardRevision}:${hunk.id}`}
                      hunk={hunk}
                      totalHunks={totalHunks}
                      disabled={isApplying || readOnly}
                      onDecision={handleHunkDecision}
                    />
                  ))}
                </div>
              ) : !hasOfficialReview ? (
                diffLines.length === 0 ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    {t('aiDiff.no_changes')}
                  </div>
                ) : (
                  <DiffHunksView lines={diffLines} />
                )
              ) : null
            )}
          </CustomScrollArea>
        </div>
      </div>
    </section>
  );
}

export default AIDiffPanel;
