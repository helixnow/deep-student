/**
 * Strict schema-v2 board fixtures for the `.dsink` root-route CT gate.
 *
 * These fixtures only model the IPC boundary (`dstu_get` plus the existing ink
 * commands). The production `DstuFileViewer` and whatever editor it resolves
 * stay unmocked; a v2 manifest is expected to reach a board viewport instead
 * of the paged `InkEditor` route.
 */
import type { DstuNode } from '@/dstu/types';
import { boardObjectBounds } from '@/features/ink/boardRenderer';
import { inkBoardDraftJournal, type InkBoardDraftRecord } from '@/features/ink/boardDrafts';
import {
  INK_BOARD_SCHEMA_VERSION,
  INK_MIME,
  type InkBoardBounds,
  type InkBoardChunk,
  type InkBoardChunkRef,
  type InkBoardManifest,
  type InkBoardObject,
  type InkBoardSurface,
  type InkManifest,
  type InkPage,
  type InkPageRef,
} from '@/features/ink/types';
import type { CtInvokeHandler } from '../mocks/tauri-core-mock';

export type InkBoardEditorMode = 'board-v2' | 'paged-v1';

/** Must stay aligned with the board renderer's hard cap. */
export const INK_BOARD_CT_MAX_VIEWPORT_PIXELS = 16_000_000;

export const INK_BOARD_CT_CHUNK_ID = 'board_ct_chunk0001';
export const INK_BOARD_CT_BASE_OBJECT_ID = 'board_ct_object0001';
export const INK_BOARD_CT_PAGE_ID = 'board_ct_page0001';
export const INK_BOARD_CT_PAGED_PAGE_ONE = 'board_ct_paged_page0001';
export const INK_BOARD_CT_PAGED_PAGE_TWO = 'board_ct_paged_page0002';

const BASE_SURFACE_BOUNDS: InkBoardBounds = {
  x: -1_000_000,
  y: -1_000_000,
  width: 2_000_000,
  height: 2_000_000,
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function finiteBounds(bounds: InkBoardBounds | null): InkBoardBounds | undefined {
  if (!bounds) return undefined;
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return undefined;
  if (bounds.width <= 0 || bounds.height <= 0) return undefined;
  return bounds;
}

function unionBounds(objects: InkBoardObject[]): InkBoardBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const object of objects) {
    const bounds = finiteBounds(boardObjectBounds(object));
    if (!bounds) continue;
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || maxX <= minX || maxY <= minY) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function chunkRef(chunk: InkBoardChunk, revision: string): InkBoardChunkRef {
  const samples = chunk.objects.reduce(
    (total, object) => total + (object.content.kind === 'stroke' ? object.content.samples.length : 0),
    0,
  );
  return {
    chunk_id: chunk.chunk_id,
    blob_hash: `hash-${chunk.chunk_id}-${revision}`,
    byte_length: Math.max(1, new TextEncoder().encode(JSON.stringify(chunk)).byteLength),
    object_count: chunk.objects.length,
    sample_count: samples,
    bounds: unionBounds(chunk.objects),
  };
}

export function createBoardObjectFixture(): InkBoardObject {
  return {
    id: INK_BOARD_CT_BASE_OBJECT_ID,
    author: 'user',
    created_at: 1,
    z_index: 0,
    content: {
      kind: 'stroke',
      samples: [
        { x: -120, y: -80, pressure: 0.5, elapsed_ms: 0 },
        { x: -40, y: -84, pressure: 0.5, elapsed_ms: 8 },
      ],
      style: { tool: 'pen', color: '#000000', width: 3, pressure_enabled: false },
    },
  };
}

export function createBoardChunkFixture(): InkBoardChunk {
  return {
    schema_version: INK_BOARD_SCHEMA_VERSION,
    chunk_id: INK_BOARD_CT_CHUNK_ID,
    objects: [createBoardObjectFixture()],
  };
}

export function createBoardSurfaceFixture(): InkBoardSurface {
  return {
    kind: 'board',
    page_id: INK_BOARD_CT_PAGE_ID,
    ruling: 'grid',
    bounds: { ...BASE_SURFACE_BOUNDS },
  };
}

/** Canonical v2 manifest: blank source, `pages: []`, surface and strict chunk refs. */
export function createBoardManifestFixture(documentId: string): InkBoardManifest {
  const chunk = createBoardChunkFixture();
  return {
    schema_version: INK_BOARD_SCHEMA_VERSION,
    document_id: documentId,
    revision: 'rev-ct-1',
    title: 'Board CT fixture',
    source: { kind: 'blank' },
    pages: [],
    surface: createBoardSurfaceFixture(),
    chunks: [chunkRef(chunk, 'rev-ct-1')],
  };
}

function pagedPageRef(pageId: string, width: number, height: number): InkPageRef {
  return {
    page_id: pageId,
    width,
    height,
    background: { kind: 'blank', ruling: 'blank' },
    page_blob_hash: `hash-${pageId}`,
  };
}

/** Fixed paged v1 manifest; the root route must keep using the existing InkEditor. */
export function createPagedManifestFixture(documentId: string): InkManifest {
  return {
    schema_version: 1,
    document_id: documentId,
    revision: 'page-rev-ct-1',
    title: 'Paged CT fixture',
    source: { kind: 'blank' },
    pages: [
      pagedPageRef(INK_BOARD_CT_PAGED_PAGE_ONE, 320, 240),
      pagedPageRef(INK_BOARD_CT_PAGED_PAGE_TWO, 320, 240),
    ],
  };
}

export function createPagedPageFixtures(): InkPage[] {
  return [
    { schema_version: 1, page_id: INK_BOARD_CT_PAGED_PAGE_ONE, objects: [] },
    { schema_version: 1, page_id: INK_BOARD_CT_PAGED_PAGE_TWO, objects: [] },
  ];
}

function dstuNode(documentId: string, mode: InkBoardEditorMode, path: string): DstuNode {
  return {
    id: documentId,
    path,
    name: mode === 'board-v2' ? 'board-ct.dsink' : 'paged-ct.dsink',
    type: 'file',
    size: 0,
    createdAt: 1,
    updatedAt: 1,
    sourceId: documentId,
    previewType: 'text',
    metadata: {
      mimeType: INK_MIME,
      canonicalMime: INK_MIME,
    },
  };
}

export function createInkBoardCtDocumentId(mode: InkBoardEditorMode, label = 'doc'): string {
  const prefix = mode === 'board-v2' ? 'ink_board_ct' : 'ink_paged_ct';
  return `${prefix}_${label}_${globalThis.crypto.randomUUID()}`;
}

export interface InkBoardCtInvokeCall {
  command: string;
  request?: unknown;
}

export interface InkBoardCtSaveChunksRequest {
  document_id: string;
  expected_revision: string;
  operation_id: string;
  changed: InkBoardChunk[];
  deleted: string[];
}

export interface InkBoardCtExportRequest {
  document_id: string;
  expected_revision: string;
  page_ids: string[];
  format: 'png' | 'pdf';
  operation_id: string;
  board?: {
    region: InkBoardBounds;
    page_width: number;
    page_height: number;
    paginate?: boolean;
  };
}

export interface InkBoardCtSnapshot {
  mode: InkBoardEditorMode;
  documentId: string;
  revision: string;
  manifest: InkBoardManifest | InkManifest;
  chunks: InkBoardChunk[];
  objects: InkBoardObject[];
  calls: InkBoardCtInvokeCall[];
  saveChunkRequests: InkBoardCtSaveChunksRequest[];
  saveChunkCalls: number;
  savePageCalls: number;
  createCalls: string[];
  journalAtCas: Array<InkBoardDraftRecord | undefined>;
  clipboardText: string;
  exportRequests: InkBoardCtExportRequest[];
}

export interface InkBoardCtBackend {
  handlers: Record<string, CtInvokeHandler>;
  snapshot(): InkBoardCtSnapshot;
  readDraft(): Promise<InkBoardDraftRecord | undefined>;
  setClipboard(text: string): void;
}

/**
 * IPC fixture backend. Every mutation is observable through `snapshot()`, which
 * the harness exposes on `window.__INK_BOARD_CT__` for the spec.
 */
export function createInkBoardEditorBackend(
  mode: InkBoardEditorMode,
  documentId: string,
): InkBoardCtBackend {
  const path = `/${documentId}`;
  let revisionNumber = 1;
  let manifest: InkBoardManifest | InkManifest = mode === 'board-v2'
    ? createBoardManifestFixture(documentId)
    : createPagedManifestFixture(documentId);
  const initialChunks: Array<[string, InkBoardChunk]> = mode === 'board-v2'
    ? [[INK_BOARD_CT_CHUNK_ID, createBoardChunkFixture()]]
    : [];
  const chunks = new Map<string, InkBoardChunk>(initialChunks);
  const initialPages: Array<[string, InkPage]> = mode === 'paged-v1'
    ? createPagedPageFixtures().map((page): [string, InkPage] => [page.page_id, page])
    : [];
  const pages = new Map<string, InkPage>(initialPages);
  const calls: InkBoardCtInvokeCall[] = [];
  const saveChunkRequests: InkBoardCtSaveChunksRequest[] = [];
  const createCalls: string[] = [];
  const journalAtCas: Array<InkBoardDraftRecord | undefined> = [];
  const exportRequests: InkBoardCtExportRequest[] = [];
  let clipboardText = '';
  let saveChunkCalls = 0;
  let savePageCalls = 0;

  const record = (command: string, payload: Record<string, unknown> | undefined) => {
    calls.push({
      command,
      request: payload?.request,
    });
  };

  const nextBoardManifest = (): InkBoardManifest => {
    revisionNumber += 1;
    const revision = `rev-ct-${revisionNumber}`;
    const next: InkBoardManifest = {
      ...(manifest as InkBoardManifest),
      revision,
      chunks: Array.from(chunks.values()).map((chunk) => chunkRef(chunk, revision)),
    };
    manifest = next;
    return next;
  };

  const nextPagedManifest = (): InkManifest => {
    revisionNumber += 1;
    const revision = `page-rev-ct-${revisionNumber}`;
    const next: InkManifest = {
      ...(manifest as InkManifest),
      revision,
      pages: (manifest as InkManifest).pages.map((pageRef) => (
        pages.has(pageRef.page_id)
          ? { ...pageRef, page_blob_hash: `saved-${revision}-${pageRef.page_id}` }
          : pageRef
      )),
    };
    manifest = next;
    return next;
  };

  const rejectCreate = (command: string): never => {
    createCalls.push(command);
    throw new Error(`The ${mode} root route must not create or upgrade a document.`);
  };

  const rawHandlers: Record<string, CtInvokeHandler> = {
    'plugin:clipboard-manager|write_text': (_command, payload) => {
      clipboardText = typeof payload?.text === 'string' ? payload.text : '';
      return null;
    },
    'plugin:clipboard-manager|read_text': () => clipboardText,
    dstu_get: (_command, payload) => {
      if (payload?.path !== path) throw new Error('The fixture only serves its own DSTU path.');
      return dstuNode(documentId, mode, path);
    },
    vfs_ink_get: () => clone(manifest),
    vfs_ink_get_board_overview: (_command, payload) => {
      const request = payload?.request as { document_id?: string; expected_revision?: string } | undefined;
      if (mode !== 'board-v2' || request?.document_id !== documentId) {
        throw new Error('Unexpected board overview request.');
      }
      if (request.expected_revision && request.expected_revision !== manifest.revision) {
        throw new Error('The CT board overview revision is stale.');
      }
      const maxZIndex = Array.from(chunks.values()).reduce((maximum, chunk) => (
        chunk.objects.reduce((value, object) => Math.max(value, object.z_index), maximum)
      ), -1);
      return {
        document_id: documentId,
        revision: manifest.revision,
        page_id: INK_BOARD_CT_PAGE_ID,
        max_z_index: maxZIndex < 0 ? null : String(maxZIndex),
      };
    },
    vfs_ink_get_chunks: (_command, payload) => {
      const request = payload?.request as { chunk_ids?: string[] } | undefined;
      const ids = Array.isArray(request?.chunk_ids) ? request.chunk_ids : [];
      return ids
        .map((chunkId) => chunks.get(chunkId))
        .filter((chunk): chunk is InkBoardChunk => Boolean(chunk))
        .map((chunk) => clone(chunk));
    },
    vfs_ink_save_chunks: async (_command, payload) => {
      const request = payload?.request as InkBoardCtSaveChunksRequest | undefined;
      if (!request || request.document_id !== documentId) throw new Error('Unexpected board save document.');
      if (request.expected_revision !== manifest.revision) {
        throw new Error('The CT board revision changed before CAS.');
      }
      saveChunkCalls += 1;
      saveChunkRequests.push(clone(request));
      // Read the real IndexedDB journal while the CAS is executing. A draft
      // observed here proves the production session journaled before CAS.
      const draft = await inkBoardDraftJournal.read({ document_id: documentId }).catch(() => undefined);
      journalAtCas.push(draft ? clone(draft) : undefined);
      for (const chunk of request.changed) chunks.set(chunk.chunk_id, clone(chunk));
      for (const chunkId of request.deleted) chunks.delete(chunkId);
      return clone(nextBoardManifest());
    },
    vfs_ink_export: (_command, payload) => {
      const request = payload?.request as InkBoardCtExportRequest | undefined;
      if (!request || request.document_id !== documentId) throw new Error('Unexpected export document.');
      exportRequests.push(clone(request));
      const pageId = request.page_ids[0] ?? INK_BOARD_CT_PAGE_ID;
      return {
        artifact_id: `artifact-export-${exportRequests.length}`,
        render_id: `render-export-${exportRequests.length}`,
        document_id: documentId,
        page_id: pageId,
        page_ids: [...request.page_ids],
        revision: manifest.revision,
        format: request.format,
        operation_id: request.operation_id,
        mime_type: request.format === 'pdf' ? 'application/pdf' : 'image/png',
        width_px: Math.max(1, Math.round(request.board?.region.width ?? 1)),
        height_px: Math.max(1, Math.round(request.board?.region.height ?? 1)),
        resource_id: `resource-export-${exportRequests.length}`,
        file_id: `file-board-export-${exportRequests.length}`,
        blob_hash: `hash-export-${exportRequests.length}`,
        content_hash: `content-export-${exportRequests.length}`,
        open_locator: `/file-board-export-${exportRequests.length}`,
        created_at: '2026-11-04T00:00:00Z',
      };
    },
    vfs_ink_get_page: (_command, payload) => {
      const request = payload?.request as { page_id?: string } | undefined;
      const page = request?.page_id ? pages.get(request.page_id) : undefined;
      if (!page) throw new Error('Unknown fixture paged page.');
      return clone(page);
    },
    vfs_ink_save_page: async (_command, payload) => {
      const request = payload?.request as { page?: InkPage; expected_revision?: string } | undefined;
      if (mode !== 'paged-v1' || !request?.page) throw new Error('Unexpected paged save.');
      if ((manifest as InkManifest).revision !== request.expected_revision) {
        throw new Error('The CT paged revision changed before save.');
      }
      savePageCalls += 1;
      pages.set(request.page.page_id, clone(request.page));
      return clone(nextPagedManifest());
    },
    vfs_ink_append_page: () => rejectCreate('vfs_ink_append_page'),
    vfs_ink_create: () => rejectCreate('vfs_ink_create'),
    vfs_ink_create_board: () => rejectCreate('vfs_ink_create_board'),
  };

  // Record every boundary call in fixture order so specs can prove that
  // navigation never reaches a save/create command.
  const handlers: Record<string, CtInvokeHandler> = {};
  for (const [command, handler] of Object.entries(rawHandlers)) {
    handlers[command] = (invokedCommand, payload) => {
      record(invokedCommand, payload);
      return handler(invokedCommand, payload);
    };
  }

  return {
    handlers,
    snapshot() {
      const chunkValues = Array.from(chunks.values()).map((chunk) => clone(chunk));
      return {
        mode,
        documentId,
        revision: manifest.revision,
        manifest: clone(manifest),
        chunks: chunkValues,
        objects: chunkValues.flatMap((chunk) => chunk.objects),
        calls: clone(calls),
        saveChunkRequests: clone(saveChunkRequests),
        saveChunkCalls,
        savePageCalls,
        createCalls: [...createCalls],
        journalAtCas: journalAtCas.map((draft) => (draft ? clone(draft) : undefined)),
        clipboardText,
        exportRequests: clone(exportRequests),
      };
    },
    readDraft() {
      return inkBoardDraftJournal.read({ document_id: documentId });
    },
    setClipboard(text: string) {
      clipboardText = text;
    },
  };
}
