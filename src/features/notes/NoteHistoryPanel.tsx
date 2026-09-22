import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsDialog } from '@/components/ui/DsDialog';
import { DsButton } from '@/components/ui/DsButton';
import type { DstuNode } from '@/dstu/types';
import { NotesAPI, type NoteHistoryRevision, type NoteHistorySummary } from '@/utils/notesApi';
import type { NoteHistoryCurrent, NoteHistoryRetention, NoteHistorySelection } from '@/utils/notesApi';
import { diffLines } from 'diff';
import { noteHostCoordinator } from './noteHostCoordinator';

export interface NoteHistoryPanelProps {
  noteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 通知宿主刷新列表；不要未经草稿处理直接切换当前编辑器。 */
  onRestoredCopy?: (node: DstuNode) => void;
  /** Host must settle editor drafts before a restore may write.
   * Return false to cancel; rejection is shown without writing anything. */
  beforeOverwrite?: () => Promise<boolean>;
  /** Hold all editor instances through draft settlement, commit and refresh. */
  withOverwrite?: <T>(operation: () => Promise<T>) => Promise<T>;
  onRestoredCurrent?: (node: DstuNode) => void | Promise<void>;
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
export function NoteHistoryPanel({ noteId, open, onOpenChange, ...host }: NoteHistoryPanelProps) {
  // Keyed content cancels stale note/open-session results, including close/reopen.
  return (
    <DsDialog open={open} onOpenChange={onOpenChange} maxWidth="max-w-5xl">
      {open && <HistoryContent key={noteId} noteId={noteId} {...host} />}
    </DsDialog>
  );
}

function HistoryContent({ noteId, onRestoredCopy, beforeOverwrite, withOverwrite, onRestoredCurrent }: Pick<NoteHistoryPanelProps, 'noteId' | 'onRestoredCopy' | 'beforeOverwrite' | 'withOverwrite' | 'onRestoredCurrent'>) {
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
  const [current, setCurrent] = useState<NoteHistoryCurrent | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [selection, setSelection] = useState<NoteHistorySelection | undefined>();
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [policy, setPolicy] = useState<NoteHistoryRetention | null>(null);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [restoredCurrent, setRestoredCurrent] = useState(false);
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
    setConfirmOverwrite(false); setCurrent(null); setShowDiff(false); setSelection(undefined);
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
    setConfirmOverwrite(false); setCurrent(null); setShowDiff(false); setSelection(undefined); setRestoredCurrent(false);
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
      const node = await NotesAPI.historyRestoreCopy(noteId, selected.version_id, selection);
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

  const selectedText = selected ? (selection
    ? selected.content_md.split('\n').slice(selection.start_line - 1, selection.end_line).join('\n')
    : selected.content_md) : '';
  const supported = selected?.format_version === 1 && (
    (selected.content_format === 'markdown-legacy' && ['markdown-v1', 'markdown-v1+ds-columns-v1'].includes(selected.serializer_version)) ||
    (selected.content_format === 'markdown-blocks' && ['blocks-v1', 'blocks-v1+ds-columns-v1'].includes(selected.serializer_version)));
  // Stable block selection needs a block-aware backend contract; arbitrary lines
  // may split markers. Full-document restore remains available for this format.
  const canSelectLines = selected?.content_format === 'markdown-legacy' && selected.serializer_version === 'markdown-v1' && supported;
  const busy = loading || reading || restoring || savingRetention || policyBusy;

  async function compareCurrent(overwrite = false) {
    if (!selected || mutationLock.current) return;
    const ticket = ++request.current;
    setReading(true); setError(null); setConfirmOverwrite(false);
    try {
      const stored = await NotesAPI.historyCurrent(noteId);
      if (!active.current || ticket !== request.current) return;
      setCurrent(stored); setShowDiff(true); setConfirmOverwrite(overwrite);
    } catch (e) { if (active.current && ticket === request.current) setError(message(e)); }
    finally { if (active.current && ticket === request.current) setReading(false); }
  }

  async function overwriteCurrent() {
    if (!selected || !current || !beforeOverwrite || !supported || mutationLock.current) return;
    mutationLock.current = true; setRestoring(true); setError(null);
    try {
      const overwrite = async () => {
      if (!await beforeOverwrite() || !active.current) return;
      // Keep the token from the displayed diff. If draft settlement saved a new
      // version, CAS rejects and the user must review a fresh diff.
       const node = await NotesAPI.historyRestoreCurrent(noteId, selected.version_id, current.updated_at, selection, noteHostCoordinator.getLeaseAuth(noteId));
      // A committed restore must reconcile its host even if the dialog closed
      // while IPC was running. Await refresh before the host releases its lock.
      await onRestoredCurrent?.(node);
      if (!active.current) return;
      setConfirmOverwrite(false); setRestoredCurrent(true); setCurrent(null); setShowDiff(false);
      const page = await NotesAPI.historyList(noteId, null, 30, pinnedOnly);
      if (active.current) { setItems(page.items); setCursor(page.next_cursor); }
      };
      if (withOverwrite) await withOverwrite(overwrite);
      else await overwrite();
    } catch (e) { if (active.current) { setError(message(e)); setConfirmOverwrite(false); setCurrent(null); } }
    finally { mutationLock.current = false; if (active.current) setRestoring(false); }
  }

  async function retentionPolicy(save: boolean) {
    if (mutationLock.current || (save && !policy)) return;
    mutationLock.current = true; setPolicyBusy(true); setError(null);
    try {
      const next = save ? await NotesAPI.historySetRetention(policy!) : await NotesAPI.historyGetRetention();
      if (active.current) { setPolicy(next); if (save) setRetentionNotice('history.policy_saved'); }
    } catch (e) { if (active.current) setError(message(e)); }
    finally { mutationLock.current = false; if (active.current) setPolicyBusy(false); }
  }

  return (
    <section className="flex max-h-[80vh] min-h-0 flex-col gap-3 p-5" aria-label={t('history.title')}>
      <h2 className="pr-8 text-lg font-semibold">{t('history.title')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('history.description_full', '查看完整历史与差异。默认恢复为新副本；覆盖当前笔记前会保留现有版本。预览不会自动长期保留。')}
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
        <DsButton variant="ghost" disabled={busy} onClick={() => void retentionPolicy(false)}>{t('history.configure_retention', '配置历史保留')}</DsButton>
        {policy && <div className="flex flex-wrap items-center gap-2 rounded border p-2">
          <label>{t('history.bucket_seconds', '合并间隔（秒，0 为不合并）')}
            <input aria-label={t('history.bucket_seconds', '合并间隔（秒，0 为不合并）')} type="number" min={0} max={86400} step={1} disabled={busy}
              value={policy.edit_bucket_seconds} onChange={e => setPolicy({ ...policy, edit_bucket_seconds: Number(e.target.value) })} className="ml-2 w-24 border bg-background" /></label>
          <label>{t('history.max_versions', '普通编辑版本上限（0 为不限）')}
            <input aria-label={t('history.max_versions', '普通编辑版本上限（0 为不限）')} type="number" min={0} max={100000} step={1} disabled={busy}
              value={policy.max_edit_versions ?? 0} onChange={e => setPolicy({ ...policy, max_edit_versions: Number(e.target.value) || null })} className="ml-2 w-24 border bg-background" /></label>
          <p>{t('history.policy_help', '固定版本与格式迁移基线不受此限制；修改规则不立即清理历史。')}</p>
          <DsButton disabled={busy || !Number.isInteger(policy.edit_bucket_seconds) || policy.edit_bucket_seconds < 0 || policy.edit_bucket_seconds > 86400 || (policy.max_edit_versions !== null && (!Number.isInteger(policy.max_edit_versions) || policy.max_edit_versions < 1 || policy.max_edit_versions > 100000))}
            onClick={() => void retentionPolicy(true)}>{t('history.save_policy', '保存保留规则')}</DsButton>
        </div>}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {created && <p role="status" className="text-sm">{t('history.copy_created', { name: created.name })}</p>}
      {retentionNotice && <p role="status" className="text-sm">{t(retentionNotice, retentionNotice === 'history.policy_saved' ? '保留规则已保存' : retentionNotice)}</p>}
      {restoredCurrent && <p role="status">{t('history.current_restored', '已恢复当前笔记，覆盖前版本已保留。')}</p>}
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
            {!supported && <p role="alert">{t('history.unsupported_format', '此版本格式暂不支持恢复，请使用兼容版本。')}</p>}
            {canSelectLines && <div className="flex flex-wrap gap-2 text-sm">
              <label><input type="checkbox" checked={!!selection} disabled={busy} onChange={e => { setSelection(e.target.checked ? { start_line: 1, end_line: selected.content_md.split('\n').length } : undefined); setConfirmOverwrite(false); setCreated(null); }} /> {t('history.select_lines', '只恢复选定行')}</label>
              {selection && <>
                <p className="w-full text-xs text-muted-foreground">{t('history.selection_help', '请选择完整段落、列表或代码块；不能截断文档结构。')}</p>
                <label>{t('history.start_line', '起始行')}<input aria-label={t('history.start_line', '起始行')} type="number" min={1} max={selection.end_line} value={selection.start_line} disabled={busy}
                  onChange={e => { setSelection({ ...selection, start_line: Math.max(1, Math.min(selection.end_line, Math.trunc(Number(e.target.value)))) }); setConfirmOverwrite(false); setCreated(null); }} className="ml-1 w-20 border bg-background" /></label>
                <label>{t('history.end_line', '结束行')}<input aria-label={t('history.end_line', '结束行')} type="number" min={selection.start_line} max={selected.content_md.split('\n').length} value={selection.end_line} disabled={busy}
                  onChange={e => { setSelection({ ...selection, end_line: Math.max(selection.start_line, Math.min(selected.content_md.split('\n').length, Math.trunc(Number(e.target.value)))) }); setConfirmOverwrite(false); setCreated(null); }} className="ml-1 w-20 border bg-background" /></label>
                <pre aria-label={t('history.selection_preview', '选段恢复预览')} className="w-full whitespace-pre-wrap break-words rounded border p-2">{selectedText}</pre>
              </>}
            </div>}
            <DsButton variant="ghost" disabled={busy} onClick={() => void compareCurrent()}>{t('history.compare_current', '与当前笔记比较')}</DsButton>
            {showDiff && current && <pre aria-label={t('history.diff_preview', '恢复差异预览')} className="whitespace-pre-wrap break-words rounded border p-3 text-sm">
              {diffLines(current.content_md, selectedText).map((part, index) => <span key={index} className={part.added ? 'bg-green-500/15' : part.removed ? 'bg-red-500/15 line-through' : undefined}>{part.added ? '+ ' : part.removed ? '- ' : '  '}{part.value}</span>)}
            </pre>}
            {selected.asset_refs.length > 0 && <details className="text-xs text-muted-foreground">
              <summary>{t('history.references', { count: selected.asset_refs.length })}</summary>
              <p>{t('history.references_hint')}</p>
              <ul>{selected.asset_refs.map(ref => <li key={`${ref.kind}:${ref.value}`} className="break-all">{ref.value}</li>)}</ul>
            </details>}
          </> : <p className="text-sm text-muted-foreground">{t('history.select_version')}</p>}
        </div>
      </div>
      {confirmOverwrite && current && <div role="group" aria-label={t('history.overwrite_title', '确认覆盖当前笔记')} className="space-y-2 rounded border p-3 text-sm">
        <p>{t('history.overwrite_warning', '将用上方预览内容覆盖整篇当前笔记（选段模式也替换整篇）。确认后先处理编辑草稿，并保留覆盖前的完整版本；当前内容若已变化则停止恢复。')}</p>
        <div className="flex justify-end gap-2">
          <DsButton variant="ghost" disabled={busy} onClick={() => setConfirmOverwrite(false)}>{t('history.cancel_overwrite', '取消覆盖')}</DsButton>
          <DsButton disabled={busy || !supported} onClick={() => void overwriteCurrent()}>{t('history.confirm_overwrite', '保留当前版本并覆盖')}</DsButton>
        </div>
      </div>}
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
        <DsButton variant="ghost" disabled={!selected || !supported || busy || confirmRelease || !beforeOverwrite || !onRestoredCurrent} onClick={() => void compareCurrent(true)}
          title={!beforeOverwrite ? t('history.host_required', '需要编辑器先处理未保存草稿') : undefined}>{t('history.overwrite_current', '覆盖当前笔记…')}</DsButton>
        <DsButton disabled={!selected || !supported || busy || confirmRelease || !!created} onClick={() => void restoreCopy()}>
          {restoring ? t('history.restoring') : t('history.restore_copy')}
        </DsButton>
      </div>
    </section>
  );
}

export default NoteHistoryPanel;
