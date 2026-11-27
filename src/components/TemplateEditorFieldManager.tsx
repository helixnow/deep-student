import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash, ArrowUp, ArrowDown, CheckCircle } from '@phosphor-icons/react';
import { FieldExtractionRule } from '../types';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from './ui/shad/Input';
import { Switch } from './ui/shad/Switch';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/shad/Tooltip';
import { Alert } from './ui/shad/Alert';
import { cn } from '@/utils/cn';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';

export interface FieldRenameResult {
  ok: boolean;
  /** 失败原因（已本地化），内联显示 */
  error?: string;
}

interface TemplateEditorFieldManagerProps {
  fields: string[];
  rules: Record<string, FieldExtractionRule>;
  /** 模板（正/反面）中实际引用到的字段名集合，用于展示使用标记 */
  usedFields: Set<string>;
  onRemoveField: (index: number) => void;
  onMoveField: (index: number, direction: -1 | 1) => void;
  /** 提交重命名（blur / Enter 时触发），由父级完成规则键迁移与模板引用同步 */
  onRenameField: (index: number, newName: string) => FieldRenameResult;
  onToggleRequired: (field: string, required: boolean) => void;
  /** 重命名后引用同步等瞬时通知 */
  notice?: string | null;
}

interface FieldRowProps {
  field: string;
  index: number;
  total: number;
  required: boolean;
  used: boolean;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRenameCommit: (newName: string) => FieldRenameResult;
  onToggleRequired: (required: boolean) => void;
}

const FieldRow: React.FC<FieldRowProps> = ({
  field,
  index,
  total,
  required,
  used,
  onRemove,
  onMoveUp,
  onMoveDown,
  onRenameCommit,
  onToggleRequired,
}) => {
  const { t } = useTranslation('anki');
  const { t: tTemplate } = useTranslation('template');
  const [draft, setDraft] = useState(field);
  const [error, setError] = useState<string | null>(null);

  // 外部字段名变化（排序/其他行重命名导致重挂载不一定发生）时同步草稿
  const [lastField, setLastField] = useState(field);
  if (lastField !== field) {
    setLastField(field);
    setDraft(field);
    setError(null);
  }

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === field) {
      setDraft(field);
      setError(null);
      return;
    }
    const result = onRenameCommit(trimmed);
    if (!result.ok) {
      setError(result.error ?? null);
    } else {
      setError(null);
    }
  };

  return (
    <div className="py-2.5 first:pt-1 last:pb-1">
      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground/60">
            {index + 1}
          </span>
          <Input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (isComposingKeyEvent(e)) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                setDraft(field);
                setError(null);
              }
            }}
            placeholder={tTemplate('field_name_placeholder')}
            className="min-w-0 flex-1 font-mono"
            aria-label={`${tTemplate('field_name_placeholder')} ${index + 1}`}
            aria-invalid={!!error}
          />
        </div>

        <div className="flex shrink-0 items-center gap-2 pl-7 sm:pl-0">
          {used && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                  <CheckCircle size={13} weight="fill" className="text-success shrink-0" aria-hidden="true" />
                  <span>{t('templateEditor.fieldUsed')}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                {t('templateEditor.fieldUsedInTemplate')}
              </TooltipContent>
            </Tooltip>
          )}

          <label
            className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none whitespace-nowrap"
            title={t('templateEditor.toggleRequired') as string}
          >
            <Switch
              size="sm"
              checked={required}
              onCheckedChange={onToggleRequired}
              aria-label={`${field} ${t('templateEditor.toggleRequired')}`}
            />
            <span className={cn(required && 'font-medium text-foreground')}>
              {required ? t('templateEditor.fieldRequired') : t('templateEditor.fieldOptional')}
            </span>
          </label>

          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <DsButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  iconOnly
                  onClick={onMoveUp}
                  disabled={index === 0}
                  aria-label={t('templateEditor.moveFieldUp') as string}
                >
                  <ArrowUp size={14} />
                </DsButton>
              </TooltipTrigger>
              <TooltipContent side="top">{t('templateEditor.moveFieldUp')}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <DsButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  iconOnly
                  onClick={onMoveDown}
                  disabled={index === total - 1}
                  aria-label={t('templateEditor.moveFieldDown') as string}
                >
                  <ArrowDown size={14} />
                </DsButton>
              </TooltipTrigger>
              <TooltipContent side="top">{t('templateEditor.moveFieldDown')}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <DsButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  iconOnly
                  onClick={onRemove}
                  disabled={total <= 1}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={t('templateEditor.deleteField') as string}
                >
                  <Trash size={14} />
                </DsButton>
              </TooltipTrigger>
              <TooltipContent side="top">{t('templateEditor.deleteField')}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      {error && (
        <p className="mt-1.5 pl-7 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

/**
 * 字段管理器：无套娃分隔行列表，支持提交式重命名（自动同步模板引用）、
 * 必填切换、上下排序、删除及模板引用状态展示。
 */
export const TemplateEditorFieldManager: React.FC<TemplateEditorFieldManagerProps> = ({
  fields,
  rules,
  usedFields,
  onRemoveField,
  onMoveField,
  onRenameField,
  onToggleRequired,
  notice,
}) => {
  const { t } = useTranslation('anki');
  const { t: tTemplate } = useTranslation('template');

  return (
    <div className="min-w-0">
      {notice && (
        <Alert variant="info" className="mb-3 flex items-center gap-2 py-2 text-xs" role="status">
          <CheckCircle size={14} weight="fill" className="shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </Alert>
      )}

      {fields.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {tTemplate('editor.no_fields_yet')}
        </p>
      ) : (
        <div className="divide-y divide-border/40">
          {fields.map((field, index) => (
            <FieldRow
              key={`${index}-${field}`}
              field={field}
              index={index}
              total={fields.length}
              required={rules[field]?.is_required ?? false}
              used={usedFields.has(field)}
              onRemove={() => onRemoveField(index)}
              onMoveUp={() => onMoveField(index, -1)}
              onMoveDown={() => onMoveField(index, 1)}
              onRenameCommit={(newName) => onRenameField(index, newName)}
              onToggleRequired={(required) => onToggleRequired(field, required)}
            />
          ))}
        </div>
      )}

      <p className="mt-2 px-1 text-xs text-muted-foreground/70">
        {t('templateEditor.renameSyncHint')}
      </p>
    </div>
  );
};

export default TemplateEditorFieldManager;
