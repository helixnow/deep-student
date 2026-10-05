/**
 * 课中检查点卡片：播到锚定时刻时出现在伴随面板顶部（默认只提示不暂停，可切「到点暂停」）。
 * 选择 / 判断题点选判分；其余题型看参考答案后自评。判分走题库（作答记录 / 错题 / 掌握度），
 * 答错时突出「回看这一段」。
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowCounterClockwise, CheckCircle, Play, X, XCircle } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { formatMediaRefTimestamp, MEDIA_REF_PATTERN_SOURCE } from './mediaRefTime';
import {
  CHOICE_QUESTION_TYPES,
  submitCheckpointAnswer,
  type MediaCheckpoint,
  type MediaCheckpointOption,
} from './mediaCheckpoints';

/** 回看从锚点前几秒开始，带上一点上文 */
export const CHECKPOINT_REWATCH_LEAD_SECONDS = 15;

const MEDIA_REF_RE = new RegExp(MEDIA_REF_PATTERN_SOURCE, 'g');

/** 解析里的 `[媒体@id:mm:ss]` 显示为「▶ mm:ss」 */
export function readableExplanation(text: string): string {
  return text.replace(MEDIA_REF_RE, (_match, _id: string, time: string) => `▶ ${time}`).trim();
}

type Phase =
  | { kind: 'asking' }
  | { kind: 'revealed' }
  | { kind: 'result'; isCorrect: boolean | null; correctAnswer: string | null };

export interface MediaCheckpointCardProps {
  checkpoint: MediaCheckpoint;
  pauseAtCheckpoints: boolean;
  onPauseAtCheckpointsChange: (value: boolean) => void;
  onSeek: (seconds: number) => void;
  onResume: () => void;
  onClose: () => void;
  onAnswered: (questionId: string, isCorrect: boolean | null) => void;
}

export const MediaCheckpointCard: React.FC<MediaCheckpointCardProps> = ({
  checkpoint,
  pauseAtCheckpoints,
  onPauseAtCheckpointsChange,
  onSeek,
  onResume,
  onClose,
  onAnswered,
}) => {
  const { t } = useTranslation(['learningHub']);
  const [phase, setPhase] = useState<Phase>({ kind: 'asking' });
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const time = formatMediaRefTimestamp(checkpoint.seconds);
  const isChoice = CHOICE_QUESTION_TYPES.has(checkpoint.questionType);
  const multiple = checkpoint.questionType === 'multiple_choice' || checkpoint.questionType === 'indefinite_choice';
  const options = useMemo<MediaCheckpointOption[]>(() => {
    if (checkpoint.options.length > 0) return checkpoint.options;
    if (checkpoint.questionType === 'true_false') {
      return [
        { key: 'true', content: t('learningHub:mediaCheckpoint.true') },
        { key: 'false', content: t('learningHub:mediaCheckpoint.false') },
      ];
    }
    return [];
  }, [checkpoint.options, checkpoint.questionType, t]);

  const submit = async (answer: string, isCorrectOverride?: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const result = await submitCheckpointAnswer(checkpoint.questionId, answer, isCorrectOverride);
      const isCorrect = isCorrectOverride ?? result.isCorrect;
      setPhase({ kind: 'result', isCorrect, correctAnswer: result.correctAnswer ?? checkpoint.answer });
      onAnswered(checkpoint.questionId, isCorrect);
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err), t('learningHub:mediaCheckpoint.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const choose = (key: string) => {
    if (phase.kind !== 'asking' || submitting) return;
    if (!multiple) {
      void submit(key);
      return;
    }
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const explanation = checkpoint.explanation ? readableExplanation(checkpoint.explanation) : '';
  const wrong = phase.kind === 'result' && phase.isCorrect === false;

  return (
    <div
      role="region"
      aria-label={t('learningHub:mediaCheckpoint.title', { time })}
      data-media-checkpoint={checkpoint.questionId}
      className="shrink-0 border-b border-border bg-[color:var(--surface-muted)] px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium tabular-nums text-primary">{t('learningHub:mediaCheckpoint.title', { time })}</span>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={pauseAtCheckpoints}
            onChange={(e) => onPauseAtCheckpointsChange(e.target.checked)}
            className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
          />
          {t('learningHub:mediaCheckpoint.pauseAt')}
        </label>
        <DsButton
          variant="ghost"
          size="sm"
          iconOnly
          onClick={onClose}
          aria-label={t('learningHub:mediaCheckpoint.later')}
          title={t('learningHub:mediaCheckpoint.later')}
        >
          <X size={13} aria-hidden="true" />
        </DsButton>
      </div>

      <p className="mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
        {checkpoint.content}
      </p>

      {phase.kind === 'asking' && isChoice && options.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          {options.map((option) => (
            <DsButton
              key={option.key}
              variant="ghost"
              size="sm"
              onClick={() => choose(option.key)}
              disabled={submitting}
              aria-pressed={multiple ? selected.includes(option.key) : undefined}
              className={cn(
                'study-shell-secondary-card !h-auto w-full !justify-start gap-2 !py-1.5 text-left',
                multiple && selected.includes(option.key) && 'ring-1 ring-primary',
              )}
            >
              {checkpoint.options.length > 0 ? (
                <span className="shrink-0 font-medium tabular-nums text-muted-foreground">{option.key}.</span>
              ) : null}
              <span className="min-w-0 flex-1 whitespace-normal text-sm text-foreground">{option.content}</span>
            </DsButton>
          ))}
          {multiple ? (
            <DsButton
              variant="primary"
              size="sm"
              onClick={() => void submit([...selected].sort().join(''))}
              disabled={submitting || selected.length === 0}
              className="self-start"
            >
              {t('learningHub:mediaCheckpoint.submit')}
            </DsButton>
          ) : null}
        </div>
      ) : null}

      {phase.kind === 'asking' && !(isChoice && options.length > 0) ? (
        <DsButton variant="ghost" size="sm" onClick={() => setPhase({ kind: 'revealed' })} className="mt-2">
          {t('learningHub:mediaCheckpoint.showAnswer')}
        </DsButton>
      ) : null}

      {phase.kind === 'revealed' ? (
        <div className="mt-2 flex flex-col gap-1.5">
          {checkpoint.answer ? (
            <p className="whitespace-pre-wrap text-sm text-foreground">
              {t('learningHub:mediaCheckpoint.referenceAnswer', { answer: checkpoint.answer })}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            <DsButton variant="ghost" size="sm" disabled={submitting} onClick={() => void submit('', true)}>
              <CheckCircle size={14} aria-hidden="true" />
              {t('learningHub:mediaCheckpoint.selfCorrect')}
            </DsButton>
            <DsButton variant="ghost" size="sm" disabled={submitting} onClick={() => void submit('', false)}>
              <XCircle size={14} aria-hidden="true" />
              {t('learningHub:mediaCheckpoint.selfWrong')}
            </DsButton>
          </div>
        </div>
      ) : null}

      {phase.kind === 'result' ? (
        <div className="mt-2 flex flex-col gap-1.5" role="status">
          <p className={cn(
            'flex items-center gap-1.5 text-sm font-medium',
            phase.isCorrect === true ? 'text-emerald-600 dark:text-emerald-400' : phase.isCorrect === false ? 'text-destructive' : 'text-muted-foreground',
          )}>
            {phase.isCorrect === true ? <CheckCircle size={15} weight="fill" aria-hidden="true" /> : null}
            {phase.isCorrect === false ? <XCircle size={15} weight="fill" aria-hidden="true" /> : null}
            {phase.isCorrect === true
              ? t('learningHub:mediaCheckpoint.correct')
              : phase.isCorrect === false
                ? t('learningHub:mediaCheckpoint.wrong')
                : t('learningHub:mediaCheckpoint.manualGrading')}
            {phase.isCorrect === false && phase.correctAnswer ? (
              <span className="font-normal text-muted-foreground">
                {t('learningHub:mediaCheckpoint.correctAnswer', { answer: phase.correctAnswer })}
              </span>
            ) : null}
          </p>
          {explanation ? (
            <p className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
              {explanation}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            <DsButton
              variant={wrong ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => onSeek(Math.max(0, checkpoint.seconds - CHECKPOINT_REWATCH_LEAD_SECONDS))}
              data-media-checkpoint-rewatch=""
            >
              <ArrowCounterClockwise size={14} aria-hidden="true" />
              {t('learningHub:mediaCheckpoint.rewatch')}
            </DsButton>
            <DsButton variant={wrong ? 'ghost' : 'primary'} size="sm" onClick={onResume}>
              <Play size={14} weight="fill" aria-hidden="true" />
              {t('learningHub:mediaCheckpoint.resume')}
            </DsButton>
          </div>
        </div>
      ) : null}
    </div>
  );
};
