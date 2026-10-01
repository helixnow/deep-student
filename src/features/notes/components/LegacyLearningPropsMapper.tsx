import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/notes-form-controls.css';
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
  // `_` 前缀为记忆/索引系统内部键，不作为映射来源
  const keys = Object.keys(value).filter((key) => !key.startsWith('_') && !Object.values(LEARNING_PROP_KEYS).includes(key as never));
  const run = async (action: () => void | Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  // 没有可映射的旧自由属性时不占位（撤销窗口内保留，以便回退刚完成的映射）
  if (keys.length === 0 && !undo && !preview) return null;
  return <details className="notes-disclosure notes-learn-mapper">
    <summary>{t('learning.mapping.title', { defaultValue: '映射旧自由属性' })}</summary>
    <p className="notes-learn-props-hint">{t('learning.mapping.hint', { defaultValue: '选择来源与目标值，预览后应用。原属性及未知值全部保留。' })}</p>
    <fieldset disabled={disabled || busy} className="notes-disclosure-body notes-learn-mapper-body">
      {(Object.keys(LEARNING_PROP_KEYS) as LearningField[]).map((field) => <div key={field} className="space-y-1">
        <label className="notes-field">{t('learning.mapping.source', { defaultValue: '{{field}}来源属性', field: t(`learning.fields.${field}`) })}
          <select className="notes-select" value={draft[field]?.sourceKey ?? ''} onChange={(event) => {
            const sourceKey = event.target.value;
            setDraft((current) => ({ ...current, [field]: sourceKey ? { sourceKey, field, value: typeof value[sourceKey] === 'string' ? value[sourceKey] as string : '' } : undefined }));
            setPreview(undefined);
          }}><option value="">{t('learning.unset')}</option>{keys.map((key) => <option key={key} value={key}>{key} · {String(value[key])}</option>)}</select>
        </label>
        {draft[field] && <label className="notes-field">{t('learning.mapping.target', { defaultValue: '{{field}}目标值', field: t(`learning.fields.${field}`) })}
          {field === 'mastery' ? <select className="notes-select" value={draft[field]!.value}
            onChange={(event) => { setDraft((current) => ({ ...current, [field]: { ...current[field]!, value: event.target.value } })); setPreview(undefined); }}>
            <option value="">{t('learning.unset')}</option>{MASTERY_STATES.map((state) => <option key={state} value={state}>{t(`learning.mastery.${state}`)}</option>)}
          </select> : <input className="notes-input" type={field === 'reviewDate' ? 'date' : 'text'} value={draft[field]!.value}
            onChange={(event) => { setDraft((current) => ({ ...current, [field]: { ...current[field]!, value: event.target.value } })); setPreview(undefined); }} />}
        </label>}
      </div>)}
      <button type="button" className="notes-btn" data-variant="primary" disabled={!Object.values(draft).some(Boolean)} onClick={() => void run(() => {
        setPreview(previewLearningPropMapping(value, Object.values(draft).filter((item): item is LearningPropMapping => Boolean(item))));
      })}>{t('learning.mapping.preview', { defaultValue: '预览映射' })}</button>
      {preview && <div aria-label={t('learning.mapping.preview', { defaultValue: '预览映射' })}>
        {preview.mappings.map(({ sourceKey, field, value: next }) => <p key={field}>{sourceKey} → {t(`learning.fields.${field}`)}: {String(preview.before[LEARNING_PROP_KEYS[field]] ?? '∅')} → {next}</p>)}
        <button type="button" className="notes-btn" onClick={() => void run(async () => {
          const next = applyLearningPropMapping(value, preview);
          if (await onSave(next)) { setUndo(preview); setPreview(undefined); setDraft({}); }
        })}>{t('learning.mapping.apply', { defaultValue: '应用映射' })}</button>
      </div>}
      {undo && <button type="button" className="notes-btn" data-variant="ghost" onClick={() => void run(async () => {
        if (await onSave(undoLearningPropMapping(value, undo))) setUndo(undefined);
      })}>{t('learning.mapping.undo', { defaultValue: '撤销上次映射' })}</button>}
    </fieldset>
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </details>;
}
