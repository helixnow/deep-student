import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash, ArrowUp, ArrowDown, CheckCircle } from '@phosphor-icons/react';
import { FieldExtractionRule } from '../types';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from './ui/shad/Input';
import './TemplateEditorEnhancements.css';

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
  onAddField: () => void;
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
    <div className="template-editor-field-row">
      <div className="flex items-center gap-1.5 flex-1 min-w-0">
        <span className="template-editor-field-index">{index + 1}</span>
        <Input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              setDraft(field);
              setError(null);
            }
          }}
          placeholder={tTemplate('field_name_placeholder')}
          className="md:!h-7 text-sm flex-1 min-w-0 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:text-base"
          aria-invalid={!!error}
        />
        {used && (
          <span className="template-editor-field-badge" title={t('templateEditor.fieldUsedInTemplate') as string}>
            <CheckCircle size={11} weight="fill" />
            {t('templateEditor.fieldUsed')}
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          type="button"
          className={`template-editor-required-toggle [@media(pointer:coarse)]:!min-h-11 ${required ? 'active' : ''}`}
          aria-pressed={required}
          title={t('templateEditor.toggleRequired') as string}
          onClick={() => onToggleRequired(!required)}
        >
          {required ? t('templateEditor.fieldRequired') : t('templateEditor.fieldOptional')}
        </button>
        <DsButton
          type="button" variant="ghost" size="sm" iconOnly
          onClick={onMoveUp}
          disabled={index === 0}
          className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
          title={t('templateEditor.moveFieldUp') as string}
        >
          <ArrowUp size={14} />
        </DsButton>
        <DsButton
          type="button" variant="ghost" size="sm" iconOnly
          onClick={onMoveDown}
          disabled={index === total - 1}
          className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
          title={t('templateEditor.moveFieldDown') as string}
        >
          <ArrowDown size={14} />
        </DsButton>
        <DsButton
          type="button" variant="ghost" size="sm" iconOnly
          onClick={onRemove}
          disabled={total <= 1}
          className="text-destructive hover:text-destructive [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
          title={t('templateEditor.deleteField') as string}
        >
          <Trash size={14} />
        </DsButton>
      </div>
      {error && (
        <div className="template-editor-lint-item basis-full mt-1" role="alert">{error}</div>
      )}
    </div>
  );
};

/**
 * 字段管理器：重命名（提交式，自动同步模板引用）、必填标记、
 * 上下移排序、增删，以及「模板已引用」标记。
 */
export const TemplateEditorFieldManager: React.FC<TemplateEditorFieldManagerProps> = ({
  fields,
  rules,
  usedFields,
  onAddField,
  onRemoveField,
  onMoveField,
  onRenameField,
  onToggleRequired,
  notice,
}) => {
  const { t } = useTranslation('anki');
  const { t: tTemplate } = useTranslation('template');

  return (
    <div className="template-editor-field-manager">
      {notice && (
        <div className="template-editor-sync-notice" role="status">
          <CheckCircle size={13} weight="fill" />
          {notice}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
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
      <div className="flex items-center justify-between mt-3">
        <DsButton
          type="button" variant="ghost" size="sm" onClick={onAddField}
          className="[@media(pointer:coarse)]:!min-h-11"
        >
          <Plus size={14} className="mr-1.5" />
          {tTemplate('add_field')}
        </DsButton>
        <span className="text-[10px] max-md:text-[11px] text-muted-foreground/60">
          {t('templateEditor.renameSyncHint')}
        </span>
      </div>
    </div>
  );
};

export default TemplateEditorFieldManager;
