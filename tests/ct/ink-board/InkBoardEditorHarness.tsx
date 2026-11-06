/**
 * Root-route CT harness for `.dsink` schema v2.
 *
 * The mounted tree is the real production `DstuFileViewer`; only the DSTU and
 * ink IPC commands are supplied by the fixture.
 */
import React, { useEffect, useRef, useState } from 'react';
import { flushInkEditor, type InkEditorSessionResult } from '@/features/ink/editorSession';
import { DstuFileViewer } from '@/features/ink/DstuFileViewer';
import { setCtInvokeHandlers } from '../mocks/tauri-core-mock';
import {
  createInkBoardCtDocumentId,
  createInkBoardEditorBackend,
  type InkBoardCtBackend,
  type InkBoardCtSnapshot,
  type InkBoardEditorMode,
} from './fixtures';

export interface InkBoardCtWindowBridge {
  documentId: string;
  mode: InkBoardEditorMode;
  getState(): InkBoardCtSnapshot;
  readDraft(): ReturnType<InkBoardCtBackend['readDraft']>;
  setClipboard(text: string): void;
  flush(): Promise<InkEditorSessionResult>;
}

declare global {
  interface Window {
    __INK_BOARD_CT__?: InkBoardCtWindowBridge;
  }
}

export interface InkBoardEditorHarnessProps {
  mode: InkBoardEditorMode;
  /** Stable, unique document namespace for this test. */
  label?: string;
}

export function InkBoardEditorHarness({ mode, label = 'doc' }: InkBoardEditorHarnessProps) {
  const [documentId] = useState(() => createInkBoardCtDocumentId(mode, label));
  const [backend] = useState(() => createInkBoardEditorBackend(mode, documentId));
  const [mounted, setMounted] = useState(true);
  const [mountKey, setMountKey] = useState(0);
  const initialized = useRef(false);

  if (!initialized.current) {
    initialized.current = true;
    setCtInvokeHandlers(backend.handlers);
    if (typeof window !== 'undefined') {
      window.__INK_BOARD_CT__ = {
        documentId,
        mode,
        getState: () => backend.snapshot(),
        readDraft: () => backend.readDraft(),
        setClipboard: (text: string) => backend.setClipboard(text),
        flush: () => flushInkEditor(documentId),
      };
    }
  }

  useEffect(() => () => { delete window.__INK_BOARD_CT__; }, []);

  const unmountDocument = async () => {
    const result = await flushInkEditor(documentId);
    if (result.ok) setMounted(false);
  };

  return (
    <div>
      <button
        data-testid="ink-board-ct-unmount"
        type="button"
        disabled={!mounted}
        onClick={() => { void unmountDocument(); }}
      >
        Unmount document
      </button>
      <button
        data-testid="ink-board-ct-remount"
        type="button"
        disabled={mounted}
        onClick={() => {
          setMountKey((key) => key + 1);
          setMounted(true);
        }}
      >
        Remount document
      </button>
      <div style={{ height: 480, width: 'min(640px, 100%)' }}>
        {mounted && (
          <DstuFileViewer
            key={mountKey}
            path={`/${documentId}`}
            className="h-full w-full"
          />
        )}
      </div>
    </div>
  );
}
