import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
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
    setLoading(true); setError(''); setChoices([]);
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
  return <div className="space-y-2">
    <button type="button" disabled={disabled} onClick={() => setOpen(!open)}>{t('learning.relations.choose', { defaultValue: '从资源库选择' })}</button>
    {open && <div className="space-y-2 rounded border p-2">
      {!exam && <input className="w-full border bg-background p-1" aria-label={t('learning.relations.search', { defaultValue: '查找关联资源' })} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />}
      {exam && <button type="button" onClick={() => { setExam(undefined); setPage(1); }}>{t('learning.relations.back', { defaultValue: '返回题目集' })}</button>}
      {loading ? <p role="status">{t('learning.loading')}</p> : <ul className="max-h-48 space-y-1 overflow-auto">{choices.map((choice) => <li key={choice.key}>
        <button type="button" disabled={disabled} className="w-full truncate rounded p-1 text-left hover:bg-muted" onClick={() => {
          if (type === 'mistake' && !exam) { setExam(choice); setPage(1); return; }
          onChoose(choice.resourceId, choice.location ?? '1', choice.label); setOpen(false);
        }}>{choice.label}</button>
      </li>)}</ul>}
      {!loading && choices.length === 0 && <p>{t('learning.relations.no_results', { defaultValue: '没有匹配的资源' })}</p>}
      <div className="flex gap-3"><button type="button" disabled={disabled || loading || page === 1} onClick={() => setPage(page - 1)}>{t('learning.relations.previous', { defaultValue: '上一页' })}</button>
        <button type="button" disabled={disabled || loading || !more} onClick={() => setPage(page + 1)}>{t('learning.relations.next', { defaultValue: '下一页' })}</button></div>
      {error && <p role="alert">{error}</p>}
    </div>}
  </div>;
}
