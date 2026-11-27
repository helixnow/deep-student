import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  X,
  WarningCircle,
  Lightbulb,
  ArrowClockwise,
  CircleNotch,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { DsButton } from '@/components/ui/DsButton';
import { StreamingMarkdownRenderer } from '@/features/chat/components/renderers';
import { LatexText } from '@/components/LatexText';
import { GradingDiagnosticsView } from '@/components/practice/GradingDiagnosticsView';
import { QuestionFollowUpBar } from '@/components/practice/QuestionFollowUpBar';
import { ImageAnswerDisplay } from '@/components/question-types';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import type { useQbankAiGrading } from '@/hooks/useQbankAiGrading';
import type { ImageAnswerPayload, Question, SubmitResult } from '@/api/questionBankApi';

export interface QuestionSubmitResultCardProps {
  submitResult: SubmitResult;
  submittedImageAnswer: ImageAnswerPayload | null;
  aiGrading: ReturnType<typeof useQbankAiGrading>;
  onRetryAiGrading: () => Promise<unknown> | undefined;
  canManualGrade: boolean;
  isManualGrading: boolean;
  onManualGrade: (isCorrect: boolean) => void;
  structuredRevealsAnswer: boolean;
  onRetry: () => void;
  currentQuestion: Question;
  sessionId: string;
  selectedAnswer: string;
  extraClassName?: string;
}

/**
 * 提交结果卡片（移动端与桌面端共用）
 * 包含：图片作答回显 / AI 判分流式结果 / 失败重试 / 手动批改兜底 / 追问条
 */
export const QuestionSubmitResultCard: React.FC<QuestionSubmitResultCardProps> = ({
  submitResult,
  submittedImageAnswer,
  aiGrading,
  onRetryAiGrading,
  canManualGrade,
  isManualGrading,
  onManualGrade,
  structuredRevealsAnswer,
  onRetry,
  currentQuestion,
  sessionId,
  selectedAnswer,
  extraClassName,
}) => {
  const { t } = useTranslation('practice');

  return (
    <div
      className={cn(
        'ui-rise-in p-3 rounded-md space-y-3',
        submitResult.needsManualGrading
          ? 'bg-warning/[0.08] dark:bg-warning/[0.15]'
          : submitResult.isCorrect
            ? 'bg-success/[0.08] dark:bg-success/[0.15]'
            : 'bg-destructive/[0.08] dark:bg-destructive/[0.15]',
        extraClassName
      )}
    >
      {/* 图片作答回显：本次提交是信封时只读展示缩略图 + 文字补充 */}
      {submittedImageAnswer && (
        <ImageAnswerDisplay
          images={submittedImageAnswer.images}
          text={submittedImageAnswer.text}
        />
      )}
      {submitResult.needsManualGrading ? (
        <>
          {/* AI 评判中 */}
          {aiGrading.state.isGrading ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <CircleNotch size={14} className="shrink-0 text-info animate-spin motion-reduce:animate-none" aria-hidden="true" />
                <span className="text-sm font-medium text-info">
                  {t('editor.aiGrading')}
                </span>
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={() => aiGrading.cancelGrading()}
                  className="ml-auto !h-auto !p-0 text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('common:cancel')}
                </DsButton>
              </div>
              {aiGrading.state.feedback ? (
                <CustomScrollArea
                  className="max-h-48"
                  viewportClassName="pl-6 text-sm leading-relaxed text-muted-foreground"
                  fullHeight={false}
                >
                  <StreamingMarkdownRenderer
                    content={aiGrading.state.feedback}
                    isStreaming={true}
                  />
                </CustomScrollArea>
              ) : null}
            </div>
          ) : aiGrading.state.error ? (
            /* AI 评判失败，回退手动批改 + 内联重试 */
            <div className="space-y-2">
              <div className="flex items-center gap-2.5">
                <div className="w-5 h-5 rounded-full bg-warning flex items-center justify-center">
                  <WarningCircle size={12} className="text-warning-foreground" />
                </div>
                <span className="text-sm text-warning">
                  {t('editor.aiGradingFailed')}
                </span>
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onRetryAiGrading()?.catch((err) => {
                      debugLog.warn('[QuestionBankEditor] AI grading retry failed:', err);
                    });
                  }}
                  className="ml-auto !h-auto !px-2 !py-0.5 text-xs text-info hover:bg-info/10"
                >
                  <ArrowClockwise size={12} />
                  {t('editor.aiRetry')}
                </DsButton>
              </div>
              {/* #56: 评判失败时保留已流式输出的内容，不再整段消失 */}
              <p role="alert" className="break-words text-xs text-destructive">{aiGrading.state.error}</p>
              <GradingDiagnosticsView diagnostics={aiGrading.state.diagnostics} />
              {aiGrading.state.feedback && (
                <CustomScrollArea
                  className="max-h-48"
                  viewportClassName="pl-7.5 text-sm leading-relaxed text-muted-foreground"
                  fullHeight={false}
                >
                  <StreamingMarkdownRenderer
                    content={aiGrading.state.feedback}
                    isStreaming={false}
                  />
                </CustomScrollArea>
              )}
              {submitResult.correctAnswer && (
                <p className="text-sm text-muted-foreground pl-7.5">
                  {t('editor.referenceAnswerLabel')}<LatexText content={submitResult.correctAnswer} className="inline font-medium text-foreground" />
                </p>
              )}
              {canManualGrade && (
                <div className="flex gap-2 pt-1">
                  <DsButton
                    variant="ghost"
                    size="sm"
                    onClick={() => onManualGrade(true)}
                    disabled={isManualGrading}
                    className="flex-1 !h-8 [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)] bg-success/10 text-success hover:bg-success/[0.15]"
                  >
                    <Check size={14} />
                    {t('editor.iGotItRight')}
                  </DsButton>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    onClick={() => onManualGrade(false)}
                    disabled={isManualGrading}
                    className="flex-1 !h-8 [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)] text-destructive bg-destructive/10 hover:bg-destructive/[0.15]"
                  >
                    <X size={14} />
                    {t('editor.iGotItWrong')}
                  </DsButton>
                </div>
              )}
            </div>
          ) : (
            /* 等待 AI 评判（尚未开始）- 显示等待状态 + 手动兜底 */
            <div className="space-y-2">
              <div className="flex items-center gap-2.5">
                <div className="w-5 h-5 rounded-full bg-warning flex items-center justify-center">
                  <Lightbulb size={12} className="text-warning-foreground" />
                </div>
                <div>
                  <span className="text-sm font-medium text-warning">{t('editor.subjectiveSubmitted')}</span>
                  <span className="text-xs text-muted-foreground ml-2">{t('editor.judgeSelf')}</span>
                </div>
              </div>
              {submitResult.correctAnswer && (
                <p className="text-sm text-muted-foreground pl-7.5">
                  {t('editor.referenceAnswerLabel')}<LatexText content={submitResult.correctAnswer} className="inline font-medium text-foreground" />
                </p>
              )}
              {canManualGrade && (
                <div className="flex gap-2 pt-1">
                  <DsButton
                    variant="ghost"
                    size="sm"
                    onClick={() => onManualGrade(true)}
                    disabled={isManualGrading}
                    className="flex-1 !h-8 [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)] bg-success/10 text-success hover:bg-success/[0.15]"
                  >
                    <Check size={14} />
                    {t('editor.iGotItRight')}
                  </DsButton>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    onClick={() => onManualGrade(false)}
                    disabled={isManualGrading}
                    className="flex-1 !h-8 [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)] text-destructive bg-destructive/10 hover:bg-destructive/[0.15]"
                  >
                    <X size={14} />
                    {t('editor.iGotItWrong')}
                  </DsButton>
                </div>
              )}
            </div>
          )}

          {/* AI 评判完成后的结果展示（verdict + score + feedback） */}
          {!aiGrading.state.isGrading && aiGrading.state.feedback && !aiGrading.state.error && (
            <div className="pt-2 border-t border-foreground/[0.06] space-y-2">
              {aiGrading.state.cancelled && <p className="text-xs text-warning">{t('batch.feedbackDraft')}</p>}
              {aiGrading.state.verdict && (
                <div className="flex items-center gap-2">
                  <span className={cn(
                    'text-xs font-medium px-2 py-0.5 rounded-full',
                    aiGrading.state.verdict === 'correct' ? 'bg-success/10 text-success' :
                    aiGrading.state.verdict === 'partial' ? 'bg-warning/20 text-warning' :
                    'bg-destructive/10 text-destructive'
                  )}>
                    {aiGrading.state.verdict === 'correct' ? t('editor.verdictCorrect') : aiGrading.state.verdict === 'partial' ? t('editor.verdictPartial') : t('editor.verdictIncorrect')}
                  </span>
                  {aiGrading.state.score != null && (
                    <span className="text-xs text-muted-foreground">
                      {t('editor.aiScore', { score: aiGrading.state.score })}
                    </span>
                  )}
                </div>
              )}
              <div className="text-sm text-muted-foreground leading-relaxed">
                <StreamingMarkdownRenderer
                  content={aiGrading.state.feedback}
                  isStreaming={false}
                />
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 flex-wrap">
              <div className={cn(
                'w-5 h-5 rounded-full flex items-center justify-center',
                submitResult.aiVerdict === 'partial'
                  ? 'bg-warning'
                  : submitResult.isCorrect
                    ? 'bg-success qbank-anim-pop'
                    : 'bg-destructive'
              )}>
                {submitResult.isCorrect ? (
                  <Check size={12} weight="bold" className="text-success-foreground" />
                ) : submitResult.aiVerdict === 'partial' ? (
                  <WarningCircle size={12} className="text-warning-foreground" />
                ) : (
                  <X size={12} className="text-destructive-foreground" />
                )}
              </div>
              <span className={cn(
                'text-sm font-medium',
                submitResult.aiVerdict === 'partial'
                  ? 'text-warning'
                  : submitResult.isCorrect
                    ? 'text-success'
                    : 'text-destructive'
              )}>
                {submitResult.aiVerdict === 'partial'
                  ? t('editor.verdictPartial')
                  : submitResult.isCorrect
                    ? t('editor.answerCorrect')
                    : t('editor.answerWrong')}
              </span>
              {(submitResult.aiScore != null || aiGrading.state.score != null) && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t('editor.aiScore', {
                    score: submitResult.aiScore ?? aiGrading.state.score,
                  })}
                </span>
              )}
              {/* 结构化题型的标准答案由作答组件内联揭示，这里不再重复展示原始 JSON */}
              {submitResult.correctAnswer && !submitResult.isCorrect && !structuredRevealsAnswer && (
                <span className="text-sm text-muted-foreground">
                  · {t('editor.correctAnswerLabel')}<LatexText content={submitResult.correctAnswer} className="inline font-medium text-foreground" />
                </span>
              )}
            </div>
            {/* 重做按钮 */}
            {!submitResult.isCorrect && (
              <DsButton
                variant="ghost"
                size="sm"
                onClick={onRetry}
                className="!h-auto !px-2.5 !py-1 text-xs text-muted-foreground hover:bg-foreground/5"
                title={t('editor.retryTitle')}
              >
                <ArrowClockwise size={14} />
                {t('editor.retry')}
              </DsButton>
            )}
          </div>

          {/* 主观题 AI 评判反馈：needsManualGrading 置 false 后仍保留分析正文 */}
          {!aiGrading.state.isGrading && aiGrading.state.feedback && !aiGrading.state.error && (
            <div className="pt-2 border-t border-foreground/[0.06] text-sm text-muted-foreground leading-relaxed">
              {aiGrading.state.cancelled && <p className="text-xs text-warning">{t('batch.feedbackDraft')}</p>}
              <StreamingMarkdownRenderer
                content={aiGrading.state.feedback}
                isStreaming={false}
              />
            </div>
          )}

          {/* 追问：问 AI 讲解 / 生成同类题 / 回到出处（错题 → 对话闭环） */}
          <QuestionFollowUpBar
            question={currentQuestion}
            examId={sessionId}
            userAnswer={selectedAnswer}
            isCorrect={submitResult?.isCorrect}
          />
        </>
      )}
      {aiGrading.state.diagnostics?.status === 'completed' && (
        <GradingDiagnosticsView diagnostics={aiGrading.state.diagnostics} />
      )}
    </div>
  );
};
