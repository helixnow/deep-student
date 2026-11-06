import React, { useEffect, useRef, useState } from 'react';
import { t } from '../mocks/react-i18next';
import { handleAndroidBack } from '@/app/navigation/androidBackCoordinator';
import { DstuFileViewer } from '@/features/ink/DstuFileViewer';
import { InkWorkspace } from '@/features/ink/InkWorkspace';
import FileContentView from '@/features/learning-hub/apps/views/FileContentView';
import type { DstuNode } from '@/dstu/types';
import type { InkPage } from '@/features/ink/types';
import {
  createInkBoardCtDocumentId,
  createInkBoardEditorBackend,
  type InkBoardCtSnapshot,
  type InkBoardEditorMode,
} from '../ink-board/fixtures';
import { setCtInvokeHandlers, type CtInvokeHandler } from '../mocks/tauri-core-mock';

export type InkWorkspaceCtHost = 'workspace' | 'dstu' | 'file-content';

export interface InkWorkspaceCtSnapshot extends InkBoardCtSnapshot {
  pages: InkPage[];
  manifestAttempts: number;
  pageReads: number;
  chunkReads: number;
  saveAttempts: number;
  pendingSaves: number;
}

export interface InkWorkspaceCtBridge {
  getState(): InkWorkspaceCtSnapshot;
  getLabels(): { back: string; retry: string; retrySave: string; reopen: string; exitBlocked: string };
  releaseSaves(): void;
  rejectSaves(): void;
  setActive(active: boolean): void;
  androidBack(): boolean;
  dispose(): void;
  remount(): void;
}

declare global {
  interface Window {
    __INK_WORKSPACE_CT__?: InkWorkspaceCtBridge;
  }
}

export interface InkWorkspaceHarnessProps {
  host?: InkWorkspaceCtHost;
  mode: InkBoardEditorMode;
  label?: string;
  isActive?: boolean;
  manifestFailures?: number;
  holdSaves?: boolean;
}

function createWorkspaceBackend(mode: InkBoardEditorMode, documentId: string, failures: number, holdSaves: boolean) {
  const backend = createInkBoardEditorBackend(mode, documentId);
  const pages = new Map<string, InkPage>();
  let manifestAttempts = 0;
  let pageReads = 0;
  let chunkReads = 0;
  let saveAttempts = 0;
  let held = holdSaves;
  const pending = new Set<{ resolve(): void; reject(error: Error): void }>();
  const handlers: Record<string, CtInvokeHandler> = { ...backend.handlers };
  handlers.vfs_ink_get = (command, payload) => {
    manifestAttempts += 1;
    if (manifestAttempts <= failures) {
      throw { code: 'INTERNAL', message: 'Workspace manifest probe unavailable', retryable: true };
    }
    return backend.handlers.vfs_ink_get(command, payload);
  };
  handlers.vfs_ink_get_page = async (command, payload) => {
    pageReads += 1;
    const page = await backend.handlers.vfs_ink_get_page(command, payload) as InkPage;
    pages.set(page.page_id, structuredClone(page));
    return page;
  };
  handlers.vfs_ink_get_chunks = (command, payload) => {
    chunkReads += 1;
    return backend.handlers.vfs_ink_get_chunks(command, payload);
  };
  for (const command of ['vfs_ink_save_page', 'vfs_ink_save_chunks']) {
    handlers[command] = async (invokedCommand, payload) => {
      saveAttempts += 1;
      if (held) {
        await new Promise<void>((resolve, reject) => {
          const entry = { resolve: () => { pending.delete(entry); resolve(); }, reject: (error: Error) => { pending.delete(entry); reject(error); } };
          pending.add(entry);
        });
      }
      const result = await backend.handlers[command](invokedCommand, payload);
      const request = payload?.request as { page?: InkPage } | undefined;
      if (request?.page) pages.set(request.page.page_id, structuredClone(request.page));
      return result;
    };
  }
  return {
    handlers,
    snapshot(): InkWorkspaceCtSnapshot {
      return {
        ...backend.snapshot(),
        pages: [...pages.values()].map((page) => structuredClone(page)),
        manifestAttempts,
        pageReads,
        chunkReads,
        saveAttempts,
        pendingSaves: pending.size,
      };
    },
    releaseSaves() {
      held = false;
      [...pending].forEach((entry) => entry.resolve());
    },
    rejectSaves() {
      held = false;
      [...pending].forEach((entry) => entry.reject(new Error('Workspace save unavailable')));
    },
  };
}

export function InkWorkspaceHarness({ host = 'workspace', mode, label = 'workspace', isActive = true, manifestFailures = 0, holdSaves = false }: InkWorkspaceHarnessProps) {
  const [documentId] = useState(() => createInkBoardCtDocumentId(mode, label));
  const [backend] = useState(() => createWorkspaceBackend(mode, documentId, manifestFailures, holdSaves));
  const [node] = useState<DstuNode>(() => ({
    id: documentId,
    sourceId: documentId,
    path: `/${documentId}`,
    name: mode === 'board-v2' ? 'board-ct.dsink' : 'paged-ct.dsink',
    type: 'file',
    createdAt: 1,
    updatedAt: 1,
    previewType: 'text',
    metadata: { mimeType: 'application/json' },
  }));
  const [active, setActive] = useState(isActive);
  const [mounted, setMounted] = useState(true);
  const [generation, setGeneration] = useState(0);
  const initialized = useRef(false);
  if (!initialized.current) {
    initialized.current = true;
    setCtInvokeHandlers(backend.handlers);
    window.__INK_WORKSPACE_CT__ = {
      getState: () => backend.snapshot(),
      getLabels: () => ({
        back: t('common:back'),
        retry: t('common:retry'),
        retrySave: t('actions.retrySave', { ns: 'ink' }),
        reopen: t('workspace.openFullscreen', { ns: 'ink', defaultValue: '重新打开全屏书写' }),
        exitBlocked: t('workspace.exitBlocked', { ns: 'ink', defaultValue: '保存未完成，当前编辑页面和草稿已保留。请重试保存后再返回或切换笔记。' }),
      }),
      releaseSaves: () => backend.releaseSaves(),
      rejectSaves: () => backend.rejectSaves(),
      setActive,
      androidBack: () => handleAndroidBack(),
      dispose: () => setMounted(false),
      remount: () => { setGeneration((value) => value + 1); setMounted(true); },
    };
  }
  useEffect(() => { setActive(isActive); }, [isActive]);
  useEffect(() => () => { delete window.__INK_WORKSPACE_CT__; }, []);

  return (
    <div style={{ padding: 24 }}>
      <button type="button" data-testid="ink-workspace-background-action">Background page action</button>
      <div
        data-testid="ink-workspace-embedded-host"
        data-active={active ? 'true' : 'false'}
        style={{ width: 280, height: 200, marginTop: 16, transform: 'translateZ(0)', overflow: 'hidden', visibility: active ? 'visible' : 'hidden' }}
      >
        {mounted && (host === 'dstu'
          ? <DstuFileViewer key={generation} path={node.path} />
          : host === 'file-content'
            ? <FileContentView key={generation} node={node} isActive={active} />
            : <InkWorkspace key={generation} documentId={documentId} title={node.name} isActive={active} />)}
      </div>
    </div>
  );
}
