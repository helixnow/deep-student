import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { CaretLeft, CaretRight, MagnifyingGlass } from '@phosphor-icons/react';
import '../styles/notes-form-controls.css';
import './NoteLearningRelations.css';
import { dstu } from '@/dstu';
import type { AnkiLibraryListResponse } from '@/types';
import type { NoteRelationType } from '../noteRelations';

interface Choice { key: string; label: string; resourceId: string; location?: string; sourceId?: string }
/** UI chooses names; only stable resource/document IDs and locators leave the picker. */
export function NoteRelationTargetPicker({ type, disabled, onChoose }: {
  type: NoteRelationType; disabled?: boolean; onChoose: (resourceId: string, location: string, label: string) => void;
}) {
  const { t } = useTranslation('notes');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [exam, setExam] = useState<Choice>();
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true); setError(''); setChoices([]); setMore(false);
    const load = async () => {
      let rows: Choice[];
      let hasMore: boolean;
      if (type === 'card') {
        const result = await invoke<AnkiLibraryListResponse>('list_anki_library_cards', { request: { search: query, page, pageSize: 30 } });
        rows = result.items.filter((card) => card.documentId).map((card) => ({ key: card.id, resourceId: card.documentId!, location: card.id, label: card.front || card.text || card.id }));
        hasMore = page * 30 < result.total;
      } else if (exam) {
        const result = await invoke<{ questions: Array<{ id: string; content: string; question_label?: string }>; total: number }>('qbank_list_questions', {
          request: { exam_id: exam.sourceId, filters: {}, page, page_size: 30 },
        });
        rows = result.questions.map((question) => ({ key: question.id, resourceId: exam.resourceId, location: question.id, label: `${question.question_label ?? ''} ${question.content}`.trim() }));
        hasMore = page * 30 < result.total;
      } else {
        // typeFilter is the native global smart-folder route; legacy `types` on /
        // would only enumerate the root folder and miss resources in courses.
        const types = type === 'source' ? ['file', 'textbook'] as const : ['exam'] as const;
        const results = await Promise.all(types.map((typeFilter) => dstu.list('/', { typeFilter, search: query, offset: (page - 1) * 30, limit: 30 })));
        const nodes = new Map<string, import('@/dstu').DstuNode>();
        hasMore = false;
        for (const result of results) {
          if (!result.ok) throw new Error(result.error.toUserMessage());
          hasMore ||= result.value.length === 30;
          result.value.forEach((node) => nodes.set(node.id, node));
        }
        rows = [...nodes.values()].filter((node) => node.resourceId && (type !== 'source' || node.previewType === 'pdf' || node.name.toLowerCase().endsWith('.pdf')))
          .map((node) => ({ key: node.id, resourceId: node.resourceId!, sourceId: node.id, label: node.name }));
      }
      if (active) { setChoices(rows); setMore(hasMore); }
    };
    void load().catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, type, query, page, exam]);
  return <div className="notes-rel-picker">
    <button type="button" className="notes-btn notes-rel-picker-toggle" disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}>
      <MagnifyingGlass size={12} aria-hidden="true" />{t('learning.relations.choose', { defaultValue: '从资源库选择' })}</button>
    {open && <div className="notes-rel-picker-panel">
      {!exam && <input className="notes-input" autoFocus aria-label={t('learning.relations.search', { defaultValue: '查找关联资源' })}
        placeholder={t('learning.relations.search', { defaultValue: '查找关联资源' })} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />}
      {exam && <button type="button" className="notes-rel-picker-back" onClick={() => { setExam(undefined); setPage(1); }}>
        <CaretLeft size={11} aria-hidden="true" />{t('learning.relations.back', { defaultValue: '返回题目集' })}</button>}
      {loading ? <p role="status" className="notes-props-empty">{t('learning.loading')}</p> : choices.length > 0 && <ul className="notes-rel-picker-list">{choices.map((choice) => <li key={choice.key}>
        <button type="button" disabled={disabled} className="notes-rel-picker-item" title={choice.label} onClick={() => {
          if (type === 'mistake' && !exam) { setExam(choice); setPage(1); return; }
          onChoose(choice.resourceId, choice.location ?? '1', choice.label); setOpen(false);
        }}>{choice.label}</button>
      </li>)}</ul>}
      {!loading && !error && choices.length === 0 && <p className="notes-props-empty">{t('learning.relations.no_results', { defaultValue: '没有匹配的资源' })}</p>}
      {(page > 1 || more) && <div className="notes-rel-picker-pager">
        <button type="button" className="notes-rel-icon-button" disabled={disabled || loading || page === 1} onClick={() => setPage(page - 1)}
          aria-label={t('learning.relations.previous', { defaultValue: '上一页' })} title={t('learning.relations.previous', { defaultValue: '上一页' })}><CaretLeft size={12} aria-hidden="true" /></button>
        <span>{page}</span>
        <button type="button" className="notes-rel-icon-button" disabled={disabled || loading || !more} onClick={() => setPage(page + 1)}
          aria-label={t('learning.relations.next', { defaultValue: '下一页' })} title={t('learning.relations.next', { defaultValue: '下一页' })}><CaretRight size={12} aria-hidden="true" /></button>
      </div>}
      {error && <p role="alert" className="notes-props-error">{error}</p>}
    </div>}
  </div>;
}
