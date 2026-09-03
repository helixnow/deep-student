/**
 * 笔记自定义属性（任意键值对）编辑器 —— 统一右侧栏「属性」页的一节。
 *
 * 数据契约：属性存放在 DstuNode.metadata.props（对象），写回走
 * dstu.setMetadata(path, { props })，整对象替换（与 tags 数组替换同语义）。
 * 搜索 overlay 的 `key:value` 操作符直接对该对象做交集过滤。
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CircleNotch, PencilSimple, Plus, SlidersHorizontal, Trash, X } from '@phosphor-icons/react';

/** 与 tags 数量限额同一个量级；键值均有长度限制（后端亦校验兜底） */
export const NOTE_PROPS_MAX_COUNT = 32;
export const NOTE_PROP_KEY_MAX_CHARS = 64;
export const NOTE_PROP_VALUE_MAX_CHARS = 512;

/** 与内建元数据/搜索操作符冲突的保留键 */
export const NOTE_PROPS_RESERVED_KEYS: readonly string[] = [
  'tags', 'tag', 'path', 'title', 'isfavorite', 'snippet', 'props',
];

// eslint-disable-next-line no-control-regex -- 有意拦截控制字符（与后端 validate_note_props 一致）
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type NotePropViolation =
  | 'empty_key'
  | 'reserved_key'
  | 'duplicate_key'
  | 'key_too_long'
  | 'value_too_long'
  | 'invalid_chars'
  | 'too_many'
  | null;

/** 新增/重命名属性键值的前置校验（纯函数，测试直接断言） */
export function validateNoteProp(
  key: string,
  value: string,
  existingKeys: readonly string[],
  options: { excludeKey?: string } = {},
): NotePropViolation {
  const trimmedKey = key.trim();
  if (!trimmedKey) return 'empty_key';
  if (CONTROL_CHARS.test(trimmedKey) || CONTROL_CHARS.test(value)) return 'invalid_chars';
  if (trimmedKey.length > NOTE_PROP_KEY_MAX_CHARS) return 'key_too_long';
  if (value.length > NOTE_PROP_VALUE_MAX_CHARS) return 'value_too_long';
  if (NOTE_PROPS_RESERVED_KEYS.includes(trimmedKey.toLocaleLowerCase())) return 'reserved_key';
  const excluded = options.excludeKey?.toLocaleLowerCase();
  const clash = existingKeys.some((existing) => (
    existing.toLocaleLowerCase() === trimmedKey.toLocaleLowerCase()
    && existing.toLocaleLowerCase() !== excluded
  ));
  if (clash) return 'duplicate_key';
  if (
    options.excludeKey === undefined
    && existingKeys.length >= NOTE_PROPS_MAX_COUNT
  ) return 'too_many';
  return null;
}

export interface NoteCustomPropsEditorProps {
  /** 当前属性对象（来自 metadata.props） */
  value: Record<string, unknown>;
  readOnly?: boolean;
  /** 整对象替换写回；抛错时编辑器展示错误并保留输入 */
  onChange?: (next: Record<string, unknown>) => Promise<void>;
}

export const NoteCustomPropsEditor: React.FC<NoteCustomPropsEditorProps> = ({
  value,
  readOnly = false,
  onChange,
}) => {
  const { t } = useTranslation('workbench');
  const entries = useMemo(
    () => Object.entries(value).map(([key, raw]) => [key, raw == null ? '' : String(raw)] as const),
    [value],
  );
  const keys = useMemo(() => entries.map(([key]) => key), [entries]);

  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  const canEdit = !readOnly && typeof onChange === 'function';

  useEffect(() => {
    if (adding) keyInputRef.current?.focus();
  }, [adding]);

  const violationMessage = useCallback((violation: NotePropViolation): string | null => {
    switch (violation) {
      case 'empty_key':
        return t('notesWorkspace.props.emptyKey', { defaultValue: '请输入属性名。' });
      case 'reserved_key':
        return t('notesWorkspace.props.reservedKey', { defaultValue: '该属性名为保留字，请换一个。' });
      case 'duplicate_key':
        return t('notesWorkspace.props.duplicateKey', { defaultValue: '同名属性已存在。' });
      case 'key_too_long':
        return t('notesWorkspace.props.keyTooLong', {
          defaultValue: '属性名最多 {{max}} 个字符。',
          max: NOTE_PROP_KEY_MAX_CHARS,
        });
      case 'value_too_long':
        return t('notesWorkspace.props.valueTooLong', {
          defaultValue: '属性值最多 {{max}} 个字符。',
          max: NOTE_PROP_VALUE_MAX_CHARS,
        });
      case 'invalid_chars':
        return t('notesWorkspace.props.invalidChars', { defaultValue: '属性不能包含控制字符。' });
      case 'too_many':
        return t('notesWorkspace.props.tooMany', {
          defaultValue: '最多添加 {{max}} 个属性。',
          max: NOTE_PROPS_MAX_COUNT,
        });
      default:
        return null;
    }
  }, [t]);

  const commit = useCallback(async (next: Record<string, unknown>): Promise<boolean> => {
    if (!onChange) return false;
    setSaving(true);
    setError(null);
    try {
      await onChange(next);
      return true;
    } catch (commitError) {
      setError(commitError instanceof Error && commitError.message.trim()
        ? commitError.message
        : t('notesWorkspace.props.saveFailed', { defaultValue: '无法保存属性。' }));
      return false;
    } finally {
      setSaving(false);
    }
  }, [onChange, t]);

  const addProp = useCallback(async () => {
    const violation = validateNoteProp(newKey, newValue, keys);
    const message = violationMessage(violation);
    if (message) {
      setError(message);
      return;
    }
    const next = { ...value, [newKey.trim()]: newValue };
    if (await commit(next)) {
      setNewKey('');
      setNewValue('');
      setAdding(false);
    }
  }, [commit, keys, newKey, newValue, value, violationMessage]);

  const saveEditedValue = useCallback(async () => {
    if (editingKey === null) return;
    const violation = validateNoteProp(editingKey, editingValue, keys, { excludeKey: editingKey });
    const message = violationMessage(violation);
    if (message) {
      setError(message);
      return;
    }
    const next = { ...value, [editingKey]: editingValue };
    if (await commit(next)) {
      setEditingKey(null);
      setEditingValue('');
    }
  }, [commit, editingKey, editingValue, keys, value, violationMessage]);

  const removeProp = useCallback(async (key: string) => {
    const next = { ...value };
    delete next[key];
    await commit(next);
  }, [commit, value]);

  const cancelAdd = useCallback(() => {
    setAdding(false);
    setNewKey('');
    setNewValue('');
    setError(null);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingKey(null);
    setEditingValue('');
    setError(null);
  }, []);

  return (
    <div className="notes-props-editor" data-notes-props-editor>
      <div className="notes-props-header">
        <SlidersHorizontal size={14} aria-hidden="true" />
        <h3>{t('notesWorkspace.props.title', { defaultValue: '属性' })}</h3>
        {entries.length > 0 && <span className="notes-props-count">{entries.length}</span>}
        {saving && <CircleNotch className="notes-props-spinner" size={12} aria-hidden="true" />}
      </div>

      {entries.length === 0 && !adding && (
        <p className="notes-props-empty">
          {canEdit
            ? t('notesWorkspace.props.emptyHint', {
              defaultValue: '为笔记添加任意键值属性，可用 key:value 搜索。',
            })
            : t('notesWorkspace.props.emptyReadOnly', { defaultValue: '暂无属性。' })}
        </p>
      )}

      {entries.length > 0 && (
        <dl className="notes-props-list">
          {entries.map(([key, propValue]) => (
            <div key={key} className="notes-props-row" data-prop-key={key}>
              <dt title={key}>{key}</dt>
              {editingKey === key ? (
                <dd className="notes-props-editing">
                  <input
                    value={editingValue}
                    onChange={(event) => {
                      setEditingValue(event.target.value);
                      setError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void saveEditedValue();
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelEdit();
                      }
                    }}
                    aria-label={t('notesWorkspace.props.editValueAria', {
                      defaultValue: '编辑属性 {{key}} 的值',
                      key,
                    })}
                    autoFocus
                  />
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void saveEditedValue()}
                    aria-label={t('notesWorkspace.props.confirmEdit', { defaultValue: '保存属性值' })}
                    title={t('notesWorkspace.props.confirmEdit', { defaultValue: '保存属性值' })}
                  >
                    <Check size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={cancelEdit}
                    aria-label={t('notesWorkspace.props.cancelEdit', { defaultValue: '取消编辑' })}
                    title={t('notesWorkspace.props.cancelEdit', { defaultValue: '取消编辑' })}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </dd>
              ) : (
                <dd className="notes-props-value-row">
                  <span className="notes-props-value" title={propValue}>{propValue}</span>
                  {canEdit && (
                    <span className="notes-props-row-actions">
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => {
                          setEditingKey(key);
                          setEditingValue(propValue);
                          setError(null);
                        }}
                        aria-label={t('notesWorkspace.props.editAria', {
                          defaultValue: '编辑属性 {{key}}',
                          key,
                        })}
                        title={t('notesWorkspace.props.editAria', {
                          defaultValue: '编辑属性 {{key}}',
                          key,
                        })}
                      >
                        <PencilSimple size={13} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void removeProp(key)}
                        aria-label={t('notesWorkspace.props.removeAria', {
                          defaultValue: '删除属性 {{key}}',
                          key,
                        })}
                        title={t('notesWorkspace.props.removeAria', {
                          defaultValue: '删除属性 {{key}}',
                          key,
                        })}
                      >
                        <Trash size={13} aria-hidden="true" />
                      </button>
                    </span>
                  )}
                </dd>
              )}
            </div>
          ))}
        </dl>
      )}

      {canEdit && (adding ? (
        <div className="notes-props-add-form">
          <input
            ref={keyInputRef}
            value={newKey}
            placeholder={t('notesWorkspace.props.keyPlaceholder', { defaultValue: '属性名' })}
            aria-label={t('notesWorkspace.props.keyPlaceholder', { defaultValue: '属性名' })}
            onChange={(event) => {
              setNewKey(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancelAdd();
              }
            }}
          />
          <input
            value={newValue}
            placeholder={t('notesWorkspace.props.valuePlaceholder', { defaultValue: '值' })}
            aria-label={t('notesWorkspace.props.valuePlaceholder', { defaultValue: '值' })}
            onChange={(event) => {
              setNewValue(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void addProp();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancelAdd();
              }
            }}
          />
          <button
            type="button"
            disabled={saving}
            onClick={() => void addProp()}
            aria-label={t('notesWorkspace.props.confirmAdd', { defaultValue: '添加属性' })}
            title={t('notesWorkspace.props.confirmAdd', { defaultValue: '添加属性' })}
          >
            <Check size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={cancelAdd}
            aria-label={t('notesWorkspace.props.cancelAdd', { defaultValue: '取消添加' })}
            title={t('notesWorkspace.props.cancelAdd', { defaultValue: '取消添加' })}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="notes-props-add-button"
          onClick={() => {
            setAdding(true);
            setError(null);
          }}
        >
          <Plus size={12} aria-hidden="true" />
          {t('notesWorkspace.props.add', { defaultValue: '添加属性' })}
        </button>
      ))}

      {error && (
        <p id={errorId} className="notes-props-error" role="alert">{error}</p>
      )}
    </div>
  );
};

export default NoteCustomPropsEditor;
