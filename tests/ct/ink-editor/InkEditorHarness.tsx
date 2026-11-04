import React, { useRef, useState } from 'react';
import { InkEditor } from '@/features/ink/InkEditor';
import { flushInkEditor, type InkEditorSessionResult } from '@/features/ink/editorSession';
import type { InkRect } from '@/features/ink/types';
import { ctListenerCount, dispatchCtEvent } from '../mocks/tauri-event-mock';
import { setCtInvokeHandlers } from '../mocks/tauri-core-mock';
import { createInkEditorBackend, type InkEditorBackgroundFixture } from './fixtures';

type Backend = ReturnType<typeof createInkEditorBackend>;

export interface InkAskAiCapture {
  documentId: string;
  pageId: string;
  revision: string;
  crop?: InkRect;
}

declare global {
  interface Window {
    __INK_EDITOR_CT_BACKEND__?: Backend;
    __INK_EDITOR_FLUSH_RESULT__?: InkEditorSessionResult;
    __INK_EDITOR_EMIT_CHANGED__?: (documentId: string, revision: string) => Promise<void>;
    __INK_EDITOR_ADVANCE_REMOTE__?: () => void;
    __INK_EDITOR_ASK_AI_REQUESTS__?: InkAskAiCapture[];
    __INK_EDITOR_CT_CLIPBOARD__?: { read(): string };
  }
}

/**
 * Test-only harness props. `captureAskAi` records the eventual
 * `{ documentId, pageId, revision, crop }` request (and tolerates the current
 * positional editor callback) into `window.__INK_EDITOR_ASK_AI_REQUESTS__`.
 * The Tauri clipboard-manager IPC commands are intercepted at the existing
 * tauri-core-mock invoke boundary so ink copy/paste exercises the real
 * production clipboard helper without touching the OS clipboard.
 */
export interface InkEditorHarnessProps {
  saveMode: 'success' | 'conflict' | 'offline' | 'offline-once' | 'operation-unknown' | 'save-echo';
  documentId?: string;
  imageBackground?: boolean;
  pdfPageBackground?: boolean;
  pdfPageHighlights?: boolean;
  captureAskAi?: boolean;
  /** CT-only: enlarge both pages so scroll/zoom viewport placement is observable. */
  largePage?: boolean;
  fullHeight?: boolean;
  /** Test-only toggle target for clipboard read rejection. */
  clipboardReadRejects?: boolean;
  /** Test-only: hold clipboard write until the resolve control is clicked. */
  clipboardWriteDeferred?: boolean;
  /** Test-only: preseed the IPC clipboard payload. */
  clipboardPreset?: string;
}

export function InkEditorHarness({ saveMode, documentId = 'ink-editor-ct-document', imageBackground = false, pdfPageBackground = false, pdfPageHighlights = true, captureAskAi = false, largePage = false, fullHeight = false, clipboardReadRejects = false, clipboardWriteDeferred = false, clipboardPreset = '' }: InkEditorHarnessProps) {
  const background: InkEditorBackgroundFixture = pdfPageBackground ? 'pdf_page' : imageBackground ? 'image' : 'none';
  const clipboardRef = useRef({ text: clipboardPreset });
  const clipboardReadRejectsRef = useRef(clipboardReadRejects);
  const clipboardWriteDeferredRef = useRef(clipboardWriteDeferred);
  const pendingClipboardWriteRef = useRef<{ text: string; resolve: () => void } | null>(null);
  const [backend] = useState(() => {
    const created = createInkEditorBackend(saveMode, documentId, background, { pdfPageHighlights, largePage });
    created.handlers['plugin:clipboard-manager|write_text'] = (_command, payload) => {
      const text = (payload as { text?: unknown } | undefined)?.text;
      const value = typeof text === 'string' ? text : '';
      if (!clipboardWriteDeferredRef.current) {
        clipboardRef.current.text = value;
        return;
      }
      return new Promise<void>((resolve) => {
        pendingClipboardWriteRef.current = {
          text: value,
          resolve: () => {
            clipboardRef.current.text = value;
            resolve();
          },
        };
      });
    };
    created.handlers['plugin:clipboard-manager|read_text'] = () => {
      if (clipboardReadRejectsRef.current) throw new Error('Fixture clipboard read rejected');
      return clipboardRef.current.text;
    };
    return created;
  });
  const [mounted, setMounted] = useState(true);
  const [mountKey, setMountKey] = useState(0);
  const initialized = useRef(false);
  if (!initialized.current) {
    initialized.current = true;
    setCtInvokeHandlers(backend.handlers);
    window.__INK_EDITOR_CT_BACKEND__ = backend;
    window.__INK_EDITOR_ASK_AI_REQUESTS__ = [];
    window.__INK_EDITOR_CT_CLIPBOARD__ = { read: () => clipboardRef.current.text };
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

  const captureAskAiRequest = captureAskAi
    ? (...args: unknown[]) => {
        const first = args[0];
        const request: InkAskAiCapture = first !== null && typeof first === 'object'
          ? {
              documentId: String((first as Record<string, unknown>).documentId ?? ''),
              pageId: String((first as Record<string, unknown>).pageId ?? ''),
              revision: String((first as Record<string, unknown>).revision ?? ''),
              crop: (first as Record<string, unknown>).crop as InkRect | undefined,
            }
          : {
              documentId: String(args[0] ?? ''),
              pageId: String(args[1] ?? ''),
              revision: String(args[2] ?? ''),
              crop: args[3] as InkRect | undefined,
            };
        window.__INK_EDITOR_ASK_AI_REQUESTS__?.push(request);
      }
    : undefined;

  return (
    <div className="flex min-h-0 flex-col overflow-hidden" style={{ height: '100dvh' }}>
      <div hidden={fullHeight} className="shrink-0">
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
      <button data-testid="ink-editor-reject-clipboard-read" type="button" onClick={() => {
        clipboardReadRejectsRef.current = true;
      }}>Reject clipboard read</button>
      <button data-testid="ink-editor-resolve-clipboard-write" type="button" onClick={() => {
        const pending = pendingClipboardWriteRef.current;
        if (!pending) return;
        pendingClipboardWriteRef.current = null;
        clipboardWriteDeferredRef.current = false;
        pending.resolve();
      }}>Resolve clipboard write</button>
      <button data-testid="ink-editor-unmount" type="button" onClick={() => setMounted(false)}>Unmount editor</button>
      <button data-testid="ink-editor-remount" type="button" onClick={() => {
        setMountKey((key) => key + 1);
        setMounted(true);
      }}>Remount editor</button>
      </div>
      {mounted && <InkEditor key={mountKey} className="flex-1" documentId={documentId} initialPageId="ink-editor-ct-page-2" onAskAi={captureAskAiRequest} />}
    </div>
  );
}
