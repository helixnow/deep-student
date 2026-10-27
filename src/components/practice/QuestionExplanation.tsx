import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GradingDiagnostics } from '@/api/practiceApi';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, CaretDown, CaretUp, Lightbulb, WarningCircle } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { MarkdownRenderer, StreamingMarkdownRenderer } from '@/features/chat/components/renderers';
import { useQbankAiGrading } from '@/hooks/useQbankAiGrading';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { AiExplanationWriteButton } from './AiExplanationWriteButton';
import { resolveAiExplanationWrite, toExplanationText } from './aiExplanation';
import { GradingDiagnosticsView } from './GradingDiagnosticsView';

interface Props {
  questionId: string;
  explanation?: string | null;
  aiFeedback?: string | null;
  defaultExpanded?: boolean;
  onRefreshQuestion?: (questionId: string) => Promise<void>;
}

/** Mount with the question ID as key so a stream can never appear on another question. */
export function QuestionExplanation({
  questionId,
  explanation,
  aiFeedback,
  defaultExpanded = false,
  onRefreshQuestion,
}: Props) {
  const { t } = useTranslation('practice');
  const ai = useQbankAiGrading();
  const [expanded, setExpanded] = useState(defaultExpanded);
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
        if (written && text) setSavedExplanation(toExplanationText(text));
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
            className="!h-auto !px-0 text-primary [@media(pointer:coarse)]:!min-h-11"
          >
            <Lightbulb size={16} />
            {expanded ? t('editor.collapseExplanation') : t('editor.viewExplanation')}
            {expanded ? <CaretUp size={14} /> : <CaretDown size={14} />}
          </DsButton>
        )}
        {onRefreshQuestion && (
          <DsButton
            variant="ghost"
            size="sm"
            disabled={ai.state.isGrading}
            onClick={() => void generate()}
            className="!h-auto text-info [@media(pointer:coarse)]:!min-h-11"
          >
            <ArrowClockwise size={14} className={ai.state.isGrading ? 'animate-spin' : undefined} />
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
      {expanded && (
        <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          {canonical?.trim() && <MarkdownRenderer content={canonical} />}
          {showFeedback && (
            <div className="space-y-2">
              {ai.state.error && <p className="text-xs text-warning">{t('batch.feedbackDraft')}</p>}
              {canonical?.trim() && <h4 className="text-sm font-medium text-info">{t('editor.aiAnalysis')}</h4>}
              <StreamingMarkdownRenderer content={toExplanationText(feedback)} isStreaming={ai.state.isGrading} />
              {onRefreshQuestion && !ai.state.isGrading && !ai.state.error && (
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
            <details className="space-y-2 border-t pt-2">
              <summary className="cursor-pointer text-warning">{t('batch.feedbackDraft')}</summary>
              {savedDraft.feedback && <MarkdownRenderer content={toExplanationText(savedDraft.feedback)} />}
              <GradingDiagnosticsView diagnostics={savedDraft.diagnostics} />
            </details>
          )}
        </div>
      )}
    </section>
  );
}
