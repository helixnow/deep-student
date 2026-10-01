import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCourseDefaultTemplate, loadPersonalNoteTemplates, PERSONAL_NOTE_TEMPLATES_CHANGED, type PersonalNoteTemplate } from '../personalNoteTemplates';
import type { NoteLearningProps } from '../noteLearningProps';

/** Explicitly fills a draft; the ordinary property Save button remains the only persistence action. */
export function LearningTemplatePresetPicker({ course, disabled, onChoose }: {
  course: string;
  disabled?: boolean;
  onChoose: (preset: NoteLearningProps) => void;
}) {
  const { t } = useTranslation('notes');
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<PersonalNoteTemplate[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const load = async () => {
      setLoading(true);
      try {
        const library = await loadPersonalNoteTemplates();
        if (active) { setTemplates(library); setError(''); }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (active) setLoading(false); }
    };
    void load();
    window.addEventListener(PERSONAL_NOTE_TEMPLATES_CHANGED, load);
    return () => { active = false; window.removeEventListener(PERSONAL_NOTE_TEMPLATES_CHANGED, load); };
  }, [open, reload]);
  useEffect(() => setSelectedId(''), [course]);
  const courseDefault = getCourseDefaultTemplate(templates, course);
  const selected = templates.find((template) => template.id === selectedId) ?? courseDefault;
  return <details className="space-y-2" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{t('learning.presets.title')}</summary>
    {open && <>
      {loading && <p role="status">{t('learning.presets.loading')}</p>}
      {courseDefault && <p>{t('learning.presets.course_default', { title: courseDefault.title })}</p>}
      <label className="block">{t('learning.presets.select_label')}
        <select className="w-full rounded border border-border bg-background p-1.5" value={selected?.id ?? ''}
          disabled={disabled || loading} onChange={(event) => setSelectedId(event.target.value)}>
          <option value="" disabled>{t('learning.presets.select_placeholder')}</option>
          {templates.map((template) => <option key={template.id} value={template.id}>{template.title}</option>)}
        </select>
      </label>
      {selected && <dl className="space-y-1" aria-label={t('learning.presets.preview_label')}>
        {Object.entries(selected.learningPreset ?? {}).map(([field, value]) => <div key={field}>
          <dt className="inline">{t('learning.presets.field_label', { field: t(`learning.fields.${field}`) })}</dt>
          <dd className="inline">{field === 'mastery' ? t(`learning.mastery.${value}`, { defaultValue: value }) : value}</dd>
        </div>)}
        {!Object.keys(selected.learningPreset ?? {}).length && <div>{t('learning.presets.empty')}</div>}
      </dl>}
      <p className="text-muted-foreground">{t('learning.presets.hint')}</p>
      <button type="button" className="rounded border border-border px-2 py-1"
        disabled={disabled || loading || !selected || !Object.keys(selected.learningPreset ?? {}).length}
        onClick={() => selected && onChoose(selected.learningPreset ?? {})}>{t('learning.presets.fill')}</button>
      {error && <p role="alert">{error}<button type="button" onClick={() => setReload((v) => v + 1)}>{t('personalTemplates.reload')}</button></p>}
    </>}
  </details>;
}
