import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, Check, Image as ImagePlus, CircleNotch, X } from '@phosphor-icons/react';
import { isMobilePlatform } from '@/utils/platform';
import type { Question } from '@/api/questionBankApi';
import {
  decodeUserAnswer,
  encodeImageAnswerUserAnswer,
  isSubjectiveQuestionType,
  parseImageAnswerEnvelope,
} from '@/api/questionBankApi';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { MarkdownRenderer } from '@/features/chat/components/renderers';
import { FillBlankAnswer } from '@/components/question-types/FillBlankAnswer';
import { MatchingAnswer } from '@/components/question-types/MatchingAnswer';
import { OrderingAnswer } from '@/components/question-types/OrderingAnswer';
import { AnswerImageStrip } from '@/components/question-types/AnswerImageStrip';
import {
  canAddImageAnswerImage,
  uploadImageAnswerImage,
} from '@/components/question-types/imageAnswerUpload';
import {
  decodeFillBlankUserAnswer,
  encodeFillBlankUserAnswer,
  encodeMatchingUserAnswer,
  encodeOrderingUserAnswer,
  parseFillBlankData,
  parseMatchingData,
  parseOrderingData,
} from '@/components/question-types/structured';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/lib/utils';

interface Props {
  question: Question;
  value: string;
  onChange: (value: string) => void;
  onUploadingChange?: (uploading: boolean) => void;
  onPrimaryAction?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

export function PracticeAnswerInput({ question, value, onChange, onUploadingChange, onPrimaryAction }: Props) {
  const { t } = useTranslation('practice');
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const uploadRef = useRef(false);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const envelope = parseImageAnswerEnvelope(value);
  const text = envelope?.text ?? value;
  const images = envelope?.images ?? [];
  const updateText = (next: string) =>
    onChange(images.length ? encodeImageAnswerUserAnswer(images, next) : next);
  const multiple =
    question.questionType === 'multiple_choice' || question.questionType === 'indefinite_choice';
  const fill = parseFillBlankData(question.structured_data);
  const matching = parseMatchingData(question.structured_data);
  const ordering = parseOrderingData(question.structured_data);
  const decoded = decodeUserAnswer(question.questionType, text);
  const count =
    fill?.blanks.length ??
    Math.max(1, (question.content.match(/_{2,}|（\s*）|\(\s*\)/g) ?? []).length);
  const blanks = decodeFillBlankUserAnswer(text);

  const upload = async (files: FileList | null) => {
    if (!files?.length || uploadRef.current) return;
    uploadRef.current = true;
    setUploading(true);
    onUploadingChange?.(true);
    try {
      for (const file of Array.from(files)) {
        const current = parseImageAnswerEnvelope(latest.current.value);
        if (!canAddImageAnswerImage(current?.images.length ?? 0)) break;
        const image = await uploadImageAnswerImage(file);
        const newest = parseImageAnswerEnvelope(latest.current.value);
        latest.current.onChange(
          encodeImageAnswerUserAnswer(
            [...(newest?.images ?? []), image],
            newest?.text ?? latest.current.value,
          ),
        );
      }
    } catch (error) {
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      uploadRef.current = false;
      setUploading(false);
      onUploadingChange?.(false);
      if (fileRef.current) fileRef.current.value = '';
      if (cameraRef.current) cameraRef.current.value = '';
    }
  };

  return (
    <div className="space-y-3">
      {question.options?.length ? (
        <div className="space-y-2.5" data-practice-choice>
          {multiple && (
            <p className="text-xs text-muted-foreground">{t('batch.multiChoiceHint')}</p>
          )}
          {question.options.map((option) => {
            const checked = multiple ? text.includes(option.key) : text === option.key;
            return (
              <label
                key={option.key}
                className={cn(
                  'ui-press group flex min-h-[var(--touch-target-size)] cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-[background-color,border-color,box-shadow,transform] duration-150 motion-reduce:transition-none',
                  'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1',
                  checked
                    ? 'border-primary/60 bg-primary/[0.08] shadow-soft'
                    : 'border-border/45 bg-card/60 hover:border-border/80 hover:bg-foreground/[0.03]',
                )}
              >
                <input
                  className="sr-only"
                  type={multiple ? 'checkbox' : 'radio'}
                  name={`answer-${question.id}`}
                  checked={checked}
                  onChange={() => {
                    if (!multiple) updateText(option.key);
                    else {
                      const selected = new Set(text.split(''));
                      if (selected.has(option.key)) selected.delete(option.key);
                      else selected.add(option.key);
                      updateText([...selected].sort().join(''));
                    }
                  }}
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center border font-mono text-xs font-medium transition-colors duration-150 motion-reduce:transition-none',
                    multiple ? 'rounded-md' : 'rounded-full',
                    checked
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border/60 bg-background/80 text-muted-foreground group-hover:border-border',
                  )}
                >
                  {option.key}
                </span>
                <div className="min-w-0 flex-1 pt-0.5 text-sm leading-relaxed text-foreground">
                  <MarkdownRenderer content={option.content} />
                </div>
                <Check
                  size={15}
                  weight="bold"
                  aria-hidden="true"
                  className={cn(
                    'mt-1 shrink-0 text-primary transition-opacity duration-150 motion-reduce:transition-none',
                    checked ? 'opacity-100' : 'opacity-0',
                  )}
                />
              </label>
            );
          })}
        </div>
      ) : question.questionType === 'true_false' ? (
        <div className="flex gap-3" data-practice-choice>
          {['true', 'false'].map((answer) => {
            const checked = text === answer;
            return (
              <label
                key={answer}
                className={cn(
                  'ui-press flex min-h-[var(--touch-target-size)] flex-1 cursor-pointer items-center gap-3 rounded-xl border px-4 py-2.5 text-sm transition-[background-color,border-color,box-shadow,transform] duration-150 motion-reduce:transition-none',
                  'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1',
                  checked
                    ? 'border-primary/60 bg-primary/[0.08] font-medium text-foreground shadow-soft'
                    : 'border-border/45 bg-card/60 text-foreground/85 hover:border-border/80 hover:bg-foreground/[0.03]',
                )}
              >
                <input
                  className="sr-only"
                  type="radio"
                  name={`answer-${question.id}`}
                  checked={checked}
                  onChange={() => updateText(answer)}
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs font-medium transition-colors duration-150 motion-reduce:transition-none',
                    checked
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border/60 bg-background/80 text-muted-foreground',
                  )}
                >
                  {answer === 'true' ? 'T' : 'F'}
                </span>
                <span className="flex-1">{t(`batch.${answer}`)}</span>
                <Check
                  size={15}
                  weight="bold"
                  aria-hidden="true"
                  className={cn(
                    'shrink-0 text-primary transition-opacity duration-150 motion-reduce:transition-none',
                    checked ? 'opacity-100' : 'opacity-0',
                  )}
                />
              </label>
            );
          })}
        </div>
      ) : question.questionType === 'fill_blank' && !images.length ? (
        <FillBlankAnswer
          answers={Array.from({ length: count }, (_, i) => blanks[i] ?? '')}
          onChange={(next) =>
            updateText(next.some((a) => a.trim()) ? encodeFillBlankUserAnswer(next) : '')
          }
          onPrimaryAction={onPrimaryAction}
        />
      ) : question.questionType === 'matching' && matching ? (
        <MatchingAnswer
          data={{ ...matching, pairs: [] }}
          pairs={decoded?.type === 'matching' ? decoded.pairs : []}
          onChange={(pairs) => updateText(pairs.length ? encodeMatchingUserAnswer(pairs) : '')}
        />
      ) : question.questionType === 'ordering' && ordering ? (
        <div className="space-y-2"><OrderingAnswer
          data={{ ...ordering, correct_order: [] }}
          order={
            decoded?.type === 'ordering' ? decoded.order : ordering.items.map((item) => item.key)
          }
          onChange={(order) => updateText(encodeOrderingUserAnswer(order))}
        />{!text && <DsButton variant="outline" size="sm" onClick={() => updateText(encodeOrderingUserAnswer(ordering.items.map(item => item.key)))}>{t('batch.keepOrder')}</DsButton>}</div>
      ) : question.questionType === 'numeric' && !images.length ? (
        <Input
          aria-label={t('batch.yourAnswer')}
          placeholder={t('editor.numeric.placeholder')}
          value={text}
          onChange={event => updateText(event.target.value)}
          onKeyDown={onPrimaryAction}
          inputMode="decimal"
          autoComplete="off"
          className="h-11 w-full rounded-xl border border-border/50 bg-foreground/[0.02] px-3.5 font-mono text-base tabular-nums outline-none transition-colors motion-reduce:transition-none focus-visible:border-primary/45 focus-visible:bg-background focus-visible:ring-0"
        />
      ) : (
        <textarea
          aria-label={t('batch.yourAnswer')}
          placeholder={t('editor.answerPlaceholder')}
          value={text}
          onChange={(event) => updateText(event.target.value)}
          rows={question.questionType === 'numeric' ? 2 : 7}
          className="w-full resize-y rounded-xl border border-border/50 bg-foreground/[0.02] p-3.5 text-sm leading-relaxed outline-none transition-colors motion-reduce:transition-none placeholder:text-muted-foreground/50 focus:border-primary/45 focus:bg-background"
        />
      )}
      {!!images.length && <AnswerImageStrip images={images} readOnly />}
      {!!images.length && (
        <div className="flex flex-wrap gap-2">
          {images.map((image, index) => (
            <DsButton
              key={image.id}
              variant="ghost"
              size="sm"
              onClick={() => {
                const next = images.filter((i) => i.id !== image.id);
                onChange(next.length ? encodeImageAnswerUserAnswer(next, text) : text);
              }}
            >
              <X size={14} />
              {t('batch.removeImage', { n: index + 1 })}
            </DsButton>
          ))}
        </div>
      )}
      {isSubjectiveQuestionType(question.questionType) && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif"
            multiple
            className="hidden"
            onChange={(event) => void upload(event.target.files)}
          />
          {isMobilePlatform() && (
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(event) => void upload(event.target.files)}
            />
          )}
          <DsButton
            variant="outline"
            size="sm"
            disabled={uploading || !canAddImageAnswerImage(images.length)}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? (
              <CircleNotch size={16} className="animate-spin motion-reduce:animate-none" />
            ) : (
              <ImagePlus size={16} />
            )}
            {t('batch.addImage')}
          </DsButton>
          {isMobilePlatform() && (
            <DsButton
              variant="outline"
              size="sm"
              disabled={uploading || !canAddImageAnswerImage(images.length)}
              onClick={() => cameraRef.current?.click()}
            >
              <Camera size={16} />
              {t('batch.takePhoto')}
            </DsButton>
          )}
        </div>
      )}
    </div>
  );
}
