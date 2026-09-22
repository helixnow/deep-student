import React, { useCallback, useEffect, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import { useTranslation } from 'react-i18next';
import { getErrorMessage } from '@/utils/errorUtils';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { NOTE_RELATIONS_CHANGED, isNoteRelationUsable, noteRelationsService, type NoteRelation, type NoteRelationType, type NoteRelationsService } from '../noteRelations';
import { NoteRelationPreview } from './NoteRelationPreview';
import { NoteRelationTargetPicker } from './NoteRelationTargetPicker';
import { NoteRelationTitle } from './NoteRelationTitle';

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
  const mounted = useRef(true);
  const sequence = useRef(0);
  const maintenance = useSystemStatusStore((state) => state.maintenanceMode);
  const load = useCallback(async () => {
    const ticket = ++sequence.current;
    try {
      const rows = await service.list(noteId);
      if (mounted.current && ticket === sequence.current) { setRelations(rows); setError(''); }
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
  return <section className="my-4 space-y-3 border-t border-border pt-3 text-xs" aria-label={t('learning.relations.title', { defaultValue: '学习资源关系' })}>
    <div className="flex justify-between"><h3>{t('learning.relations.title', { defaultValue: '学习资源关系' })}</h3>
      <button type="button" disabled={busy} onClick={() => void load()}>{t('learning.reload')}</button></div>
    {loading && <p role="status">{t('learning.loading')}</p>}
    {!loading && !relations.length && <p>{t('learning.relations.empty', { defaultValue: '尚未关联学习资源' })}</p>}
    <ul className="space-y-2">{relations.map((relation) => <li key={relation.id} className="rounded border p-2">
      <p className="break-words">{t(`learning.relations.types.${relation.type}`, { defaultValue: relation.type === 'source' ? '来源 PDF' : relation.type === 'card' ? '关联卡片' : '关联错题' })} · <NoteRelationTitle relation={relation} /></p>
      <p>{relation.locator.type !== 'whole' ? relation.locator.value : t('learning.relations.whole', { defaultValue: '整个资源' })}</p>
      {!isNoteRelationUsable(relation) && <p>{t('learning.relations.missing', { defaultValue: '资源或定位目标已失效' })}</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={busy || !isNoteRelationUsable(relation)} onClick={() => void run(async () => {
          const status = await service.referenceStatus(relation.resource_id, relation.locator);
          if (!status.resource_exists || !status.locator_exists) { await load(); throw new Error(t('learning.relations.missing', { defaultValue: '资源或定位目标已失效' })); }
          if (mounted.current) setPreview(relation);
        })}>{t('learning.relations.open', { defaultValue: '打开关联资源' })}</button>
        {!readOnly && <><button type="button" disabled={locked} onClick={() => { setEditing(relation); setType(relation.type); setSelectedLabel(''); setResourceId(relation.resource_id); setLocation(relation.locator.type === 'whole' ? '' : String(relation.locator.value)); }}>
          {t('learning.relations.edit', { defaultValue: '编辑关系' })}</button>
          <button type="button" disabled={locked} onClick={() => void run(async () => {
            if (!await service.delete(relation.id, relation.revision)) throw new Error(t('learning.relations.delete_failed', { defaultValue: '关系未删除，请刷新后重试。' }));
            if (mounted.current) {
              if (editing?.id === relation.id) { setEditing(undefined); setResourceId(''); setLocation(''); setSelectedLabel(''); }
              await load();
            }
          })}>{t('learning.relations.delete', { defaultValue: '解除关系' })}</button></>}
      </div>
    </li>)}</ul>
    {!readOnly && <fieldset disabled={locked} className="space-y-2">
      <label className="block">{t('learning.relations.type', { defaultValue: '关系类型' })}<select className="block w-full border bg-background p-1" value={type} onChange={(event) => { setType(event.target.value as NoteRelationType); setLocation(''); setResourceId(''); setSelectedLabel(''); }}>
        <option value="source">{t('learning.relations.types.source', { defaultValue: '来源 PDF' })}</option><option value="card">{t('learning.relations.types.card', { defaultValue: '关联卡片' })}</option><option value="mistake">{t('learning.relations.types.mistake', { defaultValue: '关联错题' })}</option>
      </select></label>
      <NoteRelationTargetPicker key={`${type}:${editing?.id ?? 'new'}`} type={type} disabled={locked} onChoose={(id, target, label) => { setResourceId(id); setLocation(target); setSelectedLabel(label); }} />
      {selectedLabel && <p className="break-words">{selectedLabel}</p>}
      <details><summary>{t('learning.relations.manual', { defaultValue: '按资源 ID 关联' })}</summary>
      <label className="block">{t('learning.relations.resource_id', { defaultValue: '资源 ID（卡片填文档 ID）' })}<input className="block w-full border bg-background p-1" value={resourceId} onChange={(event) => { setResourceId(event.target.value); setSelectedLabel(''); }} /></label>
      </details>
      <label className="block">{type === 'source' ? t('learning.relations.page', { defaultValue: 'PDF 页码' }) : type === 'card' ? t('learning.relations.card_id', { defaultValue: '卡片 ID' }) : t('learning.relations.question_id', { defaultValue: '题目 ID' })}
        <input className="block w-full border bg-background p-1" type={type === 'source' ? 'number' : 'text'} min={1} step={1} value={location} onChange={(event) => setLocation(event.target.value)} /></label>
      <button type="button" disabled={!resourceId.trim() || !location.trim()} onClick={() => void run(async () => {
        if (type === 'source' && (!Number.isInteger(Number(location)) || Number(location) < 1)) throw new Error(t('learning.relations.invalid_page', { defaultValue: '请输入从 1 开始的有效页码。' }));
        await service.put({ id: editing?.id ?? `nrel_${nanoid()}`, note_id: noteId, block_id: editing?.block_id ?? null, type,
          resource_id: resourceId.trim(), locator: type === 'source' ? { type: 'page', value: Number(location) } : { type: type === 'card' ? 'card' : 'question', value: location.trim() }, expected_revision: editing?.revision ?? null });
        if (mounted.current) { setEditing(undefined); setResourceId(''); setLocation(''); setSelectedLabel(''); await load(); }
      })}>{t('learning.relations.save', { defaultValue: '保存关系' })}</button>
      {editing && <button type="button" onClick={() => { setEditing(undefined); setResourceId(''); setLocation(''); setSelectedLabel(''); }}>{t('learning.relations.cancel', { defaultValue: '取消编辑关系' })}</button>}
    </fieldset>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {preview && <NoteRelationPreview key={preview.id} relation={preview} onClose={() => setPreview(undefined)} />}
  </section>;
}
