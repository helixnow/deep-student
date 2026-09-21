import { invoke } from '@tauri-apps/api/core';
import { nanoid } from 'nanoid';
import type { CanvasAIEditRequest } from './hooks/useAIEditState';
import type { FullDocumentSnapshot } from './fullDocument';
import { aiReviewError, composeAIReview, createAIReviewSession, type AIReviewDecision, type AIReviewSession } from './aiReviewModel';

const PREFIX = 'notes.aiReview.v1';
const runtimeId = nanoid();
export const aiReviewIndexKey = (noteId: string) => `${PREFIX}.${encodeURIComponent(noteId)}.index`;
const bodyKey = (noteId: string, id: string) => `${PREFIX}.${encodeURIComponent(noteId)}.${id}.body`;
const stateKey = (noteId: string, id: string) => `${PREFIX}.${encodeURIComponent(noteId)}.${id}.state`;
export const newAIReviewPersistenceId = () => nanoid();

export interface AIReviewRecoveryOption { id: string; windowId: string; createdAt: number }
interface RecordMeta extends AIReviewRecoveryOption { runtimeId: string }
interface StoredBody {
  version: 1;
  noteId: string;
  request: CanvasAIEditRequest;
  baseline: FullDocumentSnapshot;
  candidate: string;
}
interface StoredState {
  version: 1;
  decisions: AIReviewDecision[];
  collapsed: boolean;
  retryApplied: boolean;
  resolution?: 'accepted' | 'discarded';
}

// Settings have no RMW transaction IPC. Serialize operations for one note in this renderer;
// a different note never waits for it. Only the small index is read-modify-written.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(noteId: string, operation: () => Promise<T>): Promise<T> {
  const task = (queues.get(noteId) ?? Promise.resolve()).catch(() => {}).then(operation);
  queues.set(noteId, task);
  void task.finally(() => { if (queues.get(noteId) === task) queues.delete(noteId); }).catch(() => {});
  return task;
}
const registered = new Map<string, string>(); // candidate id -> window owner, after successful index write
const bodiesWritten = new Set<string>();
const statesWritten = new Map<string, string>();
const claims = new Map<string, string>(); // candidate id -> in-process session key
const invalidRecord = () => new Error(aiReviewError('invalid_record', '保存的审阅候选无法读取，原数据未改动。'));
const read = (key: string) => invoke<string | null>('get_setting', { key });
const write = (key: string, value: unknown) => invoke<void>('save_setting', { key, value: JSON.stringify(value) });

function parse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { throw invalidRecord(); }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
async function readIndex(noteId: string): Promise<RecordMeta[]> {
  const raw = await read(aiReviewIndexKey(noteId));
  if (raw == null) return [];
  const value = parse(raw);
  if (!Array.isArray(value) || !value.every((entry) => object(entry) && typeof entry.id === 'string'
    && typeof entry.windowId === 'string' && typeof entry.runtimeId === 'string' && typeof entry.createdAt === 'number')) throw invalidRecord();
  return value as RecordMeta[];
}

/** Deliberate allowlist: callbacks, targetWindowId and transient error/UI fields never reach disk. */
function requestData(request: CanvasAIEditRequest): CanvasAIEditRequest {
  const { requestId, noteId, operation, content, search, replace, isRegex, section } = request;
  return { requestId, noteId, operation, content, search, replace, isRegex, section };
}
function stateData(session: AIReviewSession): StoredState {
  return {
    version: 1, decisions: session.groups.map((group) => group.decision), collapsed: session.collapsed,
    retryApplied: !!session.retryBaseline, resolution: session.resolution,
  };
}

export function persistAIReviewSession(session: AIReviewSession, windowId = 'notes'): Promise<void> {
  const { persistenceId: id, baseline: { noteId } } = session;
  if (!id || session.request.noteId !== noteId) return Promise.reject(invalidRecord());
  // Snapshot the decision array now; later choices cannot change an in-flight write.
  const state = stateData(session);
  return serial(noteId, async () => {
    if (!bodiesWritten.has(id)) {
      const body: StoredBody = { version: 1, noteId, request: requestData(session.request), baseline: session.baseline, candidate: session.candidate };
      await write(bodyKey(noteId, id), body);
      bodiesWritten.add(id);
    }
    const encoded = JSON.stringify(state); // sorted-by-document array; no Map serialization
    if (statesWritten.get(id) !== encoded) {
      await invoke('save_setting', { key: stateKey(noteId, id), value: encoded });
      statesWritten.set(id, encoded);
    }
    if (registered.get(id) !== windowId) {
      const index = await readIndex(noteId);
      const existing = index.find((entry) => entry.id === id);
      const entry: RecordMeta = { id, windowId, runtimeId, createdAt: existing?.createdAt ?? Date.now() };
      await write(aiReviewIndexKey(noteId), [...index.filter((item) => item.id !== id), entry]);
      registered.set(id, windowId);
    }
  });
}

/** A terminal marker precedes cleanup so partial deletion cannot resurrect a discarded review. */
export function removePersistedAIReview(session: AIReviewSession): Promise<void> {
  const { persistenceId: id, baseline: { noteId } } = session;
  if (!id) return Promise.resolve();
  return serial(noteId, async () => {
    await write(stateKey(noteId, id), { ...stateData(session), resolution: session.resolution ?? 'discarded' });
    const index = await readIndex(noteId);
    await write(aiReviewIndexKey(noteId), index.filter((entry) => entry.id !== id));
    await invoke('delete_setting', { key: bodyKey(noteId, id) });
    await invoke('delete_setting', { key: stateKey(noteId, id) });
    bodiesWritten.delete(id); statesWritten.delete(id); registered.delete(id); claims.delete(id);
  });
}

function decodeBody(value: unknown, noteId: string): StoredBody {
  if (!object(value) || value.version !== 1 || value.noteId !== noteId || typeof value.candidate !== 'string'
    || !object(value.baseline) || value.baseline.noteId !== noteId || typeof value.baseline.markdown !== 'string'
    || typeof value.baseline.revision !== 'number' || !object(value.request) || value.request.noteId !== noteId
    || typeof value.request.requestId !== 'string' || !['set', 'append', 'replace'].includes(String(value.request.operation))) throw invalidRecord();
  for (const field of ['content', 'search', 'replace', 'section']) {
    if (value.request[field] !== undefined && typeof value.request[field] !== 'string') throw invalidRecord();
  }
  if (value.request.isRegex !== undefined && typeof value.request.isRegex !== 'boolean') throw invalidRecord();
  const body = value as unknown as StoredBody;
  return { ...body, request: requestData(body.request) };
}

export async function loadPersistedAIReview(noteId: string, windowId = 'notes', selectedId?: string): Promise<{
  session: AIReviewSession | null; options: AIReviewRecoveryOption[];
}> {
  return serial(noteId, async () => {
    const index = await readIndex(noteId);
    const eligible = index.filter((entry) => !claims.has(entry.id) && (entry.windowId === windowId || entry.runtimeId !== runtimeId));
    const candidates: Array<{ meta: RecordMeta; state: StoredState }> = [];
    for (const meta of eligible) {
      const raw = await read(stateKey(noteId, meta.id));
      if (raw == null) throw invalidRecord();
      const state = parse(raw);
      if (!object(state) || state.version !== 1 || !Array.isArray(state.decisions)
        || !state.decisions.every((decision) => ['accept', 'reject', 'pending'].includes(String(decision)))
        || typeof state.collapsed !== 'boolean' || typeof state.retryApplied !== 'boolean'
        || (state.resolution !== undefined && !['accepted', 'discarded'].includes(String(state.resolution)))) throw invalidRecord();
      if (!state.resolution) candidates.push({ meta, state: state as unknown as StoredState });
    }
    const exact = candidates.filter(({ meta }) => meta.windowId === windowId);
    const preferred = selectedId ? candidates.filter(({ meta }) => meta.id === selectedId) : exact.length ? exact : candidates;
    if (selectedId && preferred.length !== 1) throw new Error(aiReviewError('recovery_claimed', '候选已由其他笔记窗口恢复，请刷新后重试。'));
    if (preferred.length !== 1) return { session: null, options: candidates.map(({ meta }) => meta) };
    const { meta, state } = preferred[0];
    const raw = await read(bodyKey(noteId, meta.id));
    if (raw == null) throw invalidRecord();
    const body = decodeBody(parse(raw), noteId);
    const session = createAIReviewSession(body.request, body.baseline, body.candidate);
    if (session.groups.length !== state.decisions.length) throw invalidRecord();
    session.groups = session.groups.map((group, i) => ({ ...group, decision: state.decisions[i] }));
    session.collapsed = state.collapsed;
    session.persistenceId = meta.id;
    session.restored = true;
    if (state.retryApplied) session.retryBaseline = { ...body.baseline, markdown: composeAIReview(session) };
    bodiesWritten.add(meta.id);
    statesWritten.set(meta.id, JSON.stringify(state));
    // No claim/write until the hook checks its hydration generation against newly arrived requests.
    return { session, options: [] };
  });
}

export function claimAIReviewRecovery(session: AIReviewSession, key: string): boolean {
  if (!session.persistenceId || claims.has(session.persistenceId)) return false;
  claims.set(session.persistenceId, key);
  return true;
}
