import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { ChatCircleText, NotePencil } from '@phosphor-icons/react';
import { dstu } from '@/dstu';
import { CustomScrollArea } from '@/components/custom-scroll-area';

interface RelatedNote { noteId: string; title: string; updatedAt: string; via: 'origin' | 'relation' | string }
interface RelatedSession { sessionId: string; title?: string | null; messageId: string; lastReferencedAt: number }

/**
 * 资料侧反查：引用这份资料的笔记 + 讨论过它的对话。
 * 学习者从资料出发能找回自己围绕它产生的一切（摘录、笔记、问答），而不是只能单向「去」。
 */
const PdfRelatedPanel: React.FC<{ sourceId: string }> = ({ sourceId }) => {
  const { t } = useTranslation('pdf');
  const [notes, setNotes] = useState<RelatedNote[] | null>(null);
  const [sessions, setSessions] = useState<RelatedSession[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setNotes(null); setSessions(null);
    void (async () => {
      // 学习关系用 VFS 资源 id，来源/对话引用用 DSTU id：两者都查
      const node = await dstu.get(`/${sourceId}`).catch(() => null);
      const ids = [sourceId, node && node.ok ? node.value?.resourceId : undefined].filter((id): id is string => Boolean(id));
      const [noteRows, sessionRows] = await Promise.all([
        invoke<RelatedNote[]>('notes_list_referencing_resource', { resourceIds: ids }).catch(() => []),
        invoke<RelatedSession[]>('chat_v2_list_sessions_referencing', { sourceIds: ids, limit: 20 }).catch(() => []),
      ]);
      if (cancelled) return;
      setNotes(noteRows); setSessions(sessionRows);
    })();
    return () => { cancelled = true; };
  }, [sourceId]);

  const openNote = (noteId: string) => {
    window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', { detail: { noteId, source: 'pdf-related' } }));
  };
  const openSession = (session: RelatedSession) => {
    void import('@/features/notes/noteOrigin').then(({ navigateToNoteOrigin }) =>
      navigateToNoteOrigin({ kind: 'chat', sessionId: session.sessionId, messageId: session.messageId }));
  };
  const fmt = (ms: number) => new Date(ms).toLocaleDateString();

  return (
    <CustomScrollArea className="ds-pdf-related" viewportClassName="ds-pdf-related-viewport">
      <section className="ds-pdf-related-section">
        <h4>{t('related.notes', { defaultValue: '相关笔记' })}</h4>
        {notes === null ? <p className="ds-pdf-related-empty">{t('related.loading', { defaultValue: '正在查找…' })}</p>
          : notes.length === 0 ? <p className="ds-pdf-related-empty">{t('related.noNotes', { defaultValue: '还没有笔记引用这份资料。划词「保存为笔记」或在笔记属性里关联它。' })}</p>
            : notes.map((note) => (
              <button
                key={note.noteId}
                type="button"
                className={`ds-pdf-related-item border-l-2 ${note.via === 'origin' ? 'border-l-primary/70' : 'border-l-info/70'} hover:bg-foreground/[0.035] transition-colors`}
                onClick={() => openNote(note.noteId)}
              >
                <NotePencil size={14} aria-hidden="true" />
                <span className="ds-pdf-related-title">{note.title}</span>
                <span className="ds-pdf-related-meta inline-flex items-center gap-1">
                  <span className={`h-1.5 w-1.5 rounded-full ${note.via === 'origin' ? 'bg-primary' : 'bg-info'}`} aria-hidden="true" />
                  {note.via === 'origin' ? t('related.viaOrigin', { defaultValue: '摘录' }) : t('related.viaRelation', { defaultValue: '关联' })}
                </span>
              </button>
            ))}
      </section>
      <div className="h-px bg-border/35 mx-1.5" aria-hidden="true" />
      <section className="ds-pdf-related-section">
        <h4>{t('related.sessions', { defaultValue: '相关对话' })}</h4>
        {sessions === null ? <p className="ds-pdf-related-empty">{t('related.loading', { defaultValue: '正在查找…' })}</p>
          : sessions.length === 0 ? <p className="ds-pdf-related-empty">{t('related.noSessions', { defaultValue: '还没有对话讨论过这份资料。' })}</p>
            : sessions.map((session) => (
              <button
                key={session.sessionId}
                type="button"
                className="ds-pdf-related-item border-l-2 border-l-primary/50 hover:bg-foreground/[0.035] transition-colors"
                onClick={() => openSession(session)}
              >
                <ChatCircleText size={14} aria-hidden="true" />
                <span className="ds-pdf-related-title">{session.title || t('related.untitledSession', { defaultValue: '未命名对话' })}</span>
                <span className="ds-pdf-related-meta font-mono tabular-nums">{fmt(session.lastReferencedAt)}</span>
              </button>
            ))}
      </section>
    </CustomScrollArea>
  );
};

export default PdfRelatedPanel;
