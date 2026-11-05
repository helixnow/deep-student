import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

import { useEventRegistry } from '@/hooks/useEventRegistry';

import { inkBoardApi, InkApiError, type InkChangedEvent } from './api';
import {
  DraftWriteRejectedError,
  inkBoardDraftJournal,
  type InkBoardDraftClaim,
  type InkBoardDraftJournal,
  type InkBoardDraftRecord,
} from './boardDrafts';
import { registerInkEditorSession, type InkEditorSession } from './editorSession';
import { planBoardChunkEdits, type InkBoardChunkEditPlan } from './boardChunkEdits';
import {
  INK_BOARD_LIMITS,
  INK_BOARD_SCHEMA_VERSION,
  type InkBoardBounds,
  type InkBoardChunk,
  type InkBoardChunkRef,
  type InkBoardManifest,
  type InkBoardObject,
  type InkBoardSurface,
} from './types';

export type InkBoardSaveStatus = 'loading' | 'saved' | 'pending' | 'saving' | 'conflict' | 'offline' | 'storage-error';

export interface InkBoardCamera {
  x: number;
  y: number;
  scale: number;
}

export interface InkBoardConflictInfo {
  document_id: string;
  base_revision: string;
  remote_revision?: string;
  draft: InkBoardDraftRecord;
}

export interface InkBoardFlushTarget {
  documentId: string;
  pageId: string;
  revisionEpoch: number;
}

export interface InkBoardDocumentOptions {
  journal?: InkBoardDraftJournal;
  onConflict?: (info: InkBoardConflictInfo) => void;
  /** Enqueue pending host input only; the registered session owns the canonical flush. */
  beforeFlush?: (target: InkBoardFlushTarget) => void | Promise<void>;
  requestMaxBytes?: number;
}

export interface InkBoardDirtyChunk {
  chunk_id: string;
  base_blob_hash?: string;
}

export interface InkBoardDocumentState {
  status: 'loading' | 'ready' | 'error';
  saveStatus: InkBoardSaveStatus;
  manifest?: InkBoardManifest;
  surface?: InkBoardSurface;
  chunks: InkBoardChunk[];
  dirtyChunks: InkBoardDirtyChunk[];
  camera: InkBoardCamera;
  revisionEpoch: number;
  undoDepth: number;
  redoDepth: number;
  error?: unknown;
  loadVisible(bounds: InkBoardBounds): Promise<void>;
  upsertObjects(objects: InkBoardObject[]): Promise<void>;
  insertObjects(objects: InkBoardObject[]): Promise<void>;
  removeObjects(ids: string[]): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  save(): Promise<void>;
  reloadRemote(): Promise<void>;
  persistDraft(): Promise<InkBoardDraftRecord | undefined>;
  flush(): Promise<void>;
  setCamera(camera: Partial<InkBoardCamera>): void;
  setActiveInput(active: boolean): void;
}

interface BoardHistoryEntry {
  chunk_id: string;
  before?: InkBoardChunk;
  after?: InkBoardChunk;
}

interface RetryableSave {
  operationId: string;
  baseRevision: string;
  chunks: InkBoardChunk[];
  deleted: string[];
}

interface InflightSave {
  changedVersions: Map<string, number>;
  deletedVersions: Map<string, number>;
}

interface BlockedSave {
  baseRevision: string;
}

interface PendingViewportLoad {
  requestId: number;
  bounds: InkBoardBounds;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * One immutable session object per document mount/render identity. All mutable
 * board data lives here so an old session cleanup or an already-sent CAS can
 * read/write its own snapshot without touching the refs of a newer session.
 */
interface BoardSessionState {
  documentId: string;
  journal: InkBoardDraftJournal;
  owner: string;
  token: symbol;
  active: boolean;
  status: 'loading' | 'ready' | 'error';
  saveStatus: InkBoardSaveStatus;
  manifest: InkBoardManifest | null;
  chunks: Map<string, InkBoardChunk>;
  objectChunks: Map<string, string>;
  dirty: Map<string, InkBoardDirtyChunk>;
  deleted: Set<string>;
  chunkVersions: Map<string, number>;
  deletedVersions: Map<string, number>;
  undo: BoardHistoryEntry[][];
  redo: BoardHistoryEntry[][];
  epoch: number;
  sequence: number;
  editVersion: number;
  draftNeedsCleanup: boolean;
  activeInput: boolean;
  inputProtection: Promise<InkBoardDraftRecord | undefined> | null;
  loadRequest: number;
  viewportRequest: number;
  loadPending: PendingViewportLoad | null;
  loadRunning: boolean;
  visibleBounds?: InkBoardBounds;
  retrySave: RetryableSave | null;
  blockedSave: BlockedSave | null;
  inflightSave: InflightSave | null;
  ownOperations: Map<string, symbol>;
}

function createBoardSession(documentId: string, journal: InkBoardDraftJournal): BoardSessionState {
  return {
    documentId,
    journal,
    owner: ownerId(),
    token: Symbol(documentId),
    active: true,
    status: 'loading',
    saveStatus: 'loading',
    manifest: null,
    chunks: new Map(),
    objectChunks: new Map(),
    dirty: new Map(),
    deleted: new Set(),
    chunkVersions: new Map(),
    deletedVersions: new Map(),
    undo: [],
    redo: [],
    epoch: 0,
    sequence: 0,
    editVersion: 0,
    draftNeedsCleanup: false,
    activeInput: false,
    inputProtection: null,
    loadRequest: 0,
    viewportRequest: 0,
    loadPending: null,
    loadRunning: false,
    retrySave: null,
    blockedSave: null,
    inflightSave: null,
    ownOperations: new Map(),
  };
}

function sameRetryRequest(retry: RetryableSave, record: InkBoardDraftRecord): boolean {
  return retry.baseRevision === record.base_revision
    && retry.chunks.length === record.changed.length
    && retry.chunks.every((chunk, index) => chunk === record.changed[index])
    && retry.deleted.length === record.deleted.length
    && retry.deleted.every((chunkId, index) => chunkId === record.deleted[index]);
}

const MIB = 1024 * 1024;
const DEFAULT_REQUEST_MAX_BYTES = 16 * MIB;
const CHUNK_MAX_BYTES = INK_BOARD_LIMITS.chunk_max_bytes;
const CACHE_MAX_BYTES = 32 * MIB;
const MAX_REMEMBERED_OWN_OPERATIONS = 64;

const boardSaveQueues = new Map<string, Promise<void>>();

function operationId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `ink-board-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function ownerId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `ink-board-owner-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** CAS tasks are serialized per document, not per session instance. */
function serializeBoardSave(documentId: string, save: () => Promise<void>): Promise<void> {
  const previous = boardSaveQueues.get(documentId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(save);
  const queued = next.finally(() => {
    if (boardSaveQueues.get(documentId) === queued) boardSaveQueues.delete(documentId);
  });
  boardSaveQueues.set(documentId, queued);
  return queued;
}

async function awaitBoardSaveQueue(documentId: string): Promise<void> {
  const pending = boardSaveQueues.get(documentId);
  if (pending) await pending.catch(() => undefined);
}

function intersectsBounds(left: InkBoardBounds, right: InkBoardBounds): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function isBoardBounds(value: unknown): value is InkBoardBounds {
  if (!value || typeof value !== 'object') return false;
  return 'x' in value && typeof value.x === 'number' && Number.isFinite(value.x)
    && 'y' in value && typeof value.y === 'number' && Number.isFinite(value.y)
    && 'width' in value && typeof value.width === 'number' && Number.isFinite(value.width)
    && 'height' in value && typeof value.height === 'number' && Number.isFinite(value.height);
}

function isBoardChunkRef(value: unknown): value is InkBoardChunkRef {
  if (!value || typeof value !== 'object') return false;
  return 'chunk_id' in value && typeof value.chunk_id === 'string'
    && 'blob_hash' in value && typeof value.blob_hash === 'string'
    && 'byte_length' in value && typeof value.byte_length === 'number' && Number.isFinite(value.byte_length)
    && 'object_count' in value && typeof value.object_count === 'number' && Number.isFinite(value.object_count)
    && 'sample_count' in value && typeof value.sample_count === 'number' && Number.isFinite(value.sample_count)
    && 'bounds' in value && isBoardBounds(value.bounds);
}

function isBoardSurface(value: unknown): value is InkBoardSurface {
  if (!value || typeof value !== 'object') return false;
  return 'kind' in value && value.kind === 'board'
    && 'page_id' in value && typeof value.page_id === 'string'
    && 'ruling' in value && (value.ruling === 'blank' || value.ruling === 'lined' || value.ruling === 'grid')
    && 'bounds' in value && isBoardBounds(value.bounds);
}

function isInkBoardManifest(value: unknown): value is InkBoardManifest {
  if (!value || typeof value !== 'object') return false;
  if (!('schema_version' in value) || value.schema_version !== INK_BOARD_SCHEMA_VERSION) return false;
  if (!('document_id' in value) || typeof value.document_id !== 'string') return false;
  if (!('revision' in value) || typeof value.revision !== 'string') return false;
  if (!('title' in value) || typeof value.title !== 'string') return false;
  if (!('pages' in value) || !Array.isArray(value.pages) || value.pages.length !== 0) return false;
  if (!('source' in value) || !value.source || typeof value.source !== 'object'
    || !('kind' in value.source) || value.source.kind !== 'blank') return false;
  if (!('surface' in value) || !isBoardSurface(value.surface)) return false;
  if (!('chunks' in value) || !Array.isArray(value.chunks) || !value.chunks.every(isBoardChunkRef)) return false;
  return true;
}

function assertBoardManifest(manifest: unknown): InkBoardManifest {
  if (!isInkBoardManifest(manifest)) throw new Error('Ink board document must use schema v2.');
  return manifest;
}

function isSaveConflict(status: InkBoardSaveStatus): boolean {
  return status === 'conflict';
}

function isDraftRejected(error: unknown): error is DraftWriteRejectedError {
  return error instanceof DraftWriteRejectedError;
}

function cacheBudgetError(bytes: number): Error {
  return Object.assign(
    new Error(
      `Ink board viewport requires ${(bytes / MIB).toFixed(1)} MiB, `
      + `exceeding the ${CACHE_MAX_BYTES / MIB} MiB cache budget.`,
    ),
    { code: 'INK_BOARD_CACHE_BUDGET_EXCEEDED' },
  );
}

function planLoadBatches(refs: InkBoardChunkRef[], maxBytes: number): InkBoardChunkRef[][] {
  const limit = Math.max(1, Math.floor(maxBytes));
  const batches: InkBoardChunkRef[][] = [];
  let current: InkBoardChunkRef[] = [];
  let currentBytes = 0;
  for (const ref of refs) {
    const bytes = Number.isFinite(ref.byte_length) ? Math.max(0, ref.byte_length) : 0;
    if (bytes > CHUNK_MAX_BYTES) {
      throw new Error(`Ink board chunk ${ref.chunk_id} exceeds the ${CHUNK_MAX_BYTES / MIB} MiB chunk limit.`);
    }
    if (bytes > limit) {
      throw new Error(`Ink board chunk ${ref.chunk_id} exceeds the ${limit / MIB} MiB request limit.`);
    }
    if (current.length > 0 && currentBytes + bytes > limit) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(ref);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

let textEncoder: TextEncoder | undefined;

function serializedByteLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') return Number.POSITIVE_INFINITY;
    if (typeof TextEncoder === 'undefined') return json.length;
    textEncoder ??= new TextEncoder();
    return textEncoder.encode(json).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

interface ChunkCapacitySummary {
  objects: number;
  samples: number;
  bytes: number;
}

function objectSampleCount(object: InkBoardObject): number {
  return object.content.kind === 'stroke' ? object.content.samples.length : 0;
}

function summarizeCapacity(chunk: InkBoardChunk): ChunkCapacitySummary {
  let samples = 0;
  for (const object of chunk.objects) samples += objectSampleCount(object);
  return {
    objects: chunk.objects.length,
    samples,
    bytes: serializedByteLength(chunk),
  };
}

function assertChunkCapacity(summary: ChunkCapacitySummary, chunkId: string): void {
  if (summary.objects > INK_BOARD_LIMITS.chunk_objects_max) {
    throw new Error(`Ink board chunk ${chunkId} would contain too many objects.`);
  }
  if (summary.samples > INK_BOARD_LIMITS.chunk_samples_max) {
    throw new Error(`Ink board chunk ${chunkId} would contain too many samples.`);
  }
  if (summary.bytes > CHUNK_MAX_BYTES) {
    throw new Error(`Ink board chunk ${chunkId} would exceed the chunk byte limit.`);
  }
}

/**
 * Validate an undo/redo change set against the whole board before any local
 * mutation. Manifest refs already pending deletion are ghosts and must not be
 * counted again when a history entry restores or replaces that chunk.
 */
function validateHistoryCapacity(
  session: BoardSessionState,
  changes: Map<string, InkBoardChunk | undefined>,
): void {
  const manifest = session.manifest;
  if (!manifest) throw new Error('Ink board is not ready.');
  const summaries = new Map<string, ChunkCapacitySummary>();

  for (const ref of manifest.chunks) {
    if (session.deleted.has(ref.chunk_id) && !changes.has(ref.chunk_id)) continue;
    summaries.set(ref.chunk_id, {
      objects: ref.object_count,
      samples: ref.sample_count,
      bytes: ref.byte_length,
    });
  }
  for (const chunk of session.chunks.values()) {
    if (changes.has(chunk.chunk_id) || session.deleted.has(chunk.chunk_id)) continue;
    summaries.set(chunk.chunk_id, summarizeCapacity(chunk));
  }
  for (const [chunkId, chunk] of changes) {
    if (!chunk) {
      summaries.delete(chunkId);
      continue;
    }
    const summary = summarizeCapacity(chunk);
    assertChunkCapacity(summary, chunkId);
    summaries.set(chunkId, summary);
  }

  let objects = 0;
  let samples = 0;
  let bytes = 0;
  for (const summary of summaries.values()) {
    objects += summary.objects;
    samples += summary.samples;
    bytes += summary.bytes;
  }
  if (summaries.size > INK_BOARD_LIMITS.chunks_max) {
    throw new Error('Ink board would exceed the chunk limit.');
  }
  if (objects > INK_BOARD_LIMITS.objects_max) {
    throw new Error('Ink board would exceed the object limit.');
  }
  if (samples > INK_BOARD_LIMITS.samples_max) {
    throw new Error('Ink board would exceed the sample limit.');
  }
  if (bytes > INK_BOARD_LIMITS.content_max_bytes) {
    throw new Error('Ink board would exceed the content byte limit.');
  }
}

function detachChunkObjects(session: BoardSessionState, chunk: InkBoardChunk): void {
  for (const object of chunk.objects) {
    if (session.objectChunks.get(object.id) === chunk.chunk_id) {
      session.objectChunks.delete(object.id);
    }
  }
}

function applyChunkChangeSet(
  session: BoardSessionState,
  changes: Map<string, InkBoardChunk | undefined>,
): void {
  for (const [chunkId, next] of changes) {
    const previous = session.chunks.get(chunkId);
    if (previous) detachChunkObjects(session, previous);

    if (next) {
      session.chunks.set(chunkId, next);
      for (const object of next.objects) session.objectChunks.set(object.id, chunkId);
      session.deleted.delete(chunkId);
      const ref = session.manifest?.chunks.find((entry) => entry.chunk_id === chunkId);
      session.dirty.set(chunkId, ref
        ? { chunk_id: chunkId, base_blob_hash: ref.blob_hash }
        : { chunk_id: chunkId });
    } else {
      session.chunks.delete(chunkId);
      session.dirty.delete(chunkId);
      const canonical = session.manifest?.chunks.some((entry) => entry.chunk_id === chunkId) ?? false;
      if (canonical) {
        session.deleted.add(chunkId);
        session.deletedVersions.set(
          chunkId,
          (session.deletedVersions.get(chunkId) ?? 0) + 1,
        );
      } else {
        // A chunk that was never published cannot be named in CAS `deleted`.
        session.deleted.delete(chunkId);
      }
    }
    session.chunkVersions.set(
      chunkId,
      (session.chunkVersions.get(chunkId) ?? 0) + 1,
    );
  }
}

export function useInkBoardDocument(
  documentId: string,
  options: InkBoardDocumentOptions = {},
): InkBoardDocumentState {
  const journalRef = useRef(options.journal ?? inkBoardDraftJournal);
  journalRef.current = options.journal ?? inkBoardDraftJournal;
  const requestMaxBytes = options.requestMaxBytes ?? DEFAULT_REQUEST_MAX_BYTES;
  const onConflictRef = useRef(options.onConflict);
  onConflictRef.current = options.onConflict;
  const beforeFlushRef = useRef(options.beforeFlush);
  beforeFlushRef.current = options.beforeFlush;

  const [sessionState, setSessionState] = useState<BoardSessionState>(
    () => createBoardSession(documentId, journalRef.current),
  );
  if (sessionState.documentId !== documentId) {
    setSessionState(createBoardSession(documentId, journalRef.current));
  }
  const sessionRef = useRef(sessionState);
  sessionRef.current = sessionState;

  const [status, setStatus] = useState<InkBoardDocumentState['status']>('loading');
  const [saveStatus, setSaveStatus] = useState<InkBoardSaveStatus>('loading');
  const [manifestState, setManifestState] = useState<InkBoardManifest>();
  const [chunksState, setChunksState] = useState<InkBoardChunk[]>([]);
  const [dirtyChunksState, setDirtyChunksState] = useState<InkBoardDirtyChunk[]>([]);
  const [camera, setCameraState] = useState<InkBoardCamera>({ x: 0, y: 0, scale: 1 });
  const [revisionEpoch, setRevisionEpoch] = useState(0);
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
  const [error, setError] = useState<unknown>();

  const isCurrentSession = useCallback((session: BoardSessionState): boolean => (
    session.active && sessionRef.current === session
  ), []);

  const publishView = useCallback((session: BoardSessionState = sessionRef.current) => {
    if (!session.active || sessionRef.current !== session) return;
    setManifestState(session.manifest ?? undefined);
    setChunksState(Array.from(session.chunks.values()));
    setDirtyChunksState(Array.from(session.dirty.values()));
    setSaveStatus(session.saveStatus);
    setRevisionEpoch(session.epoch);
    setUndoDepth(session.undo.length);
    setRedoDepth(session.redo.length);
  }, []);

  const rememberOwnOperation = useCallback((session: BoardSessionState, id: string) => {
    session.ownOperations.set(id, session.token);
    while (session.ownOperations.size > MAX_REMEMBERED_OWN_OPERATIONS) {
      const oldest = session.ownOperations.keys().next().value;
      if (typeof oldest !== 'string') break;
      session.ownOperations.delete(oldest);
    }
  }, []);

  const performViewportLoad = useCallback(async (
    session: BoardSessionState,
    requestId: number,
    bounds: InkBoardBounds,
  ) => {
    const isLatest = (): boolean => (
      isCurrentSession(session) && session.viewportRequest === requestId
    );
    if (!isLatest()) return;
    const manifest = session.manifest;
    if (!manifest) return;
    const revision = manifest.revision;
    const editVersion = session.editVersion;
    const refById = new Map(manifest.chunks.map((ref) => [ref.chunk_id, ref]));
    const visibleRefs = manifest.chunks.filter((ref) => (
      !session.deleted.has(ref.chunk_id) && intersectsBounds(ref.bounds, bounds)
    ));
    const visibleIds = new Set(visibleRefs.map((ref) => ref.chunk_id));
    const dirtyIds = new Set(session.dirty.keys());
    const requiredIds = new Set<string>([...visibleIds, ...dirtyIds]);

    const sizeOf = (chunkId: string, cache: Map<string, InkBoardChunk>): number => {
      const ref = refById.get(chunkId);
      const chunk = cache.get(chunkId);
      return Math.max(
        ref?.byte_length ?? 0,
        chunk ? serializedByteLength(chunk) : 0,
      );
    };
    const cachedRequiredBytes = (cache: Map<string, InkBoardChunk>): number => {
      let total = 0;
      for (const chunkId of requiredIds) total += sizeOf(chunkId, cache);
      return total;
    };

    // Reject before evicting or fetching so the previous cache and dirty state
    // stay intact.
    const initialBytes = cachedRequiredBytes(session.chunks);
    if (initialBytes > CACHE_MAX_BYTES) {
      const error = cacheBudgetError(initialBytes);
      setError(error);
      throw error;
    }

    const missing = visibleRefs.filter((ref) => !session.chunks.has(ref.chunk_id));
    let batches: InkBoardChunkRef[][];
    try {
      batches = planLoadBatches(missing, requestMaxBytes);
    } catch (planError) {
      setError(planError);
      throw planError;
    }

    // Synchronous prefetch eviction: keep only the new visible cached chunks
    // and every dirty chunk. Publish so the pruned residency is observable
    // before any fetch starts. No old clean viewport survives this point.
    const kept = new Map<string, InkBoardChunk>();
    for (const chunkId of requiredIds) {
      const chunk = session.chunks.get(chunkId);
      if (chunk) kept.set(chunkId, chunk);
    }
    session.chunks.clear();
    session.objectChunks.clear();
    for (const [chunkId, chunk] of kept) {
      session.chunks.set(chunkId, chunk);
      for (const object of chunk.objects) session.objectChunks.set(object.id, chunkId);
    }
    session.visibleBounds = bounds;
    publishView(session);

    const retainedBytes = Array.from(session.chunks.entries()).reduce(
      (sum, [chunkId, chunk]) => sum + Math.max(
        refById.get(chunkId)?.byte_length ?? 0,
        serializedByteLength(chunk),
      ),
      0,
    );
    const fetched = new Map<string, InkBoardChunk>();
    let fetchedBytes = 0;

    for (const batch of batches) {
      if (!isLatest()) return;
      try {
        const response = await inkBoardApi.getChunks({
          document_id: session.documentId,
          expected_revision: revision,
          chunk_ids: batch.map((ref) => ref.chunk_id),
        });
        if (!isLatest()) return;
        const byId = new Map(response.map((chunk) => [chunk.chunk_id, chunk]));
        for (const ref of batch) {
          const chunk = byId.get(ref.chunk_id);
          if (!chunk) throw new Error(`Ink board chunk ${ref.chunk_id} is missing from the loaded batch.`);
          if (chunk.schema_version !== INK_BOARD_SCHEMA_VERSION || chunk.chunk_id !== ref.chunk_id) {
            throw new Error(`Ink board chunk ${ref.chunk_id} has an unsupported schema.`);
          }
          fetched.set(ref.chunk_id, chunk);
          fetchedBytes += Math.max(ref.byte_length, serializedByteLength(chunk));
        }
        // Verify actual encoded residency per batch, not only after every batch.
        if (retainedBytes + fetchedBytes > CACHE_MAX_BYTES) {
          throw cacheBudgetError(retainedBytes + fetchedBytes);
        }
      } catch (loadError) {
        if (!isLatest()) return;
        setError(loadError);
        throw loadError;
      }
    }

    if (!isLatest()) return;
    if (!session.manifest
      || session.manifest.document_id !== session.documentId
      || session.manifest.revision !== revision) {
      const error = new Error('Ink board revision changed while loading chunks.');
      setError(error);
      throw error;
    }
    if (session.editVersion !== editVersion) {
      const error = new Error('Ink board changed while loading the viewport.');
      setError(error);
      throw error;
    }

    for (const [chunkId, chunk] of fetched) {
      session.chunks.set(chunkId, chunk);
      for (const object of chunk.objects) session.objectChunks.set(object.id, chunkId);
    }
    setError(undefined);
    publishView(session);
  }, [isCurrentSession, publishView, requestMaxBytes]);

  const runViewportQueue = useCallback((session: BoardSessionState) => {
    if (session.loadRunning) return;
    session.loadRunning = true;
    void (async () => {
      try {
        while (true) {
          const request = session.loadPending;
          if (!request) break;
          session.loadPending = null;
          if (!isCurrentSession(session) || request.requestId !== session.viewportRequest) {
            request.resolve();
            continue;
          }
          try {
            await performViewportLoad(session, request.requestId, request.bounds);
            request.resolve();
          } catch (error) {
            request.reject(error);
          }
        }
      } finally {
        session.loadRunning = false;
      }
    })();
  }, [isCurrentSession, performViewportLoad]);

  const loadVisible = useCallback((bounds: InkBoardBounds): Promise<void> => {
    const session = sessionRef.current;
    if (!session.manifest) return Promise.reject(new Error('Ink board is not ready.'));
    const requestId = ++session.viewportRequest;
    const previous = session.loadPending;
    if (previous) previous.resolve();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    session.loadPending = { requestId, bounds, resolve, reject };
    runViewportQueue(session);
    return promise;
  }, [runViewportQueue]);

  const collectDirtyChunks = useCallback((session: BoardSessionState): InkBoardChunk[] => {
    const chunks: InkBoardChunk[] = [];
    for (const chunkId of session.dirty.keys()) {
      const chunk = session.chunks.get(chunkId);
      if (chunk) chunks.push(chunk);
    }
    return chunks;
  }, []);

  const buildDraftRecord = useCallback((
    session: BoardSessionState,
    saveState?: 'conflict' | 'offline',
    baseRevisionOverride?: string,
  ): InkBoardDraftRecord | undefined => {
    const manifest = session.manifest;
    if (!manifest) return undefined;
    const changed = collectDirtyChunks(session);
    const deleted = Array.from(session.deleted);
    if (changed.length === 0 && deleted.length === 0) return undefined;
    const sequence = ++session.sequence;
    session.draftNeedsCleanup = true;
    return {
      document_id: session.documentId,
      owner: session.owner,
      page_id: manifest.surface.page_id,
      base_revision: baseRevisionOverride ?? manifest.revision,
      sequence,
      changed,
      deleted,
      updated_at: Date.now(),
      ...(saveState ? { save_state: saveState } : {}),
    };
  }, [collectDirtyChunks]);

  /**
   * Persist this session's own snapshot. This is allowed for an inactive old
   * session during cleanup; it never reads sessionRef or writes another key.
   */
  const persistSessionDraft = useCallback(async (
    session: BoardSessionState,
  ): Promise<InkBoardDraftRecord | undefined> => {
    if (session.status !== 'ready') return undefined;
    const record = buildDraftRecord(
      session,
      session.saveStatus === 'conflict'
        ? 'conflict'
        : session.saveStatus === 'offline' ? 'offline' : undefined,
    );
    const editVersion = session.editVersion;
    const sequence = session.sequence;
    const cleanConflict = !record && session.saveStatus === 'conflict'
      && !session.inflightSave && !session.activeInput;
    if (!record && (session.inflightSave || (!session.draftNeedsCleanup && !cleanConflict))) return undefined;
    try {
      if (record) {
        await session.journal.persist(record);
      } else {
        await session.journal.discard(
          { document_id: session.documentId },
          sequence,
          session.owner,
        );
        if (session.sequence === sequence) session.draftNeedsCleanup = false;
      }
      const clearedConflict = cleanConflict && session.editVersion === editVersion
        && !session.inflightSave && !session.activeInput
        && session.dirty.size === 0 && session.deleted.size === 0 && !session.draftNeedsCleanup;
      if (isCurrentSession(session) && (session.saveStatus !== 'conflict' || clearedConflict)
        && (!record || (session.saveStatus === 'storage-error' && session.editVersion === editVersion))) {
        session.saveStatus = session.dirty.size > 0 || session.deleted.size > 0
          || session.inflightSave || session.draftNeedsCleanup || session.activeInput
          ? 'pending'
          : 'saved';
        if (clearedConflict) {
          session.retrySave = null;
          session.blockedSave = null;
        }
        setError(undefined);
        publishView(session);
      }
      return record;
    } catch (persistError) {
      if (isCurrentSession(session)) {
        session.saveStatus = isDraftRejected(persistError) ? 'conflict' : 'storage-error';
        setError(persistError);
        publishView(session);
      }
      throw persistError;
    }
  }, [buildDraftRecord, isCurrentSession, publishView]);

  const publishLocalEdit = useCallback((session: BoardSessionState) => {
    if (session.saveStatus !== 'conflict' && session.saveStatus !== 'storage-error') {
      session.saveStatus = session.dirty.size > 0 || session.deleted.size > 0
        || session.inflightSave || session.draftNeedsCleanup
        ? 'pending'
        : 'saved';
    }
    if (session.saveStatus === 'saved') {
      session.retrySave = null;
      session.blockedSave = null;
    }
    publishView(session);
  }, [publishView]);

  const applyObjectEdits = useCallback(async (
    objects: InkBoardObject[],
    allowNew: boolean,
  ) => {
    const session = sessionRef.current;
    const manifest = session.manifest;
    if (!manifest
      || manifest.document_id !== session.documentId
      || objects.length === 0) return;

    let plan: InkBoardChunkEditPlan;
    try {
      // Pure capacity/ownership preflight. It never fetches unloaded chunks;
      // unknown ownership fails unless the caller explicitly allowed new objects.
      plan = planBoardChunkEdits(
        manifest,
        Array.from(session.chunks.values()),
        objects,
        { allowNew },
      );
    } catch (planError) {
      const error = planError instanceof Error && /not in a loaded chunk/i.test(planError.message)
        ? new Error('Ink board object ownership is unknown; its chunk is not loaded.')
        : planError;
      if (isCurrentSession(session)) setError(error);
      throw error;
    }
    if (!isCurrentSession(session)) return;

    if (session.blockedSave) {
      session.blockedSave = null;
      setError(undefined);
    }

    const changedById = new Map(
      plan.changed.map((chunk) => [chunk.chunk_id, chunk] as const),
    );
    const history: BoardHistoryEntry[] = plan.previous.map((entry) => ({
      chunk_id: entry.chunk_id,
      before: entry.previous,
      after: changedById.get(entry.chunk_id),
    }));
    applyChunkChangeSet(
      session,
      new Map(plan.changed.map((chunk) => [chunk.chunk_id, chunk] as const)),
    );

    session.editVersion += 1;
    if (history.length > 0) {
      session.undo.push(history);
      session.redo = [];
    }
    publishLocalEdit(session);
  }, [isCurrentSession, publishLocalEdit]);

  const upsertObjects = useCallback((objects: InkBoardObject[]): Promise<void> => (
    applyObjectEdits(
      objects,
      (sessionRef.current.manifest?.chunks.length ?? -1) === 0,
    )
  ), [applyObjectEdits]);

  const insertObjects = useCallback((objects: InkBoardObject[]): Promise<void> => (
    applyObjectEdits(objects, true)
  ), [applyObjectEdits]);

  const removeObjects = useCallback(async (ids: string[]): Promise<void> => {
    const session = sessionRef.current;
    if (!isCurrentSession(session) || session.status !== 'ready' || !session.manifest) return;
    if (!Array.isArray(ids)) throw new Error('Ink board object ids must be an array.');
    if (ids.length === 0) return;

    const unique = new Set<string>();
    const removedByChunk = new Map<string, Set<string>>();
    try {
      for (const id of ids) {
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error('Ink board object id is invalid.');
        }
        if (unique.has(id)) throw new Error(`Ink board object ${id} is duplicated.`);
        unique.add(id);
        const chunkId = session.objectChunks.get(id);
        const chunk = chunkId ? session.chunks.get(chunkId) : undefined;
        if (!chunkId || !chunk || !chunk.objects.some((object) => object.id === id)) {
          throw new Error('Ink board object ownership is unknown; its chunk is not loaded.');
        }
        let removed = removedByChunk.get(chunkId);
        if (!removed) {
          removed = new Set();
          removedByChunk.set(chunkId, removed);
        }
        removed.add(id);
      }
    } catch (error) {
      if (isCurrentSession(session)) setError(error);
      throw error;
    }

    const changes = new Map<string, InkBoardChunk | undefined>();
    const history: BoardHistoryEntry[] = [];
    for (const [chunkId, removed] of removedByChunk) {
      const before = session.chunks.get(chunkId);
      if (!before) {
        const error = new Error('Ink board object ownership is unknown; its chunk is not loaded.');
        if (isCurrentSession(session)) setError(error);
        throw error;
      }
      const remaining = before.objects.filter((object) => !removed.has(object.id));
      const after = remaining.length > 0
        ? {
          schema_version: before.schema_version,
          chunk_id: before.chunk_id,
          objects: remaining,
        }
        : undefined;
      changes.set(chunkId, after);
      history.push({ chunk_id: chunkId, before, after });
    }

    try {
      validateHistoryCapacity(session, changes);
    } catch (error) {
      if (isCurrentSession(session)) setError(error);
      throw error;
    }
    if (!isCurrentSession(session)) return;

    if (session.blockedSave) {
      session.blockedSave = null;
      setError(undefined);
    }
    applyChunkChangeSet(session, changes);
    session.editVersion += 1;
    session.undo.push(history);
    session.redo = [];
    publishLocalEdit(session);
  }, [isCurrentSession, publishLocalEdit]);

  const applyHistoryEntries = useCallback(async (
    session: BoardSessionState,
    entries: BoardHistoryEntry[],
    direction: 'undo' | 'redo',
  ): Promise<void> => {
    if (!isCurrentSession(session) || session.status !== 'ready' || entries.length === 0) return;
    const stack = direction === 'undo' ? session.undo : session.redo;
    if (stack[stack.length - 1] !== entries) return;

    const changes = new Map<string, InkBoardChunk | undefined>();
    for (const entry of entries) {
      changes.set(entry.chunk_id, direction === 'undo' ? entry.before : entry.after);
    }
    try {
      validateHistoryCapacity(session, changes);
    } catch (error) {
      if (isCurrentSession(session)) setError(error);
      throw error;
    }
    if (!isCurrentSession(session)) return;

    if (session.blockedSave) {
      session.blockedSave = null;
      setError(undefined);
    }
    applyChunkChangeSet(session, changes);
    stack.pop();
    if (direction === 'undo') session.redo.push(entries);
    else session.undo.push(entries);
    session.editVersion += 1;
    publishLocalEdit(session);
  }, [isCurrentSession, publishLocalEdit]);

  const undo = useCallback((): Promise<void> => {
    const session = sessionRef.current;
    const entries = session.undo[session.undo.length - 1];
    if (!entries) return Promise.resolve();
    return applyHistoryEntries(session, entries, 'undo');
  }, [applyHistoryEntries]);

  const redo = useCallback((): Promise<void> => {
    const session = sessionRef.current;
    const entries = session.redo[session.redo.length - 1];
    if (!entries) return Promise.resolve();
    return applyHistoryEntries(session, entries, 'redo');
  }, [applyHistoryEntries]);

  const saveSession = useCallback((session: BoardSessionState): Promise<void> => {
    const queued = serializeBoardSave(session.documentId, async () => {
      // Only the live session may continue a save; a queued or in-flight task
      // from a previous session must not CAS, publish, or delete drafts.
      if (!isCurrentSession(session) || session.status !== 'ready') return;
      const manifestAtStart = session.manifest;
      if (!manifestAtStart || manifestAtStart.document_id !== session.documentId) return;
      if (session.blockedSave) return;

      const rejectJournalFailure = (error: unknown) => {
        if (!isCurrentSession(session)) return;
        if (isDraftRejected(error)) {
          // Ownership/staleness rejection means this session no longer controls
          // the durable draft. Never continue to CAS or pretend it was stored.
          session.retrySave = null;
          session.saveStatus = 'conflict';
          setError(error);
        } else {
          session.saveStatus = 'storage-error';
        }
        publishView(session);
      };

      if (isSaveConflict(session.saveStatus)) {
        session.blockedSave = null;
        const conflictRecord = buildDraftRecord(session, 'conflict');
        if (conflictRecord) {
          try {
            await session.journal.persist(conflictRecord);
          } catch (journalError) {
            rejectJournalFailure(journalError);
            return;
          }
        } else {
          await persistSessionDraft(session);
        }
        if (isCurrentSession(session)) publishView(session);
        return;
      }

      const record = buildDraftRecord(
        session,
        session.saveStatus === 'offline' ? 'offline' : undefined,
      );
      if (!record) {
        await persistSessionDraft(session);
        return;
      }
      // The versions and edit snapshot must belong to the same synchronous
      // moment as the record. Capturing them after the journal await would let
      // a gesture that landed during that await be treated as if it had been
      // part of this CAS payload.
      const versions = new Map<string, number>();
      for (const chunk of record.changed) {
        versions.set(chunk.chunk_id, session.chunkVersions.get(chunk.chunk_id) ?? 0);
      }
      const deletedVersions = new Map<string, number>();
      for (const chunkId of record.deleted) {
        deletedVersions.set(chunkId, session.deletedVersions.get(chunkId) ?? 0);
      }
      const editVersionAtRecord = session.editVersion;
      const epochAtRecord = session.epoch;
      for (const chunk of record.changed) {
        if (serializedByteLength(chunk) > CHUNK_MAX_BYTES) {
          if (isCurrentSession(session)) {
            setError(new Error(`Ink board chunk ${chunk.chunk_id} exceeds the ${CHUNK_MAX_BYTES / MIB} MiB chunk limit.`));
            session.saveStatus = 'offline';
            publishView(session);
          }
          return;
        }
      }

      // Journal first: a storage failure must never be followed by a CAS.
      try {
        await session.journal.persist(record);
      } catch (journalError) {
        rejectJournalFailure(journalError);
        return;
      }
      if (!isCurrentSession(session)) return;

      if (isSaveConflict(session.saveStatus)) {
        publishView(session);
        return;
      }
      const manifestAfterJournal = session.manifest;
      if (!manifestAfterJournal
        || manifestAfterJournal.document_id !== session.documentId
        || manifestAfterJournal.revision !== record.base_revision) {
        session.saveStatus = 'conflict';
        const conflictRecord = buildDraftRecord(session, 'conflict');
        if (conflictRecord) {
          try {
            await session.journal.persist(conflictRecord);
          } catch (journalError) {
            rejectJournalFailure(journalError);
          }
        }
        if (isCurrentSession(session)) publishView(session);
        return;
      }

      const retry = session.retrySave;
      const saveOperationId = retry && sameRetryRequest(retry, record)
        ? retry.operationId
        : operationId();
      session.retrySave = null;
      rememberOwnOperation(session, saveOperationId);
      session.inflightSave = {
        changedVersions: new Map(versions),
        deletedVersions: new Map(deletedVersions),
      };

      session.saveStatus = 'saving';
      publishView(session);
      try {
        const savedManifest = await inkBoardApi.saveChunks({
          document_id: session.documentId,
          expected_revision: record.base_revision,
          operation_id: saveOperationId,
          changed: record.changed,
          deleted: record.deleted,
        });
        session.inflightSave = null;
        // An already-sent CAS may complete after its session is superseded or
        // unmounted. It must not clear another session's draft or publish state.
        if (!isCurrentSession(session)) return;

        const latestManifest = session.manifest;
        const canApplySavedManifest = !latestManifest
          || (latestManifest.document_id === session.documentId
            && latestManifest.revision === record.base_revision);
        if (canApplySavedManifest) {
          session.manifest = savedManifest;
        }
        for (const chunk of record.changed) {
          if ((session.chunkVersions.get(chunk.chunk_id) ?? 0) === versions.get(chunk.chunk_id)) {
            session.dirty.delete(chunk.chunk_id);
          } else if (canApplySavedManifest
            && session.epoch === epochAtRecord
            && !session.chunks.has(chunk.chunk_id)
            && !session.deleted.has(chunk.chunk_id)) {
            // This CAS just made the new chunk canonical, but it was removed
            // locally while the request was in flight. Keep that removal as a
            // pending canonical deletion instead of treating local absence as
            // "no changes".
            session.deleted.add(chunk.chunk_id);
            session.deletedVersions.set(
              chunk.chunk_id,
              (session.deletedVersions.get(chunk.chunk_id) ?? 0) + 1,
            );
          }
        }
        for (const deleted of record.deleted) {
          if ((session.deletedVersions.get(deleted) ?? 0) === deletedVersions.get(deleted)) {
            session.deleted.delete(deleted);
          }
        }

        const pendingBeforeCleanup = session.dirty.size > 0 || session.deleted.size > 0;
        try {
          if (pendingBeforeCleanup) {
            // Edits made while the CAS was in flight were not part of the
            // committed payload. Rewrite the journal at the returned base
            // revision so a restart retries the new delta.
            const rebased = buildDraftRecord(session, undefined, savedManifest.revision);
            if (rebased) await session.journal.persist(rebased);
          } else {
            // Only delete up to the highest sequence this session issued. This
            // includes lifecycle drafts written during the CAS but never a
            // newer owner's draft.
            const throughSequence = session.sequence;
            await session.journal.discard(
              { document_id: session.documentId },
              throughSequence,
              session.owner,
            );
            if (session.sequence === throughSequence) session.draftNeedsCleanup = false;
          }
          if (!isCurrentSession(session)) return;
          // Re-read current dirty/version after the cleanup await. A new edit
          // may have landed while the discard/persist was in flight.
          if (session.dirty.size > 0 || session.deleted.size > 0) {
            const afterCommit = buildDraftRecord(session, undefined, savedManifest.revision);
            if (afterCommit) await session.journal.persist(afterCommit);
          }
        } catch (cleanupError) {
          rejectJournalFailure(cleanupError);
          return;
        }
        if (!isCurrentSession(session)) return;

        session.blockedSave = null;
        session.retrySave = null;
        session.saveStatus = session.dirty.size > 0 || session.deleted.size > 0 || session.draftNeedsCleanup
          ? 'pending'
          : 'saved';
        setError(undefined);
        publishView(session);
      } catch (saveError) {
        const inflight = session.inflightSave;
        session.inflightSave = null;
        if (!isCurrentSession(session)) return;

        // The CAS may have committed before its response was lost. If one of
        // its changed chunks was removed locally while it was in flight, keep
        // that local absence as a pending delete intent instead of replaying
        // the old changed payload or assuming the server still has no chunk.
        if (inflight) {
          let lostPublishedRemoval = false;
          for (const chunk of record.changed) {
            const capturedVersion = inflight.changedVersions.get(chunk.chunk_id);
            if (capturedVersion === undefined) continue;
            if ((session.chunkVersions.get(chunk.chunk_id) ?? 0) === capturedVersion) continue;
            if (session.chunks.has(chunk.chunk_id)) continue;
            if (!session.deleted.has(chunk.chunk_id)) {
              session.deleted.add(chunk.chunk_id);
              session.deletedVersions.set(
                chunk.chunk_id,
                (session.deletedVersions.get(chunk.chunk_id) ?? 0) + 1,
              );
            }
            lostPublishedRemoval = true;
          }
          if (lostPublishedRemoval) {
            session.saveStatus = 'conflict';
            session.retrySave = null;
            session.blockedSave = null;
            const conflictRecord = buildDraftRecord(session, 'conflict');
            if (conflictRecord) {
              try {
                await session.journal.persist(conflictRecord);
              } catch (journalError) {
                rejectJournalFailure(journalError);
              }
            }
            if (isCurrentSession(session)) publishView(session);
            return;
          }
        }

        const apiError = saveError instanceof InkApiError ? saveError : undefined;
        const conflict = apiError?.code === 'REVISION_CONFLICT' || apiError?.code === 'OPERATION_STATE_UNKNOWN';
        if (conflict) {
          session.saveStatus = 'conflict';
          session.blockedSave = null;
          if (apiError?.code === 'REVISION_CONFLICT') session.ownOperations.delete(saveOperationId);
          const conflictRecord = buildDraftRecord(session, 'conflict') ?? record;
          try {
            await session.journal.persist(conflictRecord);
          } catch (journalError) {
            rejectJournalFailure(journalError);
          }
          if (isCurrentSession(session)) {
            onConflictRef.current?.({
              document_id: session.documentId,
              base_revision: record.base_revision,
              remote_revision: apiError?.current_revision,
              draft: conflictRecord,
            });
          }
        } else if (apiError && apiError.retryable === false) {
          // A deterministic rejection will fail identically for the same input.
          // Expose it and block flush from replaying that exact CAS until a new
          // gesture or an explicit remote reload changes the input.
          const inputChangedDuringSave = session.editVersion !== editVersionAtRecord
            || record.changed.some((chunk) => (
              (session.chunkVersions.get(chunk.chunk_id) ?? 0) !== versions.get(chunk.chunk_id)
            ));
          session.retrySave = null;
          session.saveStatus = 'offline';
          setError(apiError);
          if (!inputChangedDuringSave) {
            session.blockedSave = { baseRevision: record.base_revision };
          }
          const blockedRecord = buildDraftRecord(session, 'offline') ?? record;
          try {
            await session.journal.persist(blockedRecord);
          } catch (journalError) {
            rejectJournalFailure(journalError);
          }
        } else {
          session.retrySave = {
            operationId: saveOperationId,
            baseRevision: record.base_revision,
            chunks: record.changed,
            deleted: [...record.deleted],
          };
          session.saveStatus = 'offline';
          const retryRecord = buildDraftRecord(session, 'offline') ?? record;
          try {
            await session.journal.persist(retryRecord);
          } catch (journalError) {
            rejectJournalFailure(journalError);
          }
        }
        if (isCurrentSession(session)) publishView(session);
      }
    });
    return queued;
  }, [buildDraftRecord, isCurrentSession, persistSessionDraft, publishView, rememberOwnOperation]);

  const save = useCallback((): Promise<void> => saveSession(sessionRef.current), [saveSession]);

  const isLocallyDirty = useCallback((session: BoardSessionState): boolean => (
    session.activeInput
    || session.dirty.size > 0
    || session.deleted.size > 0
    || session.saveStatus === 'pending'
    || session.saveStatus === 'saving'
    || session.saveStatus === 'offline'
    || session.saveStatus === 'conflict'
    || session.saveStatus === 'storage-error'
  ), []);

  const flushSession = useCallback(async (session: BoardSessionState) => {
    const epoch = session.epoch;
    const pageId = session.manifest?.surface.page_id;
    const assertSession = () => {
      if (!isCurrentSession(session)
        || session.epoch !== epoch
        || session.manifest?.surface.page_id !== pageId) {
        throw new Error('Ink board session changed.');
      }
    };
    assertSession();
    await awaitBoardSaveQueue(session.documentId);
    assertSession();
    if (session.blockedSave) throw new Error('Ink board has a non-retryable save error.');
    if (session.saveStatus !== 'saved') await saveSession(session);
    else await persistSessionDraft(session);
    assertSession();
    if (session.saveStatus !== 'saved') throw new Error('Ink board has an unsaved draft.');
  }, [isCurrentSession, persistSessionDraft, saveSession]);

  const flush = useCallback((): Promise<void> => flushSession(sessionRef.current), [flushSession]);

  const persistDraft = useCallback((): Promise<InkBoardDraftRecord | undefined> => (
    persistSessionDraft(sessionRef.current)
  ), [persistSessionDraft]);

  const reloadRemote = useCallback(async () => {
    const session = sessionRef.current;
    if (!isCurrentSession(session)) return;
    const editVersion = session.editVersion;
    const throughSequence = session.sequence;
    try {
      await session.journal.discard(
        { document_id: session.documentId },
        throughSequence,
        session.owner,
      );
      if (session.sequence === throughSequence) session.draftNeedsCleanup = false;
    } catch (discardError) {
      if (isDraftRejected(discardError) && isCurrentSession(session)) {
        session.saveStatus = 'conflict';
        setError(discardError);
        publishView(session);
        return;
      }
      // Other storage failures must not block an explicit remote reload.
    }
    if (!isCurrentSession(session) || session.editVersion !== editVersion) return;
    const requestId = ++session.loadRequest;
    const manifest = assertBoardManifest(await inkBoardApi.get({ document_id: session.documentId }));
    if (!isCurrentSession(session)
      || requestId !== session.loadRequest
      || session.editVersion !== editVersion) return;
    session.manifest = manifest;
    session.chunks.clear();
    session.objectChunks.clear();
    session.dirty.clear();
    session.deleted.clear();
    session.chunkVersions.clear();
    session.deletedVersions.clear();
    session.undo = [];
    session.redo = [];
    session.retrySave = null;
    session.blockedSave = null;
    session.inflightSave = null;
    session.saveStatus = 'saved';
    session.epoch += 1;
    setError(undefined);
    publishView(session);
    const bounds = session.visibleBounds;
    if (bounds) await loadVisible(bounds).catch(() => undefined);
  }, [isCurrentSession, loadVisible, publishView]);

  const setCamera = useCallback((next: Partial<InkBoardCamera>) => {
    setCameraState((current) => ({ ...current, ...next }));
  }, []);

  const setActiveInput = useCallback((active: boolean) => {
    sessionState.activeInput = active;
  }, [sessionState]);

  useEffect(() => {
    const session = sessionState;
    session.active = true;
    let cancelled = false;
    const requestId = ++session.loadRequest;
    session.status = 'loading';
    session.saveStatus = 'loading';
    session.retrySave = null;
    session.blockedSave = null;
    session.inflightSave = null;
    if (isCurrentSession(session)) {
      setStatus('loading');
      setSaveStatus('loading');
    }

    void (async () => {
      try {
        const manifest = assertBoardManifest(await inkBoardApi.get({ document_id: session.documentId }));
        let claim: InkBoardDraftClaim;
        try {
          // Claim is the atomic read: it returns the current draft together with
          // the sequence floor and fences any previous owner of this document.
          claim = await session.journal.claim(
            { document_id: session.documentId },
            session.owner,
          );
        } catch (claimError) {
          if (cancelled || !isCurrentSession(session)) return;
          // A failed claim is not "no draft": expose storage-error instead of
          // silently starting clean and saved.
          session.status = 'error';
          session.saveStatus = 'storage-error';
          setStatus('error');
          setSaveStatus('storage-error');
          setError(claimError);
          return;
        }
        if (cancelled || !isCurrentSession(session) || requestId !== session.loadRequest) return;
        const draft = claim.draft;
        session.draftNeedsCleanup = Boolean(draft);

        session.manifest = manifest;
        session.chunks.clear();
        session.objectChunks.clear();
        session.dirty.clear();
        session.deleted.clear();
        session.chunkVersions.clear();
        session.deletedVersions.clear();
        session.undo = [];
        session.redo = [];
        session.sequence = Math.max(
          session.sequence,
          claim.sequence_floor,
          draft?.sequence ?? 0,
        );

        let nextSaveStatus: InkBoardSaveStatus = 'saved';
        if (draft) {
          for (const chunk of draft.changed) {
            session.chunks.set(chunk.chunk_id, chunk);
            for (const object of chunk.objects) session.objectChunks.set(object.id, chunk.chunk_id);
            const ref = manifest.chunks.find((entry) => entry.chunk_id === chunk.chunk_id);
            session.dirty.set(chunk.chunk_id, ref
              ? { chunk_id: chunk.chunk_id, base_blob_hash: ref.blob_hash }
              : { chunk_id: chunk.chunk_id });
          }
          for (const chunkId of draft.deleted) {
            const removed = session.chunks.get(chunkId);
            if (removed) {
              for (const object of removed.objects) {
                if (session.objectChunks.get(object.id) === chunkId) session.objectChunks.delete(object.id);
              }
            }
            session.chunks.delete(chunkId);
            session.deleted.add(chunkId);
            session.deletedVersions.set(
              chunkId,
              (session.deletedVersions.get(chunkId) ?? 0) + 1,
            );
          }
          const revisionChanged = draft.base_revision !== manifest.revision;
          nextSaveStatus = revisionChanged || draft.save_state === 'conflict'
            ? 'conflict'
            : draft.save_state ?? 'pending';
        }

        session.saveStatus = nextSaveStatus;
        session.status = 'ready';
        setError(undefined);
        publishView(session);
        setStatus('ready');

        if (draft && nextSaveStatus === 'conflict') {
          onConflictRef.current?.({
            document_id: session.documentId,
            base_revision: draft.base_revision,
            remote_revision: manifest.revision,
            draft,
          });
        }
      } catch (loadError) {
        if (cancelled || !isCurrentSession(session)) return;
        session.status = 'error';
        setStatus('error');
        setError(loadError);
      }
    })();

    return () => {
      cancelled = true;
      session.active = false;
    };
  }, [sessionState, isCurrentSession, publishView]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<InkChangedEvent>('ink:changed', async ({ payload }) => {
      if (cancelled || !payload) return;
      const session = sessionRef.current;
      if (payload.document_id !== session.documentId) return;
      if (!isCurrentSession(session)) return;
      const current = session.manifest;
      if (!current || current.document_id !== session.documentId) return;

      if (payload.operation_id
        && session.ownOperations.get(payload.operation_id) === session.token) {
        // Own echoes only confirm identity; committed drafts are cleared by the
        // successful CAS cleanup, never by a blind sequence-based delete here.
        session.ownOperations.delete(payload.operation_id);
        return;
      }

      if (payload.revision === current.revision) return;

      if (isLocallyDirty(session)) {
        session.blockedSave = null;
        session.saveStatus = 'conflict';
        const draft = buildDraftRecord(session, 'conflict');
        if (draft) {
          try {
            await session.journal.persist(draft);
          } catch (journalError) {
            if (isCurrentSession(session)) {
              if (isDraftRejected(journalError)) {
                session.saveStatus = 'conflict';
                setError(journalError);
              } else {
                session.saveStatus = 'storage-error';
              }
            }
          }
          if (isCurrentSession(session)) {
            onConflictRef.current?.({
              document_id: session.documentId,
              base_revision: current.revision,
              remote_revision: payload.revision,
              draft,
            });
          }
        }
        if (isCurrentSession(session)) publishView(session);
        return;
      }

      const requestId = ++session.loadRequest;
      const editVersion = session.editVersion;
      try {
        const manifest = await inkBoardApi.get({ document_id: session.documentId });
        const boardManifest = assertBoardManifest(manifest);
        if (cancelled
          || !isCurrentSession(session)
          || requestId !== session.loadRequest) return;
        if (session.editVersion !== editVersion || isLocallyDirty(session)) {
          // A local edit landed while the clean refetch was in flight. Keep the
          // local state and the draft; do not apply or discard the remote one.
          session.blockedSave = null;
          session.saveStatus = 'conflict';
          const draft = buildDraftRecord(session, 'conflict');
          if (draft) {
            try {
              await session.journal.persist(draft);
            } catch (journalError) {
              if (isCurrentSession(session)) {
                if (isDraftRejected(journalError)) {
                  session.saveStatus = 'conflict';
                  setError(journalError);
                } else {
                  session.saveStatus = 'storage-error';
                }
              }
            }
            if (isCurrentSession(session)) {
              onConflictRef.current?.({
                document_id: session.documentId,
                base_revision: session.manifest?.revision ?? current.revision,
                remote_revision: boardManifest.revision,
                draft,
              });
            }
          }
          if (isCurrentSession(session)) publishView(session);
          return;
        }
        if (!session.manifest
          || session.manifest.document_id !== session.documentId
          || session.manifest.revision !== current.revision) {
          // The local revision advanced while the advisory refetch was pending;
          // ignore the now-stale clean snapshot.
          return;
        }
        const latest = session.manifest;
        if (!latest || boardManifest.document_id !== session.documentId) return;
        if (boardManifest.revision === latest.revision) return;

        session.manifest = boardManifest;
        session.chunks.clear();
        session.objectChunks.clear();
        session.dirty.clear();
        session.deleted.clear();
        session.chunkVersions.clear();
        session.deletedVersions.clear();
        session.undo = [];
        session.redo = [];
        session.retrySave = null;
        session.blockedSave = null;
        session.inflightSave = null;
        session.saveStatus = 'saved';
        session.epoch += 1;
        setError(undefined);
        publishView(session);

        const throughSequence = session.sequence;
        try {
          await session.journal.discard(
            { document_id: session.documentId },
            throughSequence,
            session.owner,
          );
          if (session.sequence === throughSequence) session.draftNeedsCleanup = false;
        } catch (discardError) {
          if (isDraftRejected(discardError) && isCurrentSession(session)) {
            session.saveStatus = 'conflict';
            setError(discardError);
            publishView(session);
            return;
          }
          // Other leftovers remain as local residue only.
        }
        if (!isCurrentSession(session)) return;
        if (session.dirty.size > 0 || session.deleted.size > 0) {
          const residue = buildDraftRecord(session, 'offline');
          let residueError: unknown;
          if (residue) {
            try {
              await session.journal.persist(residue);
            } catch (journalError) {
              residueError = journalError;
            }
          }
          if (!isCurrentSession(session)) return;
          if (residueError !== undefined) {
            if (isDraftRejected(residueError)) {
              session.saveStatus = 'conflict';
              setError(residueError);
            } else {
              session.saveStatus = 'storage-error';
            }
          } else {
            session.saveStatus = 'offline';
          }
          publishView(session);
          return;
        }
        const bounds = session.visibleBounds;
        if (bounds) void loadVisible(bounds).catch(() => undefined);
      } catch {
        // A changed event is advisory; keep the current manifest if refetch fails.
      }
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [buildDraftRecord, isCurrentSession, isLocallyDirty, loadVisible, publishView]);

  const sessionIsDirty = useCallback((session: BoardSessionState) => (
    session.activeInput
      || session.dirty.size > 0
      || session.deleted.size > 0
      || session.draftNeedsCleanup
      || (session.saveStatus !== 'saved' && session.saveStatus !== 'loading')
  ), []);
  const protectSessionInput = useCallback((session: BoardSessionState): Promise<InkBoardDraftRecord | undefined> => {
    if (session.inputProtection) return session.inputProtection;
    const pageId = session.manifest?.surface.page_id;
    const epoch = session.epoch;
    const beforeFlush = beforeFlushRef.current;
    const pending = (async () => {
      try {
        if (session.activeInput && pageId) {
          await beforeFlush?.({ documentId: session.documentId, pageId, revisionEpoch: epoch });
        }
      } catch (inputError) {
        await persistSessionDraft(session);
        throw inputError;
      }
      return persistSessionDraft(session);
    })();
    session.inputProtection = pending;
    void pending.finally(() => {
      if (session.inputProtection === pending) session.inputProtection = null;
    }).catch(() => undefined);
    return pending;
  }, [persistSessionDraft]);
  const surfacePageId = sessionState.manifest?.surface.page_id;
  const sessionHandle = useMemo<InkEditorSession | null>(() => {
    if (!surfacePageId) return null;
    const boundSession = sessionState;
    return {
      key: { document_id: boundSession.documentId, page_id: surfacePageId },
      isDirty: () => sessionIsDirty(boundSession),
      flush: async () => {
        const epoch = boundSession.epoch;
        const assertBoundSession = () => {
          if (!isCurrentSession(boundSession)
            || boundSession.epoch !== epoch
            || boundSession.manifest?.surface.page_id !== surfacePageId) {
            throw new Error('Ink board session changed.');
          }
        };
        assertBoundSession();
        await beforeFlushRef.current?.({
          documentId: boundSession.documentId,
          pageId: surfacePageId,
          revisionEpoch: epoch,
        });
        assertBoundSession();
        await flushSession(boundSession);
        assertBoundSession();
      },
      persistDraft: async () => {
        // Cleanup persists its own bound session snapshot even after the
        // session became inactive, but it never reads the current session.
        await protectSessionInput(boundSession);
        return undefined;
      },
    };
  }, [flushSession, isCurrentSession, protectSessionInput, sessionIsDirty, sessionState, surfacePageId]);

  useEffect(() => {
    if (!sessionHandle) return;
    const unregister = registerInkEditorSession(sessionHandle);
    return () => {
      void sessionHandle.persistDraft().catch(() => undefined).finally(unregister);
    };
  }, [sessionHandle]);

  const persistLifecycleDraft = useCallback(() => {
    const session = sessionRef.current;
    if (!session.manifest) return;
    void protectSessionInput(session).catch(() => undefined);
  }, [protectSessionInput]);
  const onPageHide = useCallback(() => {
    persistLifecycleDraft();
  }, [persistLifecycleDraft]);
  const onVisibilityHidden = useCallback(() => {
    if (globalThis.document?.visibilityState !== 'hidden') return;
    persistLifecycleDraft();
  }, [persistLifecycleDraft]);
  useEventRegistry([
    { target: 'window', type: 'pagehide', listener: onPageHide },
    { target: 'document', type: 'visibilitychange', listener: onVisibilityHidden },
  ], [onPageHide, onVisibilityHidden]);

  return {
    status,
    saveStatus,
    manifest: manifestState,
    surface: manifestState?.surface,
    chunks: chunksState,
    dirtyChunks: dirtyChunksState,
    camera,
    revisionEpoch,
    undoDepth,
    redoDepth,
    error,
    loadVisible,
    upsertObjects,
    insertObjects,
    removeObjects,
    undo,
    redo,
    save,
    reloadRemote,
    persistDraft,
    flush,
    setCamera,
    setActiveInput,
  };
}
