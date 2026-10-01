import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsDialog } from '../../ui/DsDialog';
import { DsButton } from '../../ui/DsButton';
import type { BlockTransferNote, BlockTransferReceipt, BlockTransferService } from './service';

export interface BlockTransferDialogProps {
  sourceNoteId: string;
  blockIds: readonly string[];
  service: BlockTransferService;
  onClose(): void;
}

export function BlockTransferDialog({ sourceNoteId, blockIds, service, onClose }: BlockTransferDialogProps) {
  const { t } = useTranslation('notes');
  const [notes, setNotes] = useState<BlockTransferNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [targetId, setTargetId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<BlockTransferReceipt | null>(null);
  const [undone, setUndone] = useState(false);
  const inFlight = useRef(false);
  // Retain operation ID across transport retries so the backend log can deduplicate.
  const operation = useRef({ targetId: '', id: crypto.randomUUID() });
  useEffect(() => {
    let active = true;
    service.listTargets(sourceNoteId).then(result => { if (active) setNotes(result); })
      .catch(reason => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sourceNoteId, service]);
  const run = async (undo = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError('');
    try {
      if (undo && receipt) {
        const result = await service.undo(receipt);
        setReceipt(result); setUndone(true);
      } else {
        if (operation.current.targetId !== targetId) operation.current = { targetId, id: crypto.randomUUID() };
        const result = await service.move(sourceNoteId, targetId, blockIds, operation.current.id);
        setReceipt(result); setUndone(result.result.undone);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const filtered = notes.filter(note => `${note.title} ${note.path}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <DsDialog open onOpenChange={open => { if (!open && !inFlight.current) onClose(); }} showClose={!busy} closeOnOverlay={!busy}>
    <div className="space-y-4 p-5" aria-busy={busy}>
      <h2 className="text-lg font-semibold">{t('blockTransfer.title', { defaultValue: '移动块到其他笔记' })}</h2>
      {receipt ? <>
        <p role="status">{undone
          ? t('blockTransfer.undone', { defaultValue: '已撤销移动' })
          : t('blockTransfer.done', { defaultValue: '块已移动，原有块 ID 已保留' })}</p>
        {receipt.refreshError != null && <p role="alert">{t('blockTransfer.refreshFailed', { defaultValue: '保存已完成，但页面刷新失败。请重新打开两篇笔记。' })}</p>}
      </> : <>
        <p className="text-sm text-muted-foreground">{t('blockTransfer.description', { defaultValue: '将所选块追加到目标笔记末尾。移动前会保存两篇笔记的开放草稿。' })}</p>
        <input autoFocus value={query} onChange={event => setQuery(event.target.value)} disabled={busy}
          aria-label={t('blockTransfer.search', { defaultValue: '搜索笔记或路径' })}
          placeholder={t('blockTransfer.search', { defaultValue: '搜索笔记或路径' })}
          className="w-full rounded border bg-background p-2" />
        <div role="radiogroup" aria-label={t('blockTransfer.target', { defaultValue: '目标笔记' })} className="max-h-64 space-y-1 overflow-auto">
          {filtered.map(note => <label key={note.id} className="flex cursor-pointer items-start gap-2 rounded border p-2">
            <input type="radio" name="block-transfer-target" value={note.id} checked={targetId === note.id}
              disabled={busy} onChange={() => setTargetId(note.id)} />
            <span className="min-w-0"><span className="block truncate">{note.title}</span>
              <span className="block break-all text-xs text-muted-foreground">{note.path || '/'} · {note.id}</span></span>
          </label>)}
          {loading ? <p role="status">{t('blockTransfer.loading', { defaultValue: '正在加载笔记…' })}</p>
            : !filtered.length && <p>{t('blockTransfer.empty', { defaultValue: '没有匹配的目标笔记' })}</p>}
        </div>
      </>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <DsButton variant="ghost" disabled={busy} onClick={onClose}>{t('blockTransfer.close', { defaultValue: '关闭' })}</DsButton>
        {receipt ? !undone && <DsButton disabled={busy} onClick={() => void run(true)}>{t('blockTransfer.undo', { defaultValue: '撤销移动' })}</DsButton>
          : <DsButton disabled={busy || !targetId || loading} onClick={() => void run()}>{t('blockTransfer.move', { defaultValue: '移动' })}</DsButton>}
      </div>
    </div>
  </DsDialog>;
}
