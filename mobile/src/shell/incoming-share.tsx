import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { registerBackHandler } from '@/app/navigation/androidBackCoordinator';
import { createRoot } from 'react-dom/client';
import { attachmentDstuAdapter } from '@/dstu/adapters/attachmentDstuAdapter';
import { notesDstuAdapter } from '@/dstu/adapters/notesDstuAdapter';
import type { DstuNode } from '@/dstu/types';
import { abortStagedUpload } from '@/utils/stagedUpload';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import { useVfsContextInject } from '@/features/learning-hub/hooks/useVfsContextInject';
import { opfsExists, opfsRemove } from './opfs';
import { stageIncomingFile, retryIncomingShare, listenAndroidShares, finishIncomingShare, type IncomingShare, type ShareFile } from './android-native';

async function importFile(file: ShareFile) {
  const name = file.name.split(/[\\/]/).pop() || 'attachment';
  const { uploadId, size } = await stageIncomingFile(file);
  try {
    const result = await attachmentDstuAdapter.createFromStagedUpload({ name, uploadId, size, mimeType: file.mime }, file.mime.startsWith('image/') ? 'image' : 'file');
    if (!result.ok) throw new Error(result.error.toUserMessage());
    return result.value;
  } catch (error) {
    await abortStagedUpload(uploadId);
    throw error;
  }
}

async function openChat() {
  dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'chat-v2' });
  if (sessionManager.getCurrentSessionId()) return;
  await new Promise<void>((resolve, reject) => {
    const off = sessionManager.subscribe(event => {
      if (event.type === 'current-session-changed' && event.sessionId) { clearTimeout(timer); off(); resolve(); }
    });
    const timer = setTimeout(() => { off(); reject(new Error(i18n.t('common:incomingShare.openChat'))); }, 5000);
    dispatchAppEvent(APP_EVENTS.CHAT_NEW_SESSION);
  });
}

type SavedNode = Pick<DstuNode, 'id' | 'name' | 'type'>;
type ImportProgress = { nodes: Record<string, SavedNode>; attached: string[] };

function ShareDialog({ share, onRetry, onDone }: { share: IncomingShare; onRetry: (share: IncomingShare) => void; onDone: () => void }) {
  const { t } = useTranslation('common');
  const modal = useRef<HTMLDialogElement>(null);
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { injectToChat } = useVfsContextInject();
  const progressKey = 'dstu-incoming-share:' + share.id;
  const [progress] = useState<ImportProgress>(() => {
    try {
      const saved = localStorage.getItem(progressKey);
      if (!saved) return { nodes: {}, attached: [] };
      const parsed = JSON.parse(saved) as Partial<ImportProgress>;
      return {
        nodes: parsed && typeof parsed.nodes === 'object' && parsed.nodes ? parsed.nodes : {},
        attached: Array.isArray(parsed?.attached) ? parsed.attached : [],
      };
    } catch {
      return { nodes: {}, attached: [] };
    }
  });
  function remember(key: string, { id, name, type }: SavedNode) {
    progress.nodes[key] = { id, name, type };
    localStorage.setItem(progressKey, JSON.stringify(progress));
  }
  async function complete() {
    await finishIncomingShare(share.id);
    localStorage.removeItem(progressKey);
    onDone();
  }
  async function perform(action: 'retry' | 'cancel' | 'library' | 'chat') {
    if (working.current) return;
    working.current = true;
    setBusy(true); setError('');
    try {
      if (action === 'retry') {
        onRetry(await retryIncomingShare(share.id));
        return;
      }
      if (action !== 'cancel') {
        if (action === 'chat') await openChat();
        for (const file of share.files ?? []) {
          if (!progress.nodes[file.id]) remember(file.id, await importFile(file));
        }
        if (share.text && !progress.nodes.text) {
          const note = await notesDstuAdapter.importMarkdownContent(t('incomingShare.noteName'), share.text, null, share.id);
          if (!note.ok) throw new Error(note.error.toUserMessage());
          remember('text', note.value);
        }
        if (action === 'chat') for (const node of Object.values(progress.nodes)) {
          if (progress.attached.includes(node.id)) continue;
          const result = await injectToChat({ sourceId: node.id, sourceType: node.type === 'note' ? 'note' : node.type === 'image' ? 'image' : 'file', name: node.name, openAttachmentPanel: false });
          if (!result.success) throw new Error(result.error || t('incomingShare.attachError'));
          progress.attached.push(node.id);
          localStorage.setItem(progressKey, JSON.stringify(progress));
        }
      }
      await complete();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { working.current = false; setBusy(false); }
  }
  const dismiss = useRef(() => {});
  dismiss.current = () => { void perform('cancel'); };
  useEffect(() => {
    const dialog = modal.current!;
    dialog.showModal();
    const off = registerBackHandler(() => { dismiss.current(); return true; });
    return () => { off(); dialog.close(); };
  }, []);
  const hasContent = Boolean(share.files?.length || share.text);
  return <dialog ref={modal} aria-labelledby="incoming-share-title" onCancel={event => { event.preventDefault(); dismiss.current(); }}
    className="fixed m-auto max-h-[80dvh] w-[calc(100%_-_2rem)] max-w-sm space-y-3 overflow-auto rounded-xl border bg-background p-5 text-foreground shadow-lg backdrop:bg-black/40">
    <h2 id="incoming-share-title" className="font-semibold">{t('incomingShare.title')}</h2>
    {share.files?.map(file => <p key={file.id} className="break-all">{file.name}</p>)}
    {share.text && <p className="line-clamp-3 break-all">{share.text}</p>}
    {(error || share.error || !hasContent) && <p role="alert">{error || t(share.error === 'storage' ? 'incomingShare.storageError' : 'incomingShare.unreadable')}</p>}
    <div className="flex flex-wrap justify-end gap-2 pt-1">
      {share.canRetry && (
        <button type="button" disabled={busy} onClick={() => void perform('retry')}
          className="min-h-11 rounded-lg border border-border bg-secondary px-3.5 text-sm font-medium text-secondary-foreground disabled:opacity-50">
          {t('actions.retry')}
        </button>
      )}
      {hasContent && (
        <>
          <button type="button" disabled={busy} onClick={() => void perform('library')}
            className="min-h-11 rounded-lg border border-border bg-secondary px-3.5 text-sm font-medium text-secondary-foreground disabled:opacity-50">
            {t('incomingShare.library')}
          </button>
          <button type="button" disabled={busy} onClick={() => void perform('chat')}
            className="min-h-11 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {t('incomingShare.chat')}
          </button>
        </>
      )}
      <button type="button" disabled={busy} onClick={() => void perform('cancel')}
        className="min-h-11 rounded-lg px-3.5 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50">
        {t('incomingShare.close')}
      </button>
    </div>
  </dialog>;
}

function IncomingShares() {
  const [queue, setQueue] = useState<IncomingShare[]>([]);
  useEffect(() => {
    let active = true;
    const listener = listenAndroidShares(share => {
      if (active) setQueue(items => items.some(item => item.id === share.id) ? items : [...items, share].sort((a, b) => a.receivedAt - b.receivedAt));
    });
    return () => { active = false; void listener.then(handle => handle.remove()); };
  }, []);
  const share = queue[0];
  return share ? <ShareDialog key={share.id} share={share} onRetry={updated => setQueue(items => items.map(item => item.id === updated.id ? updated : item))} onDone={() => setQueue(items => items.filter(item => item.id !== share.id))} /> : null;
}
export function mountIncomingShares() {
  // Old versions copied incoming files into this private scratch directory before uploading.
  const oldScratch = '/deep-student/tmp/shared-input';
  void opfsExists(oldScratch).then(async exists => { if (exists) await opfsRemove(oldScratch, { recursive: true }); })
    .catch(error => console.warn('Could not remove obsolete share scratch files', error));
  const container = document.body.appendChild(document.createElement('div'));
  createRoot(container).render(<IncomingShares />);
}
