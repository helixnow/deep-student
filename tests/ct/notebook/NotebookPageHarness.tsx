import React, { useEffect, useRef, useState } from 'react';
import 'overlayscrollbars/overlayscrollbars.css';
import { MobileHeaderActiveViewSync, MobileHeaderProvider } from '@/components/layout/MobileHeaderContext';
import { MobileLayoutProvider } from '@/components/layout/MobileLayoutContext';
import { NotebookPage } from '@/features/ink/NotebookPage';
import { resetCtInvokeHandlers, setCtInvokeHandlers } from '../mocks/tauri-core-mock';
import {
  createNotebookCtBackend,
  type NotebookCtBackendOptions,
  type NotebookCtCanonical,
  type NotebookCtSnapshot,
} from './fixtures';

export interface NotebookCtBridge {
  getState(): NotebookCtSnapshot;
  readCanonical(documentId: string): Promise<NotebookCtCanonical>;
  releaseSaves(): void;
}

declare global {
  interface Window {
    __NOTEBOOK_LIBRARY_CT__?: NotebookCtBridge;
  }
}

export function NotebookPageHarness(props: NotebookCtBackendOptions) {
  const [backend] = useState(() => createNotebookCtBackend(props));
  const initialized = useRef(false);
  if (!initialized.current) {
    initialized.current = true;
    setCtInvokeHandlers(backend.handlers);
    window.__NOTEBOOK_LIBRARY_CT__ = {
      getState: () => backend.snapshot(),
      readCanonical: (documentId) => backend.readCanonical(documentId),
      releaseSaves: () => backend.releaseSaves(),
    };
  }
  useEffect(() => () => {
    backend.releaseSaves();
    delete window.__NOTEBOOK_LIBRARY_CT__;
    resetCtInvokeHandlers();
  }, [backend]);

  return (
    <MobileLayoutProvider>
      <MobileHeaderProvider>
        <MobileHeaderActiveViewSync activeView="notes" />
        <div data-testid="notebook-ct-host" style={{ width: '100%', height: '100dvh', minHeight: 0, overflow: 'hidden' }}>
          <NotebookPage isActive />
        </div>
      </MobileHeaderProvider>
    </MobileLayoutProvider>
  );
}
