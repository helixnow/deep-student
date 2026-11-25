import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Tag,
  CircleNotch,
  PaperPlaneRight,
  Star,
  GearSix,
  Eye,
  Crop,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { QuestionMaterialView } from '@/components/QuestionMaterialView';
import type { Question, SubmitResult } from '@/api/questionBankApi';
import type { ExtendedQuestionType } from '@/components/question-types';
import {
  DIFFICULTY_CONFIG,
  DIFFICULTY_I18N_KEY,
  QUESTION_TYPE_I18N_KEY,
  STATUS_CONFIG,
  STATUS_I18N_KEY,
} from './questionBankEditorConfig';
import {
  QuestionContentBlock,
  QuestionImagesSection,
} from './QuestionMediaPrimitives';
import { QuestionBrowseAnswerView } from './QuestionAnswerInputSection';

export interface QuestionEditorStageProps {
  variant: 'mobile' | 'desktop';
  currentQuestion: Question;
  currentIndex: number;
  totalQuestions: number;
  qType: ExtendedQuestionType;
  isChoiceQuestion: boolean;
  isSmallScreen: boolean;
  focusMode: boolean;
  browseMode: boolean;
  isFavorite: boolean;
  canToggleFavorite: boolean;
  showSettingsPanel: boolean;
  hideAnswerMode: boolean;
  answerRevealed: boolean;
  submitResult: SubmitResult | null;
  canSubmit: boolean;
  isSubmitting: boolean;
  questionImageUrls: Record<string, string>;
  questionTransitionStyle: React.CSSProperties;
  structuredAnswerSummaryNode: React.ReactNode;
  browsePracticeButton: React.ReactNode;
  answerInputNode: React.ReactNode;
  submitResultCardNode: React.ReactNode;
  browseExplanationNode: React.ReactNode;
  practiceExplanationNode: React.ReactNode;
  userNoteSectionNode: React.ReactNode;
  onToggleFavorite: () => void;
  onOpenCropDialog: () => void;
  onToggleSettingsPanel: () => void;
  onRefreshQuestion?: (questionId: string) => Promise<void>;
  onRevealAnswer: () => void;
  onSubmit: () => void;
}

/**
 * 题目主舞台（移动端与桌面端共用）：
 * 题头页眉 + 共享材料 + 题干 Markdown + 图片区 + 浏览/作答区 + 结果卡/解析/笔记
 */
export const QuestionEditorStage: React.FC<QuestionEditorStageProps> = ({
  variant,
  currentQuestion,
  currentIndex,
  totalQuestions,
  qType,
  isChoiceQuestion,
  isSmallScreen,
  focusMode,
  browseMode,
  isFavorite,
  canToggleFavorite,
  showSettingsPanel,
  hideAnswerMode,
  answerRevealed,
  submitResult,
  canSubmit,
  isSubmitting,
  questionImageUrls,
  questionTransitionStyle,
  structuredAnswerSummaryNode,
  browsePracticeButton,
  answerInputNode,
  submitResultCardNode,
  browseExplanationNode,
  practiceExplanationNode,
  userNoteSectionNode,
  onToggleFavorite,
  onOpenCropDialog,
  onToggleSettingsPanel,
  onRefreshQuestion,
  onRevealAnswer,
  onSubmit,
}) => {
  const { t } = useTranslation('practice');
  const isDesktop = variant === 'desktop';

  return (
    <div
      key={currentQuestion.id}
      className={cn('ui-slide-fade-in', isDesktop ? 'space-y-5' : 'space-y-4')}
      style={questionTransitionStyle}
    >
      {/* 单行题头页眉：题号 + 题型 + 难度 + 状态（桌面端）+ 标签 + 收藏 + 原图裁剪 + 设置 */}
      <div className={cn('flex flex-wrap items-center gap-1.5', isDesktop && 'sm:gap-2')}>
        <span className="font-mono text-xs font-medium tabular-nums text-muted-foreground">
          {currentQuestion.questionLabel || `Q${currentIndex + 1}`} · {currentIndex + 1}/{totalQuestions}
        </span>
        <span className="rounded-md bg-foreground/[0.04] px-2 py-0.5 text-xs text-muted-foreground">
          {t(`editor.questionType.${QUESTION_TYPE_I18N_KEY[currentQuestion.questionType]}`)}
        </span>
        {/* 专注模式下隐藏难度、状态与标签 */}
        {!focusMode && currentQuestion.difficulty && (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-foreground/[0.04] px-2 py-0.5 text-xs text-muted-foreground">
            <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', DIFFICULTY_CONFIG[currentQuestion.difficulty].dot)} aria-hidden="true" />
            {t(`questionBank.difficulty.${DIFFICULTY_I18N_KEY[currentQuestion.difficulty]}`)}
          </span>
        )}
        {isDesktop && !focusMode && currentQuestion.status && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', STATUS_CONFIG[currentQuestion.status].dot)} aria-hidden="true" />
            {t(`questionBank.status.${STATUS_I18N_KEY[currentQuestion.status]}`)}
          </span>
        )}
        {!focusMode && currentQuestion.tags && currentQuestion.tags.length > 0 && (
          currentQuestion.tags.map(tag => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-md bg-foreground/[0.04] px-2 py-0.5 text-xs text-muted-foreground"
            >
              <Tag size={11} />
              {tag}
            </span>
          ))
        )}
        <div className="ml-auto flex items-center gap-1">
          {canToggleFavorite && (
            <DsButton
              variant="ghost"
              size={isDesktop ? 'sm' : 'icon'}
              iconOnly
              onClick={onToggleFavorite}
              aria-label={isFavorite ? t('editor.unfavorite') : t('editor.favorite')}
              aria-pressed={isFavorite}
              title={isFavorite ? t('editor.unfavorite') : t('editor.favorite')}
              className="text-muted-foreground hover:text-foreground"
            >
              <Star
                size={isDesktop ? 15 : 16}
                weight={isFavorite ? 'fill' : 'regular'}
                className={isFavorite ? 'text-warning' : undefined}
              />
            </DsButton>
          )}
          <DsButton
            variant="ghost"
            size={isDesktop ? 'sm' : 'icon'}
            iconOnly
            onClick={onOpenCropDialog}
            aria-label={t('common:question_bank.source_images')}
            title={t('common:question_bank.source_images')}
            className="text-muted-foreground hover:text-foreground"
          >
            <Crop size={isDesktop ? 15 : 16} />
          </DsButton>
          {browseMode ? browsePracticeButton : (
            <DsButton
              variant="ghost"
              size={isDesktop ? 'sm' : 'icon'}
              iconOnly
              onClick={onToggleSettingsPanel}
              aria-label={isDesktop ? t('editor.settings') : t('questionBank.settings', 'Settings')}
              aria-pressed={isDesktop ? showSettingsPanel : undefined}
              title={isDesktop ? t('editor.settings') : t('questionBank.settings', 'Settings')}
              className="text-muted-foreground hover:text-foreground"
            >
              <GearSix size={isDesktop ? 16 : 18} />
            </DsButton>
          )}
        </div>
      </div>

      <div className={isDesktop ? 'space-y-6' : 'space-y-4'}>
        {/* issue 491：共享材料在题目之前独立展示（单题练习同样可见） */}
        <QuestionMaterialView
          materials={currentQuestion.materials ?? []}
          mode={browseMode ? 'view' : 'edit'}
          onUpdated={async () => {
            if (onRefreshQuestion) await onRefreshQuestion(currentQuestion.id);
          }}
        />
        <div className="prose prose-sm dark:prose-invert max-w-[74ch] text-lg leading-[1.72] text-foreground">
          <QuestionContentBlock
            content={currentQuestion.content || currentQuestion.ocrText || t('editor.noContent')}
          />
        </div>

        {/* 题目图片 */}
        {currentQuestion.images && currentQuestion.images.length > 0 && (
          <QuestionImagesSection
            images={currentQuestion.images}
            imageUrls={questionImageUrls}
            collapsedClassName={isDesktop ? 'max-h-64' : 'max-h-48'}
            placeholderClassName={isDesktop ? 'h-32' : 'h-24'}
            iconSize={isDesktop ? 20 : 16}
            singleGridClassName={isDesktop ? 'grid-cols-1 max-w-md' : 'grid-cols-1'}
          />
        )}

        {/* 答题区域（浏览模式 vs 做题模式） */}
        {browseMode ? (
          <QuestionBrowseAnswerView
            currentQuestion={currentQuestion}
            isChoiceQuestion={isChoiceQuestion}
            structuredAnswerSummaryNode={structuredAnswerSummaryNode}
            explanationNode={browseExplanationNode}
            variant={variant}
          />
        ) : (
          <>
            {/* 暗记模式遮罩 */}
            {hideAnswerMode && !answerRevealed && !submitResult && (
              <DsButton
                variant="ghost"
                size="sm"
                onClick={onRevealAnswer}
                className={cn(
                  'w-full !h-auto !rounded-xl border border-dashed border-border/60 bg-muted/20 flex-col items-center justify-center hover:bg-foreground/[0.03]',
                  isDesktop ? '!p-12 gap-3' : '!p-8 gap-2'
                )}
              >
                <Eye size={isDesktop ? 36 : 28} className="text-muted-foreground" />
                <span className={cn('text-muted-foreground', !isDesktop && 'text-sm')}>
                  {isDesktop ? t('editor.clickToRevealWithKey') : t('editor.clickToReveal')}
                </span>
              </DsButton>
            )}

            {/* 正常答题区域（移动端与桌面端共用题型渲染） */}
            {(!hideAnswerMode || answerRevealed || submitResult) && (
              isDesktop ? <div className="space-y-4">{answerInputNode}</div> : answerInputNode
            )}

            {!submitResult && (
              <DsButton
                variant="primary"
                size="lg"
                onClick={onSubmit}
                disabled={!canSubmit || isSubmitting}
                className="w-full !rounded-xl"
              >
                {isSubmitting ? (
                  <>
                    <CircleNotch size={16} className="animate-spin" />
                    {t('editor.submitting')}
                  </>
                ) : (
                  <>
                    <PaperPlaneRight size={16} />
                    {t('editor.submitAnswer')}
                  </>
                )}
              </DsButton>
            )}

            {/* 内联快捷键提示（桌面端，按题型展示对应提示） */}
            {isDesktop && !isSmallScreen && (
              <p className="text-center text-xs text-muted-foreground/60 select-none">
                {submitResult
                  ? t('editor.inlineShortcutHintAfterSubmit')
                  : isChoiceQuestion
                    ? t('editor.inlineShortcutHint')
                    : qType === 'true_false'
                      ? t('editor.inlineShortcutHintTrueFalse')
                      : t('editor.inlineShortcutHintGeneric')}
              </p>
            )}

            {/* 提交结果 / 解析 / 用户笔记 */}
            {submitResultCardNode}
            {practiceExplanationNode}
            {userNoteSectionNode}
          </>
        )}
      </div>
    </div>
  );
};
