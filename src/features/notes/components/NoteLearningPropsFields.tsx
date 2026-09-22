import React, { useRef, useState } from 'react';
import { mergeNotePropEdits } from '../notePropEdits';
import { useTranslation } from 'react-i18next';
import {
  LEARNING_PROP_KEYS, MASTERY_STATES, readNoteLearningProps, updateNoteLearningProps,
  type LearningField,
} from '../noteLearningProps';
import { LearningTemplatePresetPicker } from './LearningTemplatePresetPicker';

/** Mount under a note-id key. Live metadata refreshes must not discard the user's draft. */
export function NoteLearningPropsFields({ value, disabled, readOnly, onSave }: {
  value: Record<string, unknown>;
  disabled?: boolean;
  readOnly?: boolean;
  onSave: (next: Record<string, unknown>) => Promise<boolean>;
}) {
  const { t } = useTranslation('notes');
  const [changes, setChanges] = useState<Partial<Record<LearningField, string>>>({});
  const [error, setError] = useState('');
  const baseline = useRef<Record<string, unknown>>();
  const [saving, setSaving] = useState(false);
  const [failedSave, setFailedSave] = useState(false);
  const edit = (field: LearningField, text: string) => {
    baseline.current ??= value;
    setChanges((prev) => ({ ...prev, [field]: text })); setError('');
  };
  const current = readNoteLearningProps(value);
  const save = async () => {
    if (saving) return;
    setSaving(true); setError('');
    try {
      const before = baseline.current ?? value;
      const next = mergeNotePropEdits(before, updateNoteLearningProps(before, changes), value);
      if (await onSave(next)) { setChanges({}); baseline.current = undefined; setFailedSave(false); }
      else setFailedSave(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  };
  return (
    <fieldset className="my-3 space-y-2 text-xs" disabled={disabled || readOnly || saving}>
      <legend className="font-medium">{t('learning.title')}</legend>
      {(Object.keys(LEARNING_PROP_KEYS) as LearningField[]).map((field) => {
        const raw = value[LEARNING_PROP_KEYS[field]];
        const invalid = raw !== undefined && current[field] === undefined;
        const inputValue = changes[field] ?? current[field] ?? '';
        return (
          <label key={field} className="block space-y-1">
            <span>{t(`learning.fields.${field}`)}</span>
            {field === 'mastery' ? (
              <select className="w-full rounded border border-border bg-background p-1.5" value={inputValue}
                onChange={(event) => edit(field, event.target.value)}>
                <option value="">{t('learning.unset')}</option>
                {MASTERY_STATES.map((state) => <option key={state} value={state}>{t(`learning.mastery.${state}`)}</option>)}
              </select>
            ) : (
              <input className="w-full rounded border border-border bg-background p-1.5"
                type={field === 'reviewDate' ? 'date' : 'text'} maxLength={512} value={inputValue}
                onChange={(event) => edit(field, event.target.value)} />
            )}
            {invalid && <span className="block text-muted-foreground">{t('learning.legacy_value', { value: String(raw) })}</span>}
          </label>
        );
      })}
      <p className="text-muted-foreground">{t('learning.legacy_hint')}</p>
      {!readOnly && <LearningTemplatePresetPicker course={changes.course ?? current.course ?? ''} disabled={disabled}
        onChoose={(preset) => { baseline.current ??= value; setChanges((draft) => {
          const next = { ...draft };
          for (const field of Object.keys(preset) as LearningField[]) {
            const key = LEARNING_PROP_KEYS[field];
            const alreadyStored = Object.keys(value).some((existing) => existing.trim().toLowerCase() === key);
            if (!alreadyStored && !Object.hasOwn(draft, field)) next[field] = preset[field];
          }
          return next;
        }); }} />}
      {!readOnly && <button type="button" className="rounded border border-border px-2 py-1"
        disabled={disabled || Object.keys(changes).length === 0} onClick={() => void save()}>{t('learning.save')}</button>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {(error || failedSave) && <button type="button" onClick={() => { baseline.current = value; setError(''); setFailedSave(false); }}>{t('learning.confirm_latest', { defaultValue: '已核对最新值，保留草稿重试' })}</button>}
    </fieldset>
  );
}
