import '@testing-library/jest-dom/vitest';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import {
  applyAgentMeshBackendEvent,
  registerAgentMeshHostBridge,
  resetAgentMeshStore,
  selectSelectedCliForSession,
  setWorkspaceBinding,
  useAgentMeshStore,
  type AgentMeshHostBridge,
  type DetectedMeshAgent,
} from '@/features/agent-mesh';
import { createChatStore } from '../../../core/store/createChatStore';
import { createDefaultPanelStates } from '../../../core/types/common';
import { CLI_ENGINE_ID_PREFIX, RuntimeModelSubmenuBody } from '../RuntimeModelSubmenuBody';
import { ModelPicker } from '../ModelPicker';
import { InputBarUI } from '../InputBarUI';
import { InputBarV2 } from '../InputBarV2';
import { ExternalCliApprovalBar } from '../ExternalCliApprovalBar';
import { useInputBarV2 } from '../useInputBarV2';
import type { AgentMentionItem } from '../useModelMentionAutocomplete';
import type { ModelInfo } from '../../../utils/parseModelMentions';
import { __resetFavoriteChatModelsForTests } from '../../../hooks/useFavoriteChatModels';

const {
  showGlobalNotificationMock,
  resolveChatReadinessMock,
  loadModelConfigSnapshotMock,
} = vi.hoisted(() => ({
  showGlobalNotificationMock: vi.fn(),
  resolveChatReadinessMock: vi.fn(async () => ({
    ok: false as boolean,
    code: 'NO_MODEL',
    message: '未配置模型',
    cta: 'OPEN_SETTINGS_MODELS' as const,
  })),
  loadModelConfigSnapshotMock: vi.fn(async () => ({
    configs: [] as Array<Record<string, unknown>>,
    vendorConfigs: [] as Array<Record<string, unknown>>,
    assignments: {},
  })),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => []),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: showGlobalNotificationMock,
}));

vi.mock('@/features/chat/readiness/readinessGate', () => ({
  resolveChatReadiness: resolveChatReadinessMock,
  keepsTurnsWithoutChatModel: vi.fn(() => false),
  triggerOpenSettingsModels: vi.fn(),
}));

vi.mock('../../../utils/modelConfigSnapshot', () => ({
  loadModelConfigSnapshot: loadModelConfigSnapshotMock,
  invalidateModelConfigSnapshot: vi.fn(),
}));

vi.mock('@/hooks/usePdfProcessingProgress', () => ({
  usePdfProcessingProgress: vi.fn(),
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  useTauriDragAndDrop: () => ({
    isDragging: false,
    dropZoneProps: {},
  }),
}));

vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({
    isMobile: false,
    isFullscreenContent: false,
  }),
}));

vi.mock('@/contexts/DialogControlContext', () => ({
  useDialogControl: () => ({
    availableMcpServers: [],
    selectedMcpServers: [],
    setSelectedMcpServers: vi.fn(),
  }),
}));

vi.mock('@/mcp/builtinMcpServer', () => ({
  isBuiltinServer: () => false,
}));

vi.mock('@/config/featureFlags', () => ({
  isMultiModelSelectEnabled: () => true,
}));

vi.mock('../../../skills/hooks/useLoadedSkills', () => ({
  useLoadedSkills: () => ({ loadedSkillIds: new Set<string>() }),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const templates: Record<string, string> = {
    'chatV2:inputBar.runtimeModelTitle': '当前对话模型',
    'chatV2:inputBar.chooseRuntimeModel': '选择模型',
    'chatV2:inputBar.runtimeModelSwitchCurrent': '{{label}}，当前：{{current}}',
    'chatV2:inputBar.runtimeModelCompareMode': '多选模式',
    'chatV2:modelPicker.searchPlaceholder': '搜索名称或模型 ID...',
    'chatV2:modelPicker.favorites': '收藏',
    'chatV2:inputBar.thinkingState.unsupported': '推理: 不支持',
    'chatV2:inputBar.thinkingState.off': '推理: 关闭',
    'chatV2:inputBar.thinkingState.on': '推理: {{depth}}',
  };
  const translate = (
    key: string,
    defaultValueOrOptions?: unknown,
    maybeOptions?: Record<string, unknown>,
  ): string => {
    const defaultValue =
      typeof defaultValueOrOptions === 'string'
        ? defaultValueOrOptions
        : (defaultValueOrOptions as { defaultValue?: string } | undefined)?.defaultValue;
    const options =
      (typeof defaultValueOrOptions === 'object' && defaultValueOrOptions !== null
        ? (defaultValueOrOptions as Record<string, unknown>)
        : maybeOptions) ?? {};
    const tpl = defaultValue ?? templates[key] ?? key;
    return tpl.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
      options[name] !== undefined ? String(options[name]) : match,
    );
  };
  return {
    ...actual,
    useTranslation: () => ({
      t: translate,
      i18n: { language: 'zh-CN', changeLanguage: vi.fn() },
    }),
  };
});

const INSTALLED_AGENTS: DetectedMeshAgent[] = [
  {
    id: 'codex',
    name: 'Codex CLI',
    handle: 'codex',
    driverKind: 'codex',
    installed: true,
    version: '0.42.0',
    capabilities: { midTurnSteer: true, approvalCallback: true },
  },
  {
    id: 'claude',
    name: 'Claude Code',
    handle: 'claude',
    driverKind: 'claude',
    installed: true,
    version: '1.0.29',
    capabilities: { midTurnSteer: true, nativeSubagentTree: true, approvalCallback: true },
  },
];

const SAMPLE_MODELS: ModelInfo[] = [
  {
    id: 'deepseek-v4',
    name: 'DeepSeek V4',
    model: 'deepseek-v4',
    vendorId: 'deepseek',
    vendorName: 'DeepSeek',
    isReasoning: true,
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    model: 'gpt-4o',
    vendorId: 'openai',
    vendorName: 'OpenAI',
    isReasoning: false,
  },
];

const CODEX_MENTION_ITEM: AgentMentionItem = {
  id: 'mesh-agent:codex',
  name: 'Codex CLI',
  model: '@codex',
  aliases: ['codex'],
  mentionKind: 'agent',
  agentId: 'codex',
  agentHandle: 'codex',
  driverKind: 'codex',
  isExternalCli: true,
  agentStatus: 'ready',
  sessionId: 'sess-native-1',
};

const DEEPSTUDENT_MENTION_ITEM: AgentMentionItem = {
  id: 'mesh-agent:deepstudent',
  name: 'DeepStudent',
  model: '@deepstudent',
  aliases: ['deepstudent'],
  mentionKind: 'agent',
  agentId: 'deepstudent',
  agentHandle: 'deepstudent',
  driverKind: 'builtin',
  isExternalCli: false,
  agentStatus: 'ready',
  sessionId: 'sess-native-1',
};

describe('T3-Code CLI Engine Picker & 100% Native Chat Turn Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetFavoriteChatModelsForTests();
    resetAgentMeshStore();
    registerAgentMeshHostBridge(null);
    vi.mocked(invoke).mockResolvedValue([]);
    loadModelConfigSnapshotMock.mockResolvedValue({
      configs: [
        {
          id: 'deepseek-v4',
          name: 'DeepSeek V4',
          model: 'deepseek-v4',
          vendorId: 'deepseek',
          vendorName: 'DeepSeek',
          enabled: true,
          apiKey: 'sk-test',
        },
      ],
      vendorConfigs: [{ id: 'deepseek', name: 'DeepSeek', providerType: 'deepseek' }],
      assignments: { model2_config_id: 'deepseek-v4' },
    });
  });

  describe('1. RuntimeModelSubmenuBody & ModelPicker CLI Engine Support', () => {
    it('renders CLI options without favorite star and hides them in multi-select compare mode', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();

      const options = [
        {
          id: `${CLI_ENGINE_ID_PREFIX}codex`,
          label: 'Codex CLI',
          providerId: '__coding_cli__',
          providerLabel: '本地编程 CLI',
          iconId: 'codex',
          isExternalCli: true,
        },
        {
          id: 'deepseek-v4',
          label: 'deepseek-v4',
          providerId: 'deepseek',
          providerLabel: 'DeepSeek',
          iconId: 'deepseek-v4',
        },
      ];

      const { rerender } = render(
        <RuntimeModelSubmenuBody
          options={options}
          currentModelId={`${CLI_ENGINE_ID_PREFIX}codex`}
          onSelect={onSelect}
          multiSelect={{
            active: false,
            selectedIds: [],
            onActiveChange: vi.fn(),
            onToggle: vi.fn(),
          }}
        />,
      );

      const cliSection = document.querySelector<HTMLElement>('[data-section="provider:__coding_cli__"]');
      expect(cliSection).not.toBeNull();
      // CLI row has no favorite star button
      expect(within(cliSection!).queryByTestId('runtime-model-favorite-toggle')).toBeNull();
      // LLM row still has favorite star button
      const llmSection = document.querySelector<HTMLElement>('[data-section="provider:deepseek"]');
      expect(within(llmSection!).getByTestId('runtime-model-favorite-toggle')).toBeInTheDocument();

      await user.click(within(cliSection!).getByRole('menuitem', { name: /Codex CLI/ }));
      expect(onSelect).toHaveBeenCalledWith('cli-agent:codex');

      // Switch to multi-select compare mode -> CLI section is hidden
      rerender(
        <RuntimeModelSubmenuBody
          options={options}
          currentModelId={`${CLI_ENGINE_ID_PREFIX}codex`}
          onSelect={onSelect}
          multiSelect={{
            active: true,
            selectedIds: [],
            onActiveChange: vi.fn(),
            onToggle: vi.fn(),
          }}
        />,
      );

      expect(document.querySelector('[data-section="provider:__coding_cli__"]')).toBeNull();
      expect(document.querySelector('[data-section="provider:deepseek"]')).not.toBeNull();
    });

    it('renders local Coding CLI group in ModelPicker single mode (even with 0 LLM models), filters by search, and hides in compare/retry modes', async () => {
      const user = userEvent.setup();
      loadModelConfigSnapshotMock.mockResolvedValueOnce({
        configs: [],
        vendorConfigs: [],
        assignments: {},
      });
      const onSelectCliAgent = vi.fn();
      const onClose = vi.fn();

      const { rerender } = render(
        <ModelPicker
          mode="single"
          externalCliAgents={INSTALLED_AGENTS}
          selectedCliAgentId="codex"
          onSelectCliAgent={onSelectCliAgent}
          onClose={onClose}
        />,
      );

      const cliSection = await screen.findByText('本地编程 CLI');
      expect(cliSection).toBeInTheDocument();
      const codexBtn = screen.getByTestId('model-picker-cli-agent-codex');
      expect(codexBtn).toHaveAttribute('aria-pressed', 'true');
      expect(codexBtn).toHaveTextContent('0.42.0');

      const searchInput = screen.getByPlaceholderText('搜索名称或模型 ID...');
      await user.type(searchInput, 'claude');
      expect(screen.queryByTestId('model-picker-cli-agent-codex')).toBeNull();
      const claudeBtn = screen.getByTestId('model-picker-cli-agent-claude');
      expect(claudeBtn).toHaveTextContent('1.0.29');

      await user.click(claudeBtn);
      expect(onSelectCliAgent).toHaveBeenCalledWith('claude');
      expect(onClose).toHaveBeenCalled();

      // Compare mode hides CLI group
      rerender(
        <ModelPicker
          mode="compare"
          externalCliAgents={INSTALLED_AGENTS}
          selectedCliAgentId="codex"
          onSelectCliAgent={onSelectCliAgent}
          onClose={onClose}
        />,
      );
      expect(screen.queryByTestId('model-picker-cli-agent-claude')).toBeNull();
    });
  });

  describe('2. ComposerToolbar & InputBarV2 Engine Selection, Per-CLI Model Drilldown, Folder Pill & API Key Suppression', () => {
    it('shows CLI reasoning effort levels for Codex/Claude and 没有可选的推理强度 for CLIs without effort tiers (never LLM sliders)', async () => {
      const user = userEvent.setup();
      const { rerender } = render(
        <InputBarUI
          inputValue=""
          canSend={true}
          canAbort={false}
          isStreaming={false}
          attachments={[]}
          panelStates={createDefaultPanelStates()}
          onInputChange={vi.fn()}
          onSend={vi.fn()}
          onAbort={vi.fn()}
          onAddAttachment={vi.fn()}
          onUpdateAttachment={vi.fn()}
          onRemoveAttachment={vi.fn()}
          onClearAttachments={vi.fn()}
          onSetPanelState={vi.fn()}
          enableThinking={true}
          thinkingStateLabel="推理: 高"
          thinkingDepthOptions={[
            { value: 'high', labelKey: 'high', defaultLabel: '高' },
          ]}
          thinkingDepthValue="high"
          onToggleThinking={vi.fn()}
          onSetThinkingDepth={vi.fn()}
          runtimeCurrentModelId="cli-agent:codex"
          runtimeModelLabel="Codex CLI"
          runtimeModelProviderLabel="本地编程 CLI"
          runtimeModelOptions={[
            {
              id: 'cli-agent:codex',
              label: 'Codex CLI',
              providerId: '__coding_cli__',
              providerLabel: '本地编程 CLI',
              isExternalCli: true,
              cliAgentId: 'codex',
              cliDriverKind: 'codex',
            },
            {
              id: 'cli-agent:opencode',
              label: 'OpenCode',
              providerId: '__coding_cli__',
              providerLabel: '本地编程 CLI',
              isExternalCli: true,
              cliAgentId: 'opencode',
              cliDriverKind: 'opencode',
            },
          ]}
          onSelectRuntimeModel={vi.fn()}
        />,
      );

      expect(screen.getByTestId('thinking-runtime-state-label')).toHaveTextContent('Codex CLI');

      await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));
      expect(await screen.findByTestId('t3-model-selector')).toBeInTheDocument();
      expect(screen.getByTestId('t3-cli-reasoning-group')).toBeInTheDocument();
      expect(screen.queryByRole('slider')).toBeNull();

      rerender(
        <InputBarUI
          inputValue=""
          canSend={true}
          canAbort={false}
          isStreaming={false}
          attachments={[]}
          panelStates={createDefaultPanelStates()}
          onInputChange={vi.fn()}
          onSend={vi.fn()}
          onAbort={vi.fn()}
          onAddAttachment={vi.fn()}
          onUpdateAttachment={vi.fn()}
          onRemoveAttachment={vi.fn()}
          onClearAttachments={vi.fn()}
          onSetPanelState={vi.fn()}
          runtimeCurrentModelId="cli-agent:opencode"
          runtimeModelLabel="OpenCode"
          runtimeModelProviderLabel="本地编程 CLI"
          runtimeModelOptions={[
            {
              id: 'cli-agent:opencode',
              label: 'OpenCode',
              providerId: '__coding_cli__',
              providerLabel: '本地编程 CLI',
              isExternalCli: true,
              cliAgentId: 'opencode',
              cliDriverKind: 'opencode',
            },
          ]}
          onSelectRuntimeModel={vi.fn()}
        />,
      );
      expect(screen.getByTestId('t3-cli-drilldown-header')).toHaveTextContent('OpenCode');
      expect(screen.getByTestId('t3-reasoning-empty')).toHaveTextContent('没有可选的推理强度');
    });

    it('drills into a Coding CLI to pick a preset or custom model + effort, displays them in pills, and forwards model + reasoningEffort to startTurn', async () => {
      const agentsWithDefaults: DetectedMeshAgent[] = [
        {
          ...INSTALLED_AGENTS[1],
          defaultModel: 'claude-sonnet-4-6',
          availableModels: ['claude-sonnet-4-6', 'claude-opus-4-6'],
        },
        INSTALLED_AGENTS[0],
      ];
      useAgentMeshStore.getState().setAgents(agentsWithDefaults);

      const startTurnSpy = vi.fn(async (req) => ({
        threadId: 'thread-claude-model-1',
        nativeTimelineAttached: true,
        thread: {
          threadId: 'thread-claude-model-1',
          chatSessionId: req.chatSessionId,
          agentId: req.agentId,
          agentName: 'Claude Code',
          rootPath: req.cwd,
          status: 'idle' as const,
          nativeTimelineAttached: true,
        },
      }));
      registerAgentMeshHostBridge({ startTurn: startTurnSpy } satisfies AgentMeshHostBridge);

      const store = createChatStore('sess-cli-model-1');
      render(<InputBarV2 store={store} availableModels={SAMPLE_MODELS} />);

      const user = userEvent.setup();
      await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));

      // Click unified local Coding CLI icon in left rail -> shows Claude Code & Codex CLI
      await user.click(await screen.findByTestId('t3-rail-group-__coding_cli__'));
      await user.click(screen.getByTestId('t3-cli-agent-row-claude'));

      // In-place 2nd-level drilldown renders follow-default + preset models + right-pane effort
      expect(screen.getByTestId('t3-cli-drilldown-header')).toHaveTextContent('Claude Code');
      expect(screen.getByTestId('t3-cli-model-default-claude')).toBeInTheDocument();
      expect(screen.getByTestId('t3-cli-model-claude-claude-opus-4-6')).toBeInTheDocument();

      // Select CLI reasoning effort 'high' in right pane
      const effortGroup = screen.getByTestId('t3-cli-reasoning-group');
      const highBtn = within(effortGroup).getAllByRole('menuitemradio').find((el) =>
        /high|高/i.test(el.textContent ?? ''),
      )!;
      await user.click(highBtn);

      // Type a custom model ID in search box and select custom model row
      const cliSearch = screen.getByTestId('t3-model-search-input');
      await user.type(cliSearch, 'glm-5-coding');
      const customModelRow = screen.getByTestId('t3-cli-model-custom-claude');
      expect(customModelRow).toHaveTextContent('glm-5-coding');
      await user.click(customModelRow);

      // Bottom-right pill & inline session CLI badge both display Claude Code · glm-5-coding
      expect(screen.getByTestId('thinking-runtime-state-label')).toHaveTextContent(
        'Claude Code · glm-5-coding',
      );
      expect(screen.getByTestId('session-cli-engine-badge-claude')).toHaveTextContent(
        'Claude Code · glm-5-coding',
      );

      // Submit a turn -> forwards model: 'glm-5-coding' & reasoningEffort: 'high' to startTurn
      act(() => {
        store.getState().setInputValue('使用自定义模型审查架构');
      });
      await user.click(screen.getByTestId('btn-send'));

      await waitFor(() => {
        expect(startTurnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            chatSessionId: 'sess-cli-model-1',
            agentId: 'claude',
            model: 'glm-5-coding',
            reasoningEffort: 'high',
            timelineMode: 'native_chat',
          }),
        );
      });
    });

    it('switches session between CLI engine and LLM in InputBarV2 without polluting model2OverrideId, shows WorkspaceFolderPill, and suppresses missingApiKey banner', async () => {
      useAgentMeshStore.getState().setAgents(INSTALLED_AGENTS);
      const store = createChatStore('sess-picker-1');
      const setChatParamsSpy = vi.spyOn(store.getState(), 'setChatParams');

      // Simulate 0 configured LLM models so missingApiKey would normally be true
      vi.mocked(invoke).mockImplementation(async (cmd) => {
        if (cmd === 'get_api_configurations') return [];
        return [];
      });

      render(<InputBarV2 store={store} availableModels={[]} />);

      // Initially no CLI selected -> missingApiKey banner appears once async check settles
      await waitFor(() => {
        expect(screen.getByTestId('chat-missing-api-key-banner')).toBeInTheDocument();
      });

      // Select Codex CLI directly via T3-Code unified model selector
      const user = userEvent.setup();
      await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));
      const codexItem = await screen.findByRole('menuitem', { name: /Codex CLI/ });
      await user.click(codexItem);

      expect(selectSelectedCliForSession(useAgentMeshStore.getState(), 'sess-picker-1')).toBe('codex');
      // Must NOT pollute chatParams.model2OverrideId with cli-agent:codex
      expect(store.getState().chatParams.model2OverrideId).toBeNull();
      expect(
        setChatParamsSpy.mock.calls.some(
          ([arg]) => typeof arg?.model2OverrideId === 'string' && arg.model2OverrideId.startsWith('cli-agent:'),
        ),
      ).toBe(false);

      // Trigger displays Codex CLI, WorkspaceFolderPill is rendered above textarea, and missingApiKey banner is suppressed
      expect(screen.getByTestId('thinking-runtime-state-label')).toHaveTextContent('Codex CLI');
      expect(screen.getByTestId('workspace-folder-pill')).toBeInTheDocument();
      expect(screen.getByTestId('session-cli-engine-badge-codex')).toBeInTheDocument();
      expect(screen.queryByTestId('chat-missing-api-key-banner')).toBeNull();

      // Re-render with availableModels and pick a regular LLM -> clears selectedCliForSession
      render(<InputBarV2 store={store} availableModels={SAMPLE_MODELS} />);
      act(() => {
        useAgentMeshStore.getState().setSelectedCliForSession('sess-picker-1', 'codex');
      });
      expect(selectSelectedCliForSession(useAgentMeshStore.getState(), 'sess-picker-1')).toBe('codex');

      // Clear via badge × button -> returns to regular LLM
      const clearBadgeBtn = within(screen.getAllByTestId('session-cli-engine-badge-codex')[0]).getByRole('button');
      await user.click(clearBadgeBtn);
      expect(selectSelectedCliForSession(useAgentMeshStore.getState(), 'sess-picker-1')).toBeNull();
    });
  });

  describe('3. 100% Native Chat Turn Submission, Rollback, Mirror Fallback & Abort', () => {
    it('submits session CLI turn into native ChatStore (user + assistant bubbles, _meta, timelineMode=native_chat), mirrors mocked deltas, and dequeues next message on completion', async () => {
      useAgentMeshStore.getState().setAgents(INSTALLED_AGENTS);
      useAgentMeshStore.getState().setSelectedCliForSession('sess-native-1', 'codex');
      await setWorkspaceBinding({
        chatSessionId: 'sess-native-1',
        rootPath: '/Users/dev/deep-student',
      });

      const startTurnSpy = vi.fn(async (req) => ({
        threadId: 'thread-codex-1',
        thread: {
          threadId: 'thread-codex-1',
          chatSessionId: req.chatSessionId,
          agentId: req.agentId,
          agentName: 'Codex CLI',
          rootPath: req.cwd,
          status: 'running' as const,
        },
      }));
      registerAgentMeshHostBridge({ startTurn: startTurnSpy } satisfies AgentMeshHostBridge);

      const store = createChatStore('sess-native-1');
      const llmSendCallback = vi.fn(async () => {});
      store.getState().setSendCallback(llmSendCallback);
      store.getState().setInputValue('重构 Composer 引擎选择器');

      const { result } = renderHook(() =>
        useInputBarV2(store, {
          getSelectedSessionCli: () => INSTALLED_AGENTS[0],
          getSelectedAgents: () => [],
          getSelectedModels: () => [],
          queueEnabled: true,
        }),
      );

      await act(async () => {
        await result.current.sendMessage();
      });

      // Readiness gate was bypassed for local CLI even though resolveChatReadinessMock returns ok: false
      expect(resolveChatReadinessMock).not.toHaveBeenCalled();
      expect(llmSendCallback).not.toHaveBeenCalled();

      // Native ChatStore immediately has 2 messages (user + streaming assistant) and sessionStatus === 'streaming'
      const afterStart = store.getState();
      expect(afterStart.sessionStatus).toBe('streaming');
      expect(result.current.isStreaming).toBe(true);
      expect(afterStart.messageOrder).toHaveLength(2);

      const [userMsgId, assistantMsgId] = afterStart.messageOrder;
      const userMsg = afterStart.messageMap.get(userMsgId)!;
      const assistantMsg = afterStart.messageMap.get(assistantMsgId)!;
      expect(userMsg.role).toBe('user');
      expect(afterStart.getMessageBlocks(userMsgId)[0]?.content).toBe('重构 Composer 引擎选择器');
      expect(assistantMsg.role).toBe('assistant');
      expect(assistantMsg._meta?.modelId).toBe('Codex CLI');
      expect(assistantMsg._meta?.modelDisplayName).toBe('Codex CLI');

      expect(startTurnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          chatSessionId: 'sess-native-1',
          agentId: 'codex',
          cwd: '/Users/dev/deep-student',
          prompt: '重构 Composer 引擎选择器',
          userPrompt: '重构 Composer 引擎选择器',
          timelineMode: 'native_chat',
          userMessageId: userMsgId,
          assistantMessageId: assistantMsgId,
        }),
      );

      // Stream deltas via AgentMesh backend event -> mirrored into native assistant content block
      act(() => {
        applyAgentMeshBackendEvent({
          type: 'assistant_delta',
          threadId: 'thread-codex-1',
          chatSessionId: 'sess-native-1',
          delta: '已完成引擎选择器重构。',
        });
      });

      const streamingBlocks = store.getState().getMessageBlocks(assistantMsgId);
      expect(streamingBlocks).toHaveLength(1);
      expect(streamingBlocks[0].content).toBe('已完成引擎选择器重构。');
      expect(streamingBlocks[0].status).toBe('running');

      // Enqueue a follow-up message while CLI is running
      store.getState().setInputValue('继续补充单元测试');
      await act(async () => {
        await result.current.sendMessage();
      });
      expect(store.getState().queuedMessages).toHaveLength(1);

      // Settle external thread -> assistant block completes, sessionStatus returns to 'idle', and queued message dequeues
      act(() => {
        applyAgentMeshBackendEvent({
          type: 'quiescent_completed',
          threadId: 'thread-codex-1',
        });
      });

      const settledState = store.getState();
      expect(settledState.getMessageBlocks(assistantMsgId)[0].status).toBe('success');
      await waitFor(() => {
        expect(llmSendCallback).toHaveBeenCalledTimes(1);
      });
    });

    it('prefixes @codex on explicit 1-turn @agent mention, and routes explicit @deepstudent to built-in LLM even when sessionCli is set', async () => {
      useAgentMeshStore.getState().setAgents(INSTALLED_AGENTS);
      resolveChatReadinessMock.mockResolvedValue({ ok: true, code: 'READY', message: '', cta: 'OPEN_SETTINGS_MODELS' });

      const startTurnSpy = vi.fn(async (req) => ({
        threadId: 'thread-explicit-1',
        nativeTimelineAttached: true,
        thread: {
          threadId: 'thread-explicit-1',
          chatSessionId: req.chatSessionId,
          agentId: req.agentId,
          agentName: 'Codex CLI',
          rootPath: '',
          status: 'idle' as const,
          nativeTimelineAttached: true,
        },
      }));
      registerAgentMeshHostBridge({ startTurn: startTurnSpy });

      const store = createChatStore('sess-native-1');
      const llmSendCallback = vi.fn(async (content, attachments, uId, aId) => {
        await store.getState().sendMessageWithIds(content, attachments, uId, aId);
        store.getState().completeStream('success');
      });
      store.getState().setSendCallback(llmSendCallback);

      let activeAgents: AgentMentionItem[] = [CODEX_MENTION_ITEM];
      const { result } = renderHook(() =>
        useInputBarV2(store, {
          getSelectedSessionCli: () => INSTALLED_AGENTS[1], // session has claude, but explicit @codex wins!
          getSelectedAgents: () => activeAgents,
          clearSelectedAgents: () => {
            activeAgents = [];
          },
          getSelectedModels: () => [],
        }),
      );

      store.getState().setInputValue('检查死锁条件');
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(startTurnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'codex',
          prompt: '检查死锁条件',
          userPrompt: '@codex 检查死锁条件',
          timelineMode: 'native_chat',
        }),
      );
      const firstUserMsgId = store.getState().messageOrder[0];
      expect(store.getState().getMessageBlocks(firstUserMsgId)[0]?.content).toBe('@codex 检查死锁条件');

      // Reset session to idle (since nativeTimelineAttached: true expects Host stream_complete)
      act(() => {
        store.getState().completeStream('success');
      });

      // Now explicitly mention @deepstudent -> routes to built-in LLM even while sessionCli is claude!
      activeAgents = [DEEPSTUDENT_MENTION_ITEM];
      store.getState().setInputValue('帮我把改动提炼成复习闪卡');
      await act(async () => {
        await result.current.sendMessage();
      });

      expect(startTurnSpy).toHaveBeenCalledTimes(1);
      expect(llmSendCallback).toHaveBeenCalledTimes(1);
      expect(llmSendCallback.mock.calls[0][0]).toBe('帮我把改动提炼成复习闪卡');
    });

    it('rolls back user & assistant messages and restores draft when host bridge is disconnected', async () => {
      useAgentMeshStore.getState().setAgents(INSTALLED_AGENTS);
      registerAgentMeshHostBridge(null);

      const store = createChatStore('sess-rollback-1');
      store.getState().setInputValue('未连接宿主时的草稿不应丢失');

      const { result } = renderHook(() =>
        useInputBarV2(store, {
          getSelectedSessionCli: () => INSTALLED_AGENTS[0],
          getSelectedAgents: () => [],
          getSelectedModels: () => [],
        }),
      );

      await act(async () => {
        await result.current.sendMessage();
      });

      const afterRollback = store.getState();
      expect(afterRollback.messageOrder).toHaveLength(0);
      expect(afterRollback.messageMap.size).toBe(0);
      expect(afterRollback.blocks.size).toBe(0);
      expect(afterRollback.sessionStatus).toBe('idle');
      expect(afterRollback.currentStreamingMessageId).toBeNull();
      expect(afterRollback.inputValue).toBe('未连接宿主时的草稿不应丢失');
      expect(showGlobalNotificationMock).toHaveBeenCalledWith('warning', expect.any(String));
    });

    it('calls agentMeshHost.interruptTurn and resets streaming state cleanly on abortStream', async () => {
      useAgentMeshStore.getState().setAgents(INSTALLED_AGENTS);
      const interruptTurnSpy = vi.fn(async () => ({ ok: true }));
      registerAgentMeshHostBridge({
        startTurn: vi.fn(async (req) => ({
          threadId: 'thread-abort-1',
          thread: {
            threadId: 'thread-abort-1',
            chatSessionId: req.chatSessionId,
            agentId: req.agentId,
            agentName: 'Codex CLI',
            rootPath: '',
            status: 'running' as const,
          },
        })),
        interruptTurn: interruptTurnSpy,
      });

      const store = createChatStore('sess-abort-1');
      store.getState().setInputValue('执行耗时构建');

      const { result } = renderHook(() =>
        useInputBarV2(store, {
          getSelectedSessionCli: () => INSTALLED_AGENTS[0],
          getSelectedAgents: () => [],
          getSelectedModels: () => [],
        }),
      );

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(store.getState().sessionStatus).toBe('streaming');
      expect(result.current.canAbort).toBe(true);

      await act(async () => {
        await result.current.abortStream();
      });

      expect(interruptTurnSpy).toHaveBeenCalledWith({
        threadId: 'thread-abort-1',
        chatSessionId: 'sess-abort-1',
      });
      expect(store.getState().sessionStatus).toBe('idle');
      expect(result.current.isStreaming).toBe(false);
    });
  });

  describe('4. ExternalCliApprovalBar & Inline Composer Mounting', () => {
    it('renders agent, tool, command/path, reason, and dispatches allow_once, allow_session, and deny via agentMeshHost.respondApproval', async () => {
      const respondApprovalSpy = vi.fn(async () => ({ ok: true }));
      registerAgentMeshHostBridge({ respondApproval: respondApprovalSpy });

      useAgentMeshStore.getState().setAgents(INSTALLED_AGENTS);
      useAgentMeshStore.getState().upsertThread({
        threadId: 'thread-approval-1',
        chatSessionId: 'sess-approval-1',
        agentId: 'codex',
        agentName: 'Codex CLI',
        rootPath: '/Users/dev/app',
        status: 'waiting_approval',
        assistantText: '',
        toolCalls: [],
        childSubagents: [],
        activeBgTaskCount: 0,
        pendingApproval: {
          requestId: 'req-101',
          threadId: 'thread-approval-1',
          toolName: 'bash',
          command: 'npm run test:unit',
          reason: '需要运行测试验证修复结果',
          requestedAt: Date.now(),
        },
        diffSummary: null,
        humanControlled: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const store = createChatStore('sess-approval-1');
      render(<InputBarV2 store={store} availableModels={SAMPLE_MODELS} />);

      const bar = await screen.findByTestId('external-cli-approval-bar');
      expect(bar).toHaveTextContent('Codex CLI');
      expect(screen.getByTestId('external-cli-approval-tool')).toHaveTextContent('bash');
      expect(screen.getByTestId('external-cli-approval-target')).toHaveTextContent('npm run test:unit');
      expect(screen.getByTestId('external-cli-approval-reason')).toHaveTextContent('需要运行测试验证修复结果');

      fireEvent.click(screen.getByTestId('external-cli-approval-allow-once'));
      await waitFor(() => {
        expect(respondApprovalSpy).toHaveBeenCalledWith({
          threadId: 'thread-approval-1',
          requestId: 'req-101',
          decision: 'allow_once',
        });
      });

      // Test allow_session and deny directly on ExternalCliApprovalBar
      const sampleThread = {
        ...useAgentMeshStore.getState().threads['thread-approval-1'],
        pendingApproval: {
          requestId: 'req-102',
          threadId: 'thread-approval-1',
          toolName: 'write_file',
          targetPath: 'src/index.ts',
          requestedAt: Date.now(),
        },
      };
      const { rerender } = render(<ExternalCliApprovalBar thread={sampleThread} />);
      fireEvent.click(screen.getByTestId('external-cli-approval-allow-session'));
      await waitFor(() => {
        expect(respondApprovalSpy).toHaveBeenCalledWith({
          threadId: 'thread-approval-1',
          requestId: 'req-102',
          decision: 'allow_session',
        });
      });

      rerender(
        <ExternalCliApprovalBar
          thread={{
            ...sampleThread,
            pendingApproval: {
              ...sampleThread.pendingApproval!,
              requestId: 'req-103',
            },
          }}
        />,
      );
      fireEvent.click(screen.getByTestId('external-cli-approval-deny'));
      await waitFor(() => {
        expect(respondApprovalSpy).toHaveBeenCalledWith({
          threadId: 'thread-approval-1',
          requestId: 'req-103',
          decision: 'deny',
        });
      });
    });
  });
});
