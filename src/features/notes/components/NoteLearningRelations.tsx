import React, { useCallback, useEffect, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import { useTranslation } from 'react-i18next';
import { getErrorMessage } from '@/utils/errorUtils';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { NOTE_RELATIONS_CHANGED, isNoteRelationUsable, noteRelationsService, type NoteRelation, type NoteRelationType, type NoteRelationsService } from '../noteRelations';
import { NoteRelationPreview } from './NoteRelationPreview';
import { NoteRelationTargetPicker } from './NoteRelationTargetPicker';
import { NoteRelationTitle } from './NoteRelationTitle';
import { ArrowClockwise, ArrowSquareOut, Cards, FilePdf, LinkBreak, LinkSimple, PencilSimple, Plus, Question, WarningCircle } from '@phosphor-icons/react';
import '../styles/notes-form-controls.css';
import './NoteLearningRelations.css';

export function NoteLearningRelations(props: { noteId: string; readOnly?: boolean; service?: NoteRelationsService }) {
  // Switching notes remounts the entire draft and invalidates all in-flight callbacks.
  return <RelationsForNote key={props.noteId} {...props} />;
}
function RelationsForNote({ noteId, readOnly, service = noteRelationsService }: { noteId: string; readOnly?: boolean; service?: NoteRelationsService }) {
  const { t } = useTranslation('notes');
  const [relations, setRelations] = useState<NoteRelation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<NoteRelationType>('source');
  const [resourceId, setResourceId] = useState('');
  const [location, setLocation] = useState('');
  const [editing, setEditing] = useState<NoteRelation>();
  const [selectedLabel, setSelectedLabel] = useState('');
  const [preview, setPreview] = useState<NoteRelation>();
  const [formOpen, setFormOpen] = useState(false);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const maintenance = useSystemStatusStore((state) => state.maintenanceMode);
  const load = useCallback(async () => {
    const ticket = ++sequence.current;
    try {
      const rows = await service.list(noteId);
      if (mounted.current && ticket === sequence.current) { setRelations(Array.isArray(rows) ? rows : []); setError(''); }
    } catch (cause) { if (mounted.current && ticket === sequence.current) setError(getErrorMessage(cause)); }
    finally { if (mounted.current && ticket === sequence.current) setLoading(false); }
  }, [noteId, service]);
  useEffect(() => {
    mounted.current = true;
    void load();
    const refresh = (event: Event) => {
      const owner = (event as CustomEvent<{ noteId: string }>).detail?.noteId;
      if (!owner || owner === noteId) void load();
    };
    window.addEventListener(NOTE_RELATIONS_CHANGED, refresh);
    window.addEventListener('focus', refresh);
    return () => { mounted.current = false; ++sequence.current; window.removeEventListener(NOTE_RELATIONS_CHANGED, refresh); window.removeEventListener('focus', refresh); };
  }, [load, noteId]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); } catch (cause) { if (mounted.current) setError(getErrorMessage(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const locked = readOnly || maintenance || busy || loading;
  const resetDraft = () => { setEditing(undefined); setResourceId(''); setLocation(''); setSelectedLabel(''); setFormOpen(false); };
  const typeLabel = (value: NoteRelationType) => t(`learning.relations.types.${value}`, { defaultValue: value === 'source' ? '来源 PDF' : value === 'card' ? '关联卡片' : '关联错题' });
  const TypeIcon = (value: NoteRelationType) => value === 'source' ? FilePdf : value === 'card' ? Cards : Question;
  const locatorLabel = type === 'source' ? t('learning.relations.page', { defaultValue: 'PDF 页码' }) : type === 'card' ? t('learning.relations.card_id', { defaultValue: '卡片 ID' }) : t('learning.relations.question_id', { defaultValue: '题目 ID' });
  const title = t('learning.relations.title', { defaultValue: '学习资源关系' });
  const showForm = !readOnly && (formOpen || Boolean(editing));
  return <section className="notes-rel" aria-label={title}>
    <div className="notes-props-header">
      <LinkSimple size={13} aria-hidden="true" />
      <h3>{title}</h3>
      {relations.length > 0 && <span className="notes-props-count">{relations.length}</span>}
      <button type="button" className="notes-rel-icon-button" disabled={busy} onClick={() => void load()}
        aria-label={t('learning.reload')} title={t('learning.reload')}>
        <ArrowClockwise size={12} aria-hidden="true" />
      </button>
    </div>
    {loading && <p role="status" className="notes-props-empty">{t('learning.loading')}</p>}
    {!loading && !relations.length && <p className="notes-props-empty">{t('learning.relations.empty', { defaultValue: '尚未关联学习资源' })}</p>}
    {relations.length > 0 && <ul className="notes-rel-list">{relations.map((relation) => {
      const usable = isNoteRelationUsable(relation);
      const Icon = TypeIcon(relation.type);
      const locator = relation.locator.type === 'whole'
        ? t('learning.relations.whole', { defaultValue: '整个资源' })
        : relation.locator.type === 'page'
          ? t('learning.relations.page_n', { defaultValue: '第 {{page}} 页', page: relation.locator.value })
          : String(relation.locator.value);
      return <li key={relation.id} className="notes-rel-row" data-invalid={!usable || undefined} data-editing={editing?.id === relation.id || undefined}>
        <span className="notes-rel-row-icon" aria-hidden="true"><Icon size={14} /></span>
        <div className="notes-rel-row-body">
          <p className="notes-rel-row-title"><NoteRelationTitle relation={relation} /></p>
          <p className="notes-rel-row-meta">{typeLabel(relation.type)} · {locator}</p>
          {!usable && <p className="notes-rel-row-warning"><WarningCircle size={11} aria-hidden="true" />{t('learning.relations.missing', { defaultValue: '资源或定位目标已失效' })}</p>}
        </div>
        <div className="notes-rel-row-actions">
          <button type="button" className="notes-rel-icon-button" disabled={busy || !usable}
            aria-label={t('learning.relations.open', { defaultValue: '打开关联资源' })} title={t('learning.relations.open', { defaultValue: '打开关联资源' })}
            onClick={() => void run(async () => {
              const status = await service.referenceStatus(relation.resource_id, relation.locator);
              if (!status.resource_exists || !status.locator_exists) { await load(); throw new Error(t('learning.relations.missing', { defaultValue: '资源或定位目标已失效' })); }
              if (mounted.current) setPreview(relation);
            })}><ArrowSquareOut size={13} aria-hidden="true" /></button>
          {!readOnly && <>
            <button type="button" className="notes-rel-icon-button" disabled={locked}
              aria-label={t('learning.relations.edit', { defaultValue: '编辑关系' })} title={t('learning.relations.edit', { defaultValue: '编辑关系' })}
              onClick={() => { setEditing(relation); setType(relation.type); setSelectedLabel(''); setResourceId(relation.resource_id); setLocation(relation.locator.type === 'whole' ? '' : String(relation.locator.value)); }}>
              <PencilSimple size={13} aria-hidden="true" /></button>
            <button type="button" className="notes-rel-icon-button" data-tone="danger" disabled={locked}
              aria-label={t('learning.relations.delete', { defaultValue: '解除关系' })} title={t('learning.relations.delete', { defaultValue: '解除关系' })}
              onClick={() => void run(async () => {
                if (!await service.delete(relation.id, relation.revision)) throw new Error(t('learning.relations.delete_failed', { defaultValue: '关系未删除，请刷新后重试。' }));
                if (mounted.current) {
                  if (editing?.id === relation.id) resetDraft();
                  await load();
                }
              })}><LinkBreak size={13} aria-hidden="true" /></button>
          </>}
        </div>
      </li>;
    })}</ul>}
    {!readOnly && !showForm && <button type="button" className="notes-props-add-button" disabled={locked} onClick={() => setFormOpen(true)}>
      <Plus size={12} aria-hidden="true" />{t('learning.relations.add', { defaultValue: '添加关联' })}
    </button>}
    {showForm && <fieldset disabled={locked} className="notes-rel-form">
      <label className="notes-field"><span>{t('learning.relations.type', { defaultValue: '关系类型' })}</span>
        <select className="notes-input notes-select" value={type} onChange={(event) => { setType(event.target.value as NoteRelationType); setLocation(''); setResourceId(''); setSelectedLabel(''); }}>
          <option value="source">{typeLabel('source')}</option><option value="card">{typeLabel('card')}</option><option value="mistake">{typeLabel('mistake')}</option>
        </select></label>
      <NoteRelationTargetPicker key={`${type}:${editing?.id ?? 'new'}`} type={type} disabled={locked} onChoose={(id, target, label) => { setResourceId(id); setLocation(target); setSelectedLabel(label); }} />
      {selectedLabel && <p className="notes-rel-selected">{selectedLabel}</p>}
      <details className="notes-disclosure"><summary>{t('learning.relations.manual', { defaultValue: '按资源 ID 关联' })}</summary>
        <label className="notes-field"><span>{t('learning.relations.resource_id', { defaultValue: '资源 ID（卡片填文档 ID）' })}</span>
          <input className="notes-input" value={resourceId} onChange={(event) => { setResourceId(event.target.value); setSelectedLabel(''); }} /></label>
      </details>
      <label className="notes-field"><span>{locatorLabel}</span>
        <input className="notes-input" type={type === 'source' ? 'number' : 'text'} min={1} step={1} value={location} onChange={(event) => setLocation(event.target.value)} /></label>
      <div className="notes-rel-form-actions">
        <button type="button" className="notes-btn" onClick={resetDraft}>
          {editing ? t('learning.relations.cancel', { defaultValue: '取消编辑关系' }) : t('learning.relations.cancel_add', { defaultValue: '取消' })}</button>
        <button type="button" className="notes-btn" data-variant="primary" disabled={!resourceId.trim() || !location.trim()} onClick={() => void run(async () => {
          if (type === 'source' && (!Number.isInteger(Number(location)) || Number(location) < 1)) throw new Error(t('learning.relations.invalid_page', { defaultValue: '请输入从 1 开始的有效页码。' }));
          await service.put({ id: editing?.id ?? `nrel_${nanoid()}`, note_id: noteId, block_id: editing?.block_id ?? null, type,
            resource_id: resourceId.trim(), locator: type === 'source' ? { type: 'page', value: Number(location) } : { type: type === 'card' ? 'card' : 'question', value: location.trim() }, expected_revision: editing?.revision ?? null });
          if (mounted.current) { resetDraft(); await load(); }
        })}>{t('learning.relations.save', { defaultValue: '保存关系' })}</button>
      </div>
    </fieldset>}
    {error && <p role="alert" className="notes-props-error">{error}</p>}
    {preview && <NoteRelationPreview key={preview.id} relation={preview} onClose={() => setPreview(undefined)} />}
  </section>;
}
