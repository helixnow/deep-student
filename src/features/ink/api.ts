import { invoke } from '@tauri-apps/api/core';

import type { InkManifest, InkPage, InkRect, InkRuling } from './types';

export interface InkRenderSpec {
  document_id: string;
  expected_revision: string;
  page_id: string;
  crop?: InkRect;
  long_edge?: number;
}

export type InkExportFormat = 'png' | 'pdf';

export interface InkPrepareSourceRequest {
  source_resource_id: string;
  operation_id: string;
}

export interface InkExportDocumentRequest {
  document_id: string;
  expected_revision: string;
  page_ids: string[];
  format: InkExportFormat;
  operation_id: string;
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
