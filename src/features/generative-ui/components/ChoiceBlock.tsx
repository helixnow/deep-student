/**
 * choice 块：单选 / 多选（min/max）/「其他」自填 / 选项图片。
 *
 * 草稿由 GenerativeInteractionProvider 汇总，提交只走 InteractionSubmitBar（本块无提交按钮）。
 * 单选用原生 radio（方向键漫游、表单语义）+ 自绘指示器；多选用体系 Checkbox。
 * 只读（流式 / 回放 / display-only / 无绑定）时控件 disabled 并回显已选项。
 */
import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, WarningCircle } from '@phosphor-icons/react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { Input } from '@/components/ui/shad/Input';
import { cn } from '@/utils/cn';
import { resolveChoiceSelectBounds, type ChoiceOption, type ChoiceProps } from '../schema';
import type { ChoiceDraftState, GenerativeUIAnswerIssue } from '../interaction/buildAnswer';
import { GENUI_CHOICE_OTHER_MAX_CHARS } from '../interaction/limits';
import {
  GenerativeInteractionReadOnlyHint,
  useGenerativeInteractionBlock,
} from './InteractionSubmitBar';
import { GenerativeImageView } from './ImageBlock';

export interface ChoiceBlockProps extends ChoiceProps {
  /** 交互块 id（取 intent 中 block.id；缺省回退 props.id） */
  blockId?: string;
}

const OTHER_OPTION_ID = '__other__';

const OPTION_ROW_BASE =
  'group relative flex min-w-0 cursor-pointer gap-3 rounded-[var(--radius-shell-control)] border px-3 py-2.5 text-left transition-colors duration-150 motion-reduce:transition-none ' +
  'min-h-[var(--touch-target-size)] lg:min-h-0 [@media(pointer:coarse)]:min-h-[var(--touch-target-size)] ' +
  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring';

function optionRowClass(selected: boolean, editable: boolean, dimmed: boolean): string {
  return cn(
    OPTION_ROW_BASE,
    selected
      ? 'border-primary/50 bg-[color:var(--interactive-selected)]'
      : 'border-border/40 bg-background',
    editable && !selected && 'hover:bg-[color:var(--interactive-hover)]',
    !editable && 'cursor-default',
    dimmed && 'opacity-60',
  );
}

/** 单选指示器（与体系 Checkbox 同尺寸 / 同主色） */
function RadioIndicator({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
        checked ? 'border-primary bg-primary' : 'border-border bg-transparent',
      )}
    >
      {checked ? <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" /> : null}
    </span>
  );
}

function issueMessage(
  t: (key: string, params?: Record<string, unknown>) => string,
  issue: GenerativeUIAnswerIssue,
  bounds: { min: number; max: number },
): string {
  return t(`interaction.issue.${issue.code}`, {
    min: bounds.min,
    max: issue.code === 'choice_other_too_long' ? GENUI_CHOICE_OTHER_MAX_CHARS : bounds.max,
  });
}

export function ChoiceBlock({
  blockId: blockIdProp,
  id,
  question,
  description,
  mode = 'single',
  options,
  minSelect,
  maxSelect,
  allowOther = false,
  required = true,
}: ChoiceBlockProps) {
  const { t } = useTranslation('generativeUi');
  const blockId = blockIdProp ?? id;
  const { draft, setDraft, issues, editable, readOnlyReason, isStreaming } =
    useGenerativeInteractionBlock<ChoiceDraftState>(blockId);
  const titleId = useId();
  const descId = useId();
  const errorId = useId();
  const otherInputId = useId();
  const groupName = useId();

  const multiple = mode === 'multiple';
  const bounds = resolveChoiceSelectBounds({ mode, options, minSelect, maxSelect });
  const selected = new Set(draft?.selected ?? []);
  const otherActive = typeof draft?.other === 'string';
  const otherText = draft?.other ?? '';
  const count = selected.size + (otherActive && otherText.trim() ? 1 : 0);
  const atMax = multiple && selected.size + (otherActive ? 1 : 0) >= bounds.max;
  const hasImages = options.some((option) => option.image);
  const invalid = issues.length > 0;
  const readOnlyResolved = readOnlyReason === 'resolved';

  const update = (next: ChoiceDraftState) => {
    if (!editable) return;
    setDraft(next);
  };

  const pickSingle = (optionId: string) => {
    if (optionId === OTHER_OPTION_ID) update({ selected: [], other: otherText });
    else update({ selected: [optionId] });
  };

  const toggleMultiple = (optionId: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(optionId);
    else next.delete(optionId);
    update({
      selected: options.map((o) => o.id).filter((oid) => next.has(oid)),
      ...(otherActive ? { other: otherText } : {}),
    });
  };

  const toggleOther = (checked: boolean) => {
    const base = { selected: [...selected] };
    update(checked ? { ...base, other: otherText } : base);
  };

  const hintText = multiple
    ? bounds.min === bounds.max
      ? t('interaction.choice.select_exact', { count: bounds.min })
      : t('interaction.choice.select_range', { min: bounds.min, max: bounds.max })
    : t('interaction.choice.single_hint');

  const renderOptionBody = (option: ChoiceOption) => (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span dir="auto" className="text-sm font-medium text-foreground break-words">
        {option.label}
      </span>
      {option.description ? (
        <span dir="auto" className="text-xs text-muted-foreground break-words">
          {option.description}
        </span>
      ) : null}
    </span>
  );

  const renderOption = (option: ChoiceOption) => {
    const checked = selected.has(option.id);
    const disabledByMax = multiple && !checked && atMax;
    const disabled = !editable || disabledByMax;
    const dimmed = (readOnlyResolved && !checked) || (editable && disabledByMax);
    const image = option.image ? (
      <GenerativeImageView
        source={option.image}
        alt={option.label}
        fit="cover"
        maxHeight={120}
        variant="thumbnail"
        enabled={!isStreaming}
      />
    ) : null;

    if (multiple) {
      return (
        <label
          key={option.id}
          className={cn(optionRowClass(checked, editable && !disabledByMax, dimmed), hasImages && 'flex-col')}
          data-choice-option={option.id}
          data-selected={checked || undefined}
        >
          {image}
          <span className="flex min-w-0 items-start gap-3">
            <Checkbox
              className="mt-0.5"
              checked={checked}
              disabled={disabled}
              onCheckedChange={(value) => toggleMultiple(option.id, value === true)}
              aria-describedby={invalid ? errorId : undefined}
            />
            {renderOptionBody(option)}
          </span>
        </label>
      );
    }

    return (
      <label
        key={option.id}
        className={cn(optionRowClass(checked, editable, dimmed), hasImages && 'flex-col')}
        data-choice-option={option.id}
        data-selected={checked || undefined}
      >
        {image}
        <span className="flex min-w-0 items-start gap-3">
          <input
            type="radio"
            className="peer sr-only"
            name={groupName}
            value={option.id}
            checked={checked}
            disabled={disabled}
            onChange={() => pickSingle(option.id)}
            aria-describedby={invalid ? errorId : undefined}
          />
          <RadioIndicator checked={checked} />
          {renderOptionBody(option)}
        </span>
      </label>
    );
  };

  const renderOther = () => {
    if (!allowOther) return null;
    const disabledByMax = multiple && !otherActive && atMax;
    const disabled = !editable || disabledByMax;
    const label = t('interaction.choice.other');
    return (
      <div
        className={cn(
          optionRowClass(otherActive, editable && !disabledByMax, readOnlyResolved && !otherActive),
          'flex-col gap-2',
          hasImages && 'sm:col-span-2',
        )}
        data-choice-option={OTHER_OPTION_ID}
        data-selected={otherActive || undefined}
      >
        <label className={cn('flex min-w-0 items-start gap-3', editable && 'cursor-pointer')}>
          {multiple ? (
            <Checkbox
              className="mt-0.5"
              checked={otherActive}
              disabled={disabled}
              onCheckedChange={(value) => toggleOther(value === true)}
            />
          ) : (
            <>
              <input
                type="radio"
                className="peer sr-only"
                name={groupName}
                value={OTHER_OPTION_ID}
                checked={otherActive}
                disabled={disabled}
                onChange={() => pickSingle(OTHER_OPTION_ID)}
              />
              <RadioIndicator checked={otherActive} />
            </>
          )}
          <span className="text-sm font-medium text-foreground">{label}</span>
        </label>
        {otherActive ? (
          <Input
            id={otherInputId}
            dir="auto"
            value={otherText}
            maxLength={GENUI_CHOICE_OTHER_MAX_CHARS}
            readOnly={!editable}
            disabled={!editable && !readOnlyResolved}
            placeholder={t('interaction.choice.other_placeholder')}
            aria-label={label}
            aria-invalid={issues.some((i) => i.code.startsWith('choice_other')) || undefined}
            onChange={(event) =>
              update({ selected: multiple ? [...selected] : [], other: event.target.value })
            }
            className="text-sm"
          />
        ) : null}
      </div>
    );
  };

  return (
    <Card
      className="min-w-0"
      role="group"
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      aria-busy={isStreaming || undefined}
      data-generative-choice
      data-choice-mode={mode}
      data-interaction-editable={editable || undefined}
    >
      <CardHeader className="gap-1 space-y-0 pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle id={titleId} dir="auto" className="text-sm font-semibold leading-snug break-words">
            {question}
            {required ? (
              <span className="ml-0.5 text-destructive" aria-hidden>
                *
              </span>
            ) : null}
            {required ? <span className="sr-only">{t('interaction.required')}</span> : null}
          </CardTitle>
          <span className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground bg-muted/40">
            {hintText}
          </span>
        </div>
        {description ? (
          <p id={descId} dir="auto" className="text-xs text-muted-foreground break-words">
            {description}
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div
          role={multiple ? undefined : 'radiogroup'}
          aria-labelledby={titleId}
          aria-invalid={invalid || undefined}
          aria-required={required || undefined}
          tabIndex={invalid ? -1 : undefined}
          className={cn('outline-none', hasImages ? 'grid grid-cols-1 gap-2 sm:grid-cols-2' : 'flex flex-col gap-2')}
        >
          {options.map(renderOption)}
          {renderOther()}
        </div>

        {multiple && editable ? (
          <p className="flex items-center gap-1 text-xs text-muted-foreground" data-choice-count>
            <Check className="h-3.5 w-3.5" aria-hidden />
            {t('interaction.choice.selected_count', { count, max: bounds.max })}
          </p>
        ) : null}

        {invalid ? (
          <p id={errorId} role="alert" className="flex items-start gap-1.5 text-xs text-destructive" data-choice-error>
            <WarningCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" weight="fill" aria-hidden />
            <span>{issueMessage(t, issues[0]!, bounds)}</span>
          </p>
        ) : null}

        <GenerativeInteractionReadOnlyHint reason={readOnlyReason} />
      </CardContent>
    </Card>
  );
}
