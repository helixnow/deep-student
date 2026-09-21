import React, { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, Robot } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { GenerativeUIPanel } from '@/features/generative-ui/components/GenerativeUIPanel';
import { buildAIDiffSummaryIntent } from '@/features/generative-ui/utils/buildAIDiffSummaryIntent';
import { isMacOS } from '@/utils/platform';
import type { AIEditState, CanvasEditOperation, DiffLine } from './hooks/useAIEditState';
import { computeDiffLines } from './hooks/useAIEditState';
import { isReviewShortcut, type AIReviewSession, type AIReviewDecision } from './aiReviewModel';

interface AIDiffPanelProps {
  state: AIEditState;
  onAccept: () => void;
  onReject: () => void;
  onSuspend: () => void;
  onCopy?: () => void;
  onApplySelected?: () => void;
  review?: AIReviewSession | null;
  onDecideGroup?: (id: number, decision: AIReviewDecision) => void;
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
      <span className={cn('w-8 text-right pr-2 select-none text-muted-foreground/60')}>
        {line.lineNumber.old || line.lineNumber.new || ''}
      </span>
      <span className={cn('w-4 text-center select-none', prefixClass)}>
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
  onApplySelected,
  review,
  onDecideGroup,
  readOnly = false,
  canHandleShortcut,
  isApplying = false,
  className,
  suspendShortcuts = false,
}: AIDiffPanelProps) {
  const { t } = useTranslation('notes');
  const { request, diffLines } = state;

  const operationLabels: Record<CanvasEditOperation, string> = {
    append: t('aiDiff.operation_append'),
    replace: t('aiDiff.operation_replace'),
    set: t('aiDiff.operation_set'),
  };

  const acceptShortcutLabel = isMacOS() ? '⌘↵' : 'Ctrl+Enter';

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Accept 应用中锁定快捷键，防止重复触发；已被其他面板消费的事件不再处理
    if (isApplying || !isReviewShortcut(e) || suspendShortcuts || canHandleShortcut?.() === false) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      if (readOnly) return;
      e.preventDefault();
      onAccept();
      return;
    }
    if (e.key === 'Escape') {
      // Esc 优先级：查找替换等面板打开时让位（宿主经 suspendShortcuts 声明）
      if (suspendShortcuts) return;
      e.preventDefault();
      e.stopPropagation();
      onSuspend();
    }
  }, [isApplying, suspendShortcuts, onAccept, onSuspend, readOnly, canHandleShortcut]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const hasChanges = diffLines.some(line => line.type !== 'unchanged');
  const addedCount = diffLines.filter(line => line.type === 'added').length;
  const removedCount = diffLines.filter(line => line.type === 'removed').length;

  const summaryIntent = useMemo(() => {
    if (!request) return null;
    return buildAIDiffSummaryIntent({
      operation: request.operation,
      operationLabel: operationLabels[request.operation],
      addedCount,
      removedCount,
      hasChanges,
      labels: {
        metaTitle: t('aiDiff.summary.meta_title'),
        metaDescription: t('aiDiff.summary.meta_description'),
        statTitle: t('aiDiff.summary.stat_title'),
        noChangeTrend: t('aiDiff.summary.no_change_trend'),
        addedKey: t('aiDiff.summary.added'),
        removedKey: t('aiDiff.summary.removed'),
        operationKey: t('aiDiff.summary.operation'),
        alertTitle: t('aiDiff.summary.no_diff_title'),
        alertDescription: t('aiDiff.summary.no_diff_description'),
      },
    });
  }, [addedCount, hasChanges, operationLabels, removedCount, request, t]);

  if (!request || !summaryIntent) return null;

  return (
    <section
      aria-label={t('aiDiff.title')}
      className={cn(
        'notes-ai-diff-inline relative z-20 flex max-h-[min(45vh,420px)] flex-shrink-0 flex-col',
        'border-b border-border bg-background ui-drop-in',
        className
      )}
    >
      <div className="mx-auto flex min-h-0 w-full max-w-[var(--notes-content-max-w)] flex-col px-5 py-2 sm:px-12">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-shell-control,12px)] border border-border bg-card shadow-[0_1px_3px_hsl(var(--shadow-base)/0.08)]">
          {/* 操作条：贴住 diff 区顶部，不随 diff 内容滚动 */}
          <div className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-border/60 bg-muted/40 px-3 py-2">
            <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary/10">
              <Robot size={14} className="text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-medium leading-tight">{t('aiDiff.title')}</h3>
              <p className="truncate text-xs text-muted-foreground">
                {operationLabels[request.operation]}
                {hasChanges && (
                  <span className="ml-2 tabular-nums">
                    <span className="text-[hsl(var(--success))]">+{addedCount}</span>
                    {' / '}
                    <span className="text-[hsl(var(--destructive))]">-{removedCount}</span>
                  </span>
                )}
              </p>
            </div>
            <div className="hidden items-center text-xs text-muted-foreground sm:flex">
              <kbd className="rounded border bg-muted px-1.5 py-0.5 text-[10px]">{acceptShortcutLabel}</kbd>
              <span className="mx-1">{t('aiDiff.accept')}</span>
              <span className="mx-0.5">·</span>
              <kbd className="rounded border bg-muted px-1.5 py-0.5 text-[10px]">Esc</kbd>
              <span className="ml-1">{t('aiDiff.suspend', '收起')}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <DsButton variant="ghost" size="sm" onClick={onCopy}>{t('aiDiff.copy_candidate', '复制候选')}</DsButton>
              <DsButton variant="ghost" size="sm" onClick={onSuspend}>{t('aiDiff.suspend', '收起')}</DsButton>
              <DsButton
                variant="outline"
                size="sm"
                onClick={onReject}
                disabled={isApplying}
                className="h-7 [@media(pointer:coarse)]:!min-h-11 ui-press transition-colors duration-150 ease-[var(--dropdown-ease,cubic-bezier(0.22,1,0.36,1))] hover:border-[hsl(var(--destructive)/0.4)] hover:text-[hsl(var(--destructive))] motion-reduce:transition-none"
              >
                <X size={13} className="mr-1" />
                {t('aiDiff.discard', '丢弃建议')}
              </DsButton>
              <DsButton
                size="sm"
                onClick={onAccept}
                disabled={isApplying || readOnly}
                aria-busy={isApplying}
                className="h-7 [@media(pointer:coarse)]:!min-h-11 ui-press transition-colors duration-150 ease-[var(--dropdown-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none"
              >
                <Check size={13} className="mr-1" />
                {review?.error ? t('aiDiff.retry', '重试应用') : t('aiDiff.accept_remaining', '应用未拒绝的建议')}
              </DsButton>
            </div>
          </div>

          {review?.error && <p role="alert" className="px-3 py-2 text-sm text-destructive">{review.error}</p>}
          {review?.wholeDocument && <p className="px-3 py-1 text-xs text-muted-foreground">{t('aiDiff.atomic', '包含复杂 Markdown 节点，按全文整组审阅以保留结构。')}</p>}
          {review && !review.wholeDocument && (
            <div className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground">
              <span>{t('aiDiff.staged', '分组决定暂存，点击应用后统一保存。')}</span>
              <DsButton variant="outline" size="sm" onClick={onApplySelected}
                disabled={isApplying || readOnly || !review.groups.some((group) => group.decision === 'accept')}>
                {t('aiDiff.apply_selected', '仅应用已接受组')}
              </DsButton>
            </div>
          )}

          <div className="flex-shrink-0 border-b border-border/40 px-3 py-2">
            <GenerativeUIPanel intent={summaryIntent} showChrome={false} />
          </div>

          <CustomScrollArea className="min-h-0 flex-1" viewportClassName="py-1">
            {diffLines.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground">
                {t('aiDiff.no_changes')}
              </div>
            ) : (
              review && !review.wholeDocument && onDecideGroup ? (
                <div>{review.groups.map((group) => (
                  <div key={group.id} className="border-b border-border/40 py-1">
                    {group.changed && <div className="flex items-center gap-1 px-3 py-1 text-xs">
                      <span className="mr-auto">{group.decision === 'accept' ? t('aiDiff.group_accepted', '已接受') : group.decision === 'reject' ? t('aiDiff.group_rejected', '已拒绝') : t('aiDiff.group_pending', '待决定')}</span>
                      <DsButton size="sm" variant="ghost" disabled={isApplying || !!review.retryBaseline} onClick={() => onDecideGroup(group.id, 'accept')}>{t('aiDiff.accept_group', '接受此组')}</DsButton>
                      <DsButton size="sm" variant="ghost" disabled={isApplying || !!review.retryBaseline} onClick={() => onDecideGroup(group.id, 'reject')}>{t('aiDiff.reject_group', '拒绝此组')}</DsButton>
                      <DsButton size="sm" variant="ghost" disabled={isApplying || !!review.retryBaseline} onClick={() => onDecideGroup(group.id, 'pending')}>{t('aiDiff.reset_group', '重置')}</DsButton>
                    </div>}
                    <DiffHunksView lines={computeDiffLines(group.before, group.after)} />
                  </div>
                ))}</div>
              ) : <DiffHunksView lines={diffLines} />
            )}
          </CustomScrollArea>
        </div>
      </div>
    </section>
  );
}

export default AIDiffPanel;
