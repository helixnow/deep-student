import { invoke } from '@tauri-apps/api/core';

import type {
  InkBoardChunk,
  InkBoardManifest,
  InkManifest,
  InkPage,
  InkRect,
  InkRuling,
} from './types';

export interface InkBoardRenderSpec {
  crop: InkRect;
  chunk_ids?: string[];
}

export interface InkRenderSpec {
  document_id: string;
  expected_revision: string;
  page_id: string;
  crop?: InkRect;
  board?: InkBoardRenderSpec;
  long_edge?: number;
}

export type InkExportFormat = 'png' | 'pdf';

export interface InkPrepareSourceRequest {
  source_resource_id: string;
  operation_id: string;
}

export interface InkBoardExportSpec {
  region: InkRect;
  page_width: number;
  page_height: number;
  paginate?: boolean;
}

export interface InkExportDocumentRequest {
  document_id: string;
  expected_revision: string;
  page_ids: string[];
  format: InkExportFormat;
  operation_id: string;
  /** Optional finite board region; paged exports leave this absent. */
  board?: InkBoardExportSpec;
}

export interface InkExportArtifact {
  artifact_id: string;
  document_id: string;
  revision: string;
  page_ids: string[];
  format: InkExportFormat;
  operation_id: string;
  source_hash?: string | null;
  conversion_revision?: string | null;
  mime_type: string;
  file_id: string;
  resource_id: string;
  blob_hash: string;
  content_hash: string;
  open_locator: string;
  created_at: string;
}

export interface InkArtifact {
  artifact_id: string;
  render_id: string;
  document_id: string;
  page_id: string;
  revision: string;
  source_hash?: string | null;
  source_annotation_revision?: string | null;
  conversion_revision?: string | null;
  crop?: InkRect | null;
  width_px: number;
  height_px: number;
  mime_type: string;
  resource_id: string;
  file_id: string;
  blob_hash: string;
  content_hash: string;
  created_at: string;
}

export interface InkCreateRequest {
  title: string;
  ruling: InkRuling;
  width: number;
  height: number;
  operation_id: string;
  folder_id?: string | null;
}

export interface InkGetRequest {
  document_id: string;
}

export interface InkGetPageRequest {
  document_id: string;
  page_id: string;
}

export interface InkSavePageRequest {
  document_id: string;
  expected_revision: string;
  operation_id: string;
  page: InkPage;
}

export interface InkCopyRequest {
  document_id: string;
  title: string;
  operation_id: string;
  folder_id?: string | null;
}

export interface InkAppendPageRequest {
  document_id: string;
  expected_revision: string;
  operation_id: string;
  width: number;
  height: number;
  ruling: InkRuling;
}

export interface InkRenameRequest {
  document_id: string;
  expected_revision: string;
  operation_id: string;
  title: string;
}

export interface InkChangedEvent {
  document_id: string;
  revision: string;
  operation_id: string;
  affected_page_ids: string[];
}

export interface InkCommandErrorPayload {
  code: string;
  message: string;
  hint?: string;
  retryable: boolean;
  current_revision?: string;
}

export class InkApiError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly current_revision?: string;

  constructor(payload: InkCommandErrorPayload) {
    super(payload.message);
    this.name = 'InkApiError';
    this.code = payload.code;
    this.hint = payload.hint;
    this.retryable = payload.retryable;
    this.current_revision = payload.current_revision;
  }
}

function asInkApiError(error: unknown): InkApiError {
  if (error instanceof InkApiError) return error;
  if (error && typeof error === 'object') {
    const payload = error as Partial<InkCommandErrorPayload>;
    if (typeof payload.code === 'string' && typeof payload.message === 'string') {
      return new InkApiError({
        code: payload.code,
        message: payload.message,
        hint: typeof payload.hint === 'string' ? payload.hint : undefined,
        retryable: payload.retryable === true,
        current_revision: typeof payload.current_revision === 'string' ? payload.current_revision : undefined,
      });
    }
  }
  return new InkApiError({
    code: 'INTERNAL',
    message: 'Ink request failed.',
    retryable: false,
  });
}

async function invokeInk<T>(command: string, request: unknown): Promise<T> {
  try {
    return await invoke<T>(command, { request });
  } catch (error) {
    throw asInkApiError(error);
  }
}

export const createInk = (request: InkCreateRequest): Promise<InkManifest> =>
  invokeInk('vfs_ink_create', request);

export const getInk = (request: InkGetRequest): Promise<InkManifest> =>
  invokeInk('vfs_ink_get', request);

export const getInkPage = (request: InkGetPageRequest): Promise<InkPage> =>
  invokeInk('vfs_ink_get_page', request);

export const saveInkPage = (request: InkSavePageRequest): Promise<InkManifest> =>
  invokeInk('vfs_ink_save_page', request);

export const copyInk = (request: InkCopyRequest): Promise<InkManifest> =>
  invokeInk('vfs_ink_copy', request);

export const appendInkPage = (request: InkAppendPageRequest): Promise<InkManifest> =>
  invokeInk('vfs_ink_append_page', request);

export const renameInk = (request: InkRenameRequest): Promise<InkManifest> =>
  invokeInk('vfs_ink_rename', request);

export const prepareSourceInk = (
  request: InkPrepareSourceRequest,
  identity: { session_id?: string; tool_call_id?: string } = {},
): Promise<InkManifest> => invokeInkWithIdentity('vfs_ink_prepare', request, identity);

export const exportInkDocument = (
  request: InkExportDocumentRequest,
  identity: { session_id?: string; tool_call_id?: string } = {},
): Promise<InkExportArtifact> => invokeInkWithIdentity('vfs_ink_export', request, identity);

async function invokeInkWithIdentity<T>(
  command: string,
  request: unknown,
  identity: { session_id?: string; tool_call_id?: string },
): Promise<T> {
  try {
    return await invoke<T>(command, { request, sessionId: identity.session_id, toolCallId: identity.tool_call_id });
  } catch (error) {
    throw asInkApiError(error);
  }
}

export async function renderInkSnapshot(
  request: InkRenderSpec,
  identity: { session_id?: string; tool_call_id?: string } = {},
): Promise<InkArtifact> {
  try {
    return await invoke<InkArtifact>('vfs_ink_render', {
      request,
      sessionId: identity.session_id,
      toolCallId: identity.tool_call_id,
    });
  } catch (error) {
    throw asInkApiError(error);
  }
}

/** Board-only render entry: the caller supplies an explicit signed world crop. */
export function renderInkBoardSnapshot(
  request: InkRenderSpec,
  identity: { session_id?: string; tool_call_id?: string } = {},
): Promise<InkArtifact> {
  if (!request.board || !Number.isFinite(request.board.crop?.width) || request.board.crop.width <= 0
    || !Number.isFinite(request.board.crop?.height) || request.board.crop.height <= 0) {
    return Promise.reject(new InkApiError({
      code: 'INVALID_ARGUMENT',
      message: 'A board render requires a finite positive crop.',
      retryable: false,
    }));
  }
  return renderInkSnapshot(request, identity);
}

/** v2 board create; blank source only. */
export interface InkCreateBoardRequest {
  title: string;
  ruling: InkRuling;
  operation_id: string;
  folder_id?: string | null;
}

/** Per-request chunk read. Callers batch by the 16 MiB request budget. */
export interface InkGetChunksRequest {
  document_id: string;
  expected_revision?: string;
  chunk_ids: string[];
}

/** Atomic chunk delta publish under CAS. */
export interface InkSaveChunksRequest {
  document_id: string;
  expected_revision: string;
  operation_id: string;
  changed: InkBoardChunk[];
  deleted: string[];
}

export const createInkBoard = (request: InkCreateBoardRequest): Promise<InkBoardManifest> =>
  invokeInk('vfs_ink_create_board', request);

export const getInkChunks = (request: InkGetChunksRequest): Promise<InkBoardChunk[]> =>
  invokeInk('vfs_ink_get_chunks', request);

export const saveInkChunks = (request: InkSaveChunksRequest): Promise<InkBoardManifest> =>
  invokeInk('vfs_ink_save_chunks', request);

/** Bounded board z-order summary. `max_z_index` is a decimal string or null. */
export interface InkBoardOverviewRequest {
  document_id: string;
  expected_revision?: string;
}

export interface InkBoardOverview {
  document_id: string;
  revision: string;
  page_id: string;
  max_z_index: string | null;
}

export const getInkBoardOverview = (request: InkBoardOverviewRequest): Promise<InkBoardOverview> =>
  invokeInk('vfs_ink_get_board_overview', request);

/** Board sibling API; the v1 `inkApi` surface stays unchanged. */
export const inkBoardApi = {
  create: createInkBoard,
  get: getInk,
  getChunks: getInkChunks,
  saveChunks: saveInkChunks,
  overview: getInkBoardOverview,
};

export const inkApi = {
  create: createInk,
  get: getInk,
  getPage: getInkPage,
  savePage: saveInkPage,
  copy: copyInk,
  appendPage: appendInkPage,
  rename: renameInk,
  prepareSource: prepareSourceInk,
  exportDocument: exportInkDocument,
  renderSnapshot: renderInkSnapshot,
};
