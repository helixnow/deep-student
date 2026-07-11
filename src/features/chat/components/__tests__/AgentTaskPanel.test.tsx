import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand';

const { invokeMock, showGlobalNotificationMock, dstuCreateMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  showGlobalNotificationMock: vi.fn(),
  dstuCreateMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/components/UnifiedNotification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/UnifiedNotification')>();
  return { ...actual, showGlobalNotification: showGlobalNotificationMock };
});

vi.mock('@/dstu/api', () => ({
  dstu: { create: dstuCreateMock },
}));

import { AgentTaskPanel } from '../AgentTaskPanel';

interface MockChatStore {
  blocks: Map<string, unknown>;
  activeBlockIds: Set<string>;
  sessionId?: string;
}

function createMockStore(state: MockChatStore): StoreApi<MockChatStore> {
  return createStore<MockChatStore>(() => state);
}

/** 组一个带单条 workspace_artifact_write change 的 store（预览/撤销用例共用） */
function createArtifactWriteStore(change: Record<string, unknown>): StoreApi<MockChatStore> {
  return createMockStore({
    sessionId: 'sess-1',
    blocks: new Map([
      [
        'todo-1',
        {
          toolName: 'todo_init',
          toolOutput: {
            title: 'Artifact runtime',
            steps: [
              { id: 'todo_1', description: 'Write artifact', status: 'completed' },
            ],
          },
        },
      ],
      [
        'artifact-1',
        {
          status: 'success',
          toolName: 'builtin-workspace_artifact_write',
          toolInput: {
            path: 'reports/session.md',
            content: 'line1\nnew line',
          },
          toolOutput: {
            path: 'reports/session.md',
            file_name: 'session.md',
            root_id: 'artifacts',
            file_change_summary: {
              created: change.op === 'created' ? 1 : 0,
              modified: change.op === 'modified' ? 1 : 0,
              deleted: 0,
              bytes_written: 14,
              changes: [change],
            },
          },
        },
      ],
    ]),
    activeBlockIds: new Set(),
  });
}

describe('AgentTaskPanel', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    showGlobalNotificationMock.mockReset();
    dstuCreateMock.mockReset();
  });

  it('does not render an empty Plan 0/0 shell before todo steps arrive', () => {
    const store = createMockStore({
      blocks: new Map(),
      activeBlockIds: new Set(['streaming-block']),
    });

    const { container } = render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Plan')).not.toBeInTheDocument();
    expect(screen.queryByText('0/0')).not.toBeInTheDocument();
  });

  it('renders todo progress once todo steps exist in the store', () => {
    const store = createMockStore({
      blocks: new Map([
        [
          'todo-1',
          {
            toolName: 'todo_init',
            toolOutput: {
              title: '迁移 study-ui playground 调试能力',
              steps: [
                { id: 'todo_1', description: '梳理真实阻塞交互链路', status: 'completed' },
                { id: 'todo_2', description: '增加 todo sample 数据与交互入口', status: 'running' },
              ],
            },
          },
        ],
      ]),
      activeBlockIds: new Set(),
    });

    render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    expect(screen.getByText('增加 todo sample 数据与交互入口')).toBeInTheDocument();
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });

  it('expands inline instead of overlaying the composer with an absolute panel', () => {
    const store = createMockStore({
      blocks: new Map([
        [
          'todo-1',
          {
            toolName: 'todo_init',
            toolOutput: {
              title: '迁移 study-ui playground 调试能力',
              steps: [
                { id: 'todo_1', description: '梳理真实阻塞交互链路', status: 'completed' },
                { id: 'todo_2', description: '增加 todo sample 数据与交互入口', status: 'running' },
              ],
            },
          },
        ],
      ]),
      activeBlockIds: new Set(),
    });

    const { container } = render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    fireEvent.click(screen.getByRole('button', { name: /增加 todo sample 数据与交互入口/i }));

    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(container.innerHTML).toContain('width="10" height="10"');
    expect(container.innerHTML).not.toContain('absolute left-0 top-full');
  });

  it('replaces the compact pill with a single expanded panel header', () => {
    const store = createMockStore({
      blocks: new Map([
        [
          'todo-1',
          {
            toolName: 'todo_init',
            toolOutput: {
              title: '迁移 study-ui playground 调试能力',
              steps: [
                { id: 'todo_1', description: '梳理真实阻塞交互链路', status: 'completed' },
                { id: 'todo_2', description: '增加 todo sample 数据与交互入口', status: 'running' },
              ],
            },
          },
        ],
      ]),
      activeBlockIds: new Set(),
    });

    const { container } = render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    fireEvent.click(screen.getByRole('button', { name: /增加 todo sample 数据与交互入口/i }));

    expect(screen.getByText('迁移 study-ui playground 调试能力')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('h-7 px-2.5');
  });

  it('shows only title and progress in collapsed mode without progress dots', () => {
    const store = createMockStore({
      blocks: new Map([
        [
          'todo-1',
          {
            toolName: 'todo_init',
            toolOutput: {
              title: '迁移 study-ui playground 调试能力',
              steps: [
                { id: 'todo_1', description: '梳理真实阻塞交互链路', status: 'completed' },
                { id: 'todo_2', description: '增加 todo sample 数据与交互入口', status: 'running' },
                { id: 'todo_3', description: '跑测试并记录剩余风险', status: 'pending' },
              ],
            },
          },
        ],
      ]),
      activeBlockIds: new Set(),
    });

    const { container } = render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    expect(screen.getByText('增加 todo sample 数据与交互入口')).toBeInTheDocument();
    expect(screen.getByText('1/3')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('w-1 h-1 rounded-full');
  });

  it('surfaces successful file changes inside the existing expanded task panel', () => {
    const store = createMockStore({
      blocks: new Map([
        [
          'todo-1',
          {
            toolName: 'todo_init',
            toolOutput: {
              title: 'Local runtime audit',
              steps: [
                { id: 'todo_1', description: 'Write summary file', status: 'completed' },
              ],
            },
          },
        ],
        [
          'file-1',
          {
            status: 'success',
            toolName: 'file_write',
            toolInput: {
              path: 'artifacts/runtime-summary.md',
            },
            toolOutput: {
              path: 'artifacts/runtime-summary.md',
            },
          },
        ],
      ]),
      activeBlockIds: new Set(),
    });

    render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    fireEvent.click(screen.getByRole('button', { name: /Local runtime audit/i }));

    expect(screen.getByText('Changes')).toBeInTheDocument();
    expect(screen.getByText('Create')).toBeInTheDocument();
    expect(screen.getByText('artifacts/runtime-summary.md')).toBeInTheDocument();
  });

  it('surfaces workspace artifact write summaries without a separate task UI', () => {
    const store = createMockStore({
      blocks: new Map([
        [
          'todo-1',
          {
            toolName: 'todo_init',
            toolOutput: {
              title: 'Artifact runtime',
              steps: [
                { id: 'todo_1', description: 'Create artifact', status: 'completed' },
              ],
            },
          },
        ],
        [
          'artifact-1',
          {
            status: 'success',
            toolName: 'builtin-workspace_artifact_write',
            toolInput: {
              path: 'reports/session.md',
              content: '# Summary',
            },
            toolOutput: {
              path: 'reports/session.md',
              file_name: 'session.md',
              file_change_summary: {
                created: 1,
                modified: 0,
                deleted: 0,
                bytes_written: 9,
                changes: [
                  {
                    op: 'created',
                    root_id: 'artifacts',
                    relative_path: 'reports/session.md',
                  },
                ],
              },
            },
          },
        ],
      ]),
      activeBlockIds: new Set(),
    });

    render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    fireEvent.click(screen.getByRole('button', { name: /Artifact runtime/i }));

    expect(screen.getByText('Changes')).toBeInTheDocument();
    expect(screen.getByText('Create')).toBeInTheDocument();
    expect(screen.getAllByText('reports/session.md').length).toBeGreaterThan(0);
  });

  it('surfaces workspace runtime reads and directory listings inside the task panel', () => {
    const store = createMockStore({
      blocks: new Map([
        [
          'todo-1',
          {
            toolName: 'todo_init',
            toolOutput: {
              title: 'Runtime visibility',
              steps: [
                { id: 'todo_1', description: 'Inspect files', status: 'completed' },
              ],
            },
          },
        ],
        [
          'list-1',
          {
            status: 'success',
            toolName: 'builtin-workspace_file_list',
            toolInput: {
              root_id: 'workspace',
              path: 'src',
            },
            toolOutput: {
              root_id: 'workspace',
              relative_path: 'src',
              entries: [{ name: 'main.tsx' }, { name: 'app.tsx' }],
              skipped: 1,
            },
          },
        ],
        [
          'read-1',
          {
            status: 'success',
            toolName: 'builtin-workspace_file_read',
            toolInput: {
              root_id: 'temp',
              path: 'scratch/output.txt',
            },
            toolOutput: {
              root_id: 'temp',
              relative_path: 'scratch/output.txt',
              bytes: 42,
              truncated: false,
            },
          },
        ],
      ]),
      activeBlockIds: new Set(),
    });

    render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    fireEvent.click(screen.getByRole('button', { name: /Runtime visibility/i }));

    expect(screen.getByText('Runtime')).toBeInTheDocument();
    expect(screen.getByText('List')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('workspace')).toBeInTheDocument();
    expect(screen.getByText('temp')).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('scratch/output.txt')).toBeInTheDocument();
    expect(screen.getByText('2 entries, 1 skipped')).toBeInTheDocument();
    expect(screen.getByText('42 bytes')).toBeInTheDocument();
  });

  it('surfaces blocked workspace runtime calls without a separate task UI', () => {
    const store = createMockStore({
      blocks: new Map([
        [
          'todo-1',
          {
            toolName: 'todo_init',
            toolOutput: {
              title: 'Runtime blocked',
              steps: [
                { id: 'todo_1', description: 'Try unauthorized read', status: 'failed' },
              ],
            },
          },
        ],
        [
          'blocked-1',
          {
            status: 'error',
            error: 'Unsupported runtime root secret',
            toolName: 'builtin-workspace_file_read',
            toolInput: {
              root_id: 'secret',
              path: 'private.txt',
            },
            toolOutput: {
              success: false,
            },
          },
        ],
      ]),
      activeBlockIds: new Set(),
    });

    render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    fireEvent.click(screen.getByRole('button', { name: /Runtime blocked/i }));

    expect(screen.getByText('Runtime')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('secret')).toBeInTheDocument();
    expect(screen.getByText('private.txt')).toBeInTheDocument();
  });

  it('surfaces local shell preflight inside the existing runtime section', () => {
    const store = createMockStore({
      blocks: new Map([
        [
          'todo-1',
          {
            toolName: 'todo_init',
            toolOutput: {
              title: 'Shell preflight',
              steps: [
                { id: 'todo_1', description: 'Check command risk', status: 'completed' },
              ],
            },
          },
        ],
        [
          'shell-1',
          {
            status: 'success',
            toolName: 'builtin-local_shell_preflight',
            toolInput: {
              command: 'git status --short',
              root_id: 'workspace',
              cwd: '.',
            },
            toolOutput: {
              command: 'git status --short',
              root_id: 'workspace',
              cwd: '.',
              risk_level: 'low',
              would_execute: false,
              execution_supported: false,
            },
          },
        ],
      ]),
      activeBlockIds: new Set(),
    });

    render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    fireEvent.click(screen.getByRole('button', { name: /Shell preflight/i }));

    expect(screen.getByText('Runtime')).toBeInTheDocument();
    expect(screen.getByText('Check')).toBeInTheDocument();
    expect(screen.getByText('workspace')).toBeInTheDocument();
    expect(screen.getByText('git status --short')).toBeInTheDocument();
    expect(screen.getByText('low / .')).toBeInTheDocument();
  });

  it('surfaces local shell execution inside the existing runtime section', () => {
    const store = createMockStore({
      blocks: new Map([
        [
          'todo-1',
          {
            toolName: 'todo_init',
            toolOutput: {
              title: 'Shell execution',
              steps: [
                { id: 'todo_1', description: 'Run command', status: 'completed' },
              ],
            },
          },
        ],
        [
          'shell-1',
          {
            status: 'success',
            toolName: 'builtin-local_shell_execute',
            toolInput: {
              command: 'git status --short',
              root_id: 'workspace',
              cwd: '.',
            },
            toolOutput: {
              command: 'git status --short',
              root_id: 'workspace',
              cwd: '.',
              exit_code: 0,
              success: true,
              timed_out: false,
              stdout_truncated: false,
              stderr_truncated: false,
              file_change_summary: {
                created: 1,
                modified: 0,
                deleted: 0,
                changes: [
                  {
                    op: 'created',
                    root_id: 'workspace',
                    relative_path: 'reports/shell-output.txt',
                    bytes: 12,
                  },
                ],
              },
            },
          },
        ],
      ]),
      activeBlockIds: new Set(),
    });

    render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    fireEvent.click(screen.getByRole('button', { name: /Shell execution/i }));

    expect(screen.getByText('Runtime')).toBeInTheDocument();
    expect(screen.getByText('Check')).toBeInTheDocument();
    expect(screen.getByText('workspace')).toBeInTheDocument();
    expect(screen.getByText('git status --short')).toBeInTheDocument();
    expect(screen.getByText('exit 0 / .')).toBeInTheDocument();
    expect(screen.getByText('Changes')).toBeInTheDocument();
    expect(screen.getByText('reports/shell-output.txt')).toBeInTheDocument();
  });

  it('summarizes non-default local shell env policy inline', () => {
    const store = createMockStore({
      blocks: new Map([
        [
          'todo-1',
          {
            toolName: 'todo_init',
            toolOutput: {
              title: 'Shell env',
              steps: [
                { id: 'todo_1', description: 'Run command', status: 'completed' },
              ],
            },
          },
        ],
        [
          'shell-1',
          {
            status: 'success',
            toolName: 'builtin-local_shell_execute',
            toolInput: {
              command: 'node --version',
              root_id: 'workspace',
              cwd: '.',
            },
            toolOutput: {
              command: 'node --version',
              root_id: 'workspace',
              cwd: '.',
              exit_code: 0,
              success: true,
              timed_out: false,
              env_policy: {
                allowlist_mode: true,
                explicit_keys: ['NODE_ENV'],
              },
              network_policy: {
                allow_network: true,
                network_capable_command: true,
              },
            },
          },
        ],
      ]),
      activeBlockIds: new Set(),
    });

    render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    fireEvent.click(screen.getByRole('button', { name: /Shell env/i }));

    expect(screen.getByText('exit 0, env allowlist +1, net / .')).toBeInTheDocument();
  });

  it('expands an inline preview with a line diff when the change has a backup_ref', async () => {
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'chat_v2_read_runtime_file') {
        if (args.rootId === 'temp') {
          return { content: 'line1\nold line', truncated: false };
        }
        return { content: 'line1\nnew line', truncated: false };
      }
      return {};
    });

    const store = createArtifactWriteStore({
      op: 'modified',
      root_id: 'artifacts',
      relative_path: 'reports/session.md',
      backup_ref: '.write_backups/1_0000_session.md',
    });

    render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    fireEvent.click(screen.getByRole('button', { name: /Artifact runtime/i }));
    fireEvent.click(screen.getByRole('button', { name: '预览' }));

    expect(await screen.findByText('+ new line')).toBeInTheDocument();
    expect(screen.getByText('- old line')).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_read_runtime_file', {
      sessionId: 'sess-1',
      rootId: 'artifacts',
      relativePath: 'reports/session.md',
    });
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_read_runtime_file', {
      sessionId: 'sess-1',
      rootId: 'temp',
      relativePath: '.write_backups/1_0000_session.md',
    });
  });

  it('shows a plain content preview when the change has no backup_ref', async () => {
    invokeMock.mockResolvedValue({ content: 'fresh content', truncated: false });

    const store = createArtifactWriteStore({
      op: 'created',
      root_id: 'artifacts',
      relative_path: 'reports/session.md',
    });

    render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    fireEvent.click(screen.getByRole('button', { name: /Artifact runtime/i }));
    fireEvent.click(screen.getByRole('button', { name: '预览' }));

    expect(await screen.findByText('fresh content')).toBeInTheDocument();
    // 新建写入没有备份，只读当前内容，不应去 temp 根取备份
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('reverts a modified artifact via restore copy and marks the chip reverted', async () => {
    invokeMock.mockResolvedValue({ reverted: true, mode: 'restored' });

    const store = createArtifactWriteStore({
      op: 'modified',
      root_id: 'artifacts',
      relative_path: 'reports/session.md',
      backup_ref: '.write_backups/1_0000_session.md',
      after_hash: 'sha256-modified',
    });

    render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    fireEvent.click(screen.getByRole('button', { name: /Artifact runtime/i }));

    const revertButton = screen.getByRole('button', { name: '恢复原内容' });
    expect(screen.queryByRole('button', { name: '删除新文件' })).not.toBeInTheDocument();
    fireEvent.click(revertButton);

    expect(await screen.findByText('已撤销')).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_revert_artifact_write', {
      sessionId: 'sess-1',
      relativePath: 'reports/session.md',
      backupRef: '.write_backups/1_0000_session.md',
      expectedAfterHash: 'sha256-modified',
    });
  });

  it('reverts a newly created artifact via delete copy', async () => {
    invokeMock.mockResolvedValue({ reverted: true, mode: 'deleted' });

    const store = createArtifactWriteStore({
      op: 'created',
      root_id: 'artifacts',
      relative_path: 'reports/session.md',
      after_hash: 'sha256-created',
    });

    render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    fireEvent.click(screen.getByRole('button', { name: /Artifact runtime/i }));

    const revertButton = screen.getByRole('button', { name: '删除新文件' });
    expect(screen.queryByRole('button', { name: '恢复原内容' })).not.toBeInTheDocument();
    fireEvent.click(revertButton);

    expect(await screen.findByText('已撤销')).toBeInTheDocument();
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_revert_artifact_write', {
        sessionId: 'sess-1',
        relativePath: 'reports/session.md',
        backupRef: null,
        expectedAfterHash: 'sha256-created',
      });
    });
  });

  it('saves a markdown artifact as a DSTU note and switches the button to open', async () => {
    invokeMock.mockResolvedValue({ content: '# Session summary', truncated: false });
    dstuCreateMock.mockResolvedValue({
      ok: true,
      value: { id: 'note-123', name: 'session', type: 'note' },
    });

    const store = createArtifactWriteStore({
      op: 'created',
      root_id: 'artifacts',
      relative_path: 'reports/session.md',
    });

    render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    fireEvent.click(screen.getByRole('button', { name: /Artifact runtime/i }));
    fireEvent.click(screen.getByRole('button', { name: '保存到笔记库' }));

    // 成功后 chip 显示已保存态，按钮切换为「打开笔记」
    expect(await screen.findByText('已存为笔记')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存到笔记库' })).not.toBeInTheDocument();

    expect(invokeMock).toHaveBeenCalledWith('chat_v2_read_runtime_file', {
      sessionId: 'sess-1',
      rootId: 'artifacts',
      relativePath: 'reports/session.md',
      maxBytes: 512 * 1024,
    });
    // 笔记标题 = 文件名去扩展名，内容为产物全文
    expect(dstuCreateMock).toHaveBeenCalledWith('/', {
      type: 'note',
      name: 'session',
      content: '# Session summary',
      metadata: { tags: [] },
    });

    const openNoteEvents: Array<{ noteId?: string; source?: string }> = [];
    const onOpenNote = (event: Event) => {
      openNoteEvents.push((event as CustomEvent).detail);
    };
    window.addEventListener('DSTU_OPEN_NOTE', onOpenNote);
    try {
      fireEvent.click(screen.getByRole('button', { name: '打开笔记' }));
    } finally {
      window.removeEventListener('DSTU_OPEN_NOTE', onOpenNote);
    }
    expect(openNoteEvents).toEqual([
      { noteId: 'note-123', source: 'agent_task_panel_changes' },
    ]);
    // 不允许重复创建
    expect(dstuCreateMock).toHaveBeenCalledTimes(1);
  });

  it('shows an error notification and keeps the save button when reading the artifact fails', async () => {
    invokeMock.mockRejectedValue(new Error('runtime file unreadable'));

    const store = createArtifactWriteStore({
      op: 'created',
      root_id: 'artifacts',
      relative_path: 'reports/session.md',
    });

    render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    fireEvent.click(screen.getByRole('button', { name: /Artifact runtime/i }));
    fireEvent.click(screen.getByRole('button', { name: '保存到笔记库' }));

    await waitFor(() => {
      expect(showGlobalNotificationMock).toHaveBeenCalledWith(
        'error',
        '存为笔记失败',
        expect.stringContaining('runtime file unreadable'),
      );
    });
    expect(dstuCreateMock).not.toHaveBeenCalled();
    expect(screen.queryByText('已存为笔记')).not.toBeInTheDocument();
    // 失败后仍可重试
    expect(screen.getByRole('button', { name: '保存到笔记库' })).toBeInTheDocument();
  });
});
