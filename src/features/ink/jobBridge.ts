import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { exportInkBoardPdf, exportInkBoardPng, exportInkPdf, exportInkPng } from './export';
import { loadInkBackground } from './background';
import { withSourceHighlights } from './sourceHighlights';
import { prepareSourcePages, type SourceFormat } from './prepare/source';
import { stageBlobUpload, abortStagedUpload } from '@/utils/stagedUpload';
import type { InkBoardChunk, InkBoardSurface, InkPage, InkPageRef, InkRect } from './types';

export type InkJobKind = 'prepare' | 'export';
export type InkExportFormat = 'png' | 'pdf';

export interface InkJobRequest {
  request_id: string;
  operation_id: string;
  kind: InkJobKind;
  session_id?: string;
  tool_call_id?: string;
  payload:
    | {
        kind: 'prepare';
        source_resource_id: string;
        source_hash: string;
        file_name: string;
        mime_type: string;
        source_bytes_base64: string;
        converter_profile: string;
        expected_converter_version: string;
      }
    | {
        kind: 'export';
        document_id: string;
        revision: string;
        page_ids: string[];
        format: InkExportFormat;
        pages: Array<{ page_ref: InkPageRef; page: InkPage; highlights: Array<Record<string, unknown>> }>;
        board?: {
          surface: InkBoardSurface;
          region: InkRect;
          page_width: number;
          page_height: number;
          paginate: boolean;
          pages: InkRect[];
          chunks: InkBoardChunk[];
        };
      };
}

export interface InkJobStagedPage {
  staged_upload_id: string;
  width_px: number;
  height_px: number;
  source_page_index?: number;
}

export interface InkJobResponse {
  request_id: string;
  operation_id: string;
  kind: InkJobKind;
  session_id?: string;
  tool_call_id?: string;
  value?:
    | { kind: 'prepared'; pages: InkJobStagedPage[]; converter_version: string; warnings: string[] }
    | { kind: 'exported'; staged_upload_id: string };
  error?: { code: string; message: string };
}

const activeJobs = new Map<string, AbortController>();

function errorResponse(request: InkJobRequest, error: unknown): InkJobResponse {
  const cause = error as Error & { code?: string };
  return {
    request_id: request.request_id,
    operation_id: request.operation_id,
    kind: request.kind,
    session_id: request.session_id,
    tool_call_id: request.tool_call_id,
    error: {
      code: typeof cause?.code === 'string' ? cause.code.slice(0, 64) : 'JOB_FAILED',
      message: (cause instanceof Error ? cause.message : String(error)).slice(0, 2048),
    },
  };
}

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function stagePages(request: InkJobRequest & { payload: Extract<InkJobRequest['payload'], { kind: 'prepare' }> }, signal: AbortSignal): Promise<InkJobResponse> {
  const bytes = decodeBase64(request.payload.source_bytes_base64);
  const extension = request.payload.file_name.toLowerCase().split('.').pop();
  const format: SourceFormat = extension === 'pdf' ? 'pdf'
    : extension === 'docx' ? 'docx'
      : extension === 'pptx' ? 'pptx' : 'image';
  if (!['pdf', 'image', 'docx', 'pptx'].includes(format)) throw Object.assign(new Error('Unsupported Ink source format.'), { code: 'UNSUPPORTED_FORMAT' });
  const result = await prepareSourcePages(bytes, format, { signal, max_pages: 500, max_pixels_per_page: 16_000_000 });
  const pages: InkJobStagedPage[] = [];
  const uploadIds: string[] = [];
  try {
    for (let index = 0; index < result.pages.length; index += 1) {
      const page = result.pages[index];
      if (signal.aborted) throw Object.assign(new Error('Ink preparation was cancelled.'), { code: 'CANCELLED' });
      const uploadId = await stageBlobUpload(page.png, { name: `ink-source-page-${index + 1}.png`, signal });
      uploadIds.push(uploadId);
      pages.push({
        staged_upload_id: uploadId,
        width_px: page.width,
        height_px: page.height,
        ...(format === 'pdf' ? { source_page_index: index } : {}),
      });
    }
    const profileVersion = result.converter_version;
    if (request.payload.converter_profile !== await profileFor(request.payload.expected_converter_version)
      || request.payload.expected_converter_version !== profileVersion) {
      throw Object.assign(new Error('Source converter version/profile changed. Retry preparation.'), { code: 'CONVERTER_PROFILE_MISMATCH' });
    }
    return {
      request_id: request.request_id,
      operation_id: request.operation_id,
      kind: request.kind,
      session_id: request.session_id,
      tool_call_id: request.tool_call_id,
      value: { kind: 'prepared', pages, converter_version: result.converter_version, warnings: result.warnings },
    };
  } catch (error) {
    await Promise.all(uploadIds.map((uploadId) => abortStagedUpload(uploadId)));
    throw error;
  }
}

async function profileFor(version: string): Promise<string> {
  const format = version.startsWith('pdfjs-dist@') ? 'ink-pdf-pages-v1'
    : version.startsWith('browser-imagebitmap-v1') ? 'ink-image-pages-v1' : 'ink-office-pages-v1';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(version)));
  return `${format}-${Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

async function publishExport(
  request: InkJobRequest & { payload: Extract<InkJobRequest['payload'], { kind: 'export' }> },
  blob: Blob,
  signal: AbortSignal,
): Promise<InkJobResponse> {
  const maxBytes = request.payload.format === 'png' ? 128 * 1024 * 1024 : 200 * 1024 * 1024;
  if (!blob.size || blob.size > maxBytes) throw Object.assign(new Error('Ink export exceeds the byte limit.'), { code: 'LIMIT_EXCEEDED' });
  const stagedUploadId = await stageBlobUpload(blob, { name: request.payload.format === 'png' ? 'ink-export.png' : 'ink-export.pdf', signal });
  return {
    request_id: request.request_id,
    operation_id: request.operation_id,
    kind: request.kind,
    session_id: request.session_id,
    tool_call_id: request.tool_call_id,
    value: { kind: 'exported', staged_upload_id: stagedUploadId },
  };
}

async function handleExport(request: InkJobRequest & { payload: Extract<InkJobRequest['payload'], { kind: 'export' }> }, signal: AbortSignal): Promise<InkJobResponse> {
  const board = request.payload.board;
  if (board) {
    if (signal.aborted) throw Object.assign(new Error('Ink export was cancelled.'), { code: 'CANCELLED' });
    const objects = board.chunks.flatMap((chunk) => chunk.objects);
    const blob = request.payload.format === 'png'
      ? await exportInkBoardPng({ surface: board.surface, objects, region: board.region }, { signal })
      : await exportInkBoardPdf({ surface: board.surface, objects, pages: board.pages }, { signal });
    return publishExport(request, blob, signal);
  }
  const pages = [];
  const leases: Array<Awaited<ReturnType<typeof loadInkBackground>>> = [];
  try {
    for (const snapshot of request.payload.pages) {
      if (signal.aborted) throw Object.assign(new Error('Ink export was cancelled.'), { code: 'CANCELLED' });
      const lease = await loadInkBackground(snapshot.page_ref);
      leases.push(lease);
      const page = withSourceHighlights(snapshot.page_ref, snapshot.page, snapshot.highlights);
      pages.push({ page_ref: snapshot.page_ref, page, background: lease.background });
    }
    const selected = request.payload.page_ids.map((pageId) => {
      const page = pages.find((candidate) => candidate.page_ref.page_id === pageId);
      if (!page) throw Object.assign(new Error(`Frozen export page ${pageId} is missing.`), { code: 'INVALID_RESPONSE' });
      return page;
    });
    const blob = request.payload.format === 'png'
      ? await exportInkPng(selected[0], { signal })
      : await exportInkPdf(selected, { page_ids: request.payload.page_ids, signal });
    return publishExport(request, blob, signal);
  } finally {
    leases.forEach((lease) => lease.dispose());
  }
}

export async function handleInkJobRequest(request: InkJobRequest): Promise<void> {
  const controller = new AbortController();
  activeJobs.set(request.request_id, controller);
  let result: InkJobResponse;
  try {
    if ((request.session_id !== undefined) !== (request.tool_call_id !== undefined)
      || !request.request_id || !request.operation_id) throw Object.assign(new Error('Ink job request identity is invalid.'), { code: 'INVALID_ARGUMENT' });
    if (request.kind === 'prepare' && request.payload.kind === 'prepare') result = await stagePages(request as InkJobRequest & { payload: Extract<InkJobRequest['payload'], { kind: 'prepare' }> }, controller.signal);
    else if (request.kind === 'export' && request.payload.kind === 'export') result = await handleExport(request as InkJobRequest & { payload: Extract<InkJobRequest['payload'], { kind: 'export' }> }, controller.signal);
    else throw Object.assign(new Error('Ink job kind and payload do not match.'), { code: 'INVALID_ARGUMENT' });
  } catch (error) {
    result = errorResponse(request, error);
  } finally {
    activeJobs.delete(request.request_id);
  }
  try {
    await invoke('vfs_ink_job_result', { response: result });
  } catch (error) {
    if (result.value?.kind === 'prepared') await Promise.all(result.value.pages.map(({ staged_upload_id }) => abortStagedUpload(staged_upload_id)));
    else if (result.value?.kind === 'exported') await abortStagedUpload(result.value.staged_upload_id);
    throw error;
  }
}

let registration: Promise<() => void> | undefined;
let owners = 0;
export async function registerInkJobBridge(): Promise<() => void> {
  if (!registration) {
    registration = (async () => {
      const stopJob = await listen<InkJobRequest>('ink:job-request', async ({ payload }) => {
        try { await handleInkJobRequest(payload); }
        catch (error) { console.error('[InkJobBridge] Failed to report job result:', error); }
      });
      try {
        const stopCancel = await listen<{ request_id: string }>('ink:job-cancel', ({ payload }) => {
          if (typeof payload?.request_id === 'string') activeJobs.get(payload.request_id)?.abort();
        });
        return () => { stopCancel(); stopJob(); };
      } catch (error) {
        stopJob();
        throw error;
      }
    })();
  }
  owners += 1;
  let stop: () => void;
  try { stop = await registration; }
  catch (error) { owners -= 1; registration = undefined; throw error; }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owners -= 1;
    if (owners === 0) { stop(); registration = undefined; }
  };
}
