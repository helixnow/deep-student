import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { dstu, type DstuNode } from '@/dstu';
import { NoteLearningViews } from './components/NoteLearningViews';
import { CreateLearningNoteDialog } from './components/CreateLearningNoteDialog';
import { learningPropsFromMetadata, readNoteLearningProps, type NoteLearningView } from './noteLearningProps';

/** Dedicated notes library. All three projections share this one DSTU list and subscription. */
export function NotesLibraryView({ onOpen, activeId }: { onOpen: (note: DstuNode) => void; activeId?: string }) {
  const { t } = useTranslation('notes');
  const [notes, setNotes] = useState<DstuNode[]>([]);
  const [view, setView] = useState<NoteLearningView>('list');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const request = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++request.current;
    try {
      const all: DstuNode[] = [];
      for (let offset = 0; ; offset += 1000) {
        const result = await dstu.list('/', { typeFilter: 'note', sortBy: 'name', sortOrder: 'asc', offset, limit: 1000 });
        if (ticket !== request.current) return;
        if (!result.ok) throw new Error(result.error.toUserMessage());
        all.push(...result.value);
        if (result.value.length < 1000) break;
      }
      setNotes(all); setError('');
    } catch (cause) { if (ticket === request.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (ticket === request.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void load();
    const stop = dstu.watch('*', () => { void load(); });
    return () => { ++request.current; stop(); };
  }, [load]);
  const search = query.trim().toLocaleLowerCase();
  const filtered = notes.filter((note) => {
    const props = readNoteLearningProps(learningPropsFromMetadata(note.metadata));
    return !search || [note.name, props.course, props.chapter].some((text) => text?.toLocaleLowerCase().includes(search));
  });
  return <section className="flex h-full min-h-0 flex-col" aria-label={t('learning.library.title', { defaultValue: '笔记学习' })}>
    <div className="space-y-2 border-b p-3 text-xs">
      <div className="flex flex-wrap gap-3"><h2>{t('learning.library.title', { defaultValue: '笔记学习' })}</h2>
        <button type="button" onClick={() => setCreating(true)}>{t('learning.create.title', { defaultValue: '新建学习笔记' })}</button>
        <button type="button" onClick={() => void load()}>{t('learning.reload')}</button></div>
      <input className="w-full rounded border bg-background p-2" aria-label={t('learning.library.search', { defaultValue: '搜索笔记、课程或章节' })} value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="flex flex-wrap gap-3" role="group" aria-label={t('learning.views_label')}>
        {(['list', 'status', 'review'] as const).map((kind) => <button type="button" key={kind} aria-pressed={view === kind} onClick={() => setView(kind)}>{t(`learning.views.${kind}`)}</button>)}
      </div>
    </div>
    {error && <p role="alert" className="p-3 text-destructive">{error}</p>}
    {loading ? <p role="status">{t('learning.loading')}</p> : <div className="min-h-0 flex-1"><NoteLearningViews notes={filtered} view={view} activeId={activeId} onOpen={onOpen} /></div>}
    {creating && createPortal(<CreateLearningNoteDialog onClose={() => setCreating(false)} onCreated={(note) => { void load(); onOpen(note); }} />, document.body)}
  </section>;
}

/** Shell entry keeps the mixed Finder separate from the notes-only view. */
export function NotesLibraryEntry({ children, onOpen, activeId }: { children: React.ReactNode; onOpen: (note: DstuNode) => void; activeId?: string }) {
  const { t } = useTranslation('notes');
  const [open, setOpen] = useState(false);
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 gap-4 border-b px-3 py-2 text-xs">
      <button type="button" aria-pressed={!open} onClick={() => setOpen(false)}>{t('learning.library.resources', { defaultValue: '学习资源' })}</button>
      <button type="button" aria-pressed={open} onClick={() => setOpen(true)}>{t('learning.library.title', { defaultValue: '笔记学习' })}</button>
    </div>
    <div className="min-h-0 flex-1">{open ? <NotesLibraryView onOpen={onOpen} activeId={activeId} /> : children}</div>
  </div>;
}
