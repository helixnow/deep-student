import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { createStore } from 'zustand/vanilla';
import { InputBarV2 } from '../InputBarV2';
import { ModelPicker } from '../ModelPicker';

let capturedInputBarUIProps: Record<string, any> | null = null;
const mockModeRegistryState = vi.hoisted(() => ({
  plugin: {} as Record<string, any>,
}));

vi.mock('../InputBarUI', () => ({
  InputBarUI: (props: Record<string, any>) => {
    capturedInputBarUIProps = props;
    return null;
  },
}));

vi.mock('../useInputBarV2', () => ({
  useInputBarV2: (store: any) => ({
    canSend: true,
    canAbort: false,
    isStreaming: false,
    attachments: store.getState().attachments,
    panelStates: {
      attachment: false,
      rag: false,
      model: false,
      advanced: false,
      learn: false,
      mcp: false,
      search: false,
      skill: false,
    },
    setInputValue: vi.fn(),
    sendMessage: vi.fn(),
    abortStream: vi.fn(),
    addAttachment: vi.fn(),
    updateAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    setPanelState: vi.fn(),
  }),
}));

vi.mock('../../../registry', () => ({
  modeRegistry: {
    getResolved: () => mockModeRegistryState.plugin,
  },
}));

vi.mock('../../skills/hooks/useLoadedSkills', () => ({
  useLoadedSkills: () => ({ loadedSkillIds: new Set<string>() }),
}));

vi.mock('./usePdfPageRefs', () => ({
  usePdfPageRefs: () => ({
    pageRefs: [],
    clearPageRefs: vi.fn(),
    removePageRef: vi.fn(),
    buildRefTags: vi.fn(() => ''),
    hasPageRefs: false,
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

vi.mock('../../skills/loader', () => ({
  reloadSkills: vi.fn(),
}));

function createMockStore() {
  const addContextRef = vi.fn();
  const setChatParams = vi.fn();

  const store = createStore<any>(() => ({
    sessionId: 'session_1',
    mode: 'chat',
    inputValue: '',
    chatParams: {
      modelId: 'deepseek-official-v4',
      model2OverrideId: null,
      maxTokens: 32_768,
      enableThinking: true,
      reasoningEffort: undefined,
      thinkingBudget: undefined,
    },
    modelRetryTarget: null,
    skillStateJson: null,
    setChatParams,
    activeSkillIds: [],
    activateSkill: vi.fn(),
    deactivateSkill: vi.fn(),
    pendingContextRefs: [],
    removeContextRef: vi.fn(),
    clearContextRefs: vi.fn(),
    pendingApprovalRequest: null,
    attachments: [{ id: 'att_1' }],
    addContextRef,
    setModelRetryTarget: vi.fn(),
    setPanelState: vi.fn(),
    retryMessage: vi.fn(),
    setPendingParallelModelIds: vi.fn(),
  }));

  return { store, addContextRef, setChatParams };
}

describe('InputBarV2 stale context ref guard', () => {
  beforeEach(() => {
    capturedInputBarUIProps = null;
    mockModeRegistryState.plugin = {};
    vi.clearAllMocks();
  });

  it('drops stale context ref creation when attachment has been removed', () => {
    const { store, addContextRef } = createMockStore();
    render(<InputBarV2 store={store as any} />);

    expect(capturedInputBarUIProps?.onContextRefCreated).toBeTypeOf('function');

    act(() => {
      store.setState({ attachments: [] });
    });

    act(() => {
      capturedInputBarUIProps?.onContextRefCreated({
        attachmentId: 'att_1',
        contextRef: {
          resourceId: 'res_1',
          hash: 'hash_1',
          typeId: 'file',
        },
      });
    });

    expect(addContextRef).not.toHaveBeenCalled();
  });

  it('only passes manual pinned skills to InputBarUI badges', () => {
    const { store } = createMockStore();

    act(() => {
      store.setState({
        activeSkillIds: ['deep-student', 'workspace-tools'],
        skillStateJson: JSON.stringify({
          manualPinnedSkillIds: [],
          agenticSessionSkillIds: ['deep-student'],
          modeRequiredBundleIds: ['workspace-tools'],
          version: 3,
        }),
      });
    });

    render(<InputBarV2 store={store as any} />);

    expect(capturedInputBarUIProps?.activeSkillIds).toEqual([]);

    act(() => {
      store.setState({
        skillStateJson: JSON.stringify({
          manualPinnedSkillIds: ['research-mode'],
          agenticSessionSkillIds: ['deep-student'],
          version: 4,
        }),
      });
    });

    expect(capturedInputBarUIProps?.activeSkillIds).toEqual(['research-mode']);
  });

  it('passes a model-aware runtime thinking state label to InputBarUI', () => {
    const { store } = createMockStore();

    render(
      <InputBarV2
        store={store as any}
        availableModels={[
          {
            id: 'deepseek-official-v4',
            name: 'DeepSeek V4 Pro',
            model: 'deepseek-v4-pro',
            providerType: 'deepseek',
            providerScope: 'deepseek',
            baseUrl: 'https://api.deepseek.com/v1',
          },
        ]}
      />
    );

    expect(capturedInputBarUIProps?.thinkingStateLabel).toBe('推理: 高');
    expect(capturedInputBarUIProps?.runtimeModelLabel).toBe('deepseek-v4-pro');
    expect(capturedInputBarUIProps?.thinkingDepthOptions?.map((option: any) => option.value)).toEqual(['high', 'max']);
    expect(capturedInputBarUIProps?.thinkingDepthOptions?.map((option: any) => option.labelKey)).toEqual([
      'settings:api.modal.deepseek.depth.high',
      'settings:api.modal.deepseek.depth.max',
    ]);
  });

  it('marks non-reasoning runtime models as unsupported instead of off', () => {
    const { store } = createMockStore();

    act(() => {
      store.setState({
        chatParams: {
          ...store.getState().chatParams,
          modelId: 'gpt-4o',
          model2OverrideId: null,
          enableThinking: true,
          reasoningEffort: 'high',
          thinkingBudget: 8192,
        },
      });
    });

    render(
      <InputBarV2
        store={store as any}
        availableModels={[
          {
            id: 'gpt-4o',
            name: 'GPT-4o',
            model: 'gpt-4o',
            isReasoning: false,
          },
        ]}
      />
    );

    expect(capturedInputBarUIProps?.thinkingStateLabel).toBe('推理: 不支持');
    expect(capturedInputBarUIProps?.thinkingUnsupported).toBe(true);
    expect(capturedInputBarUIProps?.enableThinking).toBe(false);
    expect(capturedInputBarUIProps?.thinkingDepthOptions).toEqual([]);
  });

  it('keeps pending parallel model selections out of the runtime model label', () => {
    const { store } = createMockStore();

    render(
      <InputBarV2
        store={store as any}
        availableModels={[
          {
            id: 'deepseek-official-v4',
            name: 'DeepSeek V4 Pro',
            model: 'deepseek-v4-pro',
            providerType: 'deepseek',
            providerScope: 'deepseek',
            baseUrl: 'https://api.deepseek.com/v1',
          },
          {
            id: 'qwen-max',
            name: 'Qwen Max',
            model: 'qwen-max-latest',
            providerType: 'qwen',
          },
        ]}
      />
    );

    act(() => {
      capturedInputBarUIProps?.modelMentionActions?.selectSuggestion({
        id: 'qwen-max',
        name: 'Qwen Max',
        model: 'qwen-max-latest',
      });
    });

    expect(capturedInputBarUIProps?.runtimeModelLabel).toBe('deepseek-v4-pro');
  });

  it('passes the active runtime model provider label to the presentation layer', () => {
    const { store } = createMockStore();

    render(
      <InputBarV2
        store={store as any}
        availableModels={[
          {
            id: 'deepseek-official-v4',
            name: 'DeepSeek V4 Pro',
            model: 'deepseek-v4-pro',
            providerType: 'deepseek',
            providerScope: 'deepseek',
            vendorName: 'DeepSeek Official',
          },
        ]}
      />
    );

    expect(capturedInputBarUIProps?.runtimeModelLabel).toBe('deepseek-v4-pro');
    expect(capturedInputBarUIProps?.runtimeModelProviderLabel).toBe('DeepSeek Official');
  });

  it('opens the unified model picker from the runtime menu so compare and retry stay on the right side', async () => {
    function RuntimeModelPanel() {
      return null;
    }

    mockModeRegistryState.plugin = {
      renderModelPanel: RuntimeModelPanel,
    };

    const { store } = createMockStore();

    render(
      <InputBarV2
        store={store as any}
        availableModels={[
          {
            id: 'deepseek-official-v4',
            name: 'DeepSeek V4 Pro',
            model: 'deepseek-v4-pro',
            providerType: 'deepseek',
          },
        ]}
      />
    );

    expect(capturedInputBarUIProps?.onOpenRuntimeModelPanel).toBeTypeOf('function');

    act(() => {
      capturedInputBarUIProps?.onOpenRuntimeModelPanel();
    });

    expect(store.getState().setPanelState).toHaveBeenCalledWith('model', true);

    await waitFor(() => {
      const panel = capturedInputBarUIProps?.renderModelPanel?.();
      expect(panel?.type).toBe(ModelPicker);
      expect(panel?.props?.allowCompareToggle).toBe(true);
      expect(panel?.props?.singleSelectedId).toBe(null);
    });
  });

  it('opens the unified model picker in compare mode from the runtime submenu multi-select entry', async () => {
    const { store } = createMockStore();

    render(
      <InputBarV2
        store={store as any}
        availableModels={[
          {
            id: 'deepseek-official-v4',
            name: 'DeepSeek V4 Pro',
            model: 'deepseek-v4-pro',
            providerType: 'deepseek',
          },
          {
            id: 'gpt-4o',
            name: 'GPT-4o',
            model: 'gpt-4o',
            providerType: 'openai',
          },
        ]}
      />
    );

    act(() => {
      capturedInputBarUIProps?.onOpenRuntimeModelPanel?.('compare');
    });

    expect(store.getState().setPanelState).toHaveBeenCalledWith('model', true);

    await waitFor(() => {
      const panel = capturedInputBarUIProps?.renderModelPanel?.();
      expect(panel?.type).toBe(ModelPicker);
      expect(panel?.props?.mode).toBe('compare');
      expect(panel?.props?.allowCompareToggle).toBe(true);
    });
  });

  it('passes completed context window usage to InputBarUI after an assistant response finishes', () => {
    const { store } = createMockStore();
    store.setState({
      chatParams: {
        ...store.getState().chatParams,
        contextLimit: 100_000,
      },
      messageOrder: ['msg_user_1', 'msg_assistant_1'],
      messageMap: new Map([
        ['msg_user_1', { id: 'msg_user_1', role: 'user', blockIds: [], timestamp: 1 }],
        [
          'msg_assistant_1',
          {
            id: 'msg_assistant_1',
            role: 'assistant',
            blockIds: [],
            timestamp: 2,
            _meta: {
              usage: {
                promptTokens: 32_000,
                completionTokens: 8_000,
                totalTokens: 40_000,
                source: 'api',
                lastRoundPromptTokens: 40_000,
              },
            },
          },
        ],
      ]),
    });

    render(<InputBarV2 store={store as any} />);

    expect(capturedInputBarUIProps?.contextWindowUsage).toMatchObject({
      usedTokens: 40_000,
      remainingTokens: 60_000,
      limitTokens: 100_000,
      usedPercent: 40,
      remainingPercent: 60,
      source: 'api',
    });
  });

  it('keeps the last completed context usage while a newer assistant message is still streaming', () => {
    const { store } = createMockStore();
    store.setState({
      chatParams: {
        ...store.getState().chatParams,
        contextLimit: 100_000,
      },
      messageOrder: ['msg_user_1', 'msg_assistant_1', 'msg_user_2', 'msg_assistant_2'],
      messageMap: new Map([
        ['msg_user_1', { id: 'msg_user_1', role: 'user', blockIds: [], timestamp: 1 }],
        [
          'msg_assistant_1',
          {
            id: 'msg_assistant_1',
            role: 'assistant',
            blockIds: [],
            timestamp: 2,
            _meta: {
              usage: {
                promptTokens: 20_000,
                completionTokens: 5_000,
                totalTokens: 25_000,
                source: 'api',
                lastRoundPromptTokens: 25_000,
              },
            },
          },
        ],
        ['msg_user_2', { id: 'msg_user_2', role: 'user', blockIds: [], timestamp: 3 }],
        ['msg_assistant_2', { id: 'msg_assistant_2', role: 'assistant', blockIds: [], timestamp: 4 }],
      ]),
    });

    render(<InputBarV2 store={store as any} />);

    expect(capturedInputBarUIProps?.contextWindowUsage).toMatchObject({
      usedTokens: 25_000,
      remainingTokens: 75_000,
      usedPercent: 25,
      remainingPercent: 75,
    });
  });

  it('recalculates context window usage from the current dialog model override', () => {
    const { store } = createMockStore();

    store.setState({
      chatParams: {
        ...store.getState().chatParams,
        modelId: 'wide-model',
        model2OverrideId: 'compact-model',
        maxTokens: 4096,
        contextLimit: undefined,
      },
      messageOrder: ['msg_user_1', 'msg_assistant_1'],
      messageMap: new Map([
        ['msg_user_1', { id: 'msg_user_1', role: 'user', blockIds: [], timestamp: 1 }],
        [
          'msg_assistant_1',
          {
            id: 'msg_assistant_1',
            role: 'assistant',
            blockIds: [],
            timestamp: 2,
            _meta: {
              usage: {
                promptTokens: 40_000,
                completionTokens: 1_000,
                totalTokens: 41_000,
                source: 'api',
                lastRoundPromptTokens: 40_000,
              },
            },
          },
        ],
      ]),
    });

    render(
      <InputBarV2
        store={store as any}
        availableModels={[
          {
            id: 'wide-model',
            name: 'Wide Model',
            model: 'wide-model',
            contextWindow: 100_000,
            maxOutputTokens: 4096,
          },
          {
            id: 'compact-model',
            name: 'Compact Model',
            model: 'compact-model',
            contextWindow: 50_000,
            maxOutputTokens: 4096,
          },
        ]}
      />
    );

    expect(capturedInputBarUIProps?.contextWindowUsage).toMatchObject({
      usedTokens: 40_000,
      limitTokens: 41_904,
      usedPercent: 95,
      remainingTokens: 1_904,
    });
  });

  it('sets runtime DeepSeek V4 depth from the input bar without changing settings defaults', () => {
    const { store, setChatParams } = createMockStore();

    render(
      <InputBarV2
        store={store as any}
        availableModels={[
          {
            id: 'deepseek-official-v4',
            name: 'DeepSeek V4 Pro',
            model: 'deepseek-v4-pro',
            providerType: 'deepseek',
            providerScope: 'deepseek',
            baseUrl: 'https://api.deepseek.com/v1',
          },
        ]}
      />
    );

    capturedInputBarUIProps?.onSetThinkingDepth?.('max');

    expect(setChatParams).toHaveBeenCalledWith({
      enableThinking: true,
      reasoningEffort: 'max',
      thinkingBudget: undefined,
    });
  });

  it('uses modelDisplayName as a fallback when the current config id is not in the available model cache', () => {
    const { store } = createMockStore();

    act(() => {
      store.setState({
        chatParams: {
          modelId: 'legacy-or-unloaded-config-id',
          modelDisplayName: 'deepseek-v4-pro',
          enableThinking: true,
          reasoningEffort: undefined,
          thinkingBudget: undefined,
        },
      });
    });

    render(
      <InputBarV2
        store={store as any}
        availableModels={[
          {
            id: 'different-loaded-config-id',
            name: 'DeepSeek V4 Pro',
            model: 'deepseek-v4-pro',
            providerType: 'deepseek',
            providerScope: 'deepseek',
            baseUrl: 'https://api.deepseek.com/v1',
          },
        ]}
      />
    );

    expect(capturedInputBarUIProps?.thinkingStateLabel).toBe('推理: 高');
    expect(capturedInputBarUIProps?.thinkingDepthOptions?.map((option: any) => option.value)).toEqual(['high', 'max']);
  });

  it('derives runtime thinking controls from the current dialog model override', () => {
    const { store } = createMockStore();

    act(() => {
      store.setState({
        chatParams: {
          modelId: 'qwen-max',
          model2OverrideId: 'deepseek-official-v4',
          maxTokens: 32_768,
          enableThinking: true,
          reasoningEffort: undefined,
          thinkingBudget: undefined,
        },
      });
    });

    render(
      <InputBarV2
        store={store as any}
        availableModels={[
          {
            id: 'qwen-max',
            name: 'Qwen Max',
            model: 'qwen-max',
            providerType: 'qwen',
          },
          {
            id: 'deepseek-official-v4',
            name: 'DeepSeek V4 Pro',
            model: 'deepseek-v4-pro',
            providerType: 'deepseek',
            providerScope: 'deepseek',
            baseUrl: 'https://api.deepseek.com/v1',
          },
        ]}
      />
    );

    expect(capturedInputBarUIProps?.runtimeModelLabel).toBe('deepseek-v4-pro');
    expect(capturedInputBarUIProps?.thinkingStateLabel).toBe('推理: 高');
    expect(capturedInputBarUIProps?.thinkingDepthOptions?.map((option: any) => option.value)).toEqual(['high', 'max']);
  });

  it('normalizes runtime thinking depth when switching to SiliconFlow V3.2', () => {
    const { store, setChatParams } = createMockStore();

    act(() => {
      store.setState({
        chatParams: {
          modelId: 'siliconflow-v32',
          enableThinking: true,
          reasoningEffort: 'max',
          thinkingBudget: undefined,
        },
      });
    });

    render(
      <InputBarV2
        store={store as any}
        availableModels={[
          {
            id: 'siliconflow-v32',
            name: 'DeepSeek V3.2',
            model: 'deepseek-ai/DeepSeek-V3.2',
            providerType: 'siliconflow',
            providerScope: 'siliconflow',
            baseUrl: 'https://api.siliconflow.cn/v1',
          },
        ]}
      />
    );

    expect(capturedInputBarUIProps?.thinkingStateLabel).toBe('推理: 超高');
    expect(capturedInputBarUIProps?.thinkingDepthOptions?.map((option: any) => option.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(capturedInputBarUIProps?.thinkingDepthOptions?.map((option: any) => option.labelKey)).toEqual([
      'settings:api.modal.deepseek.depth.low',
      'settings:api.modal.deepseek.depth.medium',
      'settings:api.modal.deepseek.depth.high',
      'settings:api.modal.deepseek.depth.xhigh',
    ]);
    expect(setChatParams).toHaveBeenCalledWith({
      enableThinking: true,
      reasoningEffort: 'xhigh',
      thinkingBudget: 32768,
    });
  });
});
