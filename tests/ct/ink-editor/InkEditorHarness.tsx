import React, { useRef, useState } from 'react';
import { InkEditor } from '@/features/ink/InkEditor';
import { flushInkEditor, type InkEditorSessionResult } from '@/features/ink/editorSession';
import { ctListenerCount, dispatchCtEvent } from '../mocks/tauri-event-mock';
import { setCtInvokeHandlers } from '../mocks/tauri-core-mock';
import { createInkEditorBackend, type InkEditorBackgroundFixture } from './fixtures';

type Backend = ReturnType<typeof createInkEditorBackend>;

declare global {
  interface Window {
    __INK_EDITOR_CT_BACKEND__?: Backend;
    __INK_EDITOR_FLUSH_RESULT__?: InkEditorSessionResult;
    __INK_EDITOR_EMIT_CHANGED__?: (documentId: string, revision: string) => Promise<void>;
    __INK_EDITOR_ADVANCE_REMOTE__?: () => void;
  }
}

export function InkEditorHarness({ saveMode, documentId = 'ink-editor-ct-document', imageBackground = false, pdfPageBackground = false }: { saveMode: 'success' | 'conflict' | 'offline' | 'offline-once' | 'operation-unknown' | 'save-echo'; documentId?: string; imageBackground?: boolean; pdfPageBackground?: boolean }) {
  const background: InkEditorBackgroundFixture = pdfPageBackground ? 'pdf_page' : imageBackground ? 'image' : 'none';
  const [backend] = useState(() => createInkEditorBackend(saveMode, documentId, background));
  const [mounted, setMounted] = useState(true);
  const [mountKey, setMountKey] = useState(0);
  const initialized = useRef(false);
  if (!initialized.current) {
    initialized.current = true;
    setCtInvokeHandlers(backend.handlers);
    window.__INK_EDITOR_CT_BACKEND__ = backend;
    window.__INK_EDITOR_EMIT_CHANGED__ = async (changedDocumentId, revision) => {
      await dispatchCtEvent('ink:changed', {
        document_id: changedDocumentId,
        revision,
        operation_id: 'fixture-test-operation',
        affected_page_ids: ['ink-editor-ct-page-2'],
      });
    };
    window.__INK_EDITOR_ADVANCE_REMOTE__ = () => {
      const current = backend.readPage('ink-editor-ct-page-2');
      if (!current) return;
      backend.advanceRemotePage('ink-editor-ct-page-2', {
        ...current,
        objects: [...current.objects, {
          id: 'external-remote-stroke', author: 'ai', created_at: 100,
          content: {
            kind: 'stroke',
            samples: [{ x: 16, y: 130, pressure: 0.5 }, { x: 96, y: 130, pressure: 0.5 }],
            style: { tool: 'pen', color: '#ff0000', width: 4, pressure_enabled: false },
          },
        }],
      });
    };
  }

  return (
    <div>
      <button data-testid="ink-editor-flush" type="button" onClick={async () => {
        window.__INK_EDITOR_FLUSH_RESULT__ = await flushInkEditor(documentId);
      }}>Flush editor</button>
      <output data-testid="ink-changed-listener-count">{ctListenerCount('ink:changed')}</output>
      <button data-testid="ink-editor-emit-changed" type="button" onClick={async () => {
        await dispatchCtEvent('ink:changed', {
          document_id: documentId,
          revision: backend.readManifest().revision,
          operation_id: 'fixture-external-operation',
          affected_page_ids: ['ink-editor-ct-page-2'],
        });
      }}>Emit changed event</button>
      <button data-testid="ink-editor-emit-saved-event" type="button" onClick={async () => {
        await dispatchCtEvent('ink:changed', {
          document_id: documentId,
          revision: backend.readManifest().revision,
          operation_id: 'fixture-self-save-operation',
          affected_page_ids: ['ink-editor-ct-page-2'],
        });
      }}>Emit self save event</button>
      <button data-testid="ink-editor-emit-forged-changed" type="button" onClick={async () => {
        await dispatchCtEvent('ink:changed', {
          document_id: documentId,
          revision: 'untrusted-forged-revision',
          operation_id: 'fixture-forged-operation',
          affected_page_ids: ['ink-editor-ct-page-2'],
        });
      }}>Emit forged event</button>
      <button data-testid="ink-editor-emit-wrong-document" type="button" onClick={async () => {
        await dispatchCtEvent('ink:changed', {
          document_id: 'another-document',
          revision: backend.readManifest().revision,
          operation_id: 'fixture-wrong-document-operation',
          affected_page_ids: ['ink-editor-ct-page-2'],
        });
      }}>Emit wrong document</button>
      <button data-testid="ink-editor-advance-remote" type="button" onClick={() => {
        const current = backend.readPage('ink-editor-ct-page-2');
        if (!current) return;
        backend.advanceRemotePage('ink-editor-ct-page-2', {
          ...current,
          objects: [...current.objects, {
            id: 'human-remote-stroke',
            author: 'user',
            created_at: 99,
            content: {
              kind: 'stroke',
              samples: [{ x: 16, y: 110, pressure: 0.5 }, { x: 96, y: 110, pressure: 0.5 }],
              style: { tool: 'pen', color: '#ff0000', width: 4, pressure_enabled: false },
            },
          }],
        });
      }}>Advance remote page</button>
      <button data-testid="ink-editor-advance-remote-external" type="button" onClick={() => {
        const current = backend.readPage('ink-editor-ct-page-2');
        if (!current) return;
        backend.advanceRemotePage('ink-editor-ct-page-2', {
          ...current,
          objects: [...current.objects, {
            id: 'external-remote-stroke',
            author: 'ai',
            created_at: 100,
            content: {
              kind: 'stroke',
              samples: [{ x: 16, y: 130, pressure: 0.5 }, { x: 96, y: 130, pressure: 0.5 }],
              style: { tool: 'pen', color: '#ff0000', width: 4, pressure_enabled: false },
            },
          }],
        });
      }}>Advance external page</button>
      <button data-testid="ink-editor-unmount" type="button" onClick={() => setMounted(false)}>Unmount editor</button>
      <button data-testid="ink-editor-remount" type="button" onClick={() => {
        setMountKey((key) => key + 1);
        setMounted(true);
      }}>Remount editor</button>
      {mounted && <InkEditor key={mountKey} documentId={documentId} initialPageId="ink-editor-ct-page-2" />}
    </div>
  );
}
