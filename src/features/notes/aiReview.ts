import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { CrepeEditorApi } from '@/components/crepe';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { registerNoteAIEditControl } from './aiEditControlRegistry';
import { assertFullDocumentBaseline, assertNoteContentSize, FullDocumentSaveError, type FullDocumentApi } from './fullDocument';
import { computeDiffLines, computeProposedContent, type AIEditState, type CanvasAIEditRequest, type CanvasAIEditResult } from './hooks/useAIEditState';
import type { AIEditCheckpoint } from './hooks/useCanvasAIEditHandler';
import {
  aiReviewSessionKey, composeAIReview, createAIReviewSession, decideAIReviewGroup,
  readAIReviewSession, storeAIReviewSession, type AIReviewDecision, type AIReviewSession,
  aiReviewError, aiReviewSessionVersion,
} from './aiReviewModel';
import {
  claimAIReviewRecovery, loadPersistedAIReview, newAIReviewPersistenceId,
  persistAIReviewSession, removePersistedAIReview, type AIReviewRecoveryOption,
} from './aiReviewPersistence';

type LocalRequest = CanvasAIEditRequest & {
  onLocalDisposition?: (result: { accepted: true } | { accepted: false; reason: string }) => void;
  onSettled?: () => void;
};
const emptyState: AIEditState = { isActive: false, request: null, originalContent: '', proposedContent: '', diffLines: [] };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const report = async (result: CanvasAIEditResult) => {
  try { await invoke('chat_v2_canvas_edit_result', { result }); }
  catch (error) { console.debug('[aiReview] result notification unavailable', error); }
};
const settle = (session: AIReviewSession) => {
  if (session.restored) return;
  try { (session.request as LocalRequest).onSettled?.(); }
  catch (error) { console.warn('[aiReview] onSettled failed', error); }
};

export function projectAIReviewCandidate(request: CanvasAIEditRequest, original: string): { content: string; error?: string } {
  // Preserve the original byte-for-byte; append must not trim the author's trailing whitespace.
  if (request.operation === 'set' || (request.operation === 'append' && !request.section)) {
    const content = request.operation === 'set' ? request.content ?? ''
      : original + (original && !original.endsWith('\n\n') ? original.endsWith('\n') ? '\n' : '\n\n' : '') + (request.content ?? '');
    try {
      if (request.operation === 'append' && !request.content) throw new Error(aiReviewError('append_empty', '追加内容为空。'));
      assertNoteContentSize(content);
      return { content };
    } catch (error) { return { content, error: message(error) }; }
  }
  const projected = computeProposedContent(request, original);
  return projected.error ? { content: request.content ?? request.replace ?? '', error: projected.error } : projected;
}

/** Host review controller. Decisions are staged until one version-checked, persisted apply. */
export function useAIReview({ noteId, editorApi, enabled = true, windowId }: {
  noteId?: string | null;
  editorApi: CrepeEditorApi | null;
  enabled?: boolean;
  windowId?: string;
}) {
  const key = aiReviewSessionKey(noteId ?? '', windowId);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const current = useRef({ key, noteId, editorApi, enabled, windowId });
  current.current = { key, noteId, editorApi, enabled, windowId };
  const mounted = useRef(true);
  const applying = useRef(new Set<string>());
  const [isApplying, setIsApplying] = useState(false);
  const [checkpoints, setCheckpoints] = useState<AIEditCheckpoint[]>([]);
  const checkpointsRef = useRef(checkpoints);
  checkpointsRef.current = checkpoints;
  type PersistenceState = { status: 'idle' | 'loading' | 'saving' | 'saved' | 'error'; error?: string; options?: AIReviewRecoveryOption[] };
  const persistenceStates = useRef(new Map<string, PersistenceState>());
  const persistenceTickets = useRef(new Map<string, number>());
  const publishPersistence = useCallback((target: string, state: PersistenceState) => {
    persistenceStates.current.set(target, state);
    if (mounted.current && current.current.key === target) refresh();
  }, []);
  const persist = useCallback(async (target: string, session: AIReviewSession) => {
    const ticket = (persistenceTickets.current.get(target) ?? 0) + 1;
    persistenceTickets.current.set(target, ticket);
    publishPersistence(target, { status: 'saving' });
    try {
      const [scope] = JSON.parse(target) as [string, string];
      if (session.resolution) await removePersistedAIReview(session);
      else await persistAIReviewSession(session, scope);
      if (persistenceTickets.current.get(target) !== ticket) return;
      if (session.resolution && readAIReviewSession(target)?.persistenceId === session.persistenceId) storeAIReviewSession(target, null);
      publishPersistence(target, { status: 'saved' });
    } catch (error) {
      if (persistenceTickets.current.get(target) !== ticket) return;
      const explanation = session.resolution
        ? aiReviewError('delete_failed', '审阅结束状态未能保存，重启后候选可能再次出现。请重试清理。')
        : aiReviewError('persist_failed', '候选或审阅决定尚未持久化，重启后可能丢失。请重试保存。');
      publishPersistence(target, { status: 'error', error: `${explanation} ${message(error)}` });
      if (mounted.current && current.current.key === target) showGlobalNotification('error', explanation);
    }
  }, [publishPersistence]);
  const update = useCallback((target: string, session: AIReviewSession | null, save = true) => {
    if (session && !session.persistenceId) session = { ...session, persistenceId: newAIReviewPersistenceId() };
    storeAIReviewSession(target, session);
    if (mounted.current && current.current.key === target) refresh();
    if (save && session) void persist(target, session);
  }, [persist]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    setIsApplying(applying.current.has(key));
    setCheckpoints((entries) => entries.filter((entry) => entry.noteId === noteId));
  }, [key, noteId]);

  // Re-open a preserved session only against the same content. Never silently rebase changes.
  useEffect(() => {
    const session = readAIReviewSession(key);
    if (!session || !editorApi) return;
    const api = editorApi as FullDocumentApi;
    try {
      const snapshot = api.getFullDocument();
      if (snapshot.markdown === session.baseline.markdown) {
        update(key, { ...session, baseline: snapshot }, false);
      } else if (session.retryBaseline?.markdown === snapshot.markdown) {
        update(key, { ...session, retryBaseline: snapshot }, false);
      } else {
        update(key, { ...session, conflict: true, error: aiReviewError('version_changed', '笔记版本已变化，候选及分组决定已保留。请复制候选内容后重新生成建议。') }, false);
      }
    } catch (error) { update(key, { ...session, error: message(error) }, false); }
    // A remounted view must not lose a pending/failed persistence status with its old hook refs.
    const retained = readAIReviewSession(key);
    if (retained) void persist(key, retained);
  }, [key, editorApi, update, persist]);

  const hydrate = useCallback(async (selectedId?: string) => {
    const owner = current.current;
    if (!owner.noteId || !owner.enabled || !owner.editorApi || readAIReviewSession(owner.key)) return;
    const version = aiReviewSessionVersion(owner.key);
    const ticket = (persistenceTickets.current.get(owner.key) ?? 0) + 1;
    persistenceTickets.current.set(owner.key, ticket);
    const stillCurrent = () => mounted.current && current.current.enabled && current.current.key === owner.key
      && current.current.editorApi === owner.editorApi && aiReviewSessionVersion(owner.key) === version
      && persistenceTickets.current.get(owner.key) === ticket;
    publishPersistence(owner.key, { status: 'loading' });
    try {
      const loaded = await loadPersistedAIReview(owner.noteId, owner.windowId, selectedId);
      if (!stillCurrent()) return; // includes a new request that arrived AND settled during this read
      if (!loaded.session) {
        const error = loaded.options.length ? aiReviewError('recovery_ambiguous', '找到多个旧窗口的审阅候选，请选择要恢复的候选。') : undefined;
        publishPersistence(owner.key, { status: error ? 'error' : 'idle', error, options: loaded.options });
        if (error) showGlobalNotification('warning', error);
        return;
      }
      const restored = loaded.session;
      const projection = projectAIReviewCandidate(restored.request, restored.baseline.markdown);
      if (projection.error) restored.error = projection.error;
      const snapshot = (owner.editorApi as FullDocumentApi).getFullDocument();
      if (snapshot.noteId !== restored.baseline.noteId) throw new Error(aiReviewError('version_changed', '笔记版本已变化，候选及分组决定已保留。请复制候选内容后重新生成建议。'));
      if (snapshot.markdown === restored.baseline.markdown) {
        restored.baseline = snapshot;
        // A failed applied draft lost on restart can be applied again against the unchanged original.
        restored.retryBaseline = undefined;
      } else if (restored.retryBaseline?.markdown === snapshot.markdown) restored.retryBaseline = snapshot;
      else {
        restored.conflict = true;
        restored.error = aiReviewError('version_changed', '笔记版本已变化，候选及分组决定已保留。请复制候选内容后重新生成建议。');
        restored.collapsed = false;
      }
      if (!claimAIReviewRecovery(restored, owner.key)) throw new Error(aiReviewError('recovery_claimed', '候选已由其他笔记窗口恢复，请刷新后重试。'));
      update(owner.key, restored, false);
      // Persist the new owning window only after accepting the hydration result.
      await persist(owner.key, restored);
    } catch (error) {
      if (!stillCurrent()) return;
      const explanation = aiReviewError('hydrate_failed', '无法读取已保存的审阅候选，原数据未改动。请重试恢复。');
      publishPersistence(owner.key, { status: 'error', error: `${explanation} ${message(error)}` });
      showGlobalNotification('error', explanation);
    }
  }, [persist, publishPersistence, update]);
  useEffect(() => { void hydrate(); }, [key, editorApi, enabled, hydrate]);
  const retryPersistence = useCallback(async () => {
    const owner = current.current;
    const session = readAIReviewSession(owner.key);
    if (session) await persist(owner.key, session);
    else await hydrate();
  }, [hydrate, persist]);

  const receive = useCallback(async (request: LocalRequest) => {
    const owner = current.current;
    if (!owner.enabled || request.noteId !== owner.noteId || (request.targetWindowId && request.targetWindowId !== owner.windowId)) return;
    const pending = readAIReviewSession(owner.key);
    if (pending) {
      request.onLocalDisposition?.({ accepted: false, reason: aiReviewError('pending_review', '已有建议等待审阅，请先完成或明确丢弃。') });
      if (pending.request.requestId !== request.requestId) {
        await report({ requestId: request.requestId, success: false, error: aiReviewError('pending_request', '已有建议等待审阅。') });
      }
      return;
    }
    try {
      const api = owner.editorApi as FullDocumentApi | null;
      if (!api) throw new Error(aiReviewError('editor_not_ready', '编辑器尚未就绪。'));
      const baseline = api.getFullDocument();
      const proposed = projectAIReviewCandidate(request, baseline.markdown);
      // The existing projector deliberately rejects oversized output before allocation.
      // Preserve the exact supplied text for copy/recovery even for a rejected projection.
      const candidate = proposed.content;
      const session = createAIReviewSession(request, baseline, candidate);
      if (proposed.error) session.error = proposed.error;
      update(owner.key, session);
      request.onLocalDisposition?.({ accepted: true });
      try { await invoke('chat_v2_canvas_edit_ack', { requestId: request.requestId }); }
      catch (error) { console.debug('[aiReview] ACK unavailable', error); }
    } catch (error) {
      request.onLocalDisposition?.({ accepted: false, reason: message(error) });
      await report({ requestId: request.requestId, success: false, error: message(error) });
    }
  }, [update]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const onRequest = (event: Event) => {
      const request = (event as CustomEvent<LocalRequest>).detail;
      if (request?.requestId) void receive(request);
    };
    window.addEventListener('canvas:ai-edit-request', onRequest);
    void listen<LocalRequest>('canvas:ai-edit-request', (event) => { void receive(event.payload); })
      .then((stop) => { if (disposed) stop(); else unlisten = stop; })
      .catch((error) => console.debug('[aiReview] listener unavailable', error));
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener('canvas:ai-edit-request', onRequest);
      // Keep candidate and decisions for reopen; closing a view is not a rejection.
    };
  }, [enabled, receive]);

  const handleAccept = useCallback(async (acceptPending = true) => {
    const owner = current.current;
    const session = readAIReviewSession(owner.key);
    const api = owner.editorApi as FullDocumentApi | null;
    if (!owner.enabled || !session || !api || applying.current.has(owner.key)) return;
    if (session.resolution) { await persist(owner.key, session); return; }
    const applicationSession: AIReviewSession = {
      ...session,
      groups: session.groups.map((group) => group.decision === 'pending'
        ? { ...group, decision: acceptPending ? 'accept' : 'reject' } : group),
    };
    const candidate = composeAIReview(applicationSession);
    applying.current.add(owner.key);
    setIsApplying(true);
    try {
      if (session.conflict) throw new Error(aiReviewError('version_changed', '笔记版本已变化，候选及分组决定已保留。请复制候选内容后重新生成建议。'));
      if (api.isReadonly()) throw new Error(aiReviewError('read_only', '阅读模式下不能修改笔记。'));
      // Projection errors (invalid regex/search/oversize) must not turn raw recovery text into a write.
      const projected = projectAIReviewCandidate(session.request, session.baseline.markdown);
      if (projected.error) throw new Error(projected.error);
      const baseline = session.retryBaseline ?? session.baseline;
      assertFullDocumentBaseline(api.getFullDocument(), baseline);
      let appliedDocument;
      if (session.retryBaseline) {
        if ((api.normalizeMarkdown?.(candidate) ?? candidate) !== baseline.markdown) throw new Error(aiReviewError('decisions_changed', '保存失败后分组决定已变化，请复制候选并重新审阅。'));
        if (!api.flushPendingSave) throw new Error(aiReviewError('save_unavailable', '笔记保存能力尚未就绪。'));
        await api.flushPendingSave();
        appliedDocument = baseline;
      } else {
        appliedDocument = await api.replaceFullDocument(candidate, baseline);
      }
      // A switch during persistence cannot report a new page's result as this session's success.
      if (current.current.key !== owner.key || current.current.editorApi !== api || !mounted.current) return;
      assertFullDocumentBaseline(api.getFullDocument(), appliedDocument);
      const appliedMarkdown = appliedDocument.markdown;
      const resolved: AIReviewSession = { ...applicationSession, resolution: 'accepted' };
      update(owner.key, resolved, false);
      settle(session);
      const checkpoint: AIEditCheckpoint = {
        id: session.request.requestId, noteId: session.baseline.noteId,
        originalContent: session.baseline.markdown, resultContent: appliedMarkdown, appliedAt: Date.now(),
        operation: session.request.operation, diffLines: computeDiffLines(session.baseline.markdown, appliedMarkdown),
      };
      setCheckpoints((entries) => [...entries.slice(-4), checkpoint]);
      if (!session.restored) await report({
        requestId: session.request.requestId, success: true, affectedCount: appliedMarkdown.length,
        beforePreview: session.baseline.markdown.slice(0, 500), afterPreview: appliedMarkdown.slice(0, 500),
        // A partial accept has no meaningful whole-request replaceCount.
      });
      await persist(owner.key, resolved);
    } catch (error) {
      let retryBaseline = session.retryBaseline;
      try {
        if (error instanceof FullDocumentSaveError) {
          assertFullDocumentBaseline(api.getFullDocument(), error.appliedDocument);
          retryBaseline = error.appliedDocument;
        }
      } catch { /* old editor: preserve candidate under its original note */ }
      update(owner.key, { ...applicationSession, error: message(error), retryBaseline });
    } finally {
      applying.current.delete(owner.key);
      if (mounted.current && current.current.key === owner.key) setIsApplying(false);
    }
  }, [update, persist]);

  const handleReject = useCallback(async () => {
    const { key: target } = current.current;
    const session = readAIReviewSession(target);
    if (!session || applying.current.has(target)) return;
    const resolved: AIReviewSession = session.resolution ? session : { ...session, resolution: 'discarded' };
    update(target, resolved, false);
    if (!session.resolution) {
      settle(session);
      if (!session.restored) await report({ requestId: session.request.requestId, success: false, error: aiReviewError('discarded', '用户明确丢弃建议。') });
    }
    await persist(target, resolved);
  }, [update, persist]);
  const setCollapsed = useCallback((collapsed: boolean) => {
    const { key: target } = current.current;
    const session = readAIReviewSession(target);
    if (session && session.collapsed !== collapsed && !session.resolution) update(target, { ...session, collapsed });
  }, [update]);
  const decideGroup = useCallback((id: number, decision: AIReviewDecision) => {
    const { key: target } = current.current;
    const session = readAIReviewSession(target);
    if (session && !session.retryBaseline && !session.resolution && !applying.current.has(target)) {
      const next = decideAIReviewGroup(session, id, decision);
      if (next !== session) update(target, next);
    }
  }, [update]);
  const copyCandidate = useCallback(async () => {
    const { key: target } = current.current;
    const session = readAIReviewSession(target);
    if (session && !await copyTextToClipboard(session.candidate)) {
      if (readAIReviewSession(target) === session) update(target, { ...session, error: aiReviewError('copy_failed', '复制失败，请重试。候选内容仍已保留。') }, false);
    }
  }, [update]);

  const rollbackCheckpoint = useCallback(async () => {
    const owner = current.current;
    const top = checkpointsRef.current.at(-1);
    const api = owner.editorApi as FullDocumentApi | null;
    if (!api || !top || top.noteId !== owner.noteId || applying.current.has(owner.key)) return;
    applying.current.add(owner.key);
    setIsApplying(true);
    try {
      const baseline = api.getFullDocument();
      if (baseline.markdown !== top.resultContent) throw new Error(aiReviewError('checkpoint_changed', '检查点之后正文已改变。'));
      await api.replaceFullDocument(top.originalContent, baseline);
      if (current.current.key === owner.key && mounted.current) {
        checkpointsRef.current = checkpointsRef.current.filter((entry) => entry !== top);
        setCheckpoints(checkpointsRef.current);
      }
    } catch {
      if (current.current.key === owner.key && mounted.current) setCheckpoints((entries) => entries.map((entry) => entry === top ? { ...entry, stale: true } : entry));
    } finally {
      applying.current.delete(owner.key);
      if (current.current.key === owner.key && mounted.current) setIsApplying(false);
    }
  }, []);
  const dismissCheckpoint = useCallback(() => setCheckpoints([]), []);
  useEffect(() => {
    if (!noteId || !enabled) return;
    return registerNoteAIEditControl(noteId, {
      hasPendingSuggestion: () => readAIReviewSession(key) !== null,
      rejectPendingSuggestion: handleReject,
      rollbackLatestCheckpoint: async () => {
        const top = checkpointsRef.current.at(-1);
        if (!top || top.stale) return false;
        await rollbackCheckpoint();
        return !checkpointsRef.current.includes(top);
      },
    });
  }, [noteId, enabled, key, handleReject, rollbackCheckpoint]);

  const storedSession = readAIReviewSession(key);
  const persistence = persistenceStates.current.get(key) ?? { status: 'idle' as const };
  // Existing AIDiffPanel already renders session.error; expose failures without a host edit.
  const session = storedSession && persistence.error
    ? { ...storedSession, error: [storedSession.error, persistence.error].filter(Boolean).join('\n') }
    : storedSession;
  const aiEditState: AIEditState = useMemo(() => session ? {
    isActive: true, request: session.request, originalContent: session.baseline.markdown,
    proposedContent: session.candidate, diffLines: computeDiffLines(session.baseline.markdown, session.candidate),
  } : emptyState, [session?.request, session?.baseline.markdown, session?.candidate]);
  return {
    session, aiEditState, handleAccept, handleReject, isApplying,
    setCollapsed, decideGroup, copyCandidate,
    checkpoints, checkpoint: checkpoints.at(-1) ?? null, rollbackCheckpoint, dismissCheckpoint,
    persistenceStatus: persistence.status, persistenceError: persistence.error,
    recoveryOptions: persistence.options ?? [], retryPersistence, restoreCandidate: hydrate,
  };
}
