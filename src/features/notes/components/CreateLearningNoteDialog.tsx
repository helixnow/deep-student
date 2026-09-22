import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsDialog, DsDialogBody, DsDialogHeader, DsDialogTitle } from '@/components/ui/DsDialog';
import type { DstuNode } from '@/dstu';
import { createLearningNote, finishLearningNoteCreation, LearningNoteInitializationError } from '../createLearningNote';
import { getCourseDefaultTemplate, loadPersonalNoteTemplates, type PersonalNoteTemplate } from '../personalNoteTemplates';
import { getNoteTemplates, renderNoteTemplate } from '../noteTemplates';
import { LEARNING_PROP_KEYS, MASTERY_STATES, type LearningField } from '../noteLearningProps';

export function CreateLearningNoteDialog({ folderId, onCreated, onClose }: {
  folderId?: string | null;
  onCreated: (node: DstuNode) => void | Promise<void>;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation('notes');
  const [title, setTitle] = useState('');
  const [course, setCourse] = useState('');
  const [choice, setChoice] = useState('none');
  const [templates, setTemplates] = useState<PersonalNoteTemplate[]>([]);
  const [changes, setChanges] = useState<Partial<Record<LearningField, string>>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<LearningNoteInitializationError>();
  const [created, setCreated] = useState<DstuNode>();
  const [reload, setReload] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    setLoading(true);
    void loadPersonalNoteTemplates().then((items) => { if (active) { setTemplates(items); setError(''); } })
      .catch((cause) => { if (active) setError(String(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; mounted.current = false; };
  }, [reload]);
  const courseDefault = getCourseDefaultTemplate(templates, course);
  const all = [...getNoteTemplates(i18n.language), ...templates];
  const selected = choice === 'course-default' ? courseDefault : all.find((item) => item.id === choice);
  const effectiveCourse = course || (!Object.hasOwn(changes, 'course') ? selected?.learningPreset?.course ?? '' : '');
  const preset = { ...selected?.learningPreset, ...(course.trim() ? { course: course.trim() } : {}) };
  return <DsDialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }} showClose={!busy} closeOnOverlay={!busy}
    maxWidth="max-w-xl" aria-label={t('learning.create.title', { defaultValue: '新建学习笔记' })}>
    <DsDialogHeader><DsDialogTitle>{t('learning.create.title', { defaultValue: '新建学习笔记' })}</DsDialogTitle></DsDialogHeader>
    <DsDialogBody className="py-4">
    <fieldset disabled={busy || Boolean(pending) || Boolean(created)} className="space-y-3">
      <label className="block">{t('learning.create.name', { defaultValue: '笔记标题' })}<input autoFocus className="block w-full border bg-background p-2" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="block">{t('learning.create.course', { defaultValue: '所属课程' })}<input className="block w-full border bg-background p-2" value={effectiveCourse} onChange={(event) => { setCourse(event.target.value); setChanges((current) => ({ ...current, course: event.target.value.trim() })); }} /></label>
      <label className="block">{t('learning.create.template', { defaultValue: '新建模板' })}<select className="block w-full border bg-background p-2" value={choice} onChange={(event) => setChoice(event.target.value)}>
        <option value="none">{t('learning.create.blank', { defaultValue: '空白笔记' })}</option>
        <option value="course-default" disabled={!courseDefault}>{t('learning.create.default', { defaultValue: '课程默认：{{title}}', title: courseDefault?.title ?? t('learning.unset') })}</option>
        {all.map((template) => <option key={template.id} value={template.id}>{template.title}</option>)}
      </select></label>
      {loading && <p role="status">{t('personalTemplates.loading')}</p>}
      {selected && <pre aria-label={t('personalTemplates.preview_label')} className="max-h-40 overflow-auto whitespace-pre-wrap">{renderNoteTemplate(selected.markdown, { title, locale: i18n.language })}</pre>}
      {(Object.keys(LEARNING_PROP_KEYS) as LearningField[]).filter((field) => field !== 'course').map((field) => <label key={field} className="block">{t(`learning.fields.${field}`)}
        {field === 'mastery' ? <select className="block w-full border bg-background p-2" value={changes[field] ?? preset[field] ?? ''} onChange={(event) => setChanges((current) => ({ ...current, [field]: event.target.value }))}>
          <option value="">{t('learning.unset')}</option>{MASTERY_STATES.map((state) => <option key={state} value={state}>{t(`learning.mastery.${state}`)}</option>)}
        </select> : <input className="block w-full border bg-background p-2" type={field === 'reviewDate' ? 'date' : 'text'} value={changes[field] ?? preset[field] ?? ''} onChange={(event) => setChanges((current) => ({ ...current, [field]: event.target.value }))} />}
      </label>)}
      <p>{t('learning.create.hint', { defaultValue: '课程默认仅在选择后应用，已填写的属性优先保留。' })}</p>
      <div className="flex gap-3"><button type="button" disabled={!title.trim() || (choice !== 'none' && !selected)} onClick={async () => {
        setBusy(true); setError('');
        try {
          const node = await createLearningNote({ title, course: effectiveCourse, template: selected, folderId, changes });
          if (mounted.current) { setCreated(node); await onCreated(node); onClose(); }
        } catch (cause) { if (mounted.current) { if (cause instanceof LearningNoteInitializationError) setPending(cause); setError(cause instanceof Error ? cause.message : String(cause)); } }
        finally { if (mounted.current) setBusy(false); }
      }}>{t('learning.create.submit', { defaultValue: '创建笔记' })}</button>
        <button type="button" onClick={onClose}>{t('learning.create.cancel', { defaultValue: '取消新建' })}</button></div>
    </fieldset>
    {pending && <div className="my-3 flex gap-3"><button type="button" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { const node = await finishLearningNoteCreation(pending.node, pending.props); if (mounted.current) { setCreated(node); setPending(undefined); await onCreated(node); onClose(); } }
      catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (mounted.current) setBusy(false); }
    }}>{t('learning.create.retry_props', { defaultValue: '重试保存属性' })}</button>
      <button type="button" disabled={busy} onClick={async () => {
        setBusy(true); setError('');
        try { await onCreated(pending.node); onClose(); }
        catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { if (mounted.current) setBusy(false); }
      }}>{t('learning.create.open_partial', { defaultValue: '打开已创建笔记' })}</button>
    </div>}
    {created && !busy && <button type="button" onClick={async () => {
      setBusy(true); setError('');
      try { await onCreated(created); onClose(); }
      catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (mounted.current) setBusy(false); }
    }}>{t('learning.create.open_partial', { defaultValue: '打开已创建笔记' })}</button>}
    {error && <p role="alert" className="text-destructive">{error}<button type="button" disabled={busy} onClick={() => setReload((count) => count + 1)}>{t('learning.reload')}</button></p>}
    </DsDialogBody>
  </DsDialog>;
}
