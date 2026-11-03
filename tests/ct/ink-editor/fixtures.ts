import type { CtInvokeHandler } from '../mocks/tauri-core-mock';
import { dispatchCtEvent } from '../mocks/tauri-event-mock';
import { frozenSourceHighlight } from '../ink/frozenPageFixture';
import type { InkManifest, InkObject, InkPage, InkPageRef, InkRuling } from '@/features/ink/types';

export const inkEditorDocumentId = 'ink-editor-ct-document';
export const inkEditorPageId = 'ink-editor-ct-page-2';

const pageRefs: InkPageRef[] = [
  {
    page_id: 'ink-editor-ct-page-1',
    width: 120,
    height: 160,
    background: { kind: 'blank', ruling: 'blank' },
    page_blob_hash: 'ink-editor-page-1-hash',
  },
  {
    page_id: inkEditorPageId,
    width: 120,
    height: 160,
    background: { kind: 'blank', ruling: 'blank' },
    page_blob_hash: 'ink-editor-page-2-hash',
  },
];

const bluePageStroke: InkObject = {
  id: 'fixture-blue-stroke',
  author: 'user',
  created_at: 1,
  content: {
    kind: 'stroke',
    samples: [{ x: 16, y: 20, pressure: 0.5 }, { x: 96, y: 20, pressure: 0.5 }],
    style: { tool: 'pen', color: '#0000ff', width: 4, pressure_enabled: false },
  },
};

const redOtherPageStroke: InkObject = {
  id: 'fixture-other-page-red-stroke',
  author: 'user',
  created_at: 1,
  content: {
    kind: 'stroke',
    samples: [{ x: 16, y: 40, pressure: 0.5 }, { x: 96, y: 40, pressure: 0.5 }],
    style: { tool: 'pen', color: '#ff0000', width: 4, pressure_enabled: false },
  },
};

export type InkEditorSaveMode = 'success' | 'conflict' | 'offline' | 'offline-once' | 'operation-unknown' | 'save-echo';

const RED_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAHgAAACgCAYAAADHCaiQAAABg0lEQVR4nO3RwQkAIADEsNt/aR1DqHnkX+jOduja6wAMxmAM/pTBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRx3AYvOcryTGgnpAAAAAElFTkSuQmCC';

export type InkEditorBackgroundFixture = 'none' | 'image' | 'pdf_page';

const PREPARED_RED_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

function preparedPngBase64(color = '#ff0000', width = 120, height = 160): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable');
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
}

export function createInkEditorBackend(
  saveMode: InkEditorSaveMode = 'success',
  documentId = inkEditorDocumentId,
  background: InkEditorBackgroundFixture = 'none',
  options: { pdfPageHighlights?: boolean } = {},
) {
  const pdfPageHighlights = options.pdfPageHighlights !== false;
  const manifestPages = structuredClone(pageRefs);
  if (background === 'image') manifestPages[1].background = { kind: 'image', blob_hash: 'ink-editor-background-blob' };
  if (background === 'pdf_page') {
    manifestPages[1].width = 160;
    manifestPages[1].height = 120;
    manifestPages[1].background = { kind: 'pdf_page', blob_hash: 'ink-editor-background-blob', source_page_index: 0 };
  }
  let manifest: InkManifest = {
    schema_version: 1,
    document_id: documentId,
    revision: 'revision-1',
    title: 'Ink editor CT fixture',
    source: background === 'pdf_page'
      ? { kind: 'resource', resource_id: 'res-ink-editor-pdf', source_hash: 'a'.repeat(64), conversion_revision: 'conversion-v1' }
      : { kind: 'blank' },
    pages: manifestPages,
  };
  const pdfResource = background === 'pdf_page'
    ? {
        id: 'res-ink-editor-pdf',
        hash: 'b'.repeat(64),
        type: 'file',
        storageMode: 'inline',
        metadata: {
          extra: {
            highlights: [{
              ...frozenSourceHighlight,
              rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.3 }],
            }],
          },
        },
        refCount: 1,
        createdAt: 1,
        updatedAt: 1,
      }
    : undefined;
  const pages = new Map<string, InkPage>([
    [pageRefs[0].page_id, { schema_version: 1, page_id: pageRefs[0].page_id, objects: [redOtherPageStroke] }],
    [inkEditorPageId, { schema_version: 1, page_id: inkEditorPageId, objects: [bluePageStroke] }],
  ]);
  let saveAttempted = false;
  let saveCalls = 0;
  let getCalls = 0;
  let getPageCalls = 0;
  const saveOperationIds: string[] = [];
  let appendCalls = 0;
  let appendRequest: { document_id?: string; expected_revision?: string; operation_id?: string; width?: number; height?: number; ruling?: InkRuling } | undefined;
  let renameCalls = 0;
  let renameRequest: { document_id?: string; expected_revision?: string; operation_id?: string; title?: string } | undefined;

  const handlers: Record<string, CtInvokeHandler> = {
    vfs_get_blob_base64: (_command, payload) => {
      if ((payload as { blobHash?: string } | undefined)?.blobHash !== 'ink-editor-background-blob') throw new Error('Unknown fixture blob');
      const base64 = preparedPngBase64(background === 'pdf_page' ? '#dddddd' : '#ff0000', manifestPages[1].width, manifestPages[1].height);
      return { mimeType: 'image/png', size: atob(base64).length, base64 };
    },
    vfs_get_resource: (_command, payload) => {
      const request = payload as { resourceId?: string } | undefined;
      if (request?.resourceId !== pdfResource?.id) throw new Error('Unknown fixture source resource');
      return structuredClone(pdfResource);
    },
    vfs_ink_get: (_command, payload) => {
      const request = payload?.request as { document_id?: string } | undefined;
      if (request?.document_id !== manifest.document_id) throw new Error('Unknown fixture document');
      getCalls += 1;
      return structuredClone(manifest);
    },
    vfs_ink_get_page: (_command, payload) => {
      const request = payload?.request as { document_id?: string; page_id?: string } | undefined;
      if (request?.document_id !== manifest.document_id) throw new Error('Unknown fixture document');
      getPageCalls += 1;
      const page = request.page_id ? pages.get(request.page_id) : undefined;
      if (!page) throw new Error('Unknown fixture page');
      return structuredClone(page);
    },
    vfs_ink_get_render_inputs: (_command, payload) => {
      const request = payload as { documentId?: string; expectedRevision?: string; pageId?: string } | undefined;
      if (request?.documentId !== manifest.document_id || request.expectedRevision !== manifest.revision) {
        throw new Error('Unknown fixture frozen Ink revision');
      }
      const pageRef = manifest.pages.find((candidate) => candidate.page_id === request.pageId);
      const page = request.pageId ? pages.get(request.pageId) : undefined;
      if (!pageRef || !page || page.page_id !== pageRef.page_id) throw new Error('Unknown fixture frozen Ink page');
      const highlights = pdfResource && pdfPageHighlights ? pdfResource.metadata.extra.highlights ?? [] : [];
      return structuredClone({
        revision: manifest.revision,
        source: manifest.source,
        page_ref: pageRef,
        page,
        highlights,
        source_annotation_revision: pdfResource ? 'annotations-fixture-v1' : undefined,
      });
    },
    vfs_ink_append_page: (_command, payload) => {
      const request = payload?.request as {
        document_id?: string;
        expected_revision?: string;
        operation_id?: string;
        width?: number;
        height?: number;
        ruling?: InkRuling;
      } | undefined;
      if (request?.document_id !== manifest.document_id || request.width !== 120 || request.height !== 160 || !request.ruling) {
        throw new Error('Invalid fixture append-page request');
      }
      if (request.expected_revision !== manifest.revision) throw new Error('Fixture revision conflict');
      appendCalls += 1;
      appendRequest = request;
      const pageId = `ink-editor-ct-page-${manifest.pages.length + 1}`;
      const pageRef: InkPageRef = {
        page_id: pageId,
        width: request.width,
        height: request.height,
        background: { kind: 'blank', ruling: request.ruling },
        page_blob_hash: `appended-${pageId}`,
      };
      pages.set(pageId, { schema_version: 1, page_id: pageId, objects: [] });
      manifest = { ...manifest, revision: `revision-${Number(manifest.revision.replace('revision-', '')) + 1}`, pages: [...manifest.pages, pageRef] };
      return structuredClone(manifest);
    },
    vfs_ink_rename: (_command, payload) => {
      const request = payload?.request as { document_id?: string; expected_revision?: string; title?: string } | undefined;
      if (request?.document_id !== manifest.document_id || !request.title) throw new Error('Invalid fixture rename request');
      if (request.expected_revision !== manifest.revision) throw new Error('Fixture revision conflict');
      renameCalls += 1;
      renameRequest = request;
      manifest = { ...manifest, revision: `revision-${Number(manifest.revision.replace('revision-', '')) + 1}`, title: request.title };
      return structuredClone(manifest);
    },
    vfs_ink_save_page: async (_command, payload) => {
      const request = payload?.request as {
        document_id?: string;
        expected_revision?: string;
        operation_id?: string;
        page?: InkPage;
      } | undefined;
      if (request?.document_id !== manifest.document_id || !request.page) throw new Error('Invalid fixture save');
      saveCalls += 1;
      if (request.operation_id) saveOperationIds.push(request.operation_id);
      if (saveMode === 'operation-unknown') {
        throw {
          code: 'OPERATION_STATE_UNKNOWN',
          message: 'The save outcome is unknown.',
          hint: 'Read the remote page before retrying.',
          retryable: true,
          current_revision: manifest.revision,
        };
      }
      if (saveMode === 'conflict' && !saveAttempted) {
        saveAttempted = true;
        manifest = { ...manifest, revision: 'revision-2' };
        throw {
          code: 'REVISION_CONFLICT',
          message: 'The remote page changed.',
          hint: 'Keep the local draft or reload the remote page.',
          retryable: true,
          current_revision: manifest.revision,
        };
      }
      if (saveMode === 'offline' || (saveMode === 'offline-once' && saveCalls === 1)) {
        throw { code: 'INTERNAL', message: 'The fixture is offline.', retryable: true };
      }
      if (request.expected_revision !== manifest.revision) {
        throw {
          code: 'REVISION_CONFLICT',
          message: 'The remote page changed.',
          retryable: true,
          current_revision: manifest.revision,
        };
      }
      pages.set(request.page.page_id, structuredClone(request.page));
      const revisionNumber = Number(manifest.revision.replace('revision-', '')) + 1;
      manifest = {
        ...manifest,
        revision: `revision-${revisionNumber}`,
        pages: manifest.pages.map((pageRef) => pageRef.page_id === request.page?.page_id
          ? { ...pageRef, page_blob_hash: `saved-${revisionNumber}-${pageRef.page_id}` }
          : pageRef),
      };
      if (saveMode === 'save-echo') {
        await dispatchCtEvent('ink:changed', {
          document_id: manifest.document_id,
          revision: manifest.revision,
          operation_id: request.operation_id ?? 'fixture-save-operation',
          affected_page_ids: [request.page.page_id],
        });
      }
      return structuredClone(manifest);
    },
  };

  return {
    handlers,
    readPage(pageId: string) {
      const page = pages.get(pageId);
      return page ? structuredClone(page) : undefined;
    },
    readManifest() {
      return structuredClone(manifest);
    },
    advanceRemotePage(pageId: string, page: InkPage) {
      pages.set(pageId, structuredClone(page));
      const revisionNumber = Number(manifest.revision.replace('revision-', '')) + 1;
      manifest = {
        ...manifest,
        revision: `revision-${revisionNumber}`,
        pages: manifest.pages.map((pageRef) => pageRef.page_id === pageId
          ? { ...pageRef, page_blob_hash: `remote-${revisionNumber}-${pageId}` }
          : pageRef),
      };
    },
    get saveCalls() {
      return saveCalls;
    },
    get saveOperationIds() {
      return [...saveOperationIds];
    },
    get getCalls() {
      return getCalls;
    },
    get getPageCalls() {
      return getPageCalls;
    },
    get appendCalls() {
      return appendCalls;
    },
    get appendRequest() {
      return structuredClone(appendRequest);
    },
    get renameCalls() {
      return renameCalls;
    },
    get renameRequest() {
      return structuredClone(renameRequest);
    },
  };
}
