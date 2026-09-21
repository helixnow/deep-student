import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import {
  renderNoteTemplate, replaceWithNoteTemplate,
  type NoteTemplate, type NoteTemplateDocument, type NoteTemplateDocumentHost,
} from '../noteTemplates';
import {
  loadPersonalNoteTemplates, savePersonalNoteTemplate, PERSONAL_NOTE_TEMPLATES_CHANGED,
  type PersonalNoteTemplate,
} from '../personalNoteTemplates';
import { LEARNING_PROP_KEYS, MASTERY_STATES, type LearningField, type NoteLearningProps } from '../noteLearningProps';

interface Preview {
  template: NoteTemplate;
  rendered: string;
  baseline?: NoteTemplateDocument;
}

export function PersonalNoteTemplates({ disabled, onApplyTemplate, documentHost }: {
  disabled?: boolean;
  onApplyTemplate: (template: NoteTemplate) => void | Promise<void>;
  documentHost?: NoteTemplateDocumentHost;
}) {
  const { t } = useTranslation('notes');
  const [templates, setTemplates] = useState<PersonalNoteTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [id, setId] = useState<PersonalNoteTemplate['id']>();
  const [title, setTitle] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [defaultForCourse, setDefaultForCourse] = useState('');
  const [learningPreset, setLearningPreset] = useState<NoteLearningProps>({});
  const [preview, setPreview] = useState<Preview>();
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const stored = await loadPersonalNoteTemplates();
        if (!cancelled) { setTemplates(stored); setError(''); }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    window.addEventListener(PERSONAL_NOTE_TEMPLATES_CHANGED, load);
    return () => { cancelled = true; window.removeEventListener(PERSONAL_NOTE_TEMPLATES_CHANGED, load); };
  }, [reload]);

  const run = async (action: () => Promise<void> | void) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const invalidatePreview = () => { setPreview(undefined); setConfirmReplace(false); setNotice(''); };
  const showPreview = () => {
    const baseline = documentHost?.getDocument();
    const template: NoteTemplate = { id: id ?? 'personal:draft', title: title || t('personalTemplates.untitled'), summary: '', markdown };
    setPreview({ template, rendered: renderNoteTemplate(markdown, documentHost?.variables), baseline });
    setConfirmReplace(false);
  };
  const locked = disabled || busy;
  return (
    <section className="my-3 space-y-3 border-t border-border pt-3 text-xs" aria-label={t('personalTemplates.title')}>
      <h3 className="font-medium">{t('personalTemplates.title')}</h3>
      {loading ? <p role="status">{t('personalTemplates.loading')}</p> : <div className="flex flex-wrap gap-2">
        {templates.map((template) => <button type="button" key={template.id} disabled={locked}
          className="rounded border border-border px-2 py-1" onClick={() => {
            setId(template.id); setTitle(template.title); setMarkdown(template.markdown); invalidatePreview();
            setDefaultForCourse(template.defaultForCourse ?? ''); setLearningPreset(template.learningPreset ?? {});
          }}>{template.title}</button>)}
        {!templates.length && <p className="text-muted-foreground">{t('personalTemplates.empty')}</p>}
      </div>}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={locked} className="rounded border border-border px-2 py-1" onClick={() => {
          setId(undefined); setTitle(''); setMarkdown(''); invalidatePreview();
          setDefaultForCourse(''); setLearningPreset({});
        }}>{t('personalTemplates.create')}</button>
        {documentHost && <button type="button" disabled={locked} className="rounded border border-border px-2 py-1"
          onClick={() => void run(() => {
            setMarkdown(documentHost.getDocument().markdown); setId(undefined); invalidatePreview();
            setDefaultForCourse(''); setLearningPreset({});
          })}>{t('personalTemplates.capture_note')}</button>}
      </div>
      <label className="block space-y-1"><span>{t('personalTemplates.name')}</span>
        <input className="block w-full rounded border border-border bg-background p-2" maxLength={120} value={title}
          disabled={locked} onChange={(event) => { setTitle(event.target.value); invalidatePreview(); }} />
      </label>
      <label className="block space-y-1"><span>{t('personalTemplates.body')}</span>
        <textarea className="block min-h-32 w-full rounded border border-border bg-background p-2 font-mono"
          rows={6} value={markdown} disabled={locked} onChange={(event) => { setMarkdown(event.target.value); invalidatePreview(); }} />
      </label>
      <p className="text-muted-foreground">{t('personalTemplates.variables_hint', { variables: ['{{date}}', '{{time}}', '{{title}}'].join(t('personalTemplates.variable_separator')) })}</p>
      <details className="space-y-2">
        <summary>{t('personalTemplates.learning_defaults.title')}</summary>
        <label className="block">{t('personalTemplates.learning_defaults.course')}
          <input className="block w-full rounded border border-border bg-background p-2" maxLength={512}
            disabled={locked} value={defaultForCourse} onChange={(event) => setDefaultForCourse(event.target.value)} />
        </label>
        <p className="text-muted-foreground">{t('personalTemplates.learning_defaults.hint')}</p>
        {(Object.keys(LEARNING_PROP_KEYS) as LearningField[]).map((field) => {
          const change = (value: string) => setLearningPreset((current) => {
            const next = { ...current };
            if (value) Object.assign(next, { [field]: value });
            else delete next[field];
            return next;
          });
          return <label key={field} className="block">{t(`personalTemplates.learning_defaults.fields.${field}`)}
            {field === 'mastery' ? <select className="block w-full rounded border border-border bg-background p-2"
              disabled={locked} value={learningPreset[field] ?? ''} onChange={(event) => change(event.target.value)}>
              <option value="">{t('personalTemplates.learning_defaults.unset')}</option>
              {MASTERY_STATES.map((state) => <option key={state} value={state}>{t(`learning.mastery.${state}`)}</option>)}
            </select> : <input className="block w-full rounded border border-border bg-background p-2" maxLength={512}
              type={field === 'reviewDate' ? 'date' : 'text'} disabled={locked} value={learningPreset[field] ?? ''}
              onChange={(event) => change(event.target.value)} />}
          </label>;
        })}
      </details>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={locked || loading || !title.trim() || !markdown.trim()}
          className="rounded border border-border px-2 py-1" onClick={() => void run(async () => {
            const saved = await savePersonalNoteTemplate({ id, title, markdown, defaultForCourse, learningPreset });
            setId(saved.id); setNotice(t('personalTemplates.saved'));
          })}>{id ? t('personalTemplates.save_changes') : t('personalTemplates.save')}</button>
        <button type="button" disabled={locked || !markdown.trim()} className="rounded border border-border px-2 py-1"
          onClick={() => void run(showPreview)}>{t('personalTemplates.preview')}</button>
      </div>
      {preview && <div className="space-y-2 rounded border border-border p-3">
        <h4 className="font-medium">{t('personalTemplates.preview_title', { title: preview.template.title })}</h4>
        {!documentHost && <p className="text-muted-foreground">{t('personalTemplates.title_variable_hint')}</p>}
        <div className="prose prose-sm max-h-64 overflow-auto break-words dark:prose-invert" aria-label={t('personalTemplates.preview_label')}>
          <ReactMarkdown>{preview.rendered}</ReactMarkdown>
        </div>
        <p className="text-muted-foreground">{t('personalTemplates.append_hint')}</p>
        <button type="button" disabled={locked} className="rounded border border-border px-2 py-1"
          onClick={() => void run(async () => {
            await onApplyTemplate(preview.template);
            setNotice(t('personalTemplates.append_requested'));
          })}>{t('personalTemplates.append')}</button>
        {documentHost && preview.baseline && <>
          <details><summary>{t('personalTemplates.original_content', { count: preview.baseline.markdown.length })}</summary>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{preview.baseline.markdown || t('personalTemplates.empty_note')}</pre>
          </details>
          <label className="flex items-center gap-2"><input type="checkbox" checked={confirmReplace} disabled={locked}
            onChange={(event) => setConfirmReplace(event.target.checked)} />{t('personalTemplates.confirm_replace')}</label>
          <button type="button" disabled={locked || !confirmReplace} className="rounded border border-border px-2 py-1"
            onClick={() => void run(async () => {
              await replaceWithNoteTemplate(documentHost, preview.baseline!, `${preview.rendered.trim()}\n`);
              setPreview(undefined); setConfirmReplace(false); setNotice(t('personalTemplates.replaced'));
            })}>{t('personalTemplates.replace')}</button>
        </>}
      </div>}
      {notice && <p role="status">{notice}</p>}
      {error && <div role="alert" className="text-destructive">{error}
        <button type="button" disabled={busy} className="ml-2 underline" onClick={() => setReload((value) => value + 1)}>{t('personalTemplates.reload')}</button>
      </div>}
    </section>
  );
}
