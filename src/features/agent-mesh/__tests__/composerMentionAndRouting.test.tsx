import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createStore } from 'zustand/vanilla';
import i18n from '@/i18n';
import zhAgentMesh from '@/locales/zh-CN/agentMesh.json';
import enAgentMesh from '@/locales/en-US/agentMesh.json';
import {
  registerAgentMeshHostBridge,
  resetAgentMeshStore,
  setWorkspaceBinding,
  useAgentMeshStore,
  type AgentMeshHostBridge,
  type DetectedMeshAgent,
} from '@/features/agent-mesh';
import {
  useModelMentionAutocomplete,
  type AgentMentionItem,
} from '@/features/chat/components/input-bar/useModelMentionAutocomplete';
import { ModelMentionPopover } from '@/features/chat/components/input-bar/ModelMentionPopover';
import { ModelMentionChips } from '@/features/chat/components/input-bar/ModelMentionChip';
import { useInputBarV2 } from '@/features/chat/components/input-bar/useInputBarV2';
import { QueuedMessageStack } from '@/features/chat/components/input-bar/QueuedMessageStack';
import type { QueuedMessage } from '@/features/chat/core/types/queue';
import type { ModelInfo } from '@/features/chat/utils/parseModelMentions';

const dialogOpenMock = vi.fn<() => Promise<string | string[] | null>>(async () => null);

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: () => dialogOpenMock(),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/features/chat/readiness/readinessGate', () => ({
  resolveChatReadiness: vi.fn(async () => ({ ok: true })),
  keepsTurnsWithoutChatModel: vi.fn(() => false),
  triggerOpenSettingsModels: vi.fn(),
}));

interface MockChatState {
  sessionId: string;
  inputValue: string;
  sessionStatus: 'idle' | 'streaming' | 'aborting';
  permissionPresetSyncing: boolean;
  attachments: never[];
  pendingContextRefs: never[];
  queuedMessages: QueuedMessage[];
  panelStates: {
    attachment: boolean;
    model: boolean;
    advanced: boolean;
    mcp: boolean;
    skill: boolean;
  };
  chatParams: {
    modelId: string;
    model2OverrideId: string | null;
    modelDisplayName?: string;
    modelIdPinnedByUser?: boolean;
  };
  setInputValue: (val: string) => void;
  canSend: () => boolean;
  canAbort: () => boolean;
  sendMessage: (content: string, attachments?: unknown[]) => Promise<void>;
  abortStream: () => Promise<void>;
  clearAttachments: () => void;
  setChatParams: (params: Record<string, unknown>) => void;
  setPendingParallelModelIds: (ids: string[] | null) => void;
  enqueueMessage: (content: string, attachments?: unknown[], refs?: unknown[]) => void;
  removeQueued: (id: string) => void;
  promoteQueued: (id: string) => void;
  markSteered: (id: string) => void;
  recallToDraft: (id: string) => void;
  swapQueueWithDraft: (id: string) => void;
  retryFailed: (id: string) => void;
  clearQueue: () => void;
  maybeDequeue: () => Promise<void>;
}

function createMockChatStore(sessionId = 'sess-mesh-1') {
  let queueSeq = 0;
  const sendMessageSpy = vi.fn(async () => {});
  const abortStreamSpy = vi.fn(async () => {});

  const store = createStore<MockChatState>((set, get) => ({
    sessionId,
    inputValue: '',
    sessionStatus: 'idle',
    permissionPresetSyncing: false,
    attachments: [],
    pendingContextRefs: [],
    queuedMessages: [],
    panelStates: {
      attachment: false,
      model: false,
      advanced: false,
      mcp: false,
      skill: false,
    },
    chatParams: {
      modelId: 'deepseek-v4',
      model2OverrideId: null,
    },
    setInputValue: (val) => set({ inputValue: val }),
    canSend: () => get().sessionStatus === 'idle',
    canAbort: () => get().sessionStatus === 'streaming',
    sendMessage: sendMessageSpy,
    abortStream: abortStreamSpy,
    clearAttachments: vi.fn(),
    setChatParams: (params) =>
      set((s) => ({ chatParams: { ...s.chatParams, ...params } })),
    setPendingParallelModelIds: vi.fn(),
    enqueueMessage: (content) => {
      queueSeq += 1;
      const item: QueuedMessage = {
        id: `q-${queueSeq}`,
        content,
        attachments: [],
        contextRefs: [],
        status: 'pending',
        createdAt: Date.now(),
      };
      set((s) => ({ queuedMessages: [...s.queuedMessages, item] }));
    },
    removeQueued: (id) =>
      set((s) => ({ queuedMessages: s.queuedMessages.filter((q) => q.id !== id) })),
    promoteQueued: vi.fn(),
    markSteered: vi.fn(),
    recallToDraft: vi.fn(),
    swapQueueWithDraft: vi.fn(),
    retryFailed: vi.fn(),
    clearQueue: () => set({ queuedMessages: [] }),
    maybeDequeue: vi.fn(async () => {}),
  }));

  return { store, sendMessageSpy, abortStreamSpy };
}

const SAMPLE_MODELS: ModelInfo[] = [
  { id: 'deepseek-v4', name: 'DeepSeek V4', model: 'deepseek-chat' },
  { id: 'qwen-max', name: 'Qwen3 Max', model: 'qwen-max-latest' },
];

const SAMPLE_AGENTS: AgentMentionItem[] = [
  {
    id: 'mesh-agent:claude',
    name: 'Claude Code',
    model: '@claude',
    aliases: ['claude', 'cc'],
    mentionKind: 'agent',
    agentId: 'claude',
    agentHandle: 'claude',
    driverKind: 'claude',
    isExternalCli: true,
    agentStatus: 'ready',
    capabilityBadge: '实时纠偏 · 子代理树',
    sessionId: 'sess-mesh-1',
  },
  {
    id: 'mesh-agent:codex',
    name: 'Codex CLI',
    model: '@codex',
    aliases: ['codex'],
    mentionKind: 'agent',
    agentId: 'codex',
    agentHandle: 'codex',
    driverKind: 'codex',
    isExternalCli: true,
    agentStatus: 'waiting_children',
    subagentCount: 2,
    capabilityBadge: '实时纠偏 · 网格互通',
    sessionId: 'sess-mesh-1',
  },
  {
    id: 'mesh-agent:deepstudent',
    name: 'DeepStudent',
    model: '@deepstudent',
    aliases: ['deepstudent', 'ds'],
    mentionKind: 'agent',
    agentId: 'deepstudent',
    agentHandle: 'deepstudent',
    driverKind: 'builtin',
    isExternalCli: false,
    agentStatus: 'ready',
    capabilityBadge: '全局编排 · 学习闭环',
    sessionId: 'sess-mesh-1',
  },
];

describe('Agent Mesh Composer @agent Mention, Folder Pill & Routing', () => {
  beforeEach(async () => {
    i18n.addResourceBundle('zh-CN', 'agentMesh', zhAgentMesh, true, true);
    i18n.addResourceBundle('en-US', 'agentMesh', enAgentMesh, true, true);
    await i18n.changeLanguage('zh-CN');
    resetAgentMeshStore();
    registerAgentMeshHostBridge(null);
  });

  it('preserves zero-clutter pure model popover when 0 external CLIs are installed', () => {
    const onSelectModel = vi.fn();
    const { result } = renderHook(() =>
      useModelMentionAutocomplete({
        availableModels: SAMPLE_MODELS,
        availableAgents: [],
        inputValue: '@deep',
        selectedModels: [],
        onSelectModel,
        onDeselectModel: vi.fn(),
        onRemoveLastModel: vi.fn(),
      }),
    );

    act(() => {
      result.current.actions?.updateCursorPosition(5);
    });

    expect(result.current.state?.showAutoComplete).toBe(true);
    expect(result.current.state?.suggestions).toHaveLength(1);
    expect(result.current.state?.suggestions[0].id).toBe('deepseek-v4');

    render(
      <ModelMentionPopover
        open={true}
        suggestions={result.current.state?.suggestions ?? []}
        selectedIndex={0}
        query="deep"
        onSelect={onSelectModel}
        onSelectedIndexChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('mention-section-agents')).toBeNull();
    expect(screen.queryByTestId('mention-section-models')).toBeNull();
    expect(screen.getByText('DeepSeek V4')).toBeTruthy();
  });

  it('renders Section 1 (Agents with status dots & capability badges) above Section 2 (Models) and multiline-safely inserts chips + WorkspaceFolderPill', async () => {
    const selectedAgents: AgentMentionItem[] = [];
    const onSelectAgent = vi.fn((agent: AgentMentionItem) => {
      selectedAgents.push(agent);
    });

    const multilineDraft = '第一行保留不变\n@c\n第三行代码上下文';
    const caretAfterAtC = '第一行保留不变\n@c'.length;

    const { result } = renderHook(() =>
      useModelMentionAutocomplete({
        availableModels: SAMPLE_MODELS,
        availableAgents: SAMPLE_AGENTS,
        inputValue: multilineDraft,
        selectedModels: [],
        selectedAgents: [],
        onSelectModel: vi.fn(),
        onSelectAgent,
        onDeselectModel: vi.fn(),
        onDeselectAgent: vi.fn(),
        onRemoveLastModel: vi.fn(),
      }),
    );

    act(() => {
      result.current.actions?.updateCursorPosition(caretAfterAtC);
    });

    const suggestions = result.current.state?.suggestions ?? [];
    // Both @claude and @codex match prefix 'c', plus DeepSeek ('deepseek-chat' contains 'c')
    expect(suggestions[0].id).toBe('mesh-agent:claude');
    expect(suggestions[1].id).toBe('mesh-agent:codex');

    render(
      <ModelMentionPopover
        open={true}
        suggestions={suggestions}
        selectedIndex={0}
        query="c"
        onSelect={(item) => result.current.actions?.selectSuggestion(item)}
        onSelectedIndexChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('mention-section-agents')).toBeTruthy();
    expect(screen.getByTestId('mention-section-models')).toBeTruthy();
    expect(
      screen.getByTestId('mention-agent-status-dot-claude').getAttribute('data-status'),
    ).toBe('ready');
    expect(
      screen.getByTestId('mention-agent-status-dot-codex').getAttribute('data-status'),
    ).toBe('waiting_children');
    expect(screen.getByText('等待 2 子代理')).toBeTruthy();
    expect(screen.getByText('实时纠偏 · 子代理树')).toBeTruthy();

    // Confirm selection removes ONLY '@c' and preserves surrounding lines
    let editResult: { value: string; caret: number } | null = null;
    act(() => {
      editResult = result.current.actions?.confirmSelection() ?? null;
    });

    expect(editResult).toEqual({
      value: '第一行保留不变\n\n第三行代码上下文',
      caret: '第一行保留不变\n'.length,
    });
    expect(onSelectAgent).toHaveBeenCalledWith(SAMPLE_AGENTS[0]);

    // Render selected @claude chip alongside WorkspaceFolderPill and bind a workspace directory
    const setBindingSpy = vi.fn(async ({ chatSessionId, rootPath, isolatedBranch }) => ({
      chatSessionId,
      rootPath,
      isolatedBranch,
      updatedAt: Date.now(),
    }));
    registerAgentMeshHostBridge({ setWorkspaceBinding: setBindingSpy });

    render(
      <ModelMentionChips
        models={[SAMPLE_AGENTS[0]]}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByTestId('agent-mention-chip-claude')).toBeTruthy();
    const pill = screen.getByTestId('workspace-folder-pill');
    expect(pill.textContent).toContain('选择项目目录');

    fireEvent.click(pill);
    expect(screen.getByTestId('workspace-folder-browse-btn').textContent).toContain(
      '浏览本地文件夹…',
    );
    const input = screen.getByTestId('workspace-folder-path-input');
    fireEvent.change(input, { target: { value: '/Users/dev/raft-lab' } });
    fireEvent.click(screen.getByTestId('workspace-folder-apply-btn'));

    await waitFor(() => {
      expect(setBindingSpy).toHaveBeenCalledWith({
        chatSessionId: 'sess-mesh-1',
        rootPath: '/Users/dev/raft-lab',
        isolatedBranch: false,
      });
    });
    expect(screen.getByTestId('workspace-folder-pill').textContent).toContain('raft-lab');

    // 1-click native system directory picker immediately binds folder and closes popover
    dialogOpenMock.mockResolvedValueOnce('/Users/dev/native-picked-project');
    fireEvent.click(screen.getByTestId('workspace-folder-pill'));
    expect(screen.getByTestId('workspace-folder-popover')).toBeTruthy();
    fireEvent.click(screen.getByTestId('workspace-folder-browse-btn'));

    await waitFor(() => {
      expect(setBindingSpy).toHaveBeenCalledWith({
        chatSessionId: 'sess-mesh-1',
        rootPath: '/Users/dev/native-picked-project',
        isolatedBranch: false,
      });
    });
    expect(screen.queryByTestId('workspace-folder-popover')).toBeNull();
    expect(screen.getByTestId('workspace-folder-pill').textContent).toContain(
      'native-picked-project',
    );
  });

  it('fast-paths 1 external @agent directly to agentMesh.startTurn with PDF context, and wires QueuedMessageStack Steer to agentMesh.steerTurn while running', async () => {
    const startTurnSpy = vi.fn(async (req) => ({
      threadId: 'thread-claude-1',
      thread: {
        chatSessionId: req.chatSessionId,
        agentId: req.agentId,
        agentName: 'Claude Code',
        rootPath: req.cwd,
        status: 'waiting_children' as const,
        childSubagents: [
          {
            id: 'sub-1',
            title: 'Inspect raft tests',
            status: 'running' as const,
            startedAt: Date.now(),
          },
        ],
      },
    }));
    const steerTurnSpy = vi.fn(async () => ({ ok: true }));

    const bridge: AgentMeshHostBridge = {
      startTurn: startTurnSpy,
      steerTurn: steerTurnSpy,
    };
    registerAgentMeshHostBridge(bridge);

    const detected: DetectedMeshAgent[] = [
      {
        id: 'claude',
        name: 'Claude Code',
        handle: 'claude',
        driverKind: 'claude',
        installed: true,
        capabilities: { midTurnSteer: true, nativeSubagentTree: true },
      },
    ];
    useAgentMeshStore.getState().setAgents(detected);
    await setWorkspaceBinding({
      chatSessionId: 'sess-mesh-1',
      rootPath: '/Users/dev/raft-lab',
    });

    let activeSelectedAgents: AgentMentionItem[] = [SAMPLE_AGENTS[0]];
    const clearSelectedAgents = vi.fn(() => {
      activeSelectedAgents = [];
    });
    let activePdfRefTags = '[PDF@paper-raft:4]';
    const clearPdfPageRefs = vi.fn(() => {
      activePdfRefTags = '';
    });

    const { store, sendMessageSpy } = createMockChatStore('sess-mesh-1');
    store.getState().setInputValue('修复选举超时死锁测试');

    const { result } = renderHook(() =>
      useInputBarV2(store as never, {
        getSelectedAgents: () => activeSelectedAgents,
        clearSelectedAgents,
        getSelectedModels: () => [],
        buildPdfRefTags: () => activePdfRefTags,
        getSelectedPagesContext: () => ({
          sourceId: 'paper-raft',
          sourceName: 'raft-atc14.pdf',
          locator: 'p.4',
          text: 'Election timeout randomized between 150ms and 300ms.',
        }),
        clearPdfPageRefs,
        queueEnabled: true,
      }),
    );

    await act(async () => {
      await result.current.sendMessage();
    });

    // Main chat LLM pipeline is NOT invoked on 1-external-@agent fast-path
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(clearSelectedAgents).toHaveBeenCalledTimes(1);
    expect(startTurnSpy).toHaveBeenCalledTimes(1);
    expect(startTurnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        chatSessionId: 'sess-mesh-1',
        agentId: 'claude',
        cwd: '/Users/dev/raft-lab',
        userPrompt: '@claude 修复选举超时死锁测试\n[PDF@paper-raft:4]',
        pdfRefTags: '[PDF@paper-raft:4]',
      }),
    );
    expect(startTurnSpy.mock.calls[0][0].prompt).toContain('<study_context source="raft-atc14.pdf"');
    expect(startTurnSpy.mock.calls[0][0].prompt).toContain('150ms and 300ms');

    // Thread is now waiting_children; user types another message -> enqueues into QueuedMessageStack
    store.getState().setInputValue('心跳间隔改为 50ms 并补跑单测');
    await act(async () => {
      await result.current.sendMessage();
    });

    expect(store.getState().queuedMessages).toHaveLength(1);
    expect(store.getState().queuedMessages[0].content).toBe('心跳间隔改为 50ms 并补跑单测');

    // Render QueuedMessageStack (even with allowSteer=false from default queue mode, active external thread enables Steer!)
    render(<QueuedMessageStack store={store as never} allowSteer={false} />);

    const steerBtn = screen.getByLabelText(/queue\.bubble\.steer|引导|Steer/i);
    await act(async () => {
      fireEvent.click(steerBtn);
    });

    expect(steerTurnSpy).toHaveBeenCalledTimes(1);
    expect(steerTurnSpy).toHaveBeenCalledWith({
      threadId: 'thread-claude-1',
      chatSessionId: 'sess-mesh-1',
      text: '心跳间隔改为 50ms 并补跑单测',
      priority: 'correction',
    });
    expect(store.getState().queuedMessages).toHaveLength(0);
  });

  it('routes 2+ @agent chips through main @deepstudent pipeline with semantic routing header and zero word-order mutation', async () => {
    const startTurnSpy = vi.fn();
    registerAgentMeshHostBridge({ startTurn: startTurnSpy });

    let activeSelectedAgents: AgentMentionItem[] = [SAMPLE_AGENTS[0], SAMPLE_AGENTS[1]];
    const clearSelectedAgents = vi.fn(() => {
      activeSelectedAgents = [];
    });

    const { store, sendMessageSpy } = createMockChatStore('sess-mesh-2');
    const originalUserPrompt = '先让 Claude 设计状态机接口，再让 Codex 编写并发压测并互审';
    store.getState().setInputValue(originalUserPrompt);

    const { result } = renderHook(() =>
      useInputBarV2(store as never, {
        getSelectedAgents: () => activeSelectedAgents,
        clearSelectedAgents,
        getSelectedModels: () => [],
        queueEnabled: true,
      }),
    );

    await act(async () => {
      await result.current.sendMessage();
    });

    expect(startTurnSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).toHaveBeenCalledWith(
      `[协同智能体: @claude, @codex]\n${originalUserPrompt}`,
      [],
    );
    expect(clearSelectedAgents).toHaveBeenCalledTimes(1);
  });
});
