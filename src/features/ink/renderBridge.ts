import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { renderInkPage } from './renderer';
import { flushInkEditor } from './editorSession';
import { loadInkBackground } from './background';
import { composeSourceHighlights } from './sourceHighlights';
import { stageBlobUpload, abortStagedUpload } from '@/utils/stagedUpload';
import type { InkManifest, InkPage, InkPageRef, InkRect } from './types';

export type InkRenderBackground =
  | { kind: 'image'; blob_hash: string }
  | { kind: 'pdf_page'; blob_hash: string; source_page_index: number };

export interface InkRenderRequest {
  request_id: string;
  render_id: string;
  document_id: string;
  revision: string;
  page_ref: InkPageRef;
  page: InkPage;
  crop?: InkRect;
  long_edge: number;
  highlights: Array<Record<string, unknown>>;
  source_annotation_revision?: string;
  background?: InkRenderBackground;
  session_id?: string;
  tool_call_id?: string;
}

export interface InkRenderResponse {
  request_id: string;
  render_id: string;
  session_id?: string;
  tool_call_id?: string;
  staged_upload_id?: string;
  width_px?: number;
  height_px?: number;
  error_code?: string;
  error_message?: string;
  error_stack?: string;
}

export interface InkFrozenRenderInputs {
  revision: string;
  source: InkManifest['source'];
  page_ref: InkPageRef;
  page: InkPage;
  highlights: Array<Record<string, unknown>>;
  source_annotation_revision?: string;
}

export async function getFrozenInkRenderInputs(
  documentId: string,
  expectedRevision: string,
  pageId: string,
): Promise<InkFrozenRenderInputs> {
  const inputs = await invoke<InkFrozenRenderInputs>('vfs_ink_get_render_inputs', {
    documentId,
    expectedRevision,
    pageId,
  });
  return inputs;
}

class InkRenderBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'InkRenderBridgeError';
  }
}

function errorResponse(request: InkRenderRequest, error: unknown): InkRenderResponse {
  const code = error instanceof InkRenderBridgeError ? error.code : 'RENDER_UNAVAILABLE';
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2048);
  return {
    request_id: request.request_id,
    render_id: request.render_id,
    session_id: request.session_id,
    tool_call_id: request.tool_call_id,
    error_code: code,
    error_message: message,
    error_stack: error instanceof Error ? error.stack?.slice(0, 8192) : undefined,
  };
}


function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new InkRenderBridgeError('RENDER_UNAVAILABLE', 'Canvas could not encode the Ink PNG.'));
    }, 'image/png');
  });
}

export async function handleInkRenderRequest(request: InkRenderRequest): Promise<InkRenderResponse> {
  let stagedUploadId: string | undefined;
  let backgroundLease: Awaited<ReturnType<typeof loadInkBackground>> | undefined;
  let composedBackground: HTMLCanvasElement | undefined;
  try {
    if (!request.request_id || !request.render_id || !request.document_id
      || request.page.page_id !== request.page_ref.page_id
      || !Number.isInteger(request.long_edge) || request.long_edge < 1 || request.long_edge > 2048
      || (request.session_id !== undefined) !== (request.tool_call_id !== undefined)) {
      throw new InkRenderBridgeError('INVALID_ARGUMENT', 'Frozen Ink render request is invalid.');
    }
    backgroundLease = await loadInkBackground(request.page_ref);
    composedBackground = composeSourceHighlights(backgroundLease.background, request.page_ref, request.highlights);
    const background = composedBackground ?? backgroundLease.background;

    const crop = request.crop ?? { x: 0, y: 0, width: request.page_ref.width, height: request.page_ref.height };
    const scale = request.long_edge / Math.max(crop.width, crop.height);
    const canvas = window.document.createElement('canvas');
    renderInkPage(canvas, request.page_ref, request.page, {
      background,
      crop: request.crop,
      scale,
      max_pixels: 16_000_000,
    });
    const png = await canvasPng(canvas);
    if (png.size === 0 || png.size > 4 * 1024 * 1024) {
      throw new InkRenderBridgeError('LIMIT_EXCEEDED', 'Rendered PNG exceeds the 4 MiB snapshot limit.');
    }
    stagedUploadId = await stageBlobUpload(png, { name: 'ink-render.png' });
    const response: InkRenderResponse = {
      request_id: request.request_id,
      render_id: request.render_id,
      session_id: request.session_id,
      tool_call_id: request.tool_call_id,
      staged_upload_id: stagedUploadId,
      width_px: canvas.width,
      height_px: canvas.height,
    };
    try {
      await invoke('vfs_ink_render_result', { response });
    } catch (error) {
      await abortStagedUpload(stagedUploadId);
      stagedUploadId = undefined;
      throw error;
    }
    return response;
  } catch (error) {
    if (stagedUploadId) await abortStagedUpload(stagedUploadId);
    throw error instanceof InkRenderBridgeError
      ? error
      : new InkRenderBridgeError('RENDER_UNAVAILABLE', error instanceof Error ? error.message : String(error));
  } finally {
    backgroundLease?.dispose();
    if (composedBackground) {
      composedBackground.width = 0;
      composedBackground.height = 0;
    }
  }
}

async function reportRenderFailure(request: InkRenderRequest, error: unknown): Promise<void> {
  try {
    await invoke('vfs_ink_render_result', { response: errorResponse(request, error) });
  } catch (reportError) {
    console.error('[InkRenderBridge] Failed to report render failure to Rust:', reportError);
  }
}

let bridgeRegistration: Promise<() => void> | undefined;
let bridgeOwners = 0;

export async function registerInkRenderBridge(): Promise<() => void> {
  if (!bridgeRegistration) {
    bridgeRegistration = (async () => {
      const stopRender = await listen<InkRenderRequest>('ink:render-request', async ({ payload }) => {
        try {
          await handleInkRenderRequest(payload);
        } catch (error) {
          await reportRenderFailure(payload, error);
        }
      });
      try {
        const stopFlush = await listen<{ request_id: string; document_id: string }>('ink:flush-request', async ({ payload }) => {
          try {
            const result = await flushInkEditor(payload.document_id);
            await invoke('vfs_ink_flush_result', {
              response: {
                request_id: payload.request_id,
                document_id: payload.document_id,
                ok: result.ok,
                error_code: result.ok === false ? result.code : undefined,
              },
            });
          } catch (error) {
            try {
              await invoke('vfs_ink_flush_result', {
                response: {
                  request_id: payload.request_id,
                  document_id: payload.document_id,
                  ok: false,
                  error_code: 'EDITOR_BUSY',
                },
              });
            } catch (reportError) {
              console.error('[InkRenderBridge] Failed to report editor flush failure to Rust:', reportError, error);
            }
          }
        });
        return () => {
          stopRender();
          stopFlush();
        };
      } catch (error) {
        stopRender();
        throw error;
      }
    })();
  }
  bridgeOwners += 1;
  let stop: () => void;
  try {
    stop = await bridgeRegistration;
  } catch (error) {
    bridgeOwners -= 1;
    bridgeRegistration = undefined;
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    bridgeOwners -= 1;
    if (bridgeOwners === 0) {
      stop();
      bridgeRegistration = undefined;
    }
  };
}
