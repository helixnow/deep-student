import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dstu, updatedAtToVersionToken, type DstuNode } from '@/dstu';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { NoteCustomPropsEditor } from '@/features/workbench/apps/notes/NoteCustomPropsEditor';
import '@/features/workbench/apps/notes/NoteCustomPropsEditor.css';
import { learningPropsFromMetadata } from '../noteLearningProps';
import { mergeNotePropEdits } from '../notePropEdits';

/** Independent metadata baseline: never advance the owning editor's content OCC token. Key by note ID/path. */
export function NoteLearningPropertiesSection({ node, readOnly = false }: { node: DstuNode; readOnly?: boolean }) {
  const { t } = useTranslation('notes');
  const [liveNode, setLiveNode] = useState<DstuNode | null>(null);
  const [loadError, setLoadError] = useState('');
  const latestRef = useRef<DstuNode | null>(null);
  const mountedRef = useRef(true);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const identityRef = useRef({ id: node.id, path: node.path });
  identityRef.current = { id: node.id, path: node.path };
  const isCurrent = useCallback(() => mountedRef.current
    && identityRef.current.id === node.id && identityRef.current.path === node.path, [node.id, node.path]);
  const accept = useCallback((fresh: DstuNode) => {
    if (!isCurrent() || fresh.id !== node.id || fresh.type !== 'note') return;
    if (latestRef.current && latestRef.current.updatedAt > fresh.updatedAt) return;
    latestRef.current = fresh;
    setLiveNode(fresh);
  }, [isCurrent, node.id]);
  const refresh = useCallback(async () => {
    const result = await dstu.get(node.path);
    if (!isCurrent()) throw new Error(t('learning.errors.note_switched'));
    if (!result.ok) throw new Error(result.error.toUserMessage());
    if (result.value.id !== node.id || result.value.type !== 'note') throw new Error(t('learning.errors.identity_changed'));
    accept(result.value);
    return result.value;
  }, [accept, isCurrent, node.id, node.path, t]);
  const load = useCallback(async () => {
    try { await refresh(); if (isCurrent()) setLoadError(''); }
    catch (cause) { if (isCurrent()) setLoadError(cause instanceof Error ? cause.message : String(cause)); }
  }, [isCurrent, refresh]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const stop = dstu.watch('*', (event) => {
      if (event.type === 'updated' && event.node?.id === node.id) accept(event.node);
    });
    return () => { mountedRef.current = false; stop(); };
  }, [accept, load, node.id]);

  const save = useCallback(async (edited: Record<string, unknown>) => {
    if (readOnly || !liveNode || !isCurrent()) throw new Error(t('learning.errors.not_editable'));
    if (useSystemStatusStore.getState().maintenanceMode) throw new Error(t('learning.errors.maintenance'));
    // Capture the displayed baseline before I/O; refresh may deliver a newer object.
    const baseline = learningPropsFromMetadata(liveNode.metadata);
    const fresh = await refresh();
    if (!isCurrent() || readOnlyRef.current) throw new Error(t('learning.errors.save_cancelled'));
    if (fresh.updatedAt < (latestRef.current?.updatedAt ?? 0)) throw new Error(t('learning.errors.stale_version'));
    const version = updatedAtToVersionToken(fresh.updatedAt);
    if (!version) throw new Error(t('learning.errors.version_unavailable'));
    const props = mergeNotePropEdits(baseline, edited, learningPropsFromMetadata(fresh.metadata));
    const result = await dstu.setMetadata(fresh.path, { props }, version);
    if (!isCurrent()) return; // A completed write belongs to the original note only.
    if (!result.ok) {
      await load(); // Refresh the baseline, while the editor keeps its failed draft.
      throw new Error(result.error.toUserMessage());
    }
    try { await refresh(); }
    catch (cause) {
      throw new Error(t('learning.errors.refresh_after_save_failed', {
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    }
  }, [isCurrent, liveNode, load, readOnly, refresh, t]);

  return <section aria-label={t('learning.section_label')}>
    {loadError && <p role="alert" className="text-xs text-destructive">{loadError}
      <button type="button" className="ml-2 underline" onClick={() => void load()}>{t('learning.reload')}</button>
    </p>}
    {!liveNode && !loadError && <p role="status" className="text-xs text-muted-foreground">{t('learning.loading')}</p>}
    {liveNode && <NoteCustomPropsEditor key={`${node.id}:${node.path}`}
      value={learningPropsFromMetadata(liveNode.metadata)} readOnly={readOnly} onChange={save} />}
  </section>;
}
