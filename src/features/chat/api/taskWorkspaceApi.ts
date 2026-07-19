import { invoke } from '@tauri-apps/api/core';
import type { BrowserDownloadObservation } from '@/features/browser/types';
import type { TaskObjectHandle } from '../types/taskObjects';

export interface RuntimeDirectoryEntry {
  name: string;
  relativePath: string;
  kind: 'directory' | 'file';
  sizeBytes?: number | null;
}

export interface RuntimeDirectoryPage {
  rootId: string;
  relativePath: string;
  entries: RuntimeDirectoryEntry[];
  nextCursor?: string | null;
  truncated: boolean;
  scanned: number;
}

export interface ListRuntimeDirectoryInput {
  sessionId: string;
  rootId?: string;
  relativePath?: string;
  cursor?: string;
  limit?: number;
}

export interface TaskRuntimeRoot {
  id: string;
  kind: string;
  path: string;
  access: 'read_only' | 'read_write';
  label: string;
  session_scoped: boolean;
  configured: boolean;
  /** Non-recursive identity for the selected folder itself. */
  objectHandle?: TaskObjectHandle;
}

export function listRuntimeDirectory(input: ListRuntimeDirectoryInput): Promise<RuntimeDirectoryPage> {
  return invoke<RuntimeDirectoryPage>('chat_v2_list_runtime_directory', { ...input });
}

export function listTaskBrowserDownloads(chatSessionId: string): Promise<BrowserDownloadObservation[]> {
  return invoke<BrowserDownloadObservation[]>('browser_list_task_downloads', { chatSessionId });
}

export async function configureTaskWorkspace(path: string, sessionId?: string): Promise<TaskRuntimeRoot[]> {
  const roots = await invoke<TaskRuntimeRoot[]>('chat_v2_set_workspace_root', {
    path,
    access: 'read_write',
    sessionId,
  });
  return roots.map((root) => root.id !== 'workspace' || !root.configured ? root : {
    ...root,
    objectHandle: {
      schemaVersion: 1,
      handleId: 'runtime-root:workspace',
      kind: 'folder',
      displayName: root.label,
      locator: { rootId: root.id, relativePath: '.' },
      capabilities: {
        readable: true,
        materializable: true,
        writable: root.access === 'read_write',
        shareable: false,
        sendable: false,
        deletable: false,
      },
      provenance: {
        source: 'user_selected_task_workspace',
        observedAt: new Date().toISOString(),
      },
    },
  });
}
