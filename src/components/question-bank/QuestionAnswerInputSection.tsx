import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CircleNotch, Camera } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { LatexText } from '@/components/LatexText';
import {
  IMAGE_ANSWER_MAX_IMAGES,
  IMAGE_ANSWER_MIME_TYPES,
  type ImageAnswerPayload,
  type Question,
  type QuestionImage,
  type SubmitResult,
} from '@/api/questionBankApi';
import {
  type ExtendedQuestionType,
  type MatchingPair,
  type parseFillBlankData,
  type parseMatchingData,
  type parseNumericData,
  type parseOrderingData,
  TrueFalseAnswer,
  MatchingAnswer,
  OrderingAnswer,
  NumericAnswer,
  FillBlankAnswer,
  AnswerImageStrip,
  ImageAnswerDisplay,
  canAddImageAnswerImage,
} from '@/components/question-types';
import { OptionButton } from './QuestionMediaPrimitives';

export interface QuestionAnswerInputSectionProps {
  currentQuestion: Question;
  qType: ExtendedQuestionType;
  isChoiceQuestion: boolean;
  isMultiSelect: boolean;
  isSmallScreen: boolean;
  selectedAnswer: string;
  onSelectAnswer: (value: string) => void;
  selectedOptions: Set<string>;
  onOptionClick: (key: string) => void;
  submitResult: SubmitResult | null;
  trueFalseCorrectAnswer: 'true' | 'false' | null;
  matchingData: ReturnType<typeof parseMatchingData>;
  matchingPairs: MatchingPair[];
  onMatchingPairsChange: (pairs: MatchingPair[]) => void;
  orderingData: ReturnType<typeof parseOrderingData>;
  orderingOrder: string[];
  onOrderingOrderChange: (order: string[]) => void;
  numericData: ReturnType<typeof parseNumericData>;
  fillBlankData: ReturnType<typeof parseFillBlankData>;
  fillBlankAnswers: string[];
  onFillBlankAnswersChange: (answers: string[]) => void;
  onAnswerPrimaryAction: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  imageAnswerEnabled: boolean;
  answerImages: QuestionImage[];
  submittedImageAnswer: ImageAnswerPayload | null;
  isUploadingAnswerImage: boolean;
  isSubmitting: boolean;
  answerImageInputRef: React.RefObject<HTMLInputElement | null>;
  onAnswerImageSelect: (files: FileList | null) => void;
  onRemoveAnswerImage: (id: string) => void;
}

/** 答题输入区（移动端与桌面端共用，覆盖全部题型与主观/填空图片作答） */
export const QuestionAnswerInputSection: React.FC<QuestionAnswerInputSectionProps> = ({
  currentQuestion,
  qType,
  isChoiceQuestion,
  isMultiSelect,
  isSmallScreen,
  selectedAnswer,
  onSelectAnswer,
  selectedOptions,
  onOptionClick,
  submitResult,
  trueFalseCorrectAnswer,
  matchingData,
  matchingPairs,
  onMatchingPairsChange,
  orderingData,
  orderingOrder,
  onOrderingOrderChange,
  numericData,
  fillBlankData,
  fillBlankAnswers,
  onFillBlankAnswersChange,
  onAnswerPrimaryAction,
  imageAnswerEnabled,
  answerImages,
  submittedImageAnswer,
  isUploadingAnswerImage,
  isSubmitting,
  answerImageInputRef,
  onAnswerImageSelect,
  onRemoveAnswerImage,
}) => {
  const { t } = useTranslation('practice');

  const renderImageAnswerControls = () => {
    if (!imageAnswerEnabled) return null;
    const disabled = !!submitResult || isUploadingAnswerImage || isSubmitting;
    return (
      <div className="space-y-2">
        {!submitResult && submittedImageAnswer && (
          <ImageAnswerDisplay
            images={submittedImageAnswer.images}
            text={submittedImageAnswer.text}
          />
        )}
        {answerImages.length > 0 && (
          <AnswerImageStrip
            images={answerImages}
            readOnly={!!submitResult}
            onRemove={onRemoveAnswerImage}
          />
        )}
        {!submitResult && (
          <div className="flex items-center gap-2">
            <DsButton
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || !canAddImageAnswerImage(answerImages.length)}
              onClick={() => answerImageInputRef.current?.click()}
            >
              {isUploadingAnswerImage
                ? <CircleNotch size={16} className="animate-spin" />
                : <Camera size={16} />}
              <span className="text-xs">
                {t('editor.imageAnswerUpload', { defaultValue: '拍照/上传手写答案' })}
              </span>
            </DsButton>
            <span className="text-xs text-muted-foreground">
              {answerImages.length}/{IMAGE_ANSWER_MAX_IMAGES}
            </span>
          </div>
        )}
        <input
          ref={answerImageInputRef}
          type="file"
          accept={IMAGE_ANSWER_MIME_TYPES.join(',')}
          multiple
          className="hidden"
          onChange={(e) => {
            onAnswerImageSelect(e.target.files);
          }}
        />
      </div>
    );
  };

  if (isChoiceQuestion && currentQuestion.options) {
    return (
      <div className="space-y-3" data-practice-choice>
        {currentQuestion.options.map((opt, index) => (
          <OptionButton
            key={opt.key}
            optionKey={opt.key}
            content={opt.content}
            isSelected={
              isMultiSelect
                ? selectedOptions.has(opt.key)
                : selectedAnswer === opt.key
            }
            isSubmitted={!!submitResult}
            isCorrect={submitResult?.isCorrect ?? null}
            correctAnswer={submitResult?.correctAnswer}
            onSelect={onOptionClick}
            type={isMultiSelect ? 'multiple' : 'single'}
            shortcutHint={!isSmallScreen && index < 9 ? String(index + 1) : undefined}
          />
        ))}
      </div>
    );
  }

  if (qType === 'true_false') {
    return (
      <div data-practice-choice>
        <TrueFalseAnswer
          value={selectedAnswer === 'true' || selectedAnswer === 'false' ? selectedAnswer : ''}
          onChange={(v) => onSelectAnswer(v)}
          submitted={!!submitResult}
          correctAnswer={submitResult ? trueFalseCorrectAnswer : null}
        />
      </div>
    );
  }

  if (qType === 'matching' && matchingData) {
    return (
      <MatchingAnswer
        data={matchingData}
        pairs={matchingPairs}
        onChange={onMatchingPairsChange}
        submitted={!!submitResult}
      />
    );
  }

  if (qType === 'ordering' && orderingData) {
    return (
      <OrderingAnswer
        data={orderingData}
        order={orderingOrder}
        onChange={onOrderingOrderChange}
        submitted={!!submitResult}
      />
    );
  }

  if (qType === 'numeric') {
    return (
      <NumericAnswer
        value={selectedAnswer}
        onChange={onSelectAnswer}
        spec={numericData}
        submitted={!!submitResult}
        isCorrect={submitResult ? submitResult.isCorrect : null}
        onPrimaryAction={onAnswerPrimaryAction}
      />
    );
  }

  if (qType === 'fill_blank') {
    return (
      <div className="space-y-3">
        <FillBlankAnswer
          answers={fillBlankAnswers}
          onChange={onFillBlankAnswersChange}
          blanks={fillBlankData}
          submitted={!!submitResult}
          onPrimaryAction={onAnswerPrimaryAction}
        />
        {renderImageAnswerControls()}
      </div>
    );
  }

  if (qType === 'short_answer') {
    return (
      <div className="space-y-3">
        <Input
          value={selectedAnswer}
          onChange={(e) => onSelectAnswer(e.target.value)}
          onKeyDown={onAnswerPrimaryAction}
          placeholder={t('editor.answerPlaceholder')}
          disabled={!!submitResult}
          className="h-11 rounded-xl border border-border/50 bg-foreground/[0.02] px-3.5 transition-colors focus-visible:border-primary/45 focus-visible:bg-background focus-visible:ring-0"
        />
        {renderImageAnswerControls()}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Textarea
        value={selectedAnswer}
        onChange={(e) => onSelectAnswer(e.target.value)}
        placeholder={t('editor.answerPlaceholder')}
        disabled={!!submitResult}
        rows={4}
        className="resize-none rounded-xl border border-border/50 bg-foreground/[0.02] p-3.5 transition-colors focus-visible:border-primary/45 focus-visible:bg-background focus-visible:ring-0"
      />
      {imageAnswerEnabled && renderImageAnswerControls()}
    </div>
  );
};

export interface QuestionBrowseAnswerViewProps {
  currentQuestion: Question;
  isChoiceQuestion: boolean;
  structuredAnswerSummaryNode: React.ReactNode;
  explanationNode: React.ReactNode;
  variant: 'mobile' | 'desktop';
}

/** 浏览模式：只读选项高亮、参考答案、无答案提示与解析 */
export const QuestionBrowseAnswerView: React.FC<QuestionBrowseAnswerViewProps> = ({
  currentQuestion,
  isChoiceQuestion,
  structuredAnswerSummaryNode,
  explanationNode,
  variant,
}) => {
  const { t } = useTranslation('practice');
  const isDesktop = variant === 'desktop';

  return (
    <div className={isDesktop ? 'space-y-4' : 'space-y-3'}>
      {isChoiceQuestion && currentQuestion.options && (
        <div className="space-y-2.5">
          {currentQuestion.options.map(opt => (
            <div
              key={opt.key}
              className={cn(
                'flex items-start gap-3 rounded-xl border px-4 py-3',
                isDesktop && 'transition-colors',
                currentQuestion.answer?.includes(opt.key)
                  ? 'border-success/40 bg-success/[0.06]'
                  : 'border-border/45 bg-card/60'
              )}
            >
              <span className={cn(
                'flex-shrink-0 w-6 h-6 rounded-md border flex items-center justify-center font-mono text-xs font-medium',
                currentQuestion.answer?.includes(opt.key)
                  ? 'border-success bg-success text-success-foreground'
                  : 'border-border/60 bg-background/80 text-muted-foreground'
              )}>
                {opt.key}
              </span>
              <LatexText content={opt.content} className="text-sm flex-1 pt-0.5 leading-relaxed" />
              {isDesktop && currentQuestion.answer?.includes(opt.key) && (
                <Check size={16} className="text-success flex-shrink-0" />
              )}
            </div>
          ))}
        </div>
      )}

      {(structuredAnswerSummaryNode || currentQuestion.answer) && (
        <div className="rounded-xl border border-success/35 bg-success/[0.05] p-3.5">
          <div className={cn('flex items-center', isDesktop ? 'gap-2 mb-2' : 'gap-1.5 mb-1')}>
            <Check size={isDesktop ? 16 : 14} className="text-success" />
            <span className={cn('font-medium text-success', isDesktop ? 'text-sm' : 'text-xs')}>
              {t('editor.referenceAnswer')}
            </span>
          </div>
          {structuredAnswerSummaryNode ?? (
            <LatexText content={currentQuestion.answer!} className="text-sm" />
          )}
        </div>
      )}

      {!structuredAnswerSummaryNode && !currentQuestion.answer && !currentQuestion.explanation && (
        <div className="rounded-xl bg-muted/40 p-3.5 text-center">
          <p className="text-sm text-muted-foreground">{t('editor.noAnswerOrExplanation')}</p>
        </div>
      )}

      {explanationNode}
    </div>
  );
};
