/**
 * QBankAgentDiffBar — Question-level visual review bar for Agent edits (C4 W10 Part B).
 *
 * UI-layer component adhering to Mineral Zen design tokens:
 * - 1px `border-border/35` dividers and card frames
 * - 6px `bg-primary` status indicator dot
 * - `font-mono tabular-nums` `1 / N` progress counter
 * - Expandable field-level diff (`questionText`, `options`, `correctAnswer`,
 *   `explanation`, `difficulty`, `tags`) with `-` / `+` tinted blocks
 * - Single & batch `[采纳修改]` and lossless `[撤回修改]` rollback
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowCounterClockwise,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  Check,
} from '@phosphor-icons/react';
import type { Question } from '@/api/questionBankApi';
import { DsButton } from '@/components/ui/DsButton';
import {
  useQbankAgentDiffStore,
  QuestionRevertError,
  type QuestionDiffEntry,
  type QuestionDiffField,
} from '@/stores/qbankAgentDiffStore';
import { cn } from '@/utils/cn';

const EMPTY_DIFF_ENTRIES: readonly QuestionDiffEntry[] = [];

export interface QBankAgentDiffBarProps {
  examId: string;
  activeQuestionId?: string | null;
  onRevertQuestions: (questions: Question[]) => Promise<void> | void;
  onFocusQuestion?: (questionId: string) => void;
  defaultExpanded?: boolean;
  className?: string;
}

export const QBankAgentDiffBar: React.FC<QBankAgentDiffBarProps> = ({
  examId,
  activeQuestionId,
  onRevertQuestions,
  onFocusQuestion,
  defaultExpanded = false,
  className,
}) => {
  const { t } = useTranslation(['exam_sheet']);
  const entries = useQbankAgentDiffStore(
    (state) => state.entriesByExamId[examId] ?? EMPTY_DIFF_ENTRIES,
  );
  const acceptQuestionDiff = useQbankAgentDiffStore((state) => state.acceptQuestionDiff);
  const acceptAllExamDiffs = useQbankAgentDiffStore((state) => state.acceptAllExamDiffs);

  const [cursorIndex, setCursorIndex] = useState(0);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [isReverting, setIsReverting] = useState(false);
  const revertingRef = useRef(false);

  // Sync cursor when activeQuestionId moves onto one of the pending diff entries.
  useEffect(() => {
    if (!activeQuestionId || entries.length === 0) return;
    const matchedIdx = entries.findIndex((entry) => entry.questionId === activeQuestionId);
    if (matchedIdx >= 0) {
      setCursorIndex(matchedIdx);
    }
  }, [activeQuestionId, entries]);

  // Clamp cursor when entries are accepted or reverted.
  useEffect(() => {
    if (entries.length === 0) {
      setCursorIndex(0);
      return;
    }
    setCursorIndex((prev) => Math.min(Math.max(0, prev), entries.length - 1));
  }, [entries.length]);

  const safeIndex = entries.length > 0 ? Math.min(Math.max(0, cursorIndex), entries.length - 1) : 0;
  const currentEntry = entries[safeIndex] ?? null;

  const currentQuestionBadge = useMemo(() => {
    if (!currentEntry) return '';
    return (
      currentEntry.after?.questionLabel?.trim() ||
      currentEntry.before.questionLabel?.trim() ||
      currentEntry.questionId
    );
  }, [currentEntry]);

  const handleStep = useCallback(
    (delta: -1 | 1) => {
      if (entries.length <= 1) return;
      const nextIdx = (safeIndex + delta + entries.length) % entries.length;
      setCursorIndex(nextIdx);
      const target = entries[nextIdx];
      if (target) {
        onFocusQuestion?.(target.questionId);
      }
    },
    [entries, onFocusQuestion, safeIndex],
  );

  const handleAcceptCurrent = useCallback(() => {
    if (!currentEntry || isReverting) return;
    acceptQuestionDiff(examId, currentEntry.questionId);
  }, [acceptQuestionDiff, currentEntry, examId, isReverting]);

  const handleAcceptAll = useCallback(() => {
    if (entries.length === 0 || isReverting) return;
    acceptAllExamDiffs(examId);
  }, [acceptAllExamDiffs, entries.length, examId, isReverting]);

  const revertEntries = useCallback(async (targets: readonly QuestionDiffEntry[]) => {
    if (targets.length === 0 || revertingRef.current) return;
    revertingRef.current = true;
    setIsReverting(true);
    const complete = (ids: readonly string[]) => {
      for (const entry of targets) {
        const state = useQbankAgentDiffStore.getState();
        const current = state.entriesByExamId[examId]?.find((item) => item.questionId === entry.questionId);
        // 新刷新生成的 diff 不能被旧撤回请求采纳。
        if (ids.includes(entry.questionId) && current?.before === entry.before && current?.after === entry.after) {
          state.acceptQuestionDiff(examId, entry.questionId);
        }
      }
    };
    try {
      await onRevertQuestions(targets.map((entry) => entry.before));
      complete(targets.map((entry) => entry.questionId));
    } catch (error) {
      if (error instanceof QuestionRevertError) complete(error.completedQuestionIds);
    } finally {
      revertingRef.current = false;
      setIsReverting(false);
    }
  }, [examId, onRevertQuestions]);

  const handleRevertCurrent = useCallback(async () => {
    if (currentEntry) await revertEntries([currentEntry]);
  }, [currentEntry, revertEntries]);

  const handleRevertAll = useCallback(async () => {
    await revertEntries(entries);
  }, [entries, revertEntries]);

  if (!currentEntry) {
    return null;
  }

  const emptyValueLabel = t('exam_sheet:agentDiff.emptyValue', { defaultValue: '（空）' });
  const hasMultiple = entries.length > 1;

  const formatFieldValue = (field: QuestionDiffField, rawText: string): string => {
    if (!rawText) return emptyValueLabel;
    if (field === 'difficulty') {
      return t(`exam_sheet:questionBank.difficulty.${rawText}`, { defaultValue: rawText });
    }
    return rawText;
  };

  return (
    <section
      data-testid="qbank-agent-diff-bar"
      role="region"
      aria-label={t('exam_sheet:agentDiff.title', { defaultValue: 'AI 已修改题目，请核对变更' })}
      className={cn(
        'flex-shrink-0 border-b border-border/35 bg-card/75 backdrop-blur-sm',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span
            data-testid="qbank-diff-status-dot"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
            aria-hidden="true"
          />
          <span className="truncate text-xs font-medium text-foreground">
            {t('exam_sheet:agentDiff.title', { defaultValue: 'AI 已修改题目，请核对变更' })}
          </span>
          <span
            data-testid="qbank-diff-counter"
            className="rounded-full border border-border/35 bg-muted/40 px-2 py-0.5 font-mono text-xs tabular-nums text-foreground"
          >
            {`${safeIndex + 1} / ${entries.length}`}
          </span>
          {currentQuestionBadge && (
            <button
              type="button"
              data-testid="qbank-diff-question-pill"
              onClick={() => onFocusQuestion?.(currentEntry.questionId)}
              title={t('exam_sheet:agentDiff.focusQuestion', { defaultValue: '定位题目' })}
              className="rounded border border-border/35 bg-background/70 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground transition-colors hover:text-foreground"
            >
              {currentQuestionBadge}
            </button>
          )}
          {hasMultiple && (
            <div className="inline-flex items-center gap-0.5">
              <DsButton
                variant="ghost"
                size="sm"
                iconOnly
                data-testid="qbank-diff-prev"
                disabled={isReverting}
                onClick={() => handleStep(-1)}
                aria-label={t('exam_sheet:agentDiff.prev', { defaultValue: '上一处变更' })}
                title={t('exam_sheet:agentDiff.prev', { defaultValue: '上一处变更' })}
                className="h-6 w-6"
              >
                <CaretLeft size={13} aria-hidden="true" />
              </DsButton>
              <DsButton
                variant="ghost"
                size="sm"
                iconOnly
                data-testid="qbank-diff-next"
                disabled={isReverting}
                onClick={() => handleStep(1)}
                aria-label={t('exam_sheet:agentDiff.next', { defaultValue: '下一处变更' })}
                title={t('exam_sheet:agentDiff.next', { defaultValue: '下一处变更' })}
                className="h-6 w-6"
              >
                <CaretRight size={13} aria-hidden="true" />
              </DsButton>
            </div>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <DsButton
            variant="ghost"
            size="sm"
            data-testid="qbank-diff-toggle-expand"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
            className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <CaretUp size={13} aria-hidden="true" />
            ) : (
              <CaretDown size={13} aria-hidden="true" />
            )}
            <span>
              {expanded
                ? t('exam_sheet:agentDiff.collapse', { defaultValue: '收起详情' })
                : t('exam_sheet:agentDiff.expand', { defaultValue: '展开详情' })}
            </span>
          </DsButton>

          <DsButton
            variant="outline"
            size="sm"
            data-testid="qbank-diff-revert-current"
            disabled={isReverting}
            onClick={() => void handleRevertCurrent()}
            className="h-7 gap-1 border-border/35 px-2.5 text-xs"
          >
            <ArrowCounterClockwise size={13} aria-hidden="true" />
            <span>
              {isReverting
                ? t('exam_sheet:agentDiff.reverting', { defaultValue: '正在撤回...' })
                : t('exam_sheet:agentDiff.revert', { defaultValue: '撤回修改' })}
            </span>
          </DsButton>

          {hasMultiple && (
            <DsButton
              variant="outline"
              size="sm"
              data-testid="qbank-diff-revert-all"
              disabled={isReverting}
              onClick={() => void handleRevertAll()}
              className="h-7 border-border/35 px-2.5 text-xs"
            >
              <span>{t('exam_sheet:agentDiff.revertAll', { defaultValue: '全部撤回' })}</span>
            </DsButton>
          )}

          {hasMultiple && (
            <DsButton
              variant="outline"
              size="sm"
              data-testid="qbank-diff-accept-current"
              disabled={isReverting}
              onClick={handleAcceptCurrent}
              className="h-7 gap-1 border-border/35 px-2.5 text-xs"
            >
              <Check size={13} aria-hidden="true" />
              <span>{t('exam_sheet:agentDiff.accept')}</span>
            </DsButton>
          )}

          <DsButton
            variant="primary"
            size="sm"
            data-testid="qbank-diff-accept-all"
            disabled={isReverting}
            onClick={handleAcceptAll}
            className="h-7 gap-1 px-2.5 text-xs"
          >
            <Check size={13} aria-hidden="true" />
            <span>{t('exam_sheet:agentDiff.acceptAll')}</span>
          </DsButton>
        </div>
      </div>

      {expanded && (
        <div
          data-testid="qbank-diff-details"
          className="max-h-64 space-y-2 overflow-y-auto border-t border-border/35 px-3 py-2.5 sm:px-4"
        >
          {currentEntry.changes.map((change) => (
            <div
              key={change.field}
              data-testid={`qbank-diff-field-${change.field}`}
              className="space-y-1 rounded-md border border-border/35 bg-background/60 p-2 text-xs"
            >
              <div className="text-[11px] font-medium text-muted-foreground">
                {t(`exam_sheet:agentDiff.fields.${change.field}`)}
              </div>
              <div
                data-testid={`qbank-diff-before-${change.field}`}
                className="flex items-start gap-1.5 rounded bg-[hsl(var(--destructive)/0.08)] px-2 py-1 text-foreground/90"
              >
                <span
                  className="select-none font-mono tabular-nums text-[hsl(var(--destructive))]"
                  aria-hidden="true"
                >
                  -
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                  {formatFieldValue(change.field, change.beforeText)}
                </span>
              </div>
              <div
                data-testid={`qbank-diff-after-${change.field}`}
                className="flex items-start gap-1.5 rounded bg-[hsl(var(--success)/0.10)] px-2 py-1 text-foreground"
              >
                <span
                  className="select-none font-mono tabular-nums text-[hsl(var(--success))]"
                  aria-hidden="true"
                >
                  +
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                  {formatFieldValue(change.field, change.afterText)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

export default QBankAgentDiffBar;
