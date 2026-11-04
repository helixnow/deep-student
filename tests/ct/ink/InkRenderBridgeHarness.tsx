import React, { useEffect, useState } from 'react';
import { dispatchCtEvent } from '../mocks/tauri-event-mock';
import { setCtInvokeHandlers } from '../mocks/tauri-core-mock';
import { registerInkRenderBridge } from '@/features/ink/renderBridge';
import type { InkBoardChunk, InkBoardSurface, InkPage, InkPageRef, InkRect } from '@/features/ink/types';
import { frozenPreparedPdfBackgroundHash, frozenRotatedPdfPageRef, frozenSourceHighlight } from './frozenPageFixture';
import {
  renderBridgeBlankBoardChunks,
  renderBridgeBoardChunks,
  renderBridgeBoardCrop,
  renderBridgeBoardLongEdge,
  renderBridgeBoardSurface,
} from './renderBridgeBoardFixture';

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

type BoardRequestKind =
  | 'valid'
  | 'blank'
  | 'mixed'
  | 'nonfinite-crop'
  | 'world-overflow-crop'
  | 'missing-chunks'
  | 'duplicate-chunk'
  | 'negative-object-z'
  | 'duplicate-z'
  | 'unknown-payload-field'
  | 'unknown-surface-field'
  | 'unknown-chunk-field'
  | 'unknown-content-field'
  | 'long-edge';

interface BoardRenderPayload {
  schema_version: number;
  surface: InkBoardSurface;
  crop: InkRect;
  chunks?: InkBoardChunk[];
}

const BOARD_DOCUMENT_ID = 'document-ct-board-1';
const BOARD_REVISION = 'revision-board-frozen-3';

function negativeZChunk(): InkBoardChunk {
  return {
    schema_version: 2,
    chunk_id: 'board-chunk-negative-z',
    objects: [{
      id: 'board-negative-z',
      author: 'user',
      created_at: 1,
      z_index: -1,
      content: {
        kind: 'stroke',
        samples: [{ x: 0, y: 0, pressure: 0.5 }],
        style: { tool: 'pen', color: '#000000', width: 2, pressure_enabled: false },
      },
    }],
  };
}

/** Two unique objects in different chunks share z_index 30. */
function duplicateZChunks(): InkBoardChunk[] {
  const first = renderBridgeBoardChunks[0].objects[0];
  const second = renderBridgeBoardChunks[1].objects[1];
  return [
    {
      schema_version: 2,
      chunk_id: 'board-chunk-duplicate-z-a',
      objects: [{ ...first, id: 'board-duplicate-z-a', z_index: 30 }],
    },
    {
      schema_version: 2,
      chunk_id: 'board-chunk-duplicate-z-b',
      objects: [{ ...second, id: 'board-duplicate-z-b', z_index: 30 }],
    },
  ];
}

function unknownContentChunk(): Record<string, unknown> {
  const source = renderBridgeBoardChunks[0].objects[0];
  const content = source.content as unknown as Record<string, unknown>;
  return {
    schema_version: 2,
    chunk_id: 'board-chunk-unknown-content-field',
    objects: [{ ...source, content: { ...content, unexpected_content_field: true } }],
  };
}

function boardPayload(kind: BoardRequestKind): Record<string, unknown> {
  const payload: BoardRenderPayload = {
    schema_version: 2,
    surface: renderBridgeBoardSurface,
    crop: { ...renderBridgeBoardCrop },
    chunks: renderBridgeBoardChunks,
  };
  switch (kind) {
    case 'blank':
      return { ...payload, chunks: renderBridgeBlankBoardChunks };
    case 'nonfinite-crop':
      return { ...payload, crop: { ...payload.crop, x: Number.NaN } };
    case 'world-overflow-crop':
      return { ...payload, crop: { ...payload.crop, x: -10_000_001 } };
    case 'missing-chunks':
      return {
        schema_version: payload.schema_version,
        surface: payload.surface,
        crop: payload.crop,
      };
    case 'duplicate-chunk':
      return { ...payload, chunks: [renderBridgeBoardChunks[0], { ...renderBridgeBoardChunks[0] }] };
    case 'negative-object-z':
      return { ...payload, chunks: [negativeZChunk()] };
    case 'duplicate-z':
      return { ...payload, chunks: duplicateZChunks() };
    case 'unknown-payload-field':
      return { ...payload, unexpected_payload_field: true };
    case 'unknown-surface-field':
      return { ...payload, surface: { ...payload.surface, unexpected_surface_field: true } };
    case 'unknown-chunk-field':
      return { ...payload, chunks: [{ ...renderBridgeBoardChunks[0], unexpected_chunk_field: true }] };
    case 'unknown-content-field':
      return { ...payload, chunks: [unknownContentChunk()] };
    default:
      return payload;
  }
}

function boardRequest(kind: BoardRequestKind): Record<string, unknown> {
  const request: Record<string, unknown> = {
    request_id: `request-ct-board-${kind}`,
    render_id: `render-ct-board-${kind}`,
    document_id: BOARD_DOCUMENT_ID,
    revision: BOARD_REVISION,
    page_ref: null,
    page: null,
    board: boardPayload(kind),
    crop: null,
    long_edge: kind === 'long-edge' ? 4096 : renderBridgeBoardLongEdge,
    highlights: [],
  };
  if (kind === 'mixed') {
    request.page_ref = imagePageRef;
    request.page = pageFor(imagePageRef);
  }
  return request;
}

const boardRequestKinds: BoardRequestKind[] = [
  'valid',
  'blank',
  'mixed',
  'nonfinite-crop',
  'world-overflow-crop',
  'missing-chunks',
  'duplicate-chunk',
  'negative-object-z',
  'duplicate-z',
  'unknown-payload-field',
  'unknown-surface-field',
  'unknown-chunk-field',
  'unknown-content-field',
  'long-edge',
];

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

  const requestBoard = (kind: BoardRequestKind) => {
    const request = boardRequest(kind);
    if (window.__INK_RENDER_CT__) {
      window.__INK_RENDER_CT__ = { request, pngBytes: [] };
    }
    void dispatchCtEvent('ink:render-request', request);
  };

  return <div>
    <button data-testid="ink-render-bridge-image-request" disabled={!ready} onClick={() => requestRender(false)}>Render image page</button>
    <button data-testid="ink-render-bridge-pdf-request" disabled={!ready} onClick={() => requestRender(true)}>Render prepared PDF PNG page</button>
    {boardRequestKinds.map((kind) => (
      <button
        key={kind}
        data-testid={`ink-render-bridge-board-${kind}-request`}
        disabled={!ready}
        onClick={() => requestBoard(kind)}
      >
        Render board {kind}
      </button>
    ))}
  </div>;
}
