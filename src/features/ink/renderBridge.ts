import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { renderInkPage } from './renderer';
import { renderInkBoard } from './boardRenderer';
import { assertBoardObject, exactBoardKeys } from './boardChunkEdits';
import { flushInkEditor } from './editorSession';
import { loadInkBackground } from './background';
import { composeSourceHighlights } from './sourceHighlights';
import { stageBlobUpload, abortStagedUpload } from '@/utils/stagedUpload';
import type { InkBoardRenderSpec } from './api';
import {
  INK_BOARD_LIMITS,
  INK_BOARD_SCHEMA_VERSION,
  INK_LIMITS,
  type InkBoardChunk,
  type InkBoardObject,
  type InkBoardSurface,
  type InkManifest,
  type InkPage,
  type InkPageRef,
  type InkRect,
} from './types';

export type InkRenderBackground =
  | { kind: 'image'; blob_hash: string }
  | { kind: 'pdf_page'; blob_hash: string; source_page_index: number };

/** Frozen v2 board payload carried by the render event, never coerced to a page. */
export interface InkBoardRenderPayload {
  schema_version: number;
  surface: InkBoardSurface;
  crop: InkRect;
  chunks: InkBoardChunk[];
}

export interface InkRenderRequest {
  request_id: string;
  render_id: string;
  document_id: string;
  revision: string;
  page_ref?: InkPageRef | null;
  page?: InkPage | null;
  board?: InkBoardRenderPayload | null;
  crop?: InkRect | null;
  long_edge: number;
  highlights: Array<Record<string, unknown>>;
  source_annotation_revision?: string;
  background?: InkRenderBackground | null;
  session_id?: string | null;
  tool_call_id?: string | null;
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

/** Board-only frozen inputs; page_ref/page are intentionally absent. */
export interface InkFrozenBoardRenderInputs {
  revision: string;
  source: { kind: 'blank' };
  board: InkBoardRenderPayload;
  highlights: Array<Record<string, unknown>>;
  source_annotation_revision?: string;
}

export async function getFrozenInkRenderInputs(
  documentId: string,
  expectedRevision: string,
  pageId: string,
): Promise<InkFrozenRenderInputs> {
  const raw = await invoke<unknown>('vfs_ink_get_render_inputs', {
    documentId,
    expectedRevision,
    pageId,
  });
  const response = exactKeysOrInvalid(
    raw,
    ['revision', 'source', 'page_ref', 'page', 'highlights'],
    ['source_annotation_revision'],
  );
  if (typeof response.revision !== 'string' || response.revision !== expectedRevision) {
    invalidArgument('Frozen Ink paged render revision does not match.');
  }
  const pageRef = response.page_ref;
  const page = response.page;
  if (!isRecord(pageRef) || !isRecord(page)
    || typeof pageRef.page_id !== 'string' || typeof page.page_id !== 'string'
    || pageRef.page_id !== pageId || page.page_id !== pageId) {
    invalidArgument('Frozen Ink paged render page identity is invalid.');
  }
  if (!isRecord(response.source)) {
    invalidArgument('Frozen Ink paged render source is invalid.');
  }
  const highlights = response.highlights;
  if (!Array.isArray(highlights)) {
    invalidArgument('Frozen Ink render highlights are invalid.');
  }
  const annotationRev = response.source_annotation_revision;
  const base: InkFrozenRenderInputs = {
    revision: response.revision,
    source: response.source as InkManifest['source'],
    page_ref: pageRef as unknown as InkPageRef,
    page: page as unknown as InkPage,
    highlights: highlights as Array<Record<string, unknown>>,
  };
  if (typeof annotationRev === 'string') return { ...base, source_annotation_revision: annotationRev };
  if (annotationRev === undefined) return base;
  return invalidArgument('Frozen Ink source annotation revision is invalid.');
}

export async function getFrozenInkBoardRenderInputs(
  documentId: string,
  expectedRevision: string,
  surfaceId: string,
  board: InkBoardRenderSpec,
): Promise<InkFrozenBoardRenderInputs> {
  const raw = await invoke<unknown>('vfs_ink_get_render_inputs', {
    documentId,
    expectedRevision,
    pageId: surfaceId,
    board,
  });
  const response = exactKeysOrInvalid(
    raw,
    ['revision', 'source', 'board', 'highlights'],
    ['source_annotation_revision'],
  );
  if (typeof response.revision !== 'string' || response.revision !== expectedRevision) {
    invalidArgument('Frozen Ink board render revision does not match.');
  }
  const source = exactKeysOrInvalid(response.source, ['kind']);
  if (source.kind !== 'blank') {
    invalidArgument('Frozen Ink board render source must be blank.');
  }
  const validatedBoard = validateFrozenBoardPayload(response.board);
  if (validatedBoard.surface.page_id !== surfaceId) {
    invalidArgument('Frozen Ink board render surface identity is invalid.');
  }
  const highlights = response.highlights;
  if (!Array.isArray(highlights)) {
    invalidArgument('Frozen Ink render highlights are invalid.');
  }
  const annotationRev = response.source_annotation_revision;
  const base: InkFrozenBoardRenderInputs = {
    revision: response.revision,
    source: { kind: 'blank' },
    board: {
      schema_version: INK_BOARD_SCHEMA_VERSION,
      surface: validatedBoard.surface,
      crop: validatedBoard.crop,
      chunks: validatedBoard.chunks,
    },
    highlights: highlights as Array<Record<string, unknown>>,
  };
  if (typeof annotationRev === 'string') return { ...base, source_annotation_revision: annotationRev };
  if (annotationRev === undefined) return base;
  return invalidArgument('Frozen Ink source annotation revision is invalid.');
}

function validateFrozenBoardPayload(value: unknown): ValidatedBoardPayload {
  try {
    return validateBoardPayload(value);
  } catch (error) {
    invalidArgument(error instanceof Error ? error.message : 'Frozen Ink board render payload is invalid.');
  }
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
    session_id: request.session_id ?? undefined,
    tool_call_id: request.tool_call_id ?? undefined,
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

const MAX_LONG_EDGE = 2048;
const MAX_RENDER_PIXELS = 16_000_000;
/** One board render carries at most 16 MiB of chunk JSON, matching Rust. */
const BOARD_RENDER_JSON_MAX_BYTES = 16 * 1024 * 1024;
let textEncoder: TextEncoder | undefined;

function invalidArgument(message: string): never {
  throw new InkRenderBridgeError('INVALID_ARGUMENT', message);
}

function limitExceeded(message: string): never {
  throw new InkRenderBridgeError('LIMIT_EXCEEDED', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function requireFinite(value: unknown, label: string): number {
  if (!finiteNumber(value)) invalidArgument(`${label} must be a finite number.`);
  return value;
}

function exactKeysOrInvalid(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  try {
    return exactBoardKeys(value, required, optional);
  } catch (error) {
    invalidArgument(error instanceof Error ? error.message : 'Ink board render payload is invalid.');
  }
}

function validateWorldRect(value: unknown, label: string): InkRect {
  const record = exactKeysOrInvalid(value, ['x', 'y', 'width', 'height']);
  const x = requireFinite(record.x, `${label}.x`);
  const y = requireFinite(record.y, `${label}.y`);
  const width = requireFinite(record.width, `${label}.width`);
  const height = requireFinite(record.height, `${label}.height`);
  if (width <= 0 || height <= 0) {
    invalidArgument(`${label} must have positive width and height.`);
  }
  const worldLimit = INK_BOARD_LIMITS.world_limit;
  if (x < -worldLimit || y < -worldLimit || x + width > worldLimit || y + height > worldLimit) {
    invalidArgument(`${label} is outside the finite board world.`);
  }
  return { x, y, width, height };
}

function validateBoardSurface(value: unknown): InkBoardSurface {
  const record = exactKeysOrInvalid(value, ['kind', 'page_id', 'ruling', 'bounds']);
  if (record.kind !== 'board') {
    invalidArgument('Ink board render surface must be a board surface.');
  }
  const pageId = record.page_id;
  if (typeof pageId !== 'string' || pageId.trim().length === 0) {
    invalidArgument('Ink board render surface page_id is required.');
  }
  if (pageId.length > INK_LIMITS.id_max_chars) {
    invalidArgument('Ink board render surface page_id exceeds the id limit.');
  }
  const ruling = record.ruling;
  if (ruling !== 'blank' && ruling !== 'lined' && ruling !== 'grid') {
    invalidArgument('Ink board render surface ruling is invalid.');
  }
  return {
    kind: 'board',
    page_id: pageId,
    ruling,
    bounds: validateWorldRect(record.bounds, 'Ink board surface bounds'),
  };
}

function jsonByteLength(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') return null;
    textEncoder ??= new TextEncoder();
    return textEncoder.encode(json).byteLength;
  } catch {
    return null;
  }
}

function validateBoardObject(value: unknown): InkBoardObject {
  try {
    assertBoardObject(value);
  } catch (error) {
    invalidArgument(error instanceof Error ? error.message : 'Ink board object is invalid.');
  }
  return value as InkBoardObject;
}

function rawStrokeSampleCount(value: unknown): number | null {
  if (!isRecord(value) || !isRecord(value.content) || value.content.kind !== 'stroke') return null;
  return Array.isArray(value.content.samples) ? value.content.samples.length : null;
}

interface BoardChunkSummary {
  chunk: InkBoardChunk;
  bytes: number;
  objects: number;
  samples: number;
}

function validateBoardChunk(
  value: unknown,
  chunkIds: Set<string>,
  objectIds: Set<string>,
  zIndexes: Set<number>,
): BoardChunkSummary {
  const record = exactKeysOrInvalid(value, ['schema_version', 'chunk_id', 'objects']);
  if (record.schema_version !== INK_BOARD_SCHEMA_VERSION) {
    invalidArgument('Ink board render chunk must use schema v2.');
  }
  const rawChunkId = record.chunk_id;
  if (typeof rawChunkId !== 'string' || rawChunkId.trim().length === 0) {
    invalidArgument('Ink board render chunk_id is required.');
  }
  const chunkId = rawChunkId;
  if (chunkId.length > INK_LIMITS.id_max_chars) {
    invalidArgument('Ink board render chunk_id exceeds the id limit.');
  }
  if (chunkIds.has(chunkId)) {
    invalidArgument(`Ink board render chunk ${chunkId} appears more than once.`);
  }
  chunkIds.add(chunkId);
  const rawObjects = record.objects;
  if (!Array.isArray(rawObjects)) {
    invalidArgument(`Ink board render chunk ${chunkId} requires an objects array.`);
  }
  const chunkObjects = rawObjects;
  if (chunkObjects.length > INK_BOARD_LIMITS.chunk_objects_max) {
    limitExceeded('Ink board render chunk exceeds the object limit.');
  }

  const objects: InkBoardObject[] = [];
  let samples = 0;
  for (const rawObject of chunkObjects) {
    const rawSamples = rawStrokeSampleCount(rawObject);
    if (rawSamples !== null && rawSamples > INK_BOARD_LIMITS.chunk_samples_max) {
      limitExceeded('Ink board render object exceeds the sample limit.');
    }
    const object = validateBoardObject(rawObject);
    if (objectIds.has(object.id)) {
      invalidArgument(`Ink board render object ${object.id} appears more than once.`);
    }
    objectIds.add(object.id);
    if (zIndexes.has(object.z_index)) {
      invalidArgument(`Ink board render z_index ${object.z_index} appears more than once.`);
    }
    zIndexes.add(object.z_index);
    objects.push(object);
    if (object.content.kind === 'stroke') {
      samples += object.content.samples.length;
      if (samples > INK_BOARD_LIMITS.chunk_samples_max) {
        limitExceeded('Ink board render chunk exceeds the sample limit.');
      }
    }
  }

  // Budget the received chunk before any rebuild, so known-key payload bytes
  // cannot disappear through normalization.
  const bytes = jsonByteLength(record);
  if (bytes === null) invalidArgument('Ink board render chunk is not serializable.');
  if (bytes > INK_BOARD_LIMITS.chunk_max_bytes) {
    limitExceeded('Ink board render chunk exceeds the 8 MiB chunk limit.');
  }
  const chunk: InkBoardChunk = {
    schema_version: INK_BOARD_SCHEMA_VERSION,
    chunk_id: chunkId,
    objects,
  };
  return { chunk, bytes, objects: objects.length, samples };
}

interface ValidatedBoardPayload {
  surface: InkBoardSurface;
  crop: InkRect;
  chunks: InkBoardChunk[];
}

function validateBoardPayload(value: unknown): ValidatedBoardPayload {
  const record = exactKeysOrInvalid(value, ['schema_version', 'surface', 'crop', 'chunks']);
  if (record.schema_version !== INK_BOARD_SCHEMA_VERSION) {
    invalidArgument('Ink board render payload must use schema v2.');
  }
  const surface = validateBoardSurface(record.surface);
  const crop = validateWorldRect(record.crop, 'Ink board render crop');
  const rawChunks = record.chunks;
  if (!Array.isArray(rawChunks)) {
    invalidArgument('Ink board render payload requires a chunks array.');
  }
  const chunkInput = rawChunks;
  if (chunkInput.length > INK_BOARD_LIMITS.chunks_max) {
    limitExceeded('Ink board render payload exceeds the chunk count limit.');
  }

  const chunkIds = new Set<string>();
  const objectIds = new Set<string>();
  const zIndexes = new Set<number>();
  const chunks: InkBoardChunk[] = [];
  let totalBytes = 0;
  let totalObjects = 0;
  let totalSamples = 0;
  for (const rawChunk of chunkInput) {
    const summary = validateBoardChunk(rawChunk, chunkIds, objectIds, zIndexes);
    chunks.push(summary.chunk);
    totalBytes += summary.bytes;
    totalObjects += summary.objects;
    totalSamples += summary.samples;
    if (totalBytes > BOARD_RENDER_JSON_MAX_BYTES) {
      limitExceeded('Ink board render payload exceeds the 16 MiB request limit.');
    }
    if (totalObjects > INK_BOARD_LIMITS.objects_max) {
      limitExceeded('Ink board render payload exceeds the object limit.');
    }
    if (totalSamples > INK_BOARD_LIMITS.samples_max) {
      limitExceeded('Ink board render payload exceeds the sample limit.');
    }
  }
  return { surface, crop, chunks };
}

type ValidatedRenderMode =
  | { kind: 'paged'; pageRef: InkPageRef; page: InkPage }
  | { kind: 'board'; board: ValidatedBoardPayload };

function validatePagedCrop(crop: InkRect, pageRef: InkPageRef): void {
  if (
    !finiteNumber(crop.x) || !finiteNumber(crop.y)
    || !finiteNumber(crop.width) || !finiteNumber(crop.height)
    || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
    || crop.x + crop.width > pageRef.width || crop.y + crop.height > pageRef.height
  ) {
    invalidArgument('Paged Ink render crop is invalid.');
  }
}

function validateRenderRequest(request: InkRenderRequest): ValidatedRenderMode {
  if (
    typeof request.request_id !== 'string' || request.request_id.trim().length === 0
    || typeof request.render_id !== 'string' || request.render_id.trim().length === 0
    || typeof request.document_id !== 'string' || request.document_id.trim().length === 0
    || typeof request.revision !== 'string' || request.revision.trim().length === 0
  ) {
    invalidArgument('Frozen Ink render identity is invalid.');
  }
  if ((request.session_id !== undefined) !== (request.tool_call_id !== undefined)) {
    invalidArgument('Frozen Ink render session and tool identities must be paired.');
  }
  if (!Array.isArray(request.highlights)) {
    invalidArgument('Frozen Ink render highlights must be an array.');
  }
  if (typeof request.long_edge !== 'number' || !Number.isInteger(request.long_edge)) {
    invalidArgument('Ink render long edge must be an integer.');
  }
  if (request.long_edge < 1 || request.long_edge > MAX_LONG_EDGE) {
    limitExceeded('Ink render long edge must be between 1 and 2048 pixels.');
  }

  const board = request.board ?? null;
  const pageRef = request.page_ref ?? null;
  const page = request.page ?? null;
  if (board !== null && (pageRef !== null || page !== null)) {
    invalidArgument('Paged and board Ink render cannot be combined.');
  }
  if (board !== null && request.crop !== undefined && request.crop !== null) {
    invalidArgument('Board Ink render cannot use a paged crop.');
  }
  if (board !== null) {
    return { kind: 'board', board: validateBoardPayload(board) };
  }

  if (!pageRef || !page) {
    invalidArgument('Paged Ink render requires page_ref and page.');
  }
  if (page.page_id !== pageRef.page_id) {
    invalidArgument('Paged Ink render page and page_ref ids must match.');
  }
  if (!finiteNumber(pageRef.width) || !finiteNumber(pageRef.height)
    || pageRef.width <= 0 || pageRef.height <= 0) {
    invalidArgument('Paged Ink render page dimensions must be finite and positive.');
  }
  if (request.crop !== undefined && request.crop !== null) {
    validatePagedCrop(request.crop, pageRef);
  }
  return { kind: 'paged', pageRef, page };
}

function renderBoardCanvas(board: ValidatedBoardPayload, longEdge: number): HTMLCanvasElement {
  const scale = longEdge / Math.max(board.crop.width, board.crop.height);
  const viewport = {
    width: board.crop.width * scale,
    height: board.crop.height * scale,
  };
  const canvas = document.createElement('canvas');
  const objects = board.chunks.flatMap((chunk) => chunk.objects);
  renderInkBoard(
    canvas,
    board.surface,
    objects,
    { x: board.crop.x, y: board.crop.y, zoom: scale },
    {
      dpr: 1,
      maxPixels: MAX_RENDER_PIXELS,
      viewport,
      worldRect: board.crop,
    },
  );
  return canvas;
}

export async function handleInkRenderRequest(request: InkRenderRequest): Promise<InkRenderResponse> {
  let stagedUploadId: string | undefined;
  let backgroundLease: Awaited<ReturnType<typeof loadInkBackground>> | undefined;
  let composedBackground: HTMLCanvasElement | undefined;
  try {
    const mode = validateRenderRequest(request);
    let canvas: HTMLCanvasElement;
    if (mode.kind === 'board') {
      canvas = renderBoardCanvas(mode.board, request.long_edge);
    } else {
      backgroundLease = await loadInkBackground(mode.pageRef);
      composedBackground = composeSourceHighlights(backgroundLease.background, mode.pageRef, request.highlights);
      const background = composedBackground ?? backgroundLease.background;
      const crop = request.crop ?? { x: 0, y: 0, width: mode.pageRef.width, height: mode.pageRef.height };
      const scale = request.long_edge / Math.max(crop.width, crop.height);
      canvas = document.createElement('canvas');
      renderInkPage(canvas, mode.pageRef, mode.page, {
        background,
        crop: request.crop ?? undefined,
        scale,
        max_pixels: MAX_RENDER_PIXELS,
      });
    }
    const png = await canvasPng(canvas);
    if (png.size === 0 || png.size > 4 * 1024 * 1024) {
      throw new InkRenderBridgeError('LIMIT_EXCEEDED', 'Rendered PNG exceeds the 4 MiB snapshot limit.');
    }
    stagedUploadId = await stageBlobUpload(png, { name: 'ink-render.png' });
    const response: InkRenderResponse = {
      request_id: request.request_id,
      render_id: request.render_id,
      session_id: request.session_id ?? undefined,
      tool_call_id: request.tool_call_id ?? undefined,
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
