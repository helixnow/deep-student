/**
 * 笔记模板库（Notion 式模板选择器）。
 *
 * 居中对话框：左栏「内置模板 / 我的模板」，右栏用与正文同一套 Crepe 排版渲染的实时预览；
 * 底部「使用模板」（追加，空白笔记即直接成为正文）/ 插入到光标处 / 替换全文（二次确认）。
 * 个人模板在同一对话框内用真实编辑器编辑——不暴露 Markdown 源码。
 *
 * 并发保护：打开时捕获文档基线与插入点；应用走 applyPreviewedNoteTemplate，
 * 基线之后笔记有任何变化（含 Agent 写入）都会失败关闭并重新捕获，绝不覆盖新内容。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NoteBlank, Plus, PencilSimple, Trash, FloppyDisk } from '@phosphor-icons/react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/shad/Dialog';
import { CrepeEditor, type CrepeEditorApi } from '@/components/crepe';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  applyPreviewedNoteTemplate, fillUnsetTemplateLearningProps, getNoteTemplates, renderNoteTemplate,
  type NoteTemplate, type NoteTemplateApplyMode, type NoteTemplateDocument, type NoteTemplateDocumentHost, type NoteTemplateLearningPropsHost,
} from '../noteTemplates';
import {
  deletePersonalNoteTemplate, loadPersonalNoteTemplates, savePersonalNoteTemplate, PERSONAL_NOTE_TEMPLATES_CHANGED,
  type PersonalNoteTemplate,
} from '../personalNoteTemplates';
import { LEARNING_PROP_KEYS, MASTERY_STATES, type LearningField, type NoteLearningProps } from '../noteLearningProps';
import '../styles/notes-form-controls.css';
import './NotesTemplatePanel.css';

export interface NotesTemplatePanelProps {
  /** 打开状态（父组件受控） */
  open: boolean;
  /** Esc / 关闭 / 应用模板后请求收起 */
  onRequestClose: () => void;
  /** 无 documentHost 时的回退：父组件负责渲染变量并追加到正文 */
  onApplyTemplate: (template: NoteTemplate) => void | Promise<void>;
  /** 完整文档宿主：启用预览基线、插入到光标处与替换全文 */
  documentHost?: NoteTemplateDocumentHost;
  learningPropsHost?: NoteTemplateLearningPropsHost;
  /** 只读 / 编辑器未就绪 */
  disabled?: boolean;
  /** aria-controls 关联 id（由触发按钮持有） */
  panelId: string;
  /** 关闭后焦点归还目标（模板触发按钮） */
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

type Selection = { kind: 'builtin' | 'personal'; id: string } | null;
interface Draft {
  id?: PersonalNoteTemplate['id'];
  expectedRevision?: number;
  title: string;
  markdown: string;
  defaultForCourse: string;
  learningPreset: NoteLearningProps;
}

const VARIABLES = ['{{title}}', '{{date}}', '{{time}}'];

export const NotesTemplatePanel: React.FC<NotesTemplatePanelProps> = ({
  open, onRequestClose, onApplyTemplate, disabled = false, panelId, triggerRef, documentHost, learningPropsHost,
}) => {
  const { t, i18n } = useTranslation(['notes']);
  const builtins = getNoteTemplates(i18n?.resolvedLanguage ?? i18n?.language ?? 'en-US');
  const [personal, setPersonal] = useState<PersonalNoteTemplate[]>([]);
  const [loadingPersonal, setLoadingPersonal] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState<'replace' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [baseline, setBaseline] = useState<NoteTemplateDocument>();
  const [position, setPosition] = useState<{ from: number; to: number }>();
  const draftEditorRef = useRef<CrepeEditorApi | null>(null);
  // 预览编辑器常驻复用：切换模板只 setMarkdown，不重建 Crepe（重建一次需完整初始化全部插件）
  const previewApiRef = useRef<CrepeEditorApi | null>(null);
  const navRef = useRef<HTMLDivElement | null>(null);

  const capture = useCallback(() => {
    try {
      setBaseline(documentHost?.getDocument());
      setPosition(documentHost?.getInsertionPoint?.());
    } catch { setBaseline(undefined); setPosition(undefined); }
  }, [documentHost]);

  // 打开时：捕获基线（对话框抢焦点前），默认选中第一个内置模板
  useEffect(() => {
    if (!open) return;
    capture();
    setSelection((current) => current ?? (builtins[0] ? { kind: 'builtin', id: builtins[0].id } : null));
    setDraft(null); setConfirm(null); setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在每次打开时初始化
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    const load = async () => {
      setLoadingPersonal(true);
      try {
        const stored = await loadPersonalNoteTemplates();
        if (!cancelled) setPersonal(stored);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally { if (!cancelled) setLoadingPersonal(false); }
    };
    void load();
    window.addEventListener(PERSONAL_NOTE_TEMPLATES_CHANGED, load);
    return () => { cancelled = true; window.removeEventListener(PERSONAL_NOTE_TEMPLATES_CHANGED, load); };
  }, [open]);

  const selected: NoteTemplate | PersonalNoteTemplate | undefined = useMemo(() => {
    if (!selection) return undefined;
    return selection.kind === 'builtin'
      ? builtins.find((item) => item.id === selection.id)
      : personal.find((item) => item.id === selection.id);
  }, [builtins, personal, selection]);
  const selectedPersonal = selection?.kind === 'personal' ? selected as PersonalNoteTemplate | undefined : undefined;
  const templateTitle = (template: NoteTemplate) => template.id.startsWith('personal:')
    ? template.title : t(`notes:templates.${template.id}`, template.title);
  const templateSummary = (template: NoteTemplate) => template.id.startsWith('personal:')
    ? template.summary : t(`notes:templates.${template.id}_summary`, template.summary);
  const rendered = selected ? renderNoteTemplate(selected.markdown, documentHost?.variables) : '';
  const docLength = baseline?.markdown.trim().length ?? 0;
  useEffect(() => {
    const api = previewApiRef.current;
    if (api && api.getMarkdown() !== rendered) api.setMarkdown(rendered);
  }, [rendered]);

  const close = useCallback(() => {
    onRequestClose();
    window.setTimeout(() => triggerRef?.current?.focus(), 0);
  }, [onRequestClose, triggerRef]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      capture(); // 笔记已变化：刷新基线，用户确认后可直接重试
    } finally { setBusy(false); }
  };

  const apply = (mode: NoteTemplateApplyMode) => selected && void run(async () => {
    if (documentHost && baseline) {
      await applyPreviewedNoteTemplate(documentHost, baseline, rendered, mode, position);
      // 模板属性：只填入笔记尚未设置的学习属性（与 Notion 应用模板属性一致）
      if (selected.learningPreset && Object.keys(selected.learningPreset).length > 0 && learningPropsHost) {
        const propsBaseline = learningPropsHost.getProps();
        await learningPropsHost.saveProps(fillUnsetTemplateLearningProps(propsBaseline.props, selected.learningPreset), propsBaseline);
      }
    } else {
      await onApplyTemplate(selected);
    }
    showGlobalNotification('success', t('notes:templateGallery.applied', { defaultValue: '已应用模板「{{title}}」', title: templateTitle(selected) }));
    close();
  });

  const startEdit = (next: Draft) => { setDraft(next); setConfirm(null); setError(''); };
  const saveDraft = () => draft && void run(async () => {
    const markdown = draftEditorRef.current?.getMarkdown() ?? draft.markdown;
    const saved = await savePersonalNoteTemplate({
      id: draft.id, expectedRevision: draft.expectedRevision, title: draft.title, markdown,
      defaultForCourse: draft.defaultForCourse, learningPreset: draft.learningPreset,
    });
    setPersonal((current) => [...current.filter((item) => item.id !== saved.id), saved]);
    setSelection({ kind: 'personal', id: saved.id });
    setDraft(null);
    showGlobalNotification('success', t('notes:personalTemplates.saved'));
  });
  const removeSelected = () => selectedPersonal && void run(async () => {
    await deletePersonalNoteTemplate(selectedPersonal.id, selectedPersonal.revision ?? 0);
    setPersonal((current) => current.filter((item) => item.id !== selectedPersonal.id));
    setSelection(builtins[0] ? { kind: 'builtin', id: builtins[0].id } : null);
    setConfirm(null);
  });

  // ↑/↓ 在左栏条目间移动焦点并同步选中
  const onNavKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(navRef.current?.querySelectorAll<HTMLButtonElement>('[data-template-item]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = items[Math.min(Math.max(index + (event.key === 'ArrowDown' ? 1 : -1), 0), items.length - 1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.click();
  };

  const item = (template: NoteTemplate, kind: 'builtin' | 'personal') => {
    const active = selection?.kind === kind && selection.id === template.id && !draft;
    const course = kind === 'personal' ? (template as PersonalNoteTemplate).defaultForCourse : undefined;
    return (
      <button key={template.id} type="button" data-template-item className="notes-tpl-item" aria-pressed={active}
        onClick={() => { setSelection({ kind, id: template.id }); setDraft(null); setConfirm(null); setError(''); }}>
        <NoteBlank size={15} aria-hidden="true" className="notes-tpl-item-icon" />
        <span className="notes-tpl-item-title">{templateTitle(template)}</span>
        {course && <span className="notes-tpl-item-badge">{t('notes:templateGallery.course_default', { defaultValue: '{{course}} 默认', course })}</span>}
      </button>
    );
  };

  const presetEntries = Object.entries(selected?.learningPreset ?? {}) as Array<[LearningField, string]>;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent id={panelId} className="notes-tpl-dialog" aria-labelledby={`${panelId}-title`}>
        <div className="notes-tpl-layout">
          <nav className="notes-tpl-nav" ref={navRef} onKeyDown={onNavKeyDown} aria-label={t('notes:templateGallery.title', { defaultValue: '模板' })}>
            <DialogTitle id={`${panelId}-title`} className="notes-tpl-heading">{t('notes:templateGallery.title', { defaultValue: '模板' })}</DialogTitle>
            <p className="notes-tpl-group-label">{t('notes:templateGallery.builtin', { defaultValue: '内置模板' })}</p>
            {builtins.map((template) => item(template, 'builtin'))}
            <p className="notes-tpl-group-label">{t('notes:templateGallery.mine', { defaultValue: '我的模板' })}</p>
            {loadingPersonal && personal.length === 0
              ? <p className="notes-tpl-muted" role="status">{t('notes:personalTemplates.loading')}</p>
              : personal.length === 0 && <p className="notes-tpl-muted">{t('notes:templateGallery.empty_mine', { defaultValue: '还没有自己的模板' })}</p>}
            {personal.map((template) => item(template, 'personal'))}
            <div className="notes-tpl-nav-actions">
              <button type="button" className="notes-tpl-nav-action" disabled={busy}
                onClick={() => startEdit({ title: '', markdown: '', defaultForCourse: '', learningPreset: {} })}>
                <Plus size={13} aria-hidden="true" />{t('notes:templateGallery.new', { defaultValue: '新建模板' })}
              </button>
              {documentHost && <button type="button" className="notes-tpl-nav-action" disabled={busy || !baseline?.markdown.trim()}
                onClick={() => startEdit({ title: documentHost.variables?.title ?? '', markdown: baseline?.markdown ?? '', defaultForCourse: '', learningPreset: {} })}>
                <FloppyDisk size={13} aria-hidden="true" />{t('notes:templateGallery.save_current', { defaultValue: '将当前笔记存为模板' })}
              </button>}
            </div>
          </nav>

          <section className="notes-tpl-main">
            {draft ? (
              <>
                <div className="notes-tpl-main-head">
                  <input className="notes-tpl-title-input" value={draft.title} maxLength={120} autoFocus={!draft.id}
                    aria-label={t('notes:personalTemplates.name')}
                    placeholder={t('notes:personalTemplates.untitled')}
                    onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
                </div>
                <div className="notes-tpl-preview notes-tpl-editor">
                  <CrepeEditor key={draft.id ?? 'new'} defaultValue={draft.markdown}
                    placeholder={t('notes:templateGallery.body_placeholder', { defaultValue: '像写笔记一样编写模板内容，输入 / 插入块…' })}
                    onReady={(api) => { draftEditorRef.current = api; }}
                    onDestroy={() => { draftEditorRef.current = null; }}
                    onChange={(markdown) => setDraft((current) => current ? { ...current, markdown } : current)} />
                </div>
                <p className="notes-tpl-muted notes-tpl-vars">
                  {t('notes:templateGallery.variables', { defaultValue: '可用变量（直接在内容里输入）：' })}
                  {VARIABLES.map((variable) => <code key={variable}>{variable}</code>)}
                </p>
                <details className="notes-disclosure notes-tpl-defaults">
                  <summary>{t('notes:personalTemplates.learning_defaults.title')}</summary>
                  <div className="notes-disclosure-body">
                    <label className="notes-field"><span>{t('notes:personalTemplates.learning_defaults.course')}</span>
                      <input className="notes-input" maxLength={512} value={draft.defaultForCourse}
                        onChange={(event) => setDraft({ ...draft, defaultForCourse: event.target.value })} /></label>
                    {(Object.keys(LEARNING_PROP_KEYS) as LearningField[]).map((field) => {
                      const change = (value: string) => setDraft((current) => {
                        if (!current) return current;
                        const next = { ...current.learningPreset };
                        if (value) Object.assign(next, { [field]: value }); else delete next[field];
                        return { ...current, learningPreset: next };
                      });
                      return <label key={field} className="notes-field"><span>{t(`notes:personalTemplates.learning_defaults.fields.${field}`)}</span>
                        {field === 'mastery'
                          ? <select className="notes-select" value={draft.learningPreset[field] ?? ''} onChange={(event) => change(event.target.value)}>
                            <option value="">{t('notes:personalTemplates.learning_defaults.unset')}</option>
                            {MASTERY_STATES.map((state) => <option key={state} value={state}>{t(`notes:learning.mastery.${state}`)}</option>)}
                          </select>
                          : <input className="notes-input" maxLength={512} type={field === 'reviewDate' ? 'date' : 'text'}
                            value={draft.learningPreset[field] ?? ''} onChange={(event) => change(event.target.value)} />}
                      </label>;
                    })}
                    <p className="notes-tpl-muted">{t('notes:personalTemplates.learning_defaults.hint')}</p>
                  </div>
                </details>
                <footer className="notes-tpl-footer">
                  {error && <p role="alert" className="notes-tpl-error">{error}</p>}
                  <button type="button" className="notes-btn" disabled={busy} onClick={() => { setDraft(null); setError(''); }}>
                    {t('notes:templateGallery.cancel', { defaultValue: '取消' })}</button>
                  <button type="button" className="notes-btn" data-variant="primary"
                    disabled={busy || !draft.title.trim() || !draft.markdown.trim()} onClick={saveDraft}>
                    {draft.id ? t('notes:personalTemplates.save_changes') : t('notes:personalTemplates.save')}</button>
                </footer>
              </>
            ) : selected ? (
              <>
                <div className="notes-tpl-main-head">
                  <div className="notes-tpl-main-title">
                    <h3>{templateTitle(selected)}</h3>
                    {templateSummary(selected) && <p>{templateSummary(selected)}</p>}
                  </div>
                  {selectedPersonal && <div className="notes-tpl-main-actions">
                    <button type="button" className="notes-btn" data-variant="ghost" disabled={busy}
                      onClick={() => startEdit({ id: selectedPersonal.id, expectedRevision: selectedPersonal.revision ?? 0, title: selectedPersonal.title,
                        markdown: selectedPersonal.markdown, defaultForCourse: selectedPersonal.defaultForCourse ?? '', learningPreset: selectedPersonal.learningPreset ?? {} })}>
                      <PencilSimple size={13} aria-hidden="true" />{t('notes:templateGallery.edit', { defaultValue: '编辑' })}</button>
                    <button type="button" className="notes-btn" data-variant="ghost" disabled={busy} onClick={() => setConfirm('delete')}>
                      <Trash size={13} aria-hidden="true" />{t('notes:templateGallery.delete', { defaultValue: '删除' })}</button>
                  </div>}
                </div>
                <div className="notes-tpl-preview" aria-label={t('notes:personalTemplates.preview_label')}>
                  <CrepeEditor defaultValue={rendered} readonly
                    onReady={(api) => { previewApiRef.current = api; if (api.getMarkdown() !== rendered) api.setMarkdown(rendered); }}
                    onDestroy={() => { previewApiRef.current = null; }} />
                </div>
                {presetEntries.length > 0 && <p className="notes-tpl-muted notes-tpl-presets">
                  {t('notes:templateGallery.preset_note', { defaultValue: '同时填入未设置的学习属性：' })}
                  {presetEntries.map(([field, value]) => <span key={field} className="notes-tpl-chip">
                    {t(`notes:learning.fields.${field}`)} · {field === 'mastery' ? t(`notes:learning.mastery.${value}`, { defaultValue: value }) : value}</span>)}
                </p>}
                <footer className="notes-tpl-footer">
                  {error && <p role="alert" className="notes-tpl-error">{error}</p>}
                  {confirm === 'replace' ? <>
                    <p className="notes-tpl-confirm">{t('notes:templateGallery.replace_confirm', { defaultValue: '将用此模板替换整篇笔记（当前 {{count}} 字）。', count: docLength })}</p>
                    <button type="button" className="notes-btn" disabled={busy} onClick={() => setConfirm(null)}>{t('notes:templateGallery.cancel', { defaultValue: '取消' })}</button>
                    <button type="button" className="notes-btn" data-variant="danger" disabled={busy} onClick={() => apply('replace')}>
                      {t('notes:personalTemplates.replace')}</button>
                  </> : confirm === 'delete' ? <>
                    <p className="notes-tpl-confirm">{t('notes:templateGallery.delete_confirm', { defaultValue: '删除模板「{{title}}」？', title: selected.title })}</p>
                    <button type="button" className="notes-btn" disabled={busy} onClick={() => setConfirm(null)}>{t('notes:templateGallery.cancel', { defaultValue: '取消' })}</button>
                    <button type="button" className="notes-btn" data-variant="danger" disabled={busy} onClick={removeSelected}>
                      {t('notes:templateGallery.delete', { defaultValue: '删除' })}</button>
                  </> : <>
                    {documentHost && baseline && docLength > 0 && <button type="button" className="notes-btn" data-variant="ghost"
                      disabled={disabled || busy} onClick={() => setConfirm('replace')}>{t('notes:templateGallery.replace', { defaultValue: '替换全文' })}</button>}
                    {documentHost?.insertDocument && baseline && position && docLength > 0 && <button type="button" className="notes-btn"
                      disabled={disabled || busy} onClick={() => apply('insert')}>{t('notes:personalTemplates.insert', { defaultValue: '插入当前位置' })}</button>}
                    <button type="button" className="notes-btn" data-variant="primary" disabled={disabled || busy || !rendered.trim()}
                      onClick={() => apply('append')}>
                      {docLength > 0 ? t('notes:personalTemplates.append') : t('notes:templateGallery.use', { defaultValue: '使用模板' })}</button>
                  </>}
                </footer>
              </>
            ) : (
              <p className="notes-tpl-muted">{t('notes:templateGallery.pick', { defaultValue: '从左侧选择一个模板' })}</p>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default NotesTemplatePanel;
