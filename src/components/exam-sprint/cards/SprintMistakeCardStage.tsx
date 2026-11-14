import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDown, CaretUp, Check, Sparkle, X } from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { parseCompoundSprintItem } from '../compoundCardModel';
import { resolveItemSourceAnchors } from '../sourceAnchorBridge';
import type {
  ResolvedSprintSourceAnchor,
  SprintCompoundMistakeItem,
  SprintMistakeItem,
  SprintMistakeQuestionOption,
} from '../sprintContracts';
import {
  SprintBreadcrumbHeader,
  SprintCompoundEvidenceBlocks,
  SprintMathOrPlainText,
  SprintProvenanceBar,
} from './SprintCompoundChrome';

export interface SprintMistakeCardStageProps {
  item: SprintCompoundMistakeItem;
  revealed: boolean;
  resolvedAnchors?: readonly ResolvedSprintSourceAnchor[];
  selectedOptionKeys: string[];
  scratchpadText: string;
  onSelectOptionKey: (key: string) => void;
  onScratchpadChange: (value: string) => void;
  onReveal: () => void;
  onRevealAnchor?: (anchor: ResolvedSprintSourceAnchor) => void;
}

const MULTI_CHOICE_TYPES = new Set(['multiple_choice', 'indefinite_choice']);

export function isMultiChoiceMistake(item: SprintMistakeItem): boolean {
  return MULTI_CHOICE_TYPES.has(item.questionType);
}

export function normalizeChoiceAnswerToken(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (
    lower === 'true'
    || lower === 't'
    || lower === '\u221a'
    || trimmed === '\u6b63\u786e'
    || trimmed === '\u5bf9'
  ) {
    return 'T';
  }
  if (
    lower === 'false'
    || lower === 'f'
    || lower === '\u00d7'
    || trimmed === '\u9519\u8bef'
    || trimmed === '\u9519'
  ) {
    return 'F';
  }
  const letters = trimmed.toUpperCase().match(/[A-Z]/g);
  if (letters && letters.length > 0) {
    return [...new Set(letters)].sort().join('');
  }
  return trimmed.toUpperCase();
}

export function evaluateMistakeChoiceAnswer(
  item: SprintMistakeItem,
  selectedKeys: readonly string[],
): boolean | null {
  if (selectedKeys.length === 0 || !item.answer) return null;
  const canonical = normalizeChoiceAnswerToken(item.answer);
  if (!canonical) return null;
  const picked = [...new Set(selectedKeys.map((k) => normalizeChoiceAnswerToken(k)).filter(Boolean))]
    .sort()
    .join('');
  return picked.length > 0 ? picked === canonical : null;
}

export const SprintMistakeCardStage: React.FC<SprintMistakeCardStageProps> = ({
  item,
  revealed,
  resolvedAnchors: externalAnchors,
  selectedOptionKeys,
  scratchpadText,
  onSelectOptionKey,
  onScratchpadChange,
  onReveal,
  onRevealAnchor,
}) => {
  const { t } = useTranslation('review');
  const [originalExpanded, setOriginalExpanded] = useState(false);

  const anchors = useMemo(
    () => externalAnchors ?? resolveItemSourceAnchors(item),
    [externalAnchors, item],
  );
  const compound = useMemo(
    () => parseCompoundSprintItem(item, anchors),
    [anchors, item],
  );

  const effectiveOptions = useMemo<SprintMistakeQuestionOption[]>(() => {
    if (Array.isArray(item.options) && item.options.length > 0) {
      return item.options;
    }
    if (item.questionType === 'true_false') {
      return [
        { key: 'T', content: t('structured.trueLabel') },
        { key: 'F', content: t('structured.falseLabel') },
      ];
    }
    return [];
  }, [item.options, item.questionType, t]);

  const canonicalToken = useMemo(() => normalizeChoiceAnswerToken(item.answer), [item.answer]);
  const objectiveMatched = useMemo(
    () => (effectiveOptions.length > 0 ? evaluateMistakeChoiceAnswer(item, selectedOptionKeys) : null),
    [effectiveOptions.length, item, selectedOptionKeys],
  );

  const questionTypeLabel = t(`questionType.${item.questionType}`, {
    defaultValue: item.questionType,
  });

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4" data-testid="sprint-mistake-stage">
      <div className="rounded-xl border border-border/35 bg-card p-5">
        {compound.hasBreadcrumb ? (
          <SprintBreadcrumbHeader
            originKind={compound.originKind}
            crumbs={compound.breadcrumbCrumbs}
            anchorCount={anchors.length}
          />
        ) : null}

        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2 border-b border-border/35 pb-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {item.examName ? (
              <span className="max-w-[240px] truncate font-medium text-foreground">
                {item.examName}
              </span>
            ) : null}
            <span className="rounded border border-border/35 bg-muted/40 px-2 py-0.5 text-[11px]">
              {questionTypeLabel}
            </span>
          </div>

          {item.isVariant ? (
            <span
              data-testid="sprint-variant-badge"
              className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/[0.08] px-2 py-0.5 text-xs font-medium text-primary"
            >
              <Sparkle size={12} weight="bold" aria-hidden="true" />
              <span>{t('examSprint.player.variantBadge')}</span>
            </span>
          ) : null}
        </div>

        <SprintMathOrPlainText text={item.content} className="text-base" />

        {effectiveOptions.length > 0 ? (
          <div className="mt-4 flex flex-col gap-2" role="group" aria-label={t('card.question')}>
            {effectiveOptions.map((option, index) => {
              const normalizedOptionKey = normalizeChoiceAnswerToken(option.key) || option.key;
              const isSelected = selectedOptionKeys.includes(option.key);
              const isCorrectOption =
                revealed && canonicalToken.length > 0 && canonicalToken.includes(normalizedOptionKey);
              const isWrongSelection = revealed && isSelected && !isCorrectOption;

              return (
                <button
                  key={`${option.key}-${index}`}
                  type="button"
                  disabled={revealed}
                  data-testid={`sprint-option-${option.key}`}
                  aria-pressed={isSelected}
                  onClick={() => onSelectOptionKey(option.key)}
                  className={cn(
                    'flex min-h-[44px] w-full items-start gap-3 rounded-lg border px-3.5 py-2.5 text-left text-sm transition-colors active:scale-95 active:opacity-80 disabled:cursor-default disabled:active:scale-100',
                    !revealed && !isSelected && 'border-border/35 bg-background/50 hover:bg-muted/50',
                    !revealed && isSelected && 'border-primary/50 bg-primary/[0.08] text-foreground',
                    isCorrectOption && 'border-emerald-500/40 bg-emerald-500/10 text-foreground',
                    isWrongSelection && 'border-rose-500/40 bg-rose-500/10 text-foreground',
                    revealed && !isCorrectOption && !isWrongSelection && 'border-border/35 opacity-75',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border font-mono text-xs tabular-nums',
                      isCorrectOption
                        ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : isWrongSelection
                          ? 'border-rose-500/50 bg-rose-500/15 text-rose-600 dark:text-rose-400'
                          : isSelected
                            ? 'border-primary/50 bg-primary/15 text-primary'
                            : 'border-border/35 bg-muted/40 text-muted-foreground',
                    )}
                  >
                    {option.key}
                  </span>
                  <div className="min-w-0 flex-1">
                    <SprintMathOrPlainText text={option.content} className="text-sm" />
                  </div>
                  {revealed && isCorrectOption ? (
                    <Check
                      size={16}
                      weight="bold"
                      className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                      aria-hidden="true"
                    />
                  ) : revealed && isWrongSelection ? (
                    <X
                      size={16}
                      weight="bold"
                      className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-400"
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : !revealed ? (
          <div className="mt-4 space-y-1.5">
            <label
              htmlFor="sprint-mistake-scratchpad"
              className="block text-xs font-medium text-muted-foreground"
            >
              {t('examSprint.player.scratchpadLabel')}
            </label>
            <textarea
              id="sprint-mistake-scratchpad"
              data-testid="sprint-mistake-scratchpad"
              rows={3}
              value={scratchpadText}
              onChange={(event) => onScratchpadChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  onReveal();
                }
              }}
              placeholder={t('examSprint.player.scratchpadPlaceholder')}
              className="w-full resize-y rounded-lg border border-border/35 bg-background/70 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-primary/50 focus:outline-none"
            />
          </div>
        ) : null}

        {revealed ? (
          <div className="mt-4 space-y-3 border-t border-border/35 pt-4">
            {objectiveMatched !== null ? (
              <div
                data-testid="sprint-mistake-feedback"
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium',
                  objectiveMatched
                    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'border-rose-500/25 bg-rose-500/10 text-rose-600 dark:text-rose-400',
                )}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    objectiveMatched ? 'bg-emerald-500' : 'bg-rose-500',
                  )}
                  aria-hidden="true"
                />
                <span>
                  {objectiveMatched
                    ? t('examSprint.player.suggestedGood')
                    : t('examSprint.player.suggestedAgain')}
                </span>
              </div>
            ) : null}

            {item.answer ? (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">
                  {t('examSprint.player.canonicalAnswer')}
                </div>
                <div className="font-mono text-sm font-semibold tabular-nums text-foreground">
                  <SprintMathOrPlainText text={item.answer} className="font-sans" />
                </div>
              </div>
            ) : null}

            {item.explanation ? (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">
                  {t('examSprint.player.explanation')}
                </div>
                <SprintMathOrPlainText
                  text={item.explanation}
                  className="text-sm text-muted-foreground"
                />
              </div>
            ) : null}

            <SprintCompoundEvidenceBlocks
              personalNote={compound.personalNote}
              excerpts={compound.excerpts}
              childBullets={compound.childBullets}
              onRevealAnchor={onRevealAnchor}
            />

            {item.isVariant && item.originalPromptPreview ? (
              <div className="rounded-lg border border-border/35 bg-muted/25">
                <button
                  type="button"
                  data-testid="sprint-compare-original"
                  aria-expanded={originalExpanded}
                  onClick={() => setOriginalExpanded((prev) => !prev)}
                  className="flex min-h-[44px] w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground active:scale-95 active:opacity-80"
                >
                  <span>{t('examSprint.player.compareOriginal')}</span>
                  {originalExpanded ? (
                    <CaretUp size={14} aria-hidden="true" />
                  ) : (
                    <CaretDown size={14} aria-hidden="true" />
                  )}
                </button>
                {originalExpanded ? (
                  <div className="space-y-2 border-t border-border/35 px-3 py-2.5 text-xs text-muted-foreground">
                    <SprintMathOrPlainText text={item.originalPromptPreview} className="text-xs" />
                    {item.originalAnswerPreview ? (
                      <div className="pt-1 font-mono tabular-nums text-foreground">
                        {t('examSprint.player.originalAnswerLabel')}: {item.originalAnswerPreview}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {onRevealAnchor ? (
        <SprintProvenanceBar
          anchors={anchors}
          revealed={revealed}
          primaryButtonTestId="sprint-mistake-reveal-source"
          onRevealAnchor={onRevealAnchor}
        />
      ) : null}
    </div>
  );
};

export default SprintMistakeCardStage;
