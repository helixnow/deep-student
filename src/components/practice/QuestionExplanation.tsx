import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GradingDiagnostics } from '@/api/practiceApi';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, CaretDown, Lightbulb, WarningCircle } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { MarkdownRenderer, StreamingMarkdownRenderer } from '@/features/chat/components/renderers';
import { useMotionPresence } from '@/hooks/useMotionPresence';
import { useQbankAiGrading } from '@/hooks/useQbankAiGrading';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/lib/utils';
import { AiExplanationWriteButton } from './AiExplanationWriteButton';
import { resolveAiExplanationWrite, toExplanationText } from './aiExplanation';
import { GradingDiagnosticsView } from './GradingDiagnosticsView';

interface Props {
  questionId: string;
  explanation?: string | null;
  aiFeedback?: string | null;
  defaultExpanded?: boolean;
  /** Historical practice snapshots must not be replaced by live explanations. */
  allowExplanationWrite?: boolean;
  onRefreshQuestion?: (questionId: string) => Promise<void>;
}

/** 保护纯文本算式中的单星号乘号（如 `a*t = 12 + 5*6`），避免被 Markdown 误解析为斜体吞掉星号 */
function escapeBareMathAsterisks(markdown: string): string {
  const segments = markdown.split(/(```[\s\S]*?```|`[^`\n]+`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g);
  return segments
    .map((seg, index) => {
      if (index % 2 === 1) return seg;
      return seg.replace(/(?<=[0-9a-zA-Z)\]])\*(?=\s*[0-9a-zA-Z([])/g, '\\*');
    })
    .join('');
}

/** Mount with the question ID as key so a stream can never appear on another question. */
export function QuestionExplanation({
  questionId,
  explanation,
  aiFeedback,
  defaultExpanded = false,
  allowExplanationWrite = true,
  onRefreshQuestion,
}: Props) {
  const { t } = useTranslation('practice');
  const ai = useQbankAiGrading();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const presence = useMotionPresence(expanded, { exitMs: 200, enter: 'transition' });
  const isShown = defaultExpanded && expanded ? true : presence.shown;
  const [savedExplanation, setSavedExplanation] = useState<string | null>(null);
  const [savedDraft, setSavedDraft] = useState<{ feedback: string; diagnostics?: GradingDiagnostics } | null>(null);
  const canonical = savedExplanation ?? explanation;
  const feedback = ai.state.feedback || aiFeedback || '';
  const showFeedback = Boolean(toExplanationText(feedback))
    && resolveAiExplanationWrite(canonical, feedback) !== 'none';
  const hasContent = Boolean(canonical?.trim() || toExplanationText(feedback) || savedDraft);
  useEffect(() => {
    let cancelled = false;
    setSavedDraft(null);
    if (!onRefreshQuestion) return;
    void invoke<Array<{ field_name: string; new_value: string | null }>>('qbank_get_history', {
      questionId, limit: 20,
    }).then((history) => {
      const latest = history.find((entry) => entry.field_name === 'ai_grading_draft');
      if (!latest?.new_value || cancelled) return;
      const draft = JSON.parse(latest.new_value) as { feedback?: string; diagnostics?: GradingDiagnostics };
      if (typeof draft.feedback === 'string') setSavedDraft({ ...draft, feedback: draft.feedback });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [aiFeedback, expanded, questionId, onRefreshQuestion]);

  const generate = async () => {
    if (!onRefreshQuestion || ai.state.isGrading) return;
    setExpanded(true);
    ai.resetState();
    try {
      // A reusable explanation has no student submission and is saved before completion.
      await ai.startGrading(questionId, null, 'analyze', undefined, (_verdict, _score, text, written) => {
        if (allowExplanationWrite && written && text) setSavedExplanation(toExplanationText(text));
        showGlobalNotification('success', t('editor.aiExplanationSaved'));
        void onRefreshQuestion(questionId).catch((error) => {
          showGlobalNotification('warning', getErrorMessage(error));
        });
      });
    } catch {
      // The hook keeps the error and any interrupted text visible for retry.
    }
  };

  if (!hasContent && !onRefreshQuestion) return null;

  return (
    <section className="space-y-3 border-t border-border/50 pt-3" aria-label={t('editor.explanation')}>
      <div className="flex flex-wrap items-center gap-2">
        {hasContent && (
          <DsButton
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="!px-1.5 text-primary hover:bg-primary/10"
          >
            <Lightbulb size={16} />
            {expanded ? t('editor.collapseExplanation') : t('editor.viewExplanation')}
            <CaretDown
              size={14}
              className={cn(
                'transition-transform duration-200 motion-reduce:transition-none',
                expanded && 'rotate-180',
              )}
            />
          </DsButton>
        )}
        {onRefreshQuestion && (
          <DsButton
            variant="ghost"
            size="sm"
            disabled={ai.state.isGrading}
            onClick={() => void generate()}
            className="text-info hover:bg-info/10"
          >
            <ArrowClockwise size={14} className={ai.state.isGrading ? 'animate-spin motion-reduce:animate-none' : undefined} />
            {ai.state.isGrading ? t('editor.aiAnalyzing') : t('editor.aiAnalysis')}
          </DsButton>
        )}
        {ai.state.isGrading && (
          <DsButton variant="ghost" size="sm" onClick={() => void ai.cancelGrading()}>
            {t('common:cancel')}
          </DsButton>
        )}
      </div>
      {ai.state.error && (
        <p role="alert" className="flex items-start gap-1.5 break-words text-xs text-destructive">
          <WarningCircle size={14} className="shrink-0" />
          {ai.state.error}
        </p>
      )}
      <GradingDiagnosticsView diagnostics={ai.state.diagnostics} />
      {presence.mounted && (
        <div
          aria-hidden={presence.exiting ? true : undefined}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease-standard motion-reduce:transition-none',
            isShown ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="space-y-3 border-l-2 border-primary/35 pl-3.5 pt-0.5 text-sm leading-relaxed text-foreground/85">
              {canonical?.trim() && <MarkdownRenderer content={escapeBareMathAsterisks(canonical)} />}
              {showFeedback && (
                <div className="space-y-2">
                  {(ai.state.error || ai.state.cancelled) && <p className="text-xs text-warning">{t('batch.feedbackDraft')}</p>}
                  {canonical?.trim() && <h4 className="text-xs font-medium text-muted-foreground">{t('editor.aiAnalysis')}</h4>}
                  <StreamingMarkdownRenderer content={toExplanationText(feedback)} isStreaming={ai.state.isGrading} />
                  {allowExplanationWrite && onRefreshQuestion && !ai.state.isGrading && !ai.state.error && !ai.state.cancelled && (
                    <AiExplanationWriteButton
                      questionId={questionId}
                      explanation={canonical}
                      aiText={feedback}
                      onWritten={async () => {
                        await onRefreshQuestion(questionId);
                        setSavedExplanation(null);
                      }}
                    />
                  )}
                </div>
              )}
              {savedDraft && !ai.state.feedback && (
                <details className="space-y-2 border-t border-border/40 pt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">{t('batch.feedbackDraft')}</summary>
                  {savedDraft.feedback && <MarkdownRenderer content={toExplanationText(savedDraft.feedback)} />}
                  <GradingDiagnosticsView diagnostics={savedDraft.diagnostics} />
                </details>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
