import React, { useEffect, useState } from 'react';
import { dispatchCtEvent } from '../mocks/tauri-event-mock';
import { setCtInvokeHandlers } from '../mocks/tauri-core-mock';
import { registerInkRenderBridge } from '@/features/ink/renderBridge';
import type { InkPage, InkPageRef } from '@/features/ink/types';
import { frozenPreparedPdfBackgroundHash, frozenRotatedPdfPageRef, frozenSourceHighlight } from './frozenPageFixture';

const imagePageRef: InkPageRef = {
  page_id: 'render-bridge-page',
  width: 64,
  height: 48,
  background: { kind: 'image', blob_hash: 'frozen-background-hash' },
  page_blob_hash: 'frozen-page-hash',
};

function pageFor(pageRef: InkPageRef): InkPage {
  return {
    schema_version: 1,
    page_id: pageRef.page_id,
    objects: [{
      id: 'render-bridge-red-rect',
      author: 'ai',
      created_at: 1,
      content: { kind: 'rect', rect: { x: 20, y: 14, width: 16, height: 16 }, color: '#ff0000', width: 4 },
    }],
  };
}

function makeBackgroundDataUrl(): string {
  const background = document.createElement('canvas');
  background.width = 120;
  background.height = 160;
  const context = background.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable');
  context.fillStyle = '#dddddd';
  context.fillRect(0, 0, 120, 160);
  return background.toDataURL('image/png');
}

declare global {
  interface Window {
    __INK_RENDER_CT__?: {
      request?: unknown;
      result?: Record<string, unknown>;
      pngBytes?: number[];
      failure?: { code?: string; message?: string; stack?: string };
    };
  }
}

export function InkRenderBridgeHarness() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const dataUrl = makeBackgroundDataUrl();
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    window.__INK_RENDER_CT__ = { pngBytes: [] };
    setCtInvokeHandlers({
      vfs_get_blob_base64: (_command, payload) => {
        const hash = (payload as { blobHash?: string } | undefined)?.blobHash;
        if (hash !== 'frozen-background-hash' && hash !== frozenPreparedPdfBackgroundHash) throw new Error('Unknown frozen fixture blob');
        return { base64, mimeType: 'image/png', size: atob(base64).length };
      },
      staged_upload_begin: () => 'render-bridge-upload',
      staged_upload_append: (_command, payload) => {
        const bytes = new Uint8Array(payload as unknown as ArrayLike<number>);
        window.__INK_RENDER_CT__?.pngBytes?.push(...bytes);
        return bytes.length;
      },
      staged_upload_abort: () => undefined,
      vfs_ink_render_result: (_command, payload) => {
        const response = (payload as unknown as { response: Record<string, unknown> }).response;
        if (window.__INK_RENDER_CT__) {
          window.__INK_RENDER_CT__.result = { request: window.__INK_RENDER_CT__.request, result: response };
          if (typeof response.error_code === 'string' || typeof response.error_message === 'string') {
            window.__INK_RENDER_CT__.failure = {
              code: String(response.error_code ?? ''),
              message: String(response.error_message ?? ''),
              stack: String(response.error_stack ?? ''),
            };
          }
        }
      },
    });
    let unregister: (() => void) | undefined;
    let active = true;
    void registerInkRenderBridge().then((stop) => {
      unregister = stop;
      if (active) setReady(true);
      else stop();
    });
    return () => {
      active = false;
      unregister?.();
    };
  }, []);

  const requestRender = (preparedPdf: boolean) => {
    const pageRef = preparedPdf ? frozenRotatedPdfPageRef : imagePageRef;
    const request = {
      request_id: preparedPdf ? 'request-ct-pdf-1' : 'request-ct-image-1',
      render_id: preparedPdf ? 'render-ct-pdf-1' : 'render-ct-image-1',
      document_id: 'document-ct-1',
      revision: 'revision-frozen-7',
      page_ref: pageRef,
      page: pageFor(pageRef),
      long_edge: preparedPdf ? 160 : 64,
      highlights: preparedPdf ? [frozenSourceHighlight] : [],
      background: preparedPdf
        ? { kind: 'pdf_page' as const, blob_hash: frozenPreparedPdfBackgroundHash, source_page_index: 0 }
        : { kind: 'image' as const, blob_hash: 'frozen-background-hash' },
    };
    if (window.__INK_RENDER_CT__) {
      window.__INK_RENDER_CT__ = { request, pngBytes: [] };
    }
    void dispatchCtEvent('ink:render-request', request);
  };

  return <div>
    <button data-testid="ink-render-bridge-image-request" disabled={!ready} onClick={() => requestRender(false)}>Render image page</button>
    <button data-testid="ink-render-bridge-pdf-request" disabled={!ready} onClick={() => requestRender(true)}>Render prepared PDF PNG page</button>
  </div>;
}
