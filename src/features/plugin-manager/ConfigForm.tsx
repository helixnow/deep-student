// RUST-FIX(RF-W35-config-schema-form): Rust 版插件配置是写死的 iLink 字段，不能按可序列化 Schemastery schema 生成表单。
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { SettingRow, SwitchRow } from '@/components/settings';

import {
  parseConfigNumber,
  pluginConfigForm,
  pluginConfigValues,
  validatePluginConfig,
  type PluginConfigField,
  type PluginConfigIssue,
} from './config-schema';
import type { PluginConfigFieldIssue, PluginConfigSchemaNode, PluginConfigRevision } from './types';

export interface ConfigFormProps {
  pluginId: string;
  schema: PluginConfigSchemaNode | null;
  values: Readonly<Record<string, unknown>>;
  /** 读取时的修订号；保存原样带回，Host 用它做并发检查。 */
  revision: PluginConfigRevision;
  saving?: boolean;
  /** 修订号冲突：保留草稿，提示重新读取。 */
  conflict?: boolean;
  /** 保存失败或冲突的说明（来自 Host）。 */
  message?: string;
  /** Host 返回的逐字段校验问题（字段名 = 顶层 key）。 */
  issues?: readonly PluginConfigFieldIssue[];
  onSave: (values: Readonly<Record<string, unknown>>, revision: PluginConfigRevision) => void;
  onCancel?: () => void;
  onReload?: () => void;
}

/** enum 选项值 → SegmentedControl 的字符串值（保留类型，避免 1 与 "1" 相撞）。 */
const encodeOption = (value: string | number | boolean) => JSON.stringify(value);
const decodeOption = (encoded: string): string | number | boolean => {
  try {
    const parsed = JSON.parse(encoded) as unknown;
    return typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'boolean' ? parsed : encoded;
  } catch {
    return encoded;
  }
};

const numberTexts = (fields: readonly PluginConfigField[], values: Readonly<Record<string, unknown>>) => {
  const text: Record<string, string> = {};
  for (const field of fields) {
    if (field.kind !== 'number') continue;
    const value = values[field.key];
    if (typeof value === 'number') text[field.key] = String(value);
  }
  return text;
};

/**
 * 配置表单（W35）：只渲染 W01 投影出的可序列化 schema 子集——
 * boolean → Switch、enum → SegmentedControl、string / number → Input。
 * 默认值来自 `meta.default`；保存带 revision；冲突时不静默覆盖。
 */
export function ConfigForm({
  pluginId,
  schema,
  values,
  revision,
  saving = false,
  conflict = false,
  message,
  issues: hostIssues,
  onSave,
  onCancel,
  onReload,
}: ConfigFormProps) {
  const { t } = useTranslation('plugin_manager');
  const baseId = useId();
  const form = useMemo(() => pluginConfigForm(schema), [schema]);
  const [draft, setDraft] = useState<Record<string, unknown>>(() => pluginConfigValues(form, values));
  const [numberDraft, setNumberDraft] = useState<Record<string, string>>(() =>
    numberTexts(form.fields, pluginConfigValues(form, values)),
  );
  const [localIssues, setLocalIssues] = useState<readonly PluginConfigIssue[]>([]);

  useEffect(() => {
    const next = pluginConfigValues(form, values);
    setDraft(next);
    setNumberDraft(numberTexts(form.fields, next));
    setLocalIssues([]);
  }, [form, values, revision]);

  const fieldErrors = useMemo(() => {
    const errors = new Map<string, string>();
    for (const issue of localIssues) errors.set(issue.field, t(`config.error.${issue.rule}`));
    for (const issue of hostIssues ?? []) errors.set(issue.field, issue.message);
    return errors;
  }, [localIssues, hostIssues, t]);

  const globalIssue = hostIssues?.find((issue) => issue.field === '$')?.message;

  const update = (key: string, value: unknown) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const submit = () => {
    const issues = validatePluginConfig(form, draft);
    setLocalIssues(issues);
    if (issues.length) return;
    onSave(draft, revision);
  };

  const renderField = (field: PluginConfigField) => {
    const inputId = `${baseId}-${field.key}`;
    const descriptionId = `${inputId}-description`;
    const error = fieldErrors.get(field.key);
    const errorId = error ? `${inputId}-error` : undefined;
    const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;
    const value = draft[field.key];
    const defaultHint = field.defaultValue !== undefined
      ? t('config.default', { value: String(field.defaultValue) })
      : undefined;
    const title = field.description || field.key;
    const description = [field.description ? field.key : undefined, defaultHint].filter(Boolean).join(' · ');

    return (
      <div key={field.key} data-config-field={field.key} data-kind={field.kind}>
        {field.kind === 'boolean' ? (
          <SwitchRow title={title} description={description} checked={value === true} disabled={saving}
            onCheckedChange={(checked) => update(field.key, checked)} />
        ) : (
        <SettingRow title={`${title}${field.required ? ' *' : ''}`} description={description} controlClassName="md:max-w-[50%]">
          <label htmlFor={inputId} className="sr-only">{title}{field.required ? ' *' : ''}</label>

        {field.kind === 'enum' ? (
          <SegmentedControl
            ariaLabel={field.key}
            value={encodeOption((value ?? field.defaultValue) as string | number | boolean)}
            onValueChange={(next) => update(field.key, decodeOption(next))}
            options={field.options.map((option) => ({ value: encodeOption(option.value), label: option.label }))}
            size="compact"
            stretch
            className="w-full max-w-full flex-wrap"
            itemClassName={`!h-auto min-h-7 min-w-0 max-w-full flex-auto whitespace-normal break-words py-1.5 [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)] ${error ? 'ring-1 ring-destructive' : ''}`}
          />
        ) : null}

        {field.kind === 'string' ? (
          <Input
            id={inputId}
            data-config-input={field.key}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => update(field.key, event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
          />
        ) : null}

        {field.kind === 'number' ? (
          <Input
            id={inputId}
            data-config-input={field.key}
            type="number"
            inputMode="decimal"
            min={field.min}
            max={field.max}
            step={field.step}
            value={numberDraft[field.key] ?? ''}
            onChange={(event) => {
              const text = event.target.value;
              setNumberDraft((prev) => ({ ...prev, [field.key]: text }));
              const parsed = parseConfigNumber(text);
              // 解析失败时把原文放进草稿，校验报“需要是数字”，避免静默丢掉输入。
              update(field.key, parsed === null ? text : parsed);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
          />
        ) : null}

        {description ? <span id={descriptionId} className="sr-only">{description}</span> : null}
        </SettingRow>
        )}
        {error ? (
          <p id={errorId} role="alert" className="px-1 pb-2.5 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <form
      aria-label={t('config.title', { id: pluginId })}
      data-testid="plugin-config-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="space-y-6"
    >
      {form.fields.length ? null : <p className="text-sm text-muted-foreground">{t('config.empty')}</p>}

      {form.unsupported.length ? (
        <p role="note" className="text-xs text-muted-foreground">
          {t('config.unsupported', { fields: form.unsupported.join(', ') })}
        </p>
      ) : null}

      <div className="space-y-px">{form.fields.map(renderField)}</div>

      {conflict ? (
        <div role="alert" data-testid="plugin-config-conflict" className="space-y-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
          <p>{t('config.conflict')}</p>
          {onReload ? (
            <DsButton type="button" variant="outline" size="sm" className="[@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]" onClick={onReload} disabled={saving}>
              {t('config.retry')}
            </DsButton>
          ) : null}
        </div>
      ) : null}

      {!conflict && (message || globalIssue) ? (
        <p role="alert" className="text-sm text-destructive">
          {message ?? globalIssue}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <span className="text-xs text-muted-foreground" data-testid="plugin-config-revision">
          {t('config.revision', { revision })}
        </span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {onCancel ? (
            <DsButton type="button" variant="outline" size="sm" className="[@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]" onClick={onCancel} disabled={saving}>
              {t('config.cancel')}
            </DsButton>
          ) : null}
          <DsButton type="submit" size="sm" className="[@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]" disabled={saving}>
            {saving ? t('config.saving') : t('config.save')}
          </DsButton>
        </div>
      </div>
    </form>
  );
}
