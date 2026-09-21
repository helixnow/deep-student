import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsDialog } from '@/components/ui/DsDialog';
import { DsButton } from '@/components/ui/DsButton';
import type { DstuNode } from '@/dstu/types';
import { NotesAPI, type NoteHistoryRevision, type NoteHistorySummary } from '@/utils/notesApi';

export interface NoteHistoryPanelProps {
  noteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 通知宿主刷新列表；不要未经草稿处理直接切换当前编辑器。 */
  onRestoredCopy?: (node: DstuNode) => void;
}

const sources: Record<string, string> = {
  created: 'history.sources.created', baseline: 'history.sources.baseline', edit: 'history.sources.edit',
  metadata: 'history.sources.metadata', before_restore: 'history.sources.before_restore',
  restore_copy: 'history.sources.restore_copy', trash_restore: 'history.sources.trash_restore',
};

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}

/** Independent modal: timeline → immutable Markdown preview → restore as copy. */
export function NoteHistoryPanel({ noteId, open, onOpenChange, onRestoredCopy }: NoteHistoryPanelProps) {
  // Keyed content cancels stale note/open-session results, including close/reopen.
  return (
    <DsDialog open={open} onOpenChange={onOpenChange} maxWidth="max-w-5xl">
      {open && <HistoryContent key={noteId} noteId={noteId} onRestoredCopy={onRestoredCopy} />}
    </DsDialog>
  );
}

function HistoryContent({ noteId, onRestoredCopy }: Pick<NoteHistoryPanelProps, 'noteId' | 'onRestoredCopy'>) {
  const { t, i18n } = useTranslation('notes');
  const [items, setItems] = useState<NoteHistorySummary[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [selected, setSelected] = useState<NoteHistoryRevision | null>(null);
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [savingRetention, setSavingRetention] = useState(false);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [retentionNotice, setRetentionNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<DstuNode | null>(null);
  const active = useRef(true);
  const request = useRef(0);
  const mutationLock = useRef(false);
  const listEpoch = useRef(0);

  useEffect(() => {
    active.current = true;
    listEpoch.current++;
    let cancelled = false;
    setLoading(true); setItems([]); setCursor(null); setSelected(null);
    setReading(false); setError(null); setConfirmRelease(false); setRetentionNotice(null);
    NotesAPI.historyList(noteId, null, 30, pinnedOnly).then(page => {
      if (cancelled) return;
      setItems(page.items); setCursor(page.next_cursor);
    }).catch(e => { if (!cancelled) setError(message(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; active.current = false; request.current++; };
  }, [noteId, pinnedOnly]);

  async function loadMore() {
    if (loading || cursor === null || mutationLock.current) return;
    const epoch = listEpoch.current;
    setLoading(true); setError(null);
    try {
      const page = await NotesAPI.historyList(noteId, cursor, 30, pinnedOnly);
      if (!active.current || epoch !== listEpoch.current) return;
      setItems(previous => [...previous, ...page.items]); setCursor(page.next_cursor);
    } catch (e) { if (active.current && epoch === listEpoch.current) setError(message(e)); }
    finally { if (active.current && epoch === listEpoch.current) setLoading(false); }
  }

  async function preview(versionId: string) {
    if (mutationLock.current) return;
    const ticket = ++request.current;
    setReading(true); setSelected(null); setError(null); setCreated(null);
    setConfirmRelease(false); setRetentionNotice(null);
    try {
      const revision = await NotesAPI.historyGet(noteId, versionId);
      if (!active.current || ticket !== request.current) return;
      setSelected(revision);
      setItems(previous => previous.map(item => item.version_id === versionId ? { ...item, pinned: revision.pinned } : item));
    } catch (e) { if (active.current && ticket === request.current) setError(message(e)); }
    finally { if (active.current && ticket === request.current) setReading(false); }
  }

  async function setRetention(pinned: boolean) {
    if (!selected || mutationLock.current) return;
    mutationLock.current = true; setSavingRetention(true); setError(null); setRetentionNotice(null);
    try {
      const updated = await NotesAPI.historySetPinned(noteId, selected.version_id, pinned);
      if (!active.current) return;
      setSelected(previous => previous ? { ...previous, ...updated } : null);
      setItems(previous => {
        const rows = previous.map(item => item.version_id === updated.version_id ? updated : item);
        if (pinnedOnly && pinned && !rows.some(item => item.version_id === updated.version_id)) rows.push(updated);
        return rows.filter(item => !pinnedOnly || item.pinned);
      });
      setConfirmRelease(false);
      setRetentionNotice(pinned ? 'history.retention_saved' : 'history.retention_released');
      try {
        const page = await NotesAPI.historyList(noteId, null, 30, pinnedOnly);
        if (active.current) { setItems(page.items); setCursor(page.next_cursor); }
      } catch { if (active.current) setError(t('history.retention_refresh_failed')); }
    } catch (e) { if (active.current) setError(message(e)); }
    finally { mutationLock.current = false; if (active.current) setSavingRetention(false); }
  }

  async function restoreCopy() {
    if (!selected || mutationLock.current) return;
    mutationLock.current = true; setRestoring(true); setError(null); setRetentionNotice(null);
    try {
      const node = await NotesAPI.historyRestoreCopy(noteId, selected.version_id);
      if (!active.current) return;
      setCreated(node);
      setSelected(previous => previous ? { ...previous, pinned: true } : null);
      onRestoredCopy?.(node);
      // Restore pins both its source and the pre-restore state. Refresh retention
      // indicators without re-reading or auto-pinning any preview.
      try {
        const page = await NotesAPI.historyList(noteId, null, 30, pinnedOnly);
        if (active.current) { setItems(page.items); setCursor(page.next_cursor); }
      } catch { if (active.current) setError(t('history.refresh_failed')); }
    } catch (e) { if (active.current) setError(message(e)); }
    finally { mutationLock.current = false; if (active.current) setRestoring(false); }
  }

  return (
    <section className="flex max-h-[80vh] min-h-0 flex-col gap-3 p-5" aria-label={t('history.title')}>
      <h2 className="pr-8 text-lg font-semibold">{t('history.title')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('history.description')}
      </p>
      <div className="space-y-1 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={pinnedOnly} disabled={loading || restoring || savingRetention}
            onChange={event => setPinnedOnly(event.target.checked)} />
          {t('history.retained_only')}
        </label>
        <details className="text-xs text-muted-foreground">
          <summary>{t('history.retention_rules')}</summary>
          <p className="pt-1">{t('history.retention_help')}</p>
        </details>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {created && <p role="status" className="text-sm">{t('history.copy_created', { name: created.name })}</p>}
      {retentionNotice && <p role="status" className="text-sm">{t(retentionNotice)}</p>}
      <div className="grid min-h-0 flex-1 gap-4 overflow-auto sm:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label={t('history.timeline')} className="min-h-0 overflow-auto">
          {!loading && items.length === 0 && <p className="text-sm text-muted-foreground">{t(pinnedOnly ? (cursor === null ? 'history.no_retained' : 'history.more_retained') : 'history.empty')}</p>}
          <ul className="space-y-1">
            {items.map(item => <li key={item.version_id}>
              <button type="button" disabled={restoring || savingRetention} onClick={() => void preview(item.version_id)}
                aria-pressed={selected?.version_id === item.version_id}
                className="w-full rounded-lg p-3 text-left text-sm hover:bg-muted aria-pressed:bg-muted disabled:opacity-50">
                <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString(i18n.resolvedLanguage ?? i18n.language)}</time>
                <span className="block truncate">{item.title}</span>
                <span className="text-xs text-muted-foreground">{sources[item.source] ? t(sources[item.source]) : item.source} · {item.content_bytes} B{item.pinned ? ` · ${t('history.pinned')}` : ''}</span>
              </button>
            </li>)}
          </ul>
          {loading && <p role="status" className="p-3 text-sm">{t('history.loading')}</p>}
          {cursor !== null && <DsButton variant="ghost" disabled={loading || restoring || savingRetention} onClick={() => void loadMore()}>{t('history.load_more')}</DsButton>}
        </nav>
        <div className="min-w-0 space-y-3 overflow-auto">
          {reading ? <p role="status">{t('history.loading_version')}</p> : selected ? <>
            <h3 className="font-medium">{selected.title}</h3>
            {selected.tags.length > 0 && <p className="text-sm text-muted-foreground">{t('history.tags', { tags: selected.tags.join(t('history.tag_separator')) })}</p>}
            {selected.props && <dl className="text-sm">{Object.entries(selected.props).map(([key, value]) =>
              <div key={key} className="flex gap-2"><dt>{t('history.property_label', { key })}</dt><dd>{String(value)}</dd></div>)}</dl>}
            <pre aria-label={t('history.preview_label')} className="whitespace-pre-wrap break-words rounded-lg border p-3 font-mono text-sm">{selected.content_md || t('history.empty_content')}</pre>
            {selected.asset_refs.length > 0 && <details className="text-xs text-muted-foreground">
              <summary>{t('history.references', { count: selected.asset_refs.length })}</summary>
              <p>{t('history.references_hint')}</p>
              <ul>{selected.asset_refs.map(ref => <li key={`${ref.kind}:${ref.value}`} className="break-all">{ref.value}</li>)}</ul>
            </details>}
          </> : <p className="text-sm text-muted-foreground">{t('history.select_version')}</p>}
        </div>
      </div>
      {confirmRelease && selected && <div role="group" aria-label={t('history.release_title')} className="space-y-2 rounded-lg border p-3 text-sm">
        <p>{t('history.release_warning', { title: selected.title })}</p>
        <div className="flex justify-end gap-2">
          <DsButton variant="ghost" disabled={savingRetention} onClick={() => setConfirmRelease(false)}>{t('history.cancel_release')}</DsButton>
          <DsButton disabled={savingRetention} onClick={() => void setRetention(false)}>{t('history.confirm_release')}</DsButton>
        </div>
      </div>}
      <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
        <DsButton variant="ghost" disabled={!selected || loading || reading || restoring || savingRetention || confirmRelease}
          onClick={() => selected?.pinned ? setConfirmRelease(true) : void setRetention(true)}>
          {savingRetention ? t('history.saving_retention') : t(selected?.pinned ? 'history.release_retention' : 'history.keep_version')}
        </DsButton>
        <DsButton disabled={!selected || loading || reading || restoring || savingRetention || confirmRelease || !!created} onClick={() => void restoreCopy()}>
          {restoring ? t('history.restoring') : t('history.restore_copy')}
        </DsButton>
      </div>
    </section>
  );
}

export default NoteHistoryPanel;
