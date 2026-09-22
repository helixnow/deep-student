import { invoke } from '@tauri-apps/api/core';
import { nanoid } from 'nanoid';
import { aiReviewError, type AIReviewSession } from './aiReviewModel';
import type { AIReviewRequest } from './officialDiffContract';

/** Backend integration boundary: atomic per-record CAS, no shared settings index. */
export interface NotesReviewStateRecord {
  noteId: string;
  kind: 'ai-review';
  id: string;
  revision: number;
  payload: string;
}
export interface NotesReviewStateService {
  get(noteId: string, id: string): Promise<NotesReviewStateRecord | null>;
  list(noteId: string): Promise<NotesReviewStateRecord[]>;
  /** expectedRevision=null means create-only; mismatch MUST reject without writing. */
  put(record: Omit<NotesReviewStateRecord, 'revision'>, expectedRevision: number | null): Promise<NotesReviewStateRecord>;
  delete(noteId: string, id: string, expectedRevision: number): Promise<void>;
}
interface WireState { note_id: string; type: 'review'; key: string; revision: number; value: unknown; deleted: boolean }
const fromWire = (record: WireState): NotesReviewStateRecord => ({ noteId: record.note_id, kind: 'ai-review',
  id: record.key, revision: record.revision, payload: JSON.stringify(record.value) });
export const notesReviewStateService: NotesReviewStateService = {
  get: async (noteId, id) => {
    const row = await invoke<WireState | null>('notes_state_get', { request: { note_id: noteId, type: 'review', key: id } });
    return row && !row.deleted ? fromWire(row) : null;
  },
  list: async noteId => (await invoke<WireState[]>('notes_state_list', { request: { note_id: noteId, type: 'review', include_deleted: false } }))
    .filter(row => !row.deleted).map(fromWire),
  put: async (record, expectedRevision) => fromWire(await invoke<WireState>('notes_state_put', { request: {
    note_id: record.noteId, type: 'review', key: record.id, expected_revision: expectedRevision, value: JSON.parse(record.payload),
  } })),
  delete: async (noteId, id, expectedRevision) => { await invoke('notes_state_delete', { request: {
    note_id: noteId, type: 'review', key: id, expected_revision: expectedRevision,
  } }); },
};
const runtimeId = nanoid();
export const newAIReviewPersistenceId = () => nanoid();
export interface AIReviewRecoveryOption { id: string; windowId: string; createdAt: number }
interface StoredReview {
  version: 2;
  windowId: string;
  runtimeId: string;
  createdAt: number;
  session: AIReviewSession;
}
const queues = new Map<string, Promise<unknown>>();
const revisions = new Map<string, number>();
const created = new Map<string, number>();
const claims = new Map<string, string>();
function serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const task = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
  queues.set(id, task);
  void task.finally(() => { if (queues.get(id) === task) queues.delete(id); }).catch(() => {});
  return task;
}
const invalidRecord = () => new Error(aiReviewError('invalid_record', '保存的审阅候选无法读取，原数据未改动。'));
function requestData(request: AIReviewRequest): AIReviewRequest {
  const { requestId, noteId, operation, content, search, replace, isRegex, section, scope, landing } = request;
  return { requestId, noteId, operation, content, search, replace, isRegex, section, scope, landing };
}
function encode(session: AIReviewSession, windowId: string): string {
  const id = session.persistenceId!;
  const data: StoredReview = { version: 2, windowId, runtimeId, createdAt: created.get(id) ?? Date.now(),
    session: { ...session, request: requestData(session.request), restored: undefined, persistenceRevision: undefined } };
  // Serialization for storage only. Never compare/hashes of serialized maps.
  return JSON.stringify(data);
}
function decode(record: NotesReviewStateRecord, noteId: string): StoredReview {
  let data: StoredReview;
  try { data = JSON.parse(record.payload); } catch { throw invalidRecord(); }
  const s = data?.session;
  if (record.noteId !== noteId || record.kind !== 'ai-review' || !Number.isInteger(record.revision)
    || data.version !== 2 || typeof data.windowId !== 'string' || typeof data.runtimeId !== 'string'
    || !s || s.persistenceId !== record.id || s.baseline?.noteId !== noteId || s.origin?.noteId !== noteId
    || typeof s.baseline.markdown !== 'string' || typeof s.baseline.revision !== 'number'
    || typeof s.origin.markdown !== 'string' || typeof s.candidate !== 'string' || typeof s.target !== 'string'
    || s.request?.noteId !== noteId || !['set', 'append', 'replace'].includes(s.request.operation)
    || !Array.isArray(s.decisions) || !Array.isArray(s.accepted) || !Array.isArray(s.groups)
    || typeof s.collapsed !== 'boolean') throw invalidRecord();
  s.request = requestData(s.request);
  return data;
}
export function persistAIReviewSession(session: AIReviewSession, windowId = 'notes', service = notesReviewStateService): Promise<void> {
  const id = session.persistenceId;
  if (!id || session.request.noteId !== session.baseline.noteId) return Promise.reject(invalidRecord());
  const payload = encode(session, windowId);
  return serial(id, async () => {
    const result = await service.put({ noteId: session.baseline.noteId, kind: 'ai-review', id, payload },
      revisions.get(id) ?? session.persistenceRevision ?? null);
    revisions.set(id, result.revision);
    session.persistenceRevision = result.revision;
  });
}
export function removePersistedAIReview(session: AIReviewSession, service = notesReviewStateService): Promise<void> {
  const id = session.persistenceId;
  if (!id) return Promise.resolve();
  return serial(id, async () => {
    // Terminal CAS first: even if cleanup fails a restart cannot resurrect it.
    const result = await service.put({ noteId: session.baseline.noteId, kind: 'ai-review', id,
      payload: encode({ ...session, resolution: session.resolution ?? 'discarded' }, 'notes') },
      revisions.get(id) ?? session.persistenceRevision ?? null);
    revisions.set(id, result.revision);
    await service.delete(session.baseline.noteId, id, result.revision);
    revisions.delete(id); claims.delete(id); created.delete(id);
  });
}
export async function loadPersistedAIReview(noteId: string, windowId = 'notes', selectedId?: string,
  service = notesReviewStateService): Promise<{ session: AIReviewSession | null; options: AIReviewRecoveryOption[] }> {
  const records = await service.list(noteId);
  const candidates = records.map(record => ({ record, data: decode(record, noteId) }))
    .filter(({ record, data }) => !data.session.resolution && !claims.has(record.id)
      && (data.windowId === windowId || data.runtimeId !== runtimeId));
  const exact = candidates.filter(({ data }) => data.windowId === windowId);
  const preferred = selectedId ? candidates.filter(({ record }) => record.id === selectedId) : exact.length ? exact : candidates;
  if (selectedId && preferred.length !== 1) throw invalidRecord();
  if (preferred.length !== 1) return { session: null, options: candidates.map(({ record, data }) => ({ id: record.id, windowId: data.windowId, createdAt: data.createdAt })) };
  const { record, data } = preferred[0];
  created.set(record.id, data.createdAt);
  // Do not update the CAS cache until claiming. Independent readers may have the same revision.
  return { session: { ...data.session, restored: true, persistenceRevision: record.revision }, options: [] };
}
export function claimAIReviewRecovery(session: AIReviewSession, key: string): boolean {
  if (!session.persistenceId || claims.has(session.persistenceId)) return false;
  claims.set(session.persistenceId, key);
  return true;
}
