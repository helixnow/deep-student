import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

import * as ChatFeatureBarrel from '../../index';
import * as ChatComponentsBarrel from '../index';
import { AgentTaskPanel } from '../AgentTaskPanel';
import { ChangesSection } from '../agent-task/ChangesSection';
import { ProjectKnowledgeDagDrawer, ProjectKnowledgeDagStore } from '../ProjectKnowledgeDagDrawer';
import { TurnDiffLedger, TurnDiffReviewCard } from '../TurnDiffReviewCard';
import type { ChangeItem } from '../agent-task/types';

interface MockTaskStoreState {
  blocks: Map<string, unknown>;
  activeBlockIds: Set<string>;
  sessionId?: string;
}

function createMockTaskStore(state: MockTaskStoreState): StoreApi<MockTaskStoreState> {
  return createStore<MockTaskStoreState>(() => state);
}

describe('Lane 2 Integration: Chat V2 Barrel Exports, ChangesSection TurnDiffReviewCard & AgentTaskPanel DAG Drawer', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    showGlobalNotificationMock.mockReset();
    dstuCreateMock.mockReset();
  });

  it('1. exports TurnDiffReviewCard, ProjectKnowledgeDagDrawer, ContextualMiniChat and controllers from components/index.ts and chat/index.ts', () => {
    expect(ChatComponentsBarrel.TurnDiffReviewCard).toBeDefined();
    expect(ChatComponentsBarrel.TurnDiffLedger).toBeDefined();
    expect(typeof ChatComponentsBarrel.computeUnifiedDiffSummary).toBe('function');
    expect(ChatComponentsBarrel.ProjectKnowledgeDagDrawer).toBeDefined();
    expect(ChatComponentsBarrel.ProjectKnowledgeDagStore).toBeDefined();
    expect(ChatComponentsBarrel.ContextualMiniChat).toBeDefined();

    expect(ChatFeatureBarrel.TurnDiffReviewCard).toBe(ChatComponentsBarrel.TurnDiffReviewCard);
    expect(ChatFeatureBarrel.TurnDiffLedger).toBe(ChatComponentsBarrel.TurnDiffLedger);
    expect(ChatFeatureBarrel.computeUnifiedDiffSummary).toBe(
      ChatComponentsBarrel.computeUnifiedDiffSummary,
    );
    expect(ChatFeatureBarrel.ProjectKnowledgeDagDrawer).toBe(
      ChatComponentsBarrel.ProjectKnowledgeDagDrawer,
    );
    expect(ChatFeatureBarrel.ProjectKnowledgeDagStore).toBe(
      ChatComponentsBarrel.ProjectKnowledgeDagStore,
    );
    expect(ChatFeatureBarrel.ContextualMiniChat).toBe(ChatComponentsBarrel.ContextualMiniChat);
  });

  it('2. toggles TurnDiffReviewCard inside ChangesSection and maps ChangeItem list to TurnFileDiffEntry items', () => {
    const changes: ChangeItem[] = [
      {
        id: 'chg-1',
        kind: 'file',
        action: 'create',
        label: 'notes/calculus.md',
        relativePath: 'notes/calculus.md',
        rootId: 'artifacts',
        toolName: 'builtin-workspace_artifact_write',
        afterHash: 'hash-1',
      },
      {
        id: 'chg-2',
        kind: 'file',
        action: 'update',
        label: 'src/solver.ts',
        relativePath: 'src/solver.ts',
        rootId: 'workspace',
        toolName: 'builtin-workspace_file_write',
        receipt: { op: 'modified', relative_path: 'src/solver.ts' },
      },
    ];

    render(
      <ChangesSection
        changes={changes}
        coverageIssues={[]}
        sessionId="sess-diff-1"
        onRevealRuntimeFile={vi.fn()}
      />,
    );

    const toggleBtn = screen.getByTestId('toggle-turn-diff-review-card');
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('turn-diff-review-card')).not.toBeInTheDocument();

    fireEvent.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('turn-diff-review-card')).toBeInTheDocument();
    expect(screen.getByTestId('turn-diff-file-count')).toHaveTextContent('2 个文件');
    expect(screen.getByTestId('turn-diff-entry-chg-1')).toBeInTheDocument();
    expect(screen.getByTestId('turn-diff-entry-chg-2')).toBeInTheDocument();
  });

  it('3. feeds loaded preview content and backupContent into TurnDiffReviewCard for line-level Unified Diff calculation', async () => {
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'chat_v2_read_runtime_file') {
        if (args.rootId === 'temp') {
          return { content: 'const alpha = 1;\nconst beta = 2;', truncated: false };
        }
        return { content: 'const alpha = 1;\nconst beta = 20;\nconst gamma = 30;', truncated: false };
      }
      return {};
    });

    const changes: ChangeItem[] = [
      {
        id: 'chg-preview-1',
        kind: 'file',
        action: 'update',
        label: 'src/math.ts',
        relativePath: 'src/math.ts',
        rootId: 'artifacts',
        backupRef: '.backups/math.ts',
        afterHash: 'sha-math',
        toolName: 'builtin-workspace_artifact_write',
      },
    ];

    render(
      <ChangesSection
        changes={changes}
        coverageIssues={[]}
        sessionId="sess-diff-preview"
        onRevealRuntimeFile={vi.fn()}
      />,
    );

    // 先点击预览加载真实新旧文件内容
    fireEvent.click(screen.getByRole('button', { name: /预览|preview/i }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_read_runtime_file', {
        sessionId: 'sess-diff-preview',
        rootId: 'artifacts',
        relativePath: 'src/math.ts',
      });
    });

    // 展开 TurnDiffReviewCard，验证计算出行级增删统计（+2 / -1）
    fireEvent.click(screen.getByTestId('toggle-turn-diff-review-card'));
    await waitFor(() => {
      expect(screen.getByTestId('turn-diff-total-additions')).toHaveTextContent('+2');
      expect(screen.getByTestId('turn-diff-total-deletions')).toHaveTextContent('-1');
    });
    expect(screen.getByTestId('turn-diff-preview-chg-preview-1')).toBeInTheDocument();
  });

  it('4. under StrictMode triggers backend revert IPC exactly once per file/turn, hides fake Redo when disk write-back is unavailable, and rolls back UI if IPC fails', async () => {
    invokeMock.mockResolvedValue({ reverted: true });

    const receipt2 = {
      change_id: 'ws-chg-2',
      root_id: 'workspace',
      op: 'modified',
      relative_path: 'src/index.ts',
    };

    const changes: ChangeItem[] = [
      {
        id: 'chg-a',
        kind: 'file',
        action: 'create',
        label: 'reports/out.md',
        relativePath: 'reports/out.md',
        rootId: 'artifacts',
        afterHash: 'hash-out-a',
        toolName: 'builtin-workspace_artifact_write',
      },
      {
        id: 'chg-b',
        kind: 'file',
        action: 'update',
        label: 'src/index.ts',
        relativePath: 'src/index.ts',
        rootId: 'workspace',
        receipt: receipt2,
        toolName: 'builtin-workspace_file_write',
      },
    ];

    render(
      <React.StrictMode>
        <ChangesSection
          changes={changes}
          coverageIssues={[]}
          sessionId="sess-revert-link"
          onRevealRuntimeFile={vi.fn()}
        />
      </React.StrictMode>,
    );

    fireEvent.click(screen.getByTestId('toggle-turn-diff-review-card'));

    // 单文件回滚 chg-a（StrictMode 下严格只触发 1 次后端 IPC）
    fireEvent.click(screen.getByTestId('turn-diff-revert-file-chg-a'));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_revert_artifact_write', {
        sessionId: 'sess-revert-link',
        relativePath: 'reports/out.md',
        backupRef: null,
        expectedAfterHash: 'hash-out-a',
      });
    });
    expect(screen.getByTestId('turn-diff-entry-chg-a')).toHaveAttribute('data-reverted', 'true');
    expect(screen.getByTestId('turn-diff-reverted-status-chg-a')).toHaveTextContent('已回滚');
    // 无真实磁盘写回能力时，绝不展示虚假的单文件 Redo 按钮
    expect(screen.queryByTestId('turn-diff-redo-file-chg-a')).not.toBeInTheDocument();

    // 整轮一键回滚（仅对剩余可回滚文件 chg-b 触发 1 次后端 IPC）
    fireEvent.click(screen.getByTestId('turn-diff-revert-all'));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(2);
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_revert_workspace_change', {
        sessionId: 'sess-revert-link',
        receipt: receipt2,
      });
    });
    expect(screen.getByTestId('turn-diff-all-reverted-badge')).toBeInTheDocument();
    // 无真实磁盘写回能力时，绝不展示虚假的整轮 Redo 按钮
    expect(screen.queryByTestId('turn-diff-redo-all')).not.toBeInTheDocument();
  });

  it('4b. rolls back optimistic UI state when backend revert IPC rejects, and preserves full Redo when TurnDiffLedger provides onRedoFile', async () => {
    invokeMock.mockRejectedValueOnce(new Error('disk hash mismatch'));

    const changes: ChangeItem[] = [
      {
        id: 'chg-fail',
        kind: 'file',
        action: 'create',
        label: 'reports/fail.md',
        relativePath: 'reports/fail.md',
        rootId: 'artifacts',
        afterHash: 'hash-fail',
        toolName: 'builtin-workspace_artifact_write',
      },
    ];

    const { unmount } = render(
      <React.StrictMode>
        <ChangesSection
          changes={changes}
          coverageIssues={[]}
          sessionId="sess-revert-fail"
          onRevealRuntimeFile={vi.fn()}
        />
      </React.StrictMode>,
    );

    fireEvent.click(screen.getByTestId('toggle-turn-diff-review-card'));
    fireEvent.click(screen.getByTestId('turn-diff-revert-file-chg-fail'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('turn-diff-entry-chg-fail')).toHaveAttribute(
        'data-reverted',
        'false',
      );
    });
    expect(screen.queryByTestId('turn-diff-all-reverted-badge')).not.toBeInTheDocument();
    unmount();

    // 验证纯前端 TurnDiffLedger 显式传入 onRedoFile / onRedoAll 时，完整保留 Redo 按钮且 StrictMode 下只触发一次
    const ledger = new TurnDiffLedger();
    ledger.recordChange({
      id: 'ledger-1',
      path: 'notes/demo.md',
      beforeContent: 'v1',
      afterContent: 'v2',
    });
    const onRevertFile = vi.fn((id: string) => {
      ledger.revertFile(id);
    });
    const onRedoFile = vi.fn((id: string) => {
      ledger.redoFile(id);
    });

    render(
      <React.StrictMode>
        <TurnDiffReviewCard
          entries={ledger.getEntries()}
          onRevertFile={onRevertFile}
          onRedoFile={onRedoFile}
        />
      </React.StrictMode>,
    );

    fireEvent.click(screen.getByTestId('turn-diff-revert-file-ledger-1'));
    await waitFor(() => {
      expect(onRevertFile).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId('turn-diff-redo-file-ledger-1')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('turn-diff-redo-file-ledger-1'));
    await waitFor(() => {
      expect(onRedoFile).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId('turn-diff-entry-ledger-1')).toHaveAttribute('data-reverted', 'false');
  });

  it('5. mounts ProjectKnowledgeDagDrawer inside AgentTaskPanel, persists checked DAG tasks across steps re-renders, and dispatches Ready tasks', () => {
    const store = createMockTaskStore({
      sessionId: 'sess-dag-1',
      blocks: new Map([
        [
          'todo-dag-1',
          {
            toolName: 'todo_init',
            toolOutput: {
              title: '微积分专题突破计划',
              steps: [
                { id: 'step-1', description: '推导极限定义与夹逼准则', status: 'completed' },
                { id: 'step-2', description: '完成洛必达法则典型例题', status: 'running' },
                { id: 'step-3', description: '整理泰勒展开高阶余项笔记', status: 'pending' },
              ],
            },
          },
        ],
      ]),
      activeBlockIds: new Set(),
    });

    const inputEvents: Array<{ content: string; autoSend?: boolean }> = [];
    const onSetInput = (e: Event) => {
      inputEvents.push((e as CustomEvent<{ content: string; autoSend?: boolean }>).detail);
    };
    window.addEventListener('CHAT_V2_SET_INPUT', onSetInput);

    try {
      render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

      // 展开 AgentTaskPanel
      fireEvent.click(screen.getByRole('button', { name: /完成洛必达法则典型例题/i }));

      // 点击「DAG 拓扑视图」按钮展开 ProjectKnowledgeDagDrawer
      const dagToggleBtn = screen.getByTestId('toggle-project-knowledge-dag-drawer');
      expect(dagToggleBtn).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('project-knowledge-dag-drawer')).not.toBeInTheDocument();

      fireEvent.click(dagToggleBtn);
      expect(dagToggleBtn).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByTestId('project-knowledge-dag-drawer')).toBeInTheDocument();

      // step-1 已完成，step-2 为 Ready，step-3 因依赖未完成的 step-2 处于 Blocked
      expect(screen.getByTestId('dag-todo-item-step-1')).toHaveAttribute(
        'data-dag-status',
        'completed',
      );
      expect(screen.getByTestId('dag-todo-item-step-2')).toHaveAttribute('data-dag-status', 'ready');
      expect(screen.getByTestId('dag-todo-item-step-3')).toHaveAttribute(
        'data-dag-status',
        'blocked',
      );
      expect(screen.getByTestId('dag-blocked-badge-step-3')).toHaveTextContent(
        '等待前置：完成洛必达法则典型例题',
      );

      // 勾选前置就绪任务 step-2 后，下游阻塞任务 step-3 自动解锁为 Ready
      fireEvent.click(screen.getByRole('button', { name: '勾选任务：完成洛必达法则典型例题' }));

      expect(screen.getByTestId('dag-todo-item-step-2')).toHaveAttribute(
        'data-dag-status',
        'completed',
      );
      expect(screen.getByTestId('dag-todo-item-step-3')).toHaveAttribute('data-dag-status', 'ready');

      // 模拟流式期间底层 store 的 steps 重新推送更新（step-2 仍为 running），验证用户手动勾选状态不丢失
      act(() => {
        store.setState({
          blocks: new Map([
            [
              'todo-dag-1',
              {
                toolName: 'todo_init',
                toolOutput: {
                  title: '微积分专题突破计划（流式刷新）',
                  steps: [
                    { id: 'step-1', description: '推导极限定义与夹逼准则', status: 'completed' },
                    { id: 'step-2', description: '完成洛必达法则典型例题', status: 'running' },
                    { id: 'step-3', description: '整理泰勒展开高阶余项笔记', status: 'pending' },
                  ],
                },
              },
            ],
          ]),
        });
      });

      expect(screen.getByTestId('dag-todo-item-step-2')).toHaveAttribute(
        'data-dag-status',
        'completed',
      );
      expect(screen.getByTestId('dag-todo-item-step-3')).toHaveAttribute('data-dag-status', 'ready');
      expect(screen.queryByTestId('dag-blocked-badge-step-3')).not.toBeInTheDocument();

      // 点击已解锁任务 step-3 的「派发」按钮，验证触发输入框填入事件与全局提示
      const step3Card = screen.getByTestId('dag-todo-item-step-3');
      fireEvent.click(within(step3Card).getByRole('button', { name: '派发' }));
      expect(inputEvents).toHaveLength(1);
      expect(inputEvents[0].content).toContain('整理泰勒展开高阶余项笔记');
      expect(showGlobalNotificationMock).toHaveBeenCalledWith('info', '已将就绪任务填入输入框');
    } finally {
      window.removeEventListener('CHAT_V2_SET_INPUT', onSetInput);
    }
  });

  it('6. supports custom ProjectKnowledgeDagStore injected into AgentTaskPanel, external store updates, and activePlanId prop sync', () => {
    const customKnowledgeStore = new ProjectKnowledgeDagStore();
    const savedPlan = customKnowledgeStore.savePlan({
      body: '# 线性代数强化计划\n## Steps\n- [ ] 特征值与特征向量\n- [ ] 实对称矩阵对角化',
    });
    customKnowledgeStore.savePlan({
      id: savedPlan.id,
      sessionId: 'sess-custom-dag',
    });
    const secondPlan = customKnowledgeStore.savePlan({
      body: '# 概率论冲刺计划\n## Steps\n- [ ] 大数定律与中心极限定理',
    });
    const todoA = customKnowledgeStore.saveTodo({
      body: '特征值与特征向量',
      planId: savedPlan.id,
      completed: false,
      dependsOn: [],
    });
    const todoB = customKnowledgeStore.saveTodo({
      body: '实对称矩阵对角化',
      planId: savedPlan.id,
      completed: false,
      dependsOn: [todoA.id],
    });
    const todoProb = customKnowledgeStore.saveTodo({
      body: '大数定律与中心极限定理',
      planId: secondPlan.id,
      completed: false,
      dependsOn: [],
    });

    const store = createMockTaskStore({
      sessionId: 'sess-custom-dag',
      blocks: new Map([
        [
          'todo-custom-1',
          {
            toolName: 'todo_init',
            toolOutput: {
              title: '线性代数强化计划',
              steps: [
                { id: 'step-a', description: '特征值与特征向量', status: 'running' },
                { id: 'step-b', description: '实对称矩阵对角化', status: 'pending' },
              ],
            },
          },
        ],
      ]),
      activeBlockIds: new Set(),
    });

    const { unmount } = render(
      <AgentTaskPanel
        store={store as unknown as StoreApi<any>}
        knowledgeStore={customKnowledgeStore}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /特征值与特征向量/i }));
    fireEvent.click(screen.getByTestId('toggle-project-knowledge-dag-drawer'));

    expect(screen.getByTestId(`dag-todo-item-${todoA.id}`)).toHaveAttribute(
      'data-dag-status',
      'ready',
    );
    expect(screen.getByTestId(`dag-todo-item-${todoB.id}`)).toHaveAttribute(
      'data-dag-status',
      'blocked',
    );

    // 外部直接修改 store（模拟后台 Agent 完成 todoA），抽屉自动同步刷新
    act(() => {
      customKnowledgeStore.saveTodo({ id: todoA.id, completed: true });
    });

    expect(screen.getByTestId(`dag-todo-item-${todoA.id}`)).toHaveAttribute(
      'data-dag-status',
      'completed',
    );
    expect(screen.getByTestId(`dag-todo-item-${todoB.id}`)).toHaveAttribute(
      'data-dag-status',
      'ready',
    );
    expect(screen.getByTestId('dag-completion-badge')).toHaveTextContent('1/2 (50%)');
    unmount();

    // 验证 activePlanId prop 外部切换时自动同步当前选中计划
    const { rerender } = render(
      <ProjectKnowledgeDagDrawer store={customKnowledgeStore} activePlanId={savedPlan.id} />,
    );
    expect(screen.getByTestId(`dag-todo-item-${todoA.id}`)).toBeInTheDocument();

    rerender(
      <ProjectKnowledgeDagDrawer store={customKnowledgeStore} activePlanId={secondPlan.id} />,
    );
    expect(screen.getByTestId(`dag-todo-item-${todoProb.id}`)).toBeInTheDocument();
  });
});
