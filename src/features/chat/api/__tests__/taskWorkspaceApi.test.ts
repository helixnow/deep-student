import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
  configureTaskWorkspace,
  listRuntimeDirectory,
  listTaskBrowserDownloads,
} from '../taskWorkspaceApi';

describe('taskWorkspaceApi', () => {
  beforeEach(() => invokeMock.mockReset());

  it('binds a selected folder as an explicit read-write workspace', async () => {
    invokeMock.mockResolvedValue([{
      id: 'workspace', kind: 'workspace', path: '/tmp/project', access: 'read_write',
      label: 'project', session_scoped: false, configured: true,
    }]);
    const roots = await configureTaskWorkspace('/tmp/project');
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_set_workspace_root', {
      path: '/tmp/project',
      access: 'read_write',
      sessionId: undefined,
    });
    expect(roots[0].objectHandle).toMatchObject({
      handleId: 'runtime-root:workspace',
      kind: 'folder',
      locator: { rootId: 'workspace', relativePath: '.' },
    });
    expect(roots[0].objectHandle).not.toHaveProperty('children');
  });

  it('lists only by runtime root identity and relative path', async () => {
    invokeMock.mockResolvedValue({ entries: [], truncated: false });
    await listRuntimeDirectory({
      sessionId: 'sess-1',
      rootId: 'workspace',
      relativePath: 'reports',
      limit: 40,
    });
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_list_runtime_directory', {
      sessionId: 'sess-1',
      rootId: 'workspace',
      relativePath: 'reports',
      limit: 40,
    });
    expect(invokeMock.mock.calls[0][1]).not.toHaveProperty('path');
  });

  it('queries downloads by task session rather than a browser raw path', async () => {
    invokeMock.mockResolvedValue([]);
    await listTaskBrowserDownloads('sess-1');
    expect(invokeMock).toHaveBeenCalledWith('browser_list_task_downloads', {
      chatSessionId: 'sess-1',
    });
  });
});
