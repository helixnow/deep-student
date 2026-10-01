import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  LEARNING_PROP_KEYS, MASTERY_STATES, applyLearningPropMapping, previewLearningPropMapping,
  undoLearningPropMapping, type LearningField, type LearningPropMapping, type LearningPropMappingPreview,
} from '../noteLearningProps';

/** Keyed by owning note. Preview/apply/undo all use the normal versioned metadata save. */
export function LegacyLearningPropsMapper({ value, disabled, onSave }: {
  value: Record<string, unknown>;
  disabled?: boolean;
  onSave: (next: Record<string, unknown>) => Promise<boolean>;
}) {
  const { t } = useTranslation('notes');
  const [draft, setDraft] = useState<Partial<Record<LearningField, LearningPropMapping>>>({});
  const [preview, setPreview] = useState<LearningPropMappingPreview>();
  const [undo, setUndo] = useState<LearningPropMappingPreview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const keys = Object.keys(value).filter((key) => !Object.values(LEARNING_PROP_KEYS).includes(key as never));
  const run = async (action: () => void | Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <details className="my-3 space-y-2 text-xs">
    <summary>{t('learning.mapping.title', { defaultValue: '映射旧自由属性' })}</summary>
    <p>{t('learning.mapping.hint', { defaultValue: '选择来源与目标值，预览后应用。原属性及未知值全部保留。' })}</p>
    <fieldset disabled={disabled || busy} className="space-y-2">
      {(Object.keys(LEARNING_PROP_KEYS) as LearningField[]).map((field) => <div key={field} className="space-y-1">
        <label className="block">{t('learning.mapping.source', { defaultValue: '{{field}}来源属性', field: t(`learning.fields.${field}`) })}
          <select className="block w-full rounded border bg-background p-1" value={draft[field]?.sourceKey ?? ''} onChange={(event) => {
            const sourceKey = event.target.value;
            setDraft((current) => ({ ...current, [field]: sourceKey ? { sourceKey, field, value: typeof value[sourceKey] === 'string' ? value[sourceKey] as string : '' } : undefined }));
            setPreview(undefined);
          }}><option value="">{t('learning.unset')}</option>{keys.map((key) => <option key={key} value={key}>{key} · {String(value[key])}</option>)}</select>
        </label>
        {draft[field] && <label className="block">{t('learning.mapping.target', { defaultValue: '{{field}}目标值', field: t(`learning.fields.${field}`) })}
          {field === 'mastery' ? <select className="block w-full rounded border bg-background p-1" value={draft[field]!.value}
            onChange={(event) => { setDraft((current) => ({ ...current, [field]: { ...current[field]!, value: event.target.value } })); setPreview(undefined); }}>
            <option value="">{t('learning.unset')}</option>{MASTERY_STATES.map((state) => <option key={state} value={state}>{t(`learning.mastery.${state}`)}</option>)}
          </select> : <input className="block w-full rounded border bg-background p-1" type={field === 'reviewDate' ? 'date' : 'text'} value={draft[field]!.value}
            onChange={(event) => { setDraft((current) => ({ ...current, [field]: { ...current[field]!, value: event.target.value } })); setPreview(undefined); }} />}
        </label>}
      </div>)}
      <button type="button" disabled={!Object.values(draft).some(Boolean)} onClick={() => void run(() => {
        setPreview(previewLearningPropMapping(value, Object.values(draft).filter((item): item is LearningPropMapping => Boolean(item))));
      })}>{t('learning.mapping.preview', { defaultValue: '预览映射' })}</button>
      {preview && <div aria-label={t('learning.mapping.preview', { defaultValue: '预览映射' })}>
        {preview.mappings.map(({ sourceKey, field, value: next }) => <p key={field}>{sourceKey} → {t(`learning.fields.${field}`)}: {String(preview.before[LEARNING_PROP_KEYS[field]] ?? '∅')} → {next}</p>)}
        <button type="button" onClick={() => void run(async () => {
          const next = applyLearningPropMapping(value, preview);
          if (await onSave(next)) { setUndo(preview); setPreview(undefined); setDraft({}); }
        })}>{t('learning.mapping.apply', { defaultValue: '应用映射' })}</button>
      </div>}
      {undo && <button type="button" onClick={() => void run(async () => {
        if (await onSave(undoLearningPropMapping(value, undo))) setUndo(undefined);
      })}>{t('learning.mapping.undo', { defaultValue: '撤销上次映射' })}</button>}
    </fieldset>
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </details>;
}
