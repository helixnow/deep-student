import type { DstuListOptions, DstuNode } from '@/dstu/types';
import type { InkCreateBoardRequest, InkCreateRequest } from '@/features/ink/api';
import type { InkBoardChunk, InkBoardManifest, InkManifest, InkObject, InkPage } from '@/features/ink/types';
import { INK_MIME } from '@/features/ink/types';
import {
  createInkBoardCtDocumentId,
  createInkBoardEditorBackend,
  type InkBoardCtBackend,
  type InkBoardCtSaveChunksRequest,
  type InkBoardEditorMode,
} from '../ink-board/fixtures';
import { getCtInvokeCalls, type CtInvokeHandler } from '../mocks/tauri-core-mock';

export const NOTEBOOK_CT_TEXT_COUNT = 28;
export const NOTEBOOK_CT_PDF_COUNT = 105;
export const NOTEBOOK_CT_LIST_ERROR = 'Notebook CT file page unavailable';

export interface NotebookCtSeed {
  pagedId: string;
  boardId: string;
  textId: string;
  pdfIds: string[];
  folderPath: string;
}

export interface NotebookCtListCall {
  path: string;
  options: DstuListOptions;
  returnedIds: string[];
  error?: string;
}

export interface NotebookCtDocumentState {
  documentId: string;
  mode: InkBoardEditorMode;
  created: boolean;
  node: DstuNode;
  revision: string;
  manifestReads: number;
  pageReads: number;
  chunkReads: number;
  overviewReads: number;
  saveAttempts: number;
  savePageCalls: number;
  saveChunkCalls: number;
}

export interface NotebookCtCreateCall {
  command: 'vfs_ink_create' | 'vfs_ink_create_board';
  request: InkCreateRequest | InkCreateBoardRequest;
  documentId?: string;
}

export interface NotebookCtSnapshot {
  seed: NotebookCtSeed;
  nodes: DstuNode[];
  listCalls: NotebookCtListCall[];
  createCalls: NotebookCtCreateCall[];
  documents: NotebookCtDocumentState[];
  pendingSaves: number;
  commands: string[];
}

export interface NotebookCtCanonical {
  documentId: string;
  mode: InkBoardEditorMode;
  manifest: InkManifest | InkBoardManifest;
  pages: InkPage[];
  chunks: InkBoardChunk[];
  objects: InkObject[];
}

export interface NotebookCtBackendOptions {
  label?: string;
  holdSaves?: boolean;
  listFailures?: number;
}

export interface NotebookCtBackend {
  handlers: Record<string, CtInvokeHandler>;
  snapshot(): NotebookCtSnapshot;
  readCanonical(documentId: string): Promise<NotebookCtCanonical>;
  releaseSaves(): void;
}

interface NotebookCtDocument {
  backend: InkBoardCtBackend;
  state: NotebookCtDocumentState;
  creation?: InkCreateRequest | InkCreateBoardRequest;
}

const copy = <T,>(value: T): T => structuredClone(value);
const parentPath = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
const normalizePath = (path: string) => `/${path.split('/').filter(Boolean).join('/')}`;

function listNodes(nodes: DstuNode[], path: string, options: DstuListOptions): DstuNode[] {
  let directory = normalizePath(path);
  const folderId = options.folderId;
  if (folderId && !['root', 'null'].includes(folderId)) {
    const folder = nodes.find((node) => node.id === folderId && node.type === 'folder');
    if (!folder) throw new Error(`Unknown Notebook CT folder: ${folderId}`);
    directory = folder.path;
  }
  const globalTypeList = Boolean(options.typeFilter) && directory === '/';
  const prefix = directory === '/' ? '/' : `${directory}/`;
  const query = options.search?.trim().toLocaleLowerCase();
  const results = nodes.filter((node) => {
    if (!globalTypeList && !(options.recursive ? node.path.startsWith(prefix) : parentPath(node.path) === directory)) return false;
    if (options.typeFilter && node.type !== options.typeFilter) return false;
    if (options.types?.length && !options.types.includes(node.type)) return false;
    if (query && !`${node.name} ${node.path}`.toLocaleLowerCase().includes(query)) return false;
    return true;
  });
  const sortBy = options.sortBy ?? 'updatedAt';
  const direction = options.sortOrder === 'asc' ? 1 : -1;
  results.sort((a, b) => {
    const order = sortBy === 'name' ? a.name.localeCompare(b.name) : a[sortBy] - b[sortBy];
    return order * direction || a.id.localeCompare(b.id);
  });
  const offset = Math.max(0, options.offset ?? 0);
  return copy(results.slice(offset, options.limit === undefined ? undefined : offset + Math.max(0, options.limit)));
}

function publicManifest(document: NotebookCtDocument, manifest = document.backend.snapshot().manifest): InkManifest | InkBoardManifest {
  manifest.title = document.state.node.name.replace(/\.dsink$/i, '');
  if (document.creation) {
    if (manifest.schema_version === 2) {
      (manifest as InkBoardManifest).surface.ruling = document.creation.ruling;
    } else {
      const request = document.creation as InkCreateRequest;
      manifest.pages = manifest.pages.slice(0, 1).map((page) => ({
        ...page,
        width: request.width,
        height: request.height,
        background: { kind: 'blank', ruling: request.ruling },
      }));
    }
  }
  return manifest;
}

export function createNotebookCtBackend({ label = 'library', holdSaves = false, listFailures = 0 }: NotebookCtBackendOptions = {}): NotebookCtBackend {
  const namespace = crypto.randomUUID();
  const folderPath = '/Notebook courses/Term one';
  const pagedId = createInkBoardCtDocumentId('paged-v1', `notebook-${label}-existing`);
  const boardId = createInkBoardCtDocumentId('board-v2', `notebook-${label}-existing`);
  const textId = `note_notebook_ct_${namespace}_0`;
  const pdfIds = Array.from({ length: NOTEBOOK_CT_PDF_COUNT }, (_, index) => `file_notebook_ct_pdf_${namespace}_${index}`);
  const seed: NotebookCtSeed = { pagedId, boardId, textId, pdfIds, folderPath };
  const nodes: DstuNode[] = [];
  const documents = new Map<string, NotebookCtDocument>();
  const listCalls: NotebookCtListCall[] = [];
  const createCalls: NotebookCtCreateCall[] = [];
  let remainingFailures = listFailures;
  let savesHeld = holdSaves;
  let clock = 1_800_000_000_000;
  const pending = new Set<() => void>();

  const node = (id: string, name: string, type: DstuNode['type'], path: string, updatedAt: number, mimeType?: string): DstuNode => ({
    id, sourceId: id, name, type, path, createdAt: 1, updatedAt,
    ...(mimeType ? { metadata: { mimeType, canonicalMime: mimeType } } : {}),
  });
  nodes.push(
    node(`folder_notebook_ct_${namespace}`, 'Notebook courses', 'folder', '/Notebook courses', 1),
    node(`folder_notebook_ct_term_${namespace}`, 'Term one', 'folder', folderPath, 1),
  );
  for (let index = 0; index < NOTEBOOK_CT_TEXT_COUNT; index += 1) {
    const id = index === 0 ? textId : `note_notebook_ct_${namespace}_${index}`;
    nodes.push(node(id, index === 0 ? 'Archive revision notes' : `Lesson notes ${index}`, 'note', `${folderPath}/${id}`, 2_000 - index));
  }
  for (const [index, id] of pdfIds.entries()) {
    nodes.push({
      ...node(id, `Archive reference ${index}.pdf`, 'file', index === 0 ? `/${id}` : `${folderPath}/${id}`, 10_000 - index, 'application/pdf'),
      previewType: 'pdf',
    });
  }

  const register = (mode: InkBoardEditorMode, entry: DstuNode, creation?: InkCreateRequest | InkCreateBoardRequest) => {
    const backend = createInkBoardEditorBackend(mode, entry.id);
    const document: NotebookCtDocument = {
      backend,
      creation,
      state: {
        documentId: entry.id, mode, created: Boolean(creation), node: entry,
        revision: backend.snapshot().revision,
        manifestReads: 0, pageReads: 0, chunkReads: 0, overviewReads: 0,
        saveAttempts: 0, savePageCalls: 0, saveChunkCalls: 0,
      },
    };
    documents.set(entry.id, document);
    nodes.push(entry);
    return document;
  };
  register('paged-v1', node(pagedId, 'Archive calculus.dsink', 'file', `${folderPath}/${pagedId}`, 2, INK_MIME));
  register('board-v2', node(boardId, 'Archive ideas.dsink', 'file', `${folderPath}/${boardId}`, 1, INK_MIME));

  const findDocument = (payload: Record<string, unknown> | undefined) => {
    const request = payload?.request as { document_id?: string } | undefined;
    const document = request?.document_id ? documents.get(request.document_id) : undefined;
    if (!document) throw new Error('Unknown Notebook CT document');
    return document;
  };

  const create: CtInvokeHandler = async (command, payload) => {
    const request = copy(payload?.request as InkCreateRequest | InkCreateBoardRequest);
    if (!request?.operation_id || !request.title) throw new Error('Notebook CT create requires title and operation_id');
    const mode = command === 'vfs_ink_create_board' ? 'board-v2' : 'paged-v1';
    if (mode === 'paged-v1' && (!('width' in request) || request.width <= 0 || request.height <= 0)) {
      throw new Error('Notebook CT paged create requires positive dimensions');
    }
    const call: NotebookCtCreateCall = { command: command as NotebookCtCreateCall['command'], request };
    createCalls.push(call);
    const documentId = createInkBoardCtDocumentId(mode, `notebook-${label}-created`);
    const folder = request.folder_id ? nodes.find((entry) => entry.id === request.folder_id && entry.type === 'folder') : undefined;
    if (request.folder_id && !folder) throw new Error('Unknown Notebook CT create folder');
    const document = register(mode, node(documentId, `${request.title}.dsink`, 'file', `${folder?.path ?? ''}/${documentId}`, ++clock, INK_MIME), request);
    if (mode === 'board-v2') {
      const initial = document.backend.snapshot();
      await document.backend.handlers.vfs_ink_save_chunks('vfs_ink_save_chunks', { request: {
        document_id: documentId,
        expected_revision: initial.revision,
        operation_id: `notebook-ct-empty-${crypto.randomUUID()}`,
        changed: [],
        deleted: initial.chunks.map((chunk) => chunk.chunk_id),
      } satisfies InkBoardCtSaveChunksRequest });
    }
    document.state.revision = document.backend.snapshot().revision;
    call.documentId = documentId;
    return publicManifest(document);
  };

  const handlers: Record<string, CtInvokeHandler> = {
    dstu_list: (_command, payload) => {
      const path = typeof payload?.path === 'string' ? payload.path : '/';
      const options = copy((payload?.options ?? {}) as DstuListOptions);
      const call: NotebookCtListCall = { path, options, returnedIds: [] };
      listCalls.push(call);
      if (options.typeFilter === 'file' && options.offset === 100 && remainingFailures > 0) {
        remainingFailures -= 1;
        call.error = NOTEBOOK_CT_LIST_ERROR;
        throw new Error(NOTEBOOK_CT_LIST_ERROR);
      }
      const results = listNodes(nodes, path, options);
      call.returnedIds = results.map((entry) => entry.id);
      return results;
    },
    dstu_get: (_command, payload) => {
      const entry = nodes.find((candidate) => candidate.path === payload?.path || `/${candidate.id}` === payload?.path);
      return entry ? copy(entry) : null;
    },
    vfs_ink_create: create,
    vfs_ink_create_board: create,
  };

  for (const command of ['vfs_ink_get', 'vfs_ink_get_page', 'vfs_ink_get_chunks', 'vfs_ink_get_board_overview', 'vfs_ink_save_page', 'vfs_ink_save_chunks']) {
    handlers[command] = async (invokedCommand, payload) => {
      const document = findDocument(payload);
      const request = payload?.request as { expected_revision?: string; page_id?: string; page?: InkPage };
      const boardCommand = ['vfs_ink_get_chunks', 'vfs_ink_get_board_overview', 'vfs_ink_save_chunks'].includes(command);
      const pagedCommand = ['vfs_ink_get_page', 'vfs_ink_save_page'].includes(command);
      if ((boardCommand && document.state.mode !== 'board-v2') || (pagedCommand && document.state.mode !== 'paged-v1')) {
        throw new Error('Notebook CT command does not match the document schema');
      }
      if (request.expected_revision && request.expected_revision !== document.backend.snapshot().revision) {
        throw new Error('Notebook CT command used a stale revision');
      }
      if (pagedCommand && !publicManifest(document).pages.some((page) => page.page_id === (request.page?.page_id ?? request.page_id))) {
        throw new Error('Notebook CT command used an unknown page');
      }
      if (command === 'vfs_ink_get') document.state.manifestReads += 1;
      if (command === 'vfs_ink_get_page') document.state.pageReads += 1;
      if (command === 'vfs_ink_get_chunks') document.state.chunkReads += 1;
      if (command === 'vfs_ink_get_board_overview') document.state.overviewReads += 1;
      const saving = command === 'vfs_ink_save_page' || command === 'vfs_ink_save_chunks';
      if (saving) {
        document.state.saveAttempts += 1;
        if (savesHeld) await new Promise<void>((resolve) => {
          const release = () => { pending.delete(release); resolve(); };
          pending.add(release);
        });
      }
      const result = await document.backend.handlers[command](invokedCommand, payload);
      if (saving) {
        if (command === 'vfs_ink_save_page') document.state.savePageCalls += 1;
        else document.state.saveChunkCalls += 1;
        document.state.node.updatedAt = ++clock;
        document.state.revision = document.backend.snapshot().revision;
      }
      return command === 'vfs_ink_get' || saving ? publicManifest(document, result as InkManifest | InkBoardManifest) : result;
    };
  }
  for (const command of ['vfs_ink_render', 'vfs_ink_export', 'vfs_ink_prepare', 'chat_v2_send_message', 'chat_v2_continue_message', 'chat_v2_retry_message']) {
    handlers[command] = () => { throw new Error(`Notebook acceptance must not invoke ${command}`); };
  }

  return {
    handlers,
    snapshot: () => ({
      seed: copy(seed), nodes: copy(nodes), listCalls: copy(listCalls), createCalls: copy(createCalls),
      documents: [...documents.values()].map((document) => copy(document.state)),
      pendingSaves: pending.size,
      commands: getCtInvokeCalls().map((call) => call.command),
    }),
    async readCanonical(documentId) {
      const document = documents.get(documentId);
      if (!document) throw new Error('Unknown Notebook CT canonical document');
      const current = document.backend.snapshot();
      const manifest = publicManifest(document, current.manifest);
      const pages = document.state.mode === 'paged-v1' ? await Promise.all(manifest.pages.map((page) => (
        document.backend.handlers.vfs_ink_get_page('vfs_ink_get_page', { request: { document_id: documentId, page_id: page.page_id } }) as Promise<InkPage> | InkPage
      ))) : [];
      const chunks = current.chunks;
      return copy({
        documentId, mode: document.state.mode, manifest, pages, chunks,
        objects: document.state.mode === 'board-v2' ? chunks.flatMap((chunk) => chunk.objects) : pages.flatMap((page) => page.objects),
      });
    },
    releaseSaves() {
      savesHeld = false;
      [...pending].forEach((release) => release());
    },
  };
}
