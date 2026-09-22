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
  aiReviewSessionKey, createAIReviewSession,
  readAIReviewSession, storeAIReviewSession, type AIReviewDecision, type AIReviewSession,
  aiReviewError, aiReviewSessionVersion,
} from './aiReviewModel';
import {
  claimAIReviewRecovery, loadPersistedAIReview, newAIReviewPersistenceId,
  persistAIReviewSession, removePersistedAIReview, type AIReviewRecoveryOption,
} from './aiReviewPersistence';
import { scopeAIReviewCandidate, type AIReviewHost, type AIReviewRequest, type AIReviewScope, type AIReviewLanding, type OfficialReviewControls, type OfficialReviewDecision } from './officialDiffContract';

type LocalRequest = AIReviewRequest & {
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

/** Host owns the only live document. Official review commands propose version-checked writes. */
export function useAIReview({ noteId, editorApi, enabled = true, windowId, host }: {
  noteId?: string | null;
  editorApi: CrepeEditorApi | null;
  enabled?: boolean;
  windowId?: string;
  host?: AIReviewHost;
}) {
  const key = aiReviewSessionKey(noteId ?? '', windowId);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const current = useRef({ key, noteId, editorApi, enabled, windowId, host });
  current.current = { key, noteId, editorApi, enabled, windowId, host };
  const official = useRef<{ key: string; controls: OfficialReviewControls } | null>(null);
  const lease = useRef<(() => void) | null>(null);
  const releaseLease = useCallback(() => { lease.current?.(); lease.current = null; }, []);
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
      return true;
    } catch (error) {
      if (persistenceTickets.current.get(target) !== ticket) return;
      const explanation = session.resolution
        ? aiReviewError('delete_failed', '审阅结束状态未能保存，重启后候选可能再次出现。请重试清理。')
        : aiReviewError('persist_failed', '候选或审阅决定尚未持久化，重启后可能丢失。请重试保存。');
      publishPersistence(target, { status: 'error', error: `${explanation} ${message(error)}` });
      if (mounted.current && current.current.key === target) showGlobalNotification('error', explanation);
      return false;
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
    return () => { mounted.current = false; releaseLease(); official.current?.controls.suspend(); };
  }, [releaseLease]);
  useEffect(() => {
    setIsApplying(applying.current.has(key));
    setCheckpoints((entries) => (readAIReviewSession(key)?.accepted ?? entries).filter((entry) => entry.noteId === noteId));
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
      } else if (session.retryDecision?.action === 'accept' && session.request.landing !== 'save-as'
        && (api.normalizeMarkdown?.(session.retryDecision.after) ?? session.retryDecision.after) === snapshot.markdown) {
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
      const snapshot = (owner.editorApi as FullDocumentApi).getFullDocument();
      if (snapshot.noteId !== restored.baseline.noteId) throw new Error(aiReviewError('version_changed', '笔记版本已变化，候选及分组决定已保留。请复制候选内容后重新生成建议。'));
      if (snapshot.markdown === restored.baseline.markdown) {
        restored.baseline = snapshot;
        // A failed applied draft lost on restart can be applied again against the unchanged original.
        restored.retryBaseline = undefined;
      } else if (restored.retryBaseline?.markdown === snapshot.markdown) restored.retryBaseline = snapshot;
      else if (restored.retryDecision?.action === 'accept' && restored.request.landing !== 'save-as'
        && (owner.editorApi.normalizeMarkdown?.(restored.retryDecision.after) ?? restored.retryDecision.after) === snapshot.markdown) {
        restored.retryBaseline = snapshot;
      }
      else {
        restored.conflict = true;
        restored.error = aiReviewError('version_changed', '笔记版本已变化，候选及分组决定已保留。请复制候选内容后重新生成建议。');
        restored.collapsed = false;
      }
      if (!claimAIReviewRecovery(restored, owner.key)) throw new Error(aiReviewError('recovery_claimed', '候选已由其他笔记窗口恢复，请刷新后重试。'));
      update(owner.key, restored, false);
      setCheckpoints(restored.accepted.filter(entry => entry.noteId === owner.noteId));
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
      const proposed = scopeAIReviewCandidate(request, baseline, projectAIReviewCandidate);
      // The existing projector deliberately rejects oversized output before allocation.
      // Preserve the exact supplied text for copy/recovery even for a rejected projection.
      const candidate = proposed.content;
      const session = createAIReviewSession(request, baseline, candidate);
      if (proposed.error) session.error = proposed.error;
      try { assertNoteContentSize(candidate); } catch (error) { session.error = message(error); }
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

  const handleOfficialDecision = useCallback(async (decision: OfficialReviewDecision) => {
    const owner = current.current;
    const session = readAIReviewSession(owner.key);
    const api = owner.editorApi as FullDocumentApi | null;
    if (!owner.enabled || !session || !api || applying.current.has(owner.key)) throw new Error('审阅尚未就绪。');
    if (session.resolution) throw new Error('审阅已结束。');
    applying.current.add(owner.key);
    setIsApplying(true);
    let appliedDocument = session.baseline;
    let savedAs = session.savedAs;
    try {
      if (session.conflict) throw new Error(aiReviewError('version_changed', '笔记版本已变化，候选及分组决定已保留。请复制候选内容后重新生成建议。'));
      if (session.retryDecision && (session.retryDecision.after !== decision.after || session.retryDecision.target !== decision.target
        || session.retryDecision.action !== decision.action)) throw new Error('请先重试上一组的保存，再处理其他建议。');
      if (!session.retryBaseline && session.request.landing !== 'save-as' && api.normalizeMarkdown
        && api.normalizeMarkdown(decision.before) !== api.normalizeMarkdown(session.baseline.markdown)) {
        throw new Error('候选审阅结构与正文不一致，请重新打开审阅。');
      }
      const projected = scopeAIReviewCandidate(session.request, session.origin, projectAIReviewCandidate);
      if (projected.error) throw new Error(projected.error);
      const baseline = session.retryBaseline ?? session.baseline;
      assertFullDocumentBaseline(api.getFullDocument(), baseline);
      // Persist intent before the body write. A crash between the two stores is
      // recoverable by comparing the exact proposed full document on reopen.
      const intent = { ...session, retryDecision: decision };
      if (!await persist(owner.key, intent)) throw new Error('审阅状态尚未保存，请重试。');
      if (decision.action === 'accept') {
        assertNoteContentSize(decision.after);
        if (session.request.landing === 'save-as') {
          if (!owner.host?.saveAs) throw new Error('另存结果接口尚未就绪。');
          savedAs = await owner.host.saveAs(decision.after, session.persistenceId!, session.savedAs);
          // Coordinated save-as may refresh the unchanged source and advance its
          // editor revision. Accept that revision only if its full body is intact.
          const refreshed = api.getFullDocument();
          if (refreshed.noteId !== baseline.noteId || refreshed.markdown !== baseline.markdown) throw new Error('另存期间原笔记已变化。');
          appliedDocument = refreshed;
        } else if (session.retryBaseline) {
          if ((api.normalizeMarkdown?.(decision.after) ?? decision.after) !== baseline.markdown) throw new Error('保存失败后候选已变化，请重新审阅。');
          if (!api.flushPendingSave) throw new Error('笔记保存接口尚未就绪。');
          await api.flushPendingSave();
          appliedDocument = baseline;
        } else if ((api.normalizeMarkdown?.(decision.after) ?? decision.after) !== baseline.markdown) {
          appliedDocument = owner.host?.applyDocument
            ? await owner.host.applyDocument(decision.after, baseline)
            : await api.replaceFullDocument(decision.after, baseline);
        }
      }
      if (current.current.key !== owner.key || current.current.editorApi !== api || !mounted.current) throw new Error('笔记窗口已变化，审阅结果已保留供恢复。');
      assertFullDocumentBaseline(api.getFullDocument(), appliedDocument);
      const appliedMarkdown = appliedDocument.markdown;
      const checkpointBefore = session.request.landing === 'save-as' ? session.savedAs?.markdown ?? '' : session.baseline.markdown;
      const checkpointAfter = session.request.landing === 'save-as' ? savedAs?.markdown ?? '' : appliedMarkdown;
      const checkpoint: AIEditCheckpoint = {
        id: `${session.request.requestId}:${session.decisions.length}`, noteId: savedAs?.noteId ?? session.baseline.noteId,
        originalContent: checkpointBefore, resultContent: checkpointAfter, appliedAt: Date.now(),
        operation: session.request.operation, diffLines: computeDiffLines(checkpointBefore, checkpointAfter),
      };
      const accepted = decision.action === 'accept' && checkpointBefore !== checkpointAfter ? [...session.accepted, checkpoint] : session.accepted;
      const resolved: AIReviewSession = { ...session, baseline: appliedDocument, savedAs, target: decision.target,
        generation: session.retryDecision ? session.generation + 1 : session.generation,
        decisions: [...session.decisions, decision], accepted, error: undefined,
        retryBaseline: undefined, retryDecision: undefined,
        groups: [...session.groups, { id: session.decisions.length, before: decision.before, after: decision.after,
          changed: true, decision: decision.action }],
        resolution: decision.remaining === 0 ? 'accepted' : undefined };
      update(owner.key, resolved, false);
      setCheckpoints(accepted.filter(entry => entry.noteId === owner.noteId));
      if (resolved.resolution) { releaseLease(); settle(session); }
      if (resolved.resolution && !session.restored) await report({
        requestId: session.request.requestId, success: true, affectedCount: checkpointAfter.length,
        beforePreview: session.origin.markdown.slice(0, 500), afterPreview: checkpointAfter.slice(0, 500),
      });
      // The body is confirmed; advance the projection even if the final state CAS
      // fails. The durable prepared intent still recovers the exact applied group.
      await persist(owner.key, resolved);
      return checkpointAfter;
    } catch (error) {
      // Do not roll back a successfully committed body if only state persistence failed.
      if (readAIReviewSession(owner.key) !== session) throw error;
      let retryBaseline = session.retryBaseline;
      try {
        if (error instanceof FullDocumentSaveError) {
          assertFullDocumentBaseline(api.getFullDocument(), error.appliedDocument);
          retryBaseline = error.appliedDocument;
        }
      } catch { /* old editor: preserve candidate under its original note */ }
      update(owner.key, { ...session, error: message(error), retryBaseline, retryDecision: decision });
      throw error;
    } finally {
      applying.current.delete(owner.key);
      if (mounted.current && current.current.key === owner.key) setIsApplying(false);
    }
  }, [update, persist, releaseLease]);

  const handleAccept = useCallback(async (_acceptPending = true) => {
    const owner = current.current;
    const session = readAIReviewSession(owner.key);
    if (!session || applying.current.has(owner.key)) return;
    try {
      if (session.resolution) { await persist(owner.key, session); return; }
      if (session.retryDecision) { await handleOfficialDecision(session.retryDecision); return; }
      if (official.current?.key !== owner.key) throw new Error('审阅编辑器尚未就绪，请展开候选后重试。');
      await official.current.controls.acceptAll();
    } catch (error) {
      const latest = readAIReviewSession(owner.key);
      if (latest) update(owner.key, { ...latest, error: message(error) }, false);
    }
  }, [handleOfficialDecision, persist, update]);

  const handleReject = useCallback(async () => {
    const { key: target } = current.current;
    const session = readAIReviewSession(target);
    if (!session || applying.current.has(target)) return;
    const resolved: AIReviewSession = session.resolution ? session : { ...session, resolution: 'discarded' };
    update(target, resolved, false);
    releaseLease();
    if (!session.resolution) {
      settle(session);
      if (!session.restored) await report({ requestId: session.request.requestId, success: false, error: aiReviewError('discarded', '用户明确丢弃建议。') });
    }
    await persist(target, resolved);
  }, [update, persist, releaseLease]);
  const setCollapsed = useCallback((collapsed: boolean) => {
    const { key: target } = current.current;
    const session = readAIReviewSession(target);
    if (!session || session.resolution || applying.current.has(target)) return;
    if (collapsed) { official.current?.controls.suspend(); releaseLease(); }
    let next = { ...session, collapsed };
    if (!collapsed && current.current.editorApi) {
      const snapshot = (current.current.editorApi as FullDocumentApi).getFullDocument();
      if (snapshot.markdown === (session.retryBaseline ?? session.baseline).markdown) {
        next = { ...next, baseline: session.retryBaseline ? session.baseline : snapshot,
          retryBaseline: session.retryBaseline ? snapshot : undefined, conflict: false, error: undefined };
      } else next = { ...next, conflict: true, error: '笔记版本已变化，候选和已接受组已保留。请重新生成建议。' };
    }
    if (session.collapsed !== collapsed || next.conflict !== session.conflict) update(target, next);
  }, [update, releaseLease]);
  const decideGroup = useCallback(async (index: number, decision: AIReviewDecision) => {
    if (decision === 'pending') throw new Error('已接受组请通过检查点撤销。');
    if (official.current?.key !== current.current.key) throw new Error('审阅编辑器尚未就绪。');
    await official.current.controls.decideGroup(index, decision);
  }, []);
  const onReviewReady = useCallback((controls: OfficialReviewControls | null) => {
    releaseLease();
    official.current = controls ? { key: current.current.key, controls } : null;
    const session = readAIReviewSession(current.current.key);
    if (controls && session && !session.collapsed && !session.conflict) lease.current = current.current.host?.acquireReviewLease?.() ?? null;
  }, [releaseLease]);
  const onReviewError = useCallback((error: unknown) => {
    const session = readAIReviewSession(current.current.key);
    if (session) update(current.current.key, { ...session, error: message(error) }, false);
  }, [update]);
  const changeReviewProjection = useCallback((kind?: AIReviewScope['kind'], landing?: AIReviewLanding) => {
    const owner = current.current;
    const session = readAIReviewSession(owner.key);
    if (!session || session.decisions.length || session.retryDecision || applying.current.has(owner.key)) return;
    try {
      const baseline = (owner.editorApi as FullDocumentApi).getFullDocument();
      assertFullDocumentBaseline(baseline, session.baseline);
      const scope = kind === 'page' ? { kind, from: 0, to: baseline.markdown.length, baseline } as AIReviewScope
        : kind ? owner.host?.resolveScope?.(kind) : session.request.scope;
      if (kind && !scope) throw new Error('范围选择接口尚未就绪。');
      const request = { ...session.request, scope, landing: landing ?? session.request.landing };
      const candidate = scopeAIReviewCandidate(request, baseline, projectAIReviewCandidate);
      assertNoteContentSize(candidate.content);
      update(owner.key, { ...createAIReviewSession(request, baseline, candidate.content),
        generation: session.generation + 1, persistenceId: session.persistenceId,
        persistenceRevision: session.persistenceRevision, error: candidate.error });
    } catch (error) { onReviewError(error); }
  }, [onReviewError, update]);
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
      const applied = await api.replaceFullDocument(top.originalContent, baseline);
      if (current.current.key === owner.key && mounted.current) {
        checkpointsRef.current = checkpointsRef.current.filter((entry) => entry !== top);
        setCheckpoints(checkpointsRef.current);
        const session = readAIReviewSession(owner.key);
        if (session && !session.resolution) {
          const lastAccept = session.decisions.map(decision => decision.action === 'accept' && decision.after === top.resultContent).lastIndexOf(true);
          const decisions = session.decisions.filter((_, index) => index !== lastAccept);
          update(owner.key, { ...session, baseline: applied, accepted: checkpointsRef.current, decisions,
            groups: session.groups.filter((_, index) => index !== lastAccept),
            generation: session.generation + 1, retryBaseline: undefined, retryDecision: undefined });
        }
      }
    } catch {
      if (current.current.key === owner.key && mounted.current) setCheckpoints((entries) => entries.map((entry) => entry === top ? { ...entry, stale: true } : entry));
    } finally {
      applying.current.delete(owner.key);
      if (current.current.key === owner.key && mounted.current) setIsApplying(false);
    }
  }, [update]);
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
    submitReview: receive,
    officialReviewProps: { onReviewDecision: handleOfficialDecision, onReviewReady, onReviewError },
    scopeProps: {
      onScopeChange: (kind: AIReviewScope['kind']) => changeReviewProjection(kind),
      onLandingChange: (landing: AIReviewLanding) => changeReviewProjection(undefined, landing),
      canResolveScope: !!host?.resolveScope, canSaveAs: !!host?.saveAs,
    },
    resolveScope: host?.resolveScope,
    setCollapsed, decideGroup, copyCandidate,
    checkpoints, checkpoint: checkpoints.at(-1) ?? null, rollbackCheckpoint, dismissCheckpoint,
    persistenceStatus: persistence.status, persistenceError: persistence.error,
    recoveryOptions: persistence.options ?? [], retryPersistence, restoreCandidate: hydrate,
  };
}
