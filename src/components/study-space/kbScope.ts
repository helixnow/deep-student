/**
 * 会话知识库检索范围（学习者选定的课程 / 文件夹）。
 * 后端 chat_v2_get_rag_scope / chat_v2_set_rag_scope 持久化；检索执行器把它当硬过滤
 * （builtin_retrieval_executor::apply_session_rag_scope）。
 */
import { useEffect, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { folderApi } from '@/dstu';
import { dispatchTypedEvent } from '@/events';

export interface KbScope { folderIds: string[]; label: string | null }

const EMPTY: KbScope = { folderIds: [], label: null };
const cache = new Map<string, KbScope>();
const revisions = new Map<string, number>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export const KB_SCOPE_PICKER_EVENT = 'chat:open-kb-scope-picker';

export function getKbScopeRevision(sessionId: string): number {
  return revisions.get(sessionId) ?? 0;
}

async function labelFor(folderIds: string[]): Promise<string | null> {
  if (folderIds.length === 0) return null;
  const first = await folderApi.getFolder(folderIds[0]).catch(() => null);
  const title = first && first.ok ? first.value?.title : null;
  return folderIds.length > 1 && title ? `${title} +${folderIds.length - 1}` : title ?? null;
}

export async function loadKbScope(sessionId: string): Promise<KbScope> {
  const revision = getKbScopeRevision(sessionId);
  // 未设置范围时后端/mock 可能回 null：归一为空数组，避免 labelFor 读 .length 崩
  const raw = await invoke<string[] | null>('chat_v2_get_rag_scope', { sessionId }).catch(() => null);
  const folderIds = Array.isArray(raw) ? raw : [];
  const scope = { folderIds, label: await labelFor(folderIds) };
  if (revision !== getKbScopeRevision(sessionId)) return cache.get(sessionId) ?? EMPTY;
  cache.set(sessionId, scope);
  notify();
  return scope;
}

export async function setKbScope(sessionId: string, folderIds: string[]): Promise<void> {
  const revision = getKbScopeRevision(sessionId) + 1;
  revisions.set(sessionId, revision);
  await invoke('chat_v2_set_rag_scope', { sessionId, folderIds });
  if (revision !== getKbScopeRevision(sessionId)) return;
  cache.set(sessionId, { folderIds, label: null });
  notify();
  const label = await labelFor(folderIds);
  if (revision !== getKbScopeRevision(sessionId)) return;
  cache.set(sessionId, { folderIds, label });
  notify();
}

export function useKbScope(sessionId: string | undefined): KbScope {
  const value = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => (sessionId ? cache.get(sessionId) ?? EMPTY : EMPTY),
    () => EMPTY,
  );
  useEffect(() => {
    if (sessionId && !cache.has(sessionId)) void loadKbScope(sessionId);
  }, [sessionId]);
  return value;
}

export function requestKbScopePicker(sessionId: string): void {
  dispatchTypedEvent(KB_SCOPE_PICKER_EVENT, { sessionId });
}
