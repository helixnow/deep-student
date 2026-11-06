/**
 * form 块：text / number / slider / rating / switch 五种字段。
 *
 * 草稿由 GenerativeInteractionProvider 汇总，提交只走 InteractionSubmitBar（submitLabel 由提交条使用）。
 * 校验问题（buildGenerativeUIAnswer issues）按字段回标：aria-invalid + aria-describedby + 行内文案。
 * 只读（流式 / 回放 / display-only / 无绑定）时控件 disabled 并回显值。
 */
import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Star, WarningCircle } from '@phosphor-icons/react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Label } from '@/components/ui/shad/Label';
import { Slider } from '@/components/ui/shad/Slider';
import { Switch } from '@/components/ui/shad/Switch';
import { Textarea } from '@/components/ui/shad/Textarea';
import { cn } from '@/utils/cn';
import type { FormField, FormProps } from '../schema';
import type { FormDraftState, FormDraftValue, GenerativeUIAnswerIssue } from '../interaction/buildAnswer';
import { countGenuiChars } from '../interaction/limits';
import { formatGenerativeNumber } from '../utils/formatGenerativeNumber';
import {
  GenerativeInteractionReadOnlyHint,
  useGenerativeInteractionBlock,
} from './InteractionSubmitBar';

export interface FormBlockProps extends FormProps {
  /** 交互块 id（取 intent 中 block.id；缺省回退 props.id） */
  blockId?: string;
}

type TFn = (key: string, params?: Record<string, unknown>) => string;

function rangeText(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return `${formatGenerativeNumber(min)} – ${formatGenerativeNumber(max)}`;
  if (min !== undefined) return `≥ ${formatGenerativeNumber(min)}`;
  if (max !== undefined) return `≤ ${formatGenerativeNumber(max)}`;
  return '';
}

function fieldIssueMessage(t: TFn, field: FormField, issue: GenerativeUIAnswerIssue): string {
  switch (issue.code) {
    case 'field_too_long':
      return t('interaction.issue.field_too_long', { max: field.kind === 'text' ? field.maxLength : 0 });
    case 'field_out_of_range': {
      if (field.kind === 'rating') return t('interaction.issue.field_out_of_range', { range: `1 – ${field.max}` });
      const min = field.kind === 'number' || field.kind === 'slider' ? field.min : undefined;
      const max = field.kind === 'number' || field.kind === 'slider' ? field.max : undefined;
      return t('interaction.issue.field_out_of_range', { range: rangeText(min, max) });
    }
    case 'field_step_mismatch':
      return t('interaction.issue.field_step_mismatch', { step: field.kind === 'slider' ? field.step : 1 });
    default:
      return t(`interaction.issue.${issue.code}`);
  }
}

function toInputString(value: FormDraftValue): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function toNumberOrUndefined(value: FormDraftValue): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

interface FieldControlProps {
  field: FormField;
  value: FormDraftValue;
  onChange: (value: FormDraftValue) => void;
  editable: boolean;
  inputId: string;
  labelId: string;
  describedBy?: string;
  invalid: boolean;
  t: TFn;
}

function TextControl({ field, value, onChange, editable, inputId, describedBy, invalid, t }: FieldControlProps) {
  if (field.kind !== 'text') return null;
  const text = toInputString(value);
  const used = countGenuiChars(text);
  const common = {
    id: inputId,
    dir: 'auto' as const,
    value: text,
    placeholder: field.placeholder,
    maxLength: field.maxLength,
    disabled: !editable,
    'aria-invalid': invalid || undefined,
    'aria-describedby': describedBy,
    'aria-required': field.required || undefined,
    className: 'text-sm',
  };
  return (
    <div className="space-y-1">
      {field.multiline ? (
        <Textarea {...common} rows={3} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <Input {...common} type="text" onChange={(event) => onChange(event.target.value)} />
      )}
      {editable ? (
        <p
          className={cn('text-right text-xs tabular-nums', used > field.maxLength ? 'text-destructive' : 'text-muted-foreground')}
          aria-hidden
        >
          {t('interaction.form.char_count', { count: used, max: field.maxLength })}
        </p>
      ) : null}
    </div>
  );
}

function NumberControl({ field, value, onChange, editable, inputId, describedBy, invalid }: FieldControlProps) {
  if (field.kind !== 'number') return null;
  return (
    <div className="flex items-center gap-2">
      <Input
        id={inputId}
        type="number"
        inputMode="decimal"
        value={toInputString(value)}
        min={field.min}
        max={field.max}
        step={field.step ?? 'any'}
        disabled={!editable}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        aria-required={field.required || undefined}
        onChange={(event) => onChange(event.target.value)}
        className="max-w-[12rem] text-sm tabular-nums"
      />
      {field.unit ? (
        <span dir="auto" className="shrink-0 text-sm text-muted-foreground">
          {field.unit}
        </span>
      ) : null}
    </div>
  );
}

function SliderControl({ field, value, onChange, editable, labelId, describedBy, invalid, t }: FieldControlProps) {
  if (field.kind !== 'slider') return null;
  const current = toNumberOrUndefined(value);
  const shown =
    current === undefined
      ? t('interaction.form.not_set')
      : `${formatGenerativeNumber(current)}${field.unit ?? ''}`;
  return (
    <div
      className="space-y-2"
      role="group"
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      tabIndex={invalid ? -1 : undefined}
    >
      <div className="flex items-center gap-3">
        <span className="w-10 shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatGenerativeNumber(field.min)}
        </span>
        <Slider
          className="min-h-[var(--touch-target-size)] flex-1 lg:min-h-6"
          min={field.min}
          max={field.max}
          step={field.step}
          value={[current ?? field.min]}
          disabled={!editable}
          onValueChange={(next) => {
            if (typeof next[0] === 'number') onChange(next[0]);
          }}
          data-slider-unset={current === undefined || undefined}
        />
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {formatGenerativeNumber(field.max)}
        </span>
      </div>
      <p className="text-xs" aria-live="polite">
        <span
          className={cn(
            'inline-flex items-center rounded px-1.5 py-0.5 tabular-nums',
            current === undefined ? 'bg-muted/40 text-muted-foreground' : 'bg-primary/10 font-medium text-foreground',
          )}
          data-slider-value
        >
          {shown}
        </span>
      </p>
    </div>
  );
}

function RatingControl({ field, value, onChange, editable, labelId, describedBy, invalid, t }: FieldControlProps) {
  if (field.kind !== 'rating') return null;
  const current = toNumberOrUndefined(value);
  const stars = Array.from({ length: field.max }, (_, i) => i + 1);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        tabIndex={invalid ? -1 : undefined}
        className="flex flex-wrap items-center gap-0.5"
      >
        {stars.map((n) => {
          const filled = current !== undefined && n <= current;
          return (
            <DsButton
              key={n}
              variant="ghost"
              size="sm"
              iconOnly
              role="radio"
              aria-checked={current === n}
              aria-label={t('interaction.form.rating_option', { value: n, max: field.max })}
              disabled={!editable}
              onClick={() => onChange(n)}
              className={cn(
                'border-transparent bg-transparent',
                filled ? 'text-warning hover:text-warning' : 'text-muted-foreground/60',
              )}
              data-rating-value={n}
            >
              <Star className="h-5 w-5" weight={filled ? 'fill' : 'regular'} aria-hidden />
            </DsButton>
          );
        })}
      </div>
      <span className="text-xs tabular-nums text-muted-foreground" aria-hidden>
        {current === undefined
          ? t('interaction.form.not_set')
          : t('interaction.form.rating_value', { value: current, max: field.max })}
      </span>
    </div>
  );
}

function SwitchControl({ field, value, onChange, editable, inputId, describedBy, t }: FieldControlProps) {
  if (field.kind !== 'switch') return null;
  const checked = typeof value === 'boolean' ? value : (field.default ?? false);
  return (
    <div className="flex items-center gap-2">
      <Switch
        id={inputId}
        checked={checked}
        disabled={!editable}
        aria-describedby={describedBy}
        onCheckedChange={(next) => onChange(next)}
      />
      <span className="text-xs text-muted-foreground" aria-hidden>
        {checked ? t('interaction.summary.yes') : t('interaction.summary.no')}
      </span>
    </div>
  );
}

const CONTROLS: Record<FormField['kind'], React.FC<FieldControlProps>> = {
  text: TextControl,
  number: NumberControl,
  slider: SliderControl,
  rating: RatingControl,
  switch: SwitchControl,
};

function FormFieldRow({
  field,
  value,
  onChange,
  editable,
  issue,
  t,
}: {
  field: FormField;
  value: FormDraftValue;
  onChange: (value: FormDraftValue) => void;
  editable: boolean;
  issue?: GenerativeUIAnswerIssue;
  t: TFn;
}) {
  const inputId = useId();
  const labelId = useId();
  const helpId = useId();
  const errorId = useId();
  const Control = CONTROLS[field.kind];
  const describedBy = [field.help ? helpId : null, issue ? errorId : null].filter(Boolean).join(' ') || undefined;
  const inline = field.kind === 'switch';

  return (
    <div
      className={cn('min-w-0 space-y-1.5', inline && 'flex flex-wrap items-center justify-between gap-x-4 gap-y-1 space-y-0')}
      data-form-field={field.name}
      data-form-field-kind={field.kind}
    >
      <div className={cn('min-w-0 space-y-0.5', inline && 'flex-1')}>
        <Label id={labelId} htmlFor={field.kind === 'slider' || field.kind === 'rating' ? undefined : inputId} dir="auto" className="leading-snug">
          {field.label}
          {field.required ? (
            <>
              <span className="ml-0.5 text-destructive" aria-hidden>
                *
              </span>
              <span className="sr-only">{t('interaction.required')}</span>
            </>
          ) : null}
        </Label>
        {field.help ? (
          <p id={helpId} dir="auto" className="text-xs text-muted-foreground break-words">
            {field.help}
          </p>
        ) : null}
      </div>
      <div className={cn(inline && 'shrink-0')}>
        <Control
          field={field}
          value={value}
          onChange={onChange}
          editable={editable}
          inputId={inputId}
          labelId={labelId}
          describedBy={describedBy}
          invalid={Boolean(issue)}
          t={t}
        />
      </div>
      {issue ? (
        <p
          id={errorId}
          role="alert"
          className={cn('flex items-start gap-1.5 text-xs text-destructive', inline && 'basis-full')}
          data-form-field-error={issue.code}
        >
          <WarningCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" weight="fill" aria-hidden />
          <span>{fieldIssueMessage(t, field, issue)}</span>
        </p>
      ) : null}
    </div>
  );
}

export function FormBlock({ blockId: blockIdProp, id, title, description, fields }: FormBlockProps) {
  const { t } = useTranslation('generativeUi');
  const blockId = blockIdProp ?? id;
  const { draft, setDraft, issues, editable, readOnlyReason, isStreaming } =
    useGenerativeInteractionBlock<FormDraftState>(blockId);
  const titleId = useId();
  const values = draft ?? {};
  const blockIssue = issues.find((issue) => !issue.field);

  const setValue = (name: string, value: FormDraftValue) => {
    if (!editable) return;
    setDraft({ ...values, [name]: value });
  };

  return (
    <Card
      className="min-w-0"
      role="group"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : t('interaction.a11y.form_label')}
      aria-busy={isStreaming || undefined}
      data-generative-form
      data-interaction-editable={editable || undefined}
    >
      {title || description ? (
        <CardHeader className="gap-1 space-y-0 pb-3">
          {title ? (
            <CardTitle id={titleId} dir="auto" className="text-sm font-semibold leading-snug break-words">
              {title}
            </CardTitle>
          ) : null}
          {description ? (
            <p dir="auto" className="text-xs text-muted-foreground break-words">
              {description}
            </p>
          ) : null}
        </CardHeader>
      ) : null}
      <CardContent className={cn('space-y-4', title || description ? 'pt-0' : 'pt-4')}>
        {fields.map((field) => (
          <FormFieldRow
            key={field.name}
            field={field}
            value={values[field.name]}
            onChange={(value) => setValue(field.name, value)}
            editable={editable}
            issue={issues.find((issue) => issue.field === field.name)}
            t={t}
          />
        ))}
        {blockIssue ? (
          <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
            <WarningCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" weight="fill" aria-hidden />
            <span>{t(`interaction.issue.${blockIssue.code}`)}</span>
          </p>
        ) : null}
        <GenerativeInteractionReadOnlyHint reason={readOnlyReason} />
      </CardContent>
    </Card>
  );
}
