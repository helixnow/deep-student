/**
 * Chat V2 - TauriAdapter 单元测试
 *
 * 测试 TauriAdapter 的事件监听、消息发送、会话管理等功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

// Import after mocking
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ChatV2TauriAdapter } from '@/features/chat/adapters/TauriAdapter';
import { clearModelsCache, ensureModelsCacheLoaded } from '@/features/chat/hooks/useAvailableModels';
import type { ChatStore } from '@/features/chat/core/types';
import type { SessionEventPayload } from '@/features/chat/adapters/types';
import { skillRegistry } from '@/features/chat/skills/registry';
import { clearSessionSkills, syncLoadedSkillsFromBackend } from '@/features/chat/skills/progressiveDisclosure';
import type { SkillDefinition } from '@/features/chat/skills/types';
import { groupCache } from '@/features/chat/core/store/groupCache';
import { McpService } from '@/mcp/mcpService';

// ============================================================================
// Mock Store
// ============================================================================

function createMockStore(): ChatStore {
  return {
    sessionId: 'test-session-id',
    mode: 'general_chat',
    title: 'Test Chat',
    description: 'Test description',
    sessionStatus: 'idle',
    isDataLoaded: true,
    messageMap: new Map(),
    messageOrder: [],
    blocks: new Map(),
    currentStreamingMessageId: null,
    activeBlockIds: new Set(),
    streamingVariantIds: new Set(),
    chatParams: {
      modelId: 'test-model',
      temperature: 0.7,
      contextLimit: 8192,
      maxTokens: 4096,
      enableThinking: false,
      disableTools: false,
      model2OverrideId: null,
    },
    features: new Map([
      ['rag', true],
      ['webSearch', false],
    ]),
    modeState: null,
    inputValue: '',
    attachments: [],
    panelStates: {
      rag: false,
      mcp: false,
      search: false,
      learn: false,
      model: false,
      advanced: false,
      attachment: false,
    },
    pendingContextRefs: [],
    messageOperationLock: null,
    pendingApprovalRequest: null,
    activeSkillId: null,
    activeSkillIds: [],
    skillStateJson: null,
    pendingParallelModelIds: null,
    modelRetryTarget: null,

    // Guards
    canSend: vi.fn(() => true),
    canEdit: vi.fn(() => true),
    canDelete: vi.fn(() => true),
    canAbort: vi.fn(() => true),
    isBlockLocked: vi.fn(() => false),
    isMessageLocked: vi.fn(() => false),

    // Actions
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendMessageWithIds: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn(),
    editMessage: vi.fn(),
    retryMessage: vi.fn().mockResolvedValue(undefined),
    abortStream: vi.fn().mockResolvedValue(undefined),
    createBlock: vi.fn(() => 'test-block-id'),
    updateBlockContent: vi.fn(),
    updateBlockStatus: vi.fn(),
    updateMessageMeta: vi.fn(),
    setBlockResult: vi.fn(),
    setBlockError: vi.fn(),
    updateBlock: vi.fn(),
    setCurrentStreamingMessage: vi.fn(),
    addActiveBlock: vi.fn(),
    removeActiveBlock: vi.fn(),
    setChatParams: vi.fn(),
    resetChatParams: vi.fn(),
    setFeature: vi.fn(),
    toggleFeature: vi.fn(),
    getFeature: vi.fn((key) => false),
    setModeState: vi.fn(),
    updateModeState: vi.fn(),
    setInputValue: vi.fn(),
    addAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    setPanelState: vi.fn(),
    initSession: vi.fn().mockResolvedValue(undefined),
    loadSession: vi.fn().mockResolvedValue(undefined),
    saveSession: vi.fn().mockResolvedValue(undefined),
    setSaveCallback: vi.fn(),
    setRetryCallback: vi.fn(),
    setDeleteCallback: vi.fn(),
    setEditAndResendCallback: vi.fn(),
    setSendCallback: vi.fn(),
    setAbortCallback: vi.fn(),
    setContinueMessageCallback: vi.fn(),
    continueMessage: vi.fn().mockResolvedValue(undefined),
    setLoadCallback: vi.fn(),
    setSwitchVariantCallback: vi.fn(),
    setDeleteVariantCallback: vi.fn(),
    setRetryVariantCallback: vi.fn(),
    setRetryAllVariantsCallback: vi.fn(),
    setCancelVariantCallback: vi.fn(),
    setUpdateBlockContentCallback: vi.fn(),
    setUpdateSessionSettingsCallback: vi.fn(),
    restoreFromBackend: vi.fn(),
    prependHistoryFromBackend: vi.fn(),
    createBlockWithId: vi.fn(() => 'test-block-id'),
    completeStream: vi.fn(),
    forceResetToIdle: vi.fn(),
    batchUpdateBlockContent: vi.fn(),
    getMessage: vi.fn(),
    getMessageBlocks: vi.fn(() => []),
    getOrderedMessages: vi.fn(() => []),
    setPendingParallelModelIds: vi.fn(),
    setModelRetryTarget: vi.fn(),
    setSkillStateJson: vi.fn(),
  } as unknown as ChatStore;
}

// ============================================================================
// Tests
// ============================================================================

describe('ChatV2TauriAdapter', () => {
  let adapter: ChatV2TauriAdapter;
  let mockStore: ChatStore;
  let mockUnlisten: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearModelsCache();

    // Simulate Tauri runtime so adapter.setup() doesn't short-circuit.
    (window as any).__TAURI_INTERNALS__ = {};

    mockStore = createMockStore();
    mockUnlisten = vi.fn();

    // Setup listen mock to return unlisten function
    vi.mocked(listen).mockResolvedValue(mockUnlisten);

    adapter = new ChatV2TauriAdapter('test-session-id', mockStore);
  });

  afterEach(async () => {
    await adapter.cleanup();
    clearSessionSkills('test-session-id');
    clearModelsCache();
    groupCache.clear();
    delete (window as any).__TAURI_INTERNALS__;
    delete (window as any).__TAURI_IPC__;
  });

  describe('setup', () => {
    it('should setup event listeners', async () => {
      await adapter.setup();

      // Should register block/session plus shared debug listeners.
      expect(listen).toHaveBeenCalledTimes(4);

      // Check listener channels
      expect(listen).toHaveBeenCalledWith(
        'chat_v2_event_test-session-id',
        expect.any(Function)
      );
      expect(listen).toHaveBeenCalledWith(
        'chat_v2_session_test-session-id',
        expect.any(Function)
      );

      expect(adapter.initialized).toBe(true);
    });

    it('should not setup twice', async () => {
      await adapter.setup();
      await adapter.setup();

      // Should only register once
      expect(listen).toHaveBeenCalledTimes(4);
    });
  });

  describe('cleanup', () => {
    it('should cleanup all listeners', async () => {
      await adapter.setup();

      await adapter.cleanup();

      // Should release all registered listeners.
      expect(mockUnlisten).toHaveBeenCalledTimes(4);
      expect(adapter.initialized).toBe(false);
    });

    it('should handle cleanup when not setup', () => {
      // Should not throw
      expect(() => adapter.cleanup()).not.toThrow();
    });

    it('does not clear callbacks installed by a newer same-session adapter', async () => {
      await adapter.setup();
      const newerAdapter = new ChatV2TauriAdapter('test-session-id', mockStore);
      await newerAdapter.setup();

      const sendCallbackBeforeOldCleanup = vi.mocked(mockStore.setSendCallback).mock.calls.at(-1)?.[0];
      const saveCallbackBeforeOldCleanup = vi.mocked(mockStore.setSaveCallback).mock.calls.at(-1)?.[0];
      expect(sendCallbackBeforeOldCleanup).toEqual(expect.any(Function));
      expect(saveCallbackBeforeOldCleanup).toEqual(expect.any(Function));

      await adapter.cleanup();

      expect(vi.mocked(mockStore.setSendCallback).mock.calls.at(-1)?.[0])
        .toBe(sendCallbackBeforeOldCleanup);
      expect(vi.mocked(mockStore.setSaveCallback).mock.calls.at(-1)?.[0])
        .toBe(saveCallbackBeforeOldCleanup);

      await newerAdapter.cleanup();
    });
  });

  describe('sendMessage', () => {
    beforeEach(async () => {
      await adapter.setup();
    });

    it('should send message and update store', async () => {
      vi.mocked(invoke).mockResolvedValue('assistant-msg-id');

      await adapter.sendMessage('Hello, world!');

      // Should call store.sendMessageWithIds (not sendMessage)
      expect(mockStore.sendMessageWithIds).toHaveBeenCalledWith(
        'Hello, world!',
        undefined,
        expect.stringMatching(/^msg_/),  // userMessageId
        expect.stringMatching(/^msg_/)   // assistantMessageId
      );

      // Should call backend
      expect(invoke).toHaveBeenCalledWith('chat_v2_send_message', {
        request: expect.objectContaining({
          sessionId: 'test-session-id',
          content: 'Hello, world!',
        }),
      });
    });

    it('should handle send error', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('Network error'));

      await expect(adapter.sendMessage('Hello')).rejects.toThrow('Network error');

      // Should try to abort
      expect(mockStore.abortStream).toHaveBeenCalled();
    });

    it('should send the current session model override as the effective model', async () => {
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'get_api_configurations') {
          return [
            {
              id: 'base-model',
              name: 'Base Model',
              model: 'provider/base-model',
              enabled: true,
            },
            {
              id: 'override-model',
              name: 'Override Model',
              model: 'provider/override-model',
              enabled: true,
            },
          ];
        }
        if (command === 'chat_v2_send_message') {
          return 'assistant-msg-id';
        }
        return undefined;
      });

      (mockStore as any).chatParams = {
        ...(mockStore as any).chatParams,
        modelId: 'base-model',
        modelDisplayName: 'provider/base-model',
        model2OverrideId: 'override-model',
      };

      await adapter.sendMessage('Hello with override');

      const backendCall = vi.mocked(invoke).mock.calls.find(([command]) => command === 'chat_v2_send_message');
      expect(backendCall).toBeTruthy();

      const request = (backendCall?.[1] as { request: { options: Record<string, unknown> } }).request;
      expect(request.options.modelId).toBe('override-model');
      expect(request.options.model2OverrideId).toBe('override-model');

      expect(mockStore.setChatParams).toHaveBeenCalledWith({
        modelId: 'base-model',
        model2OverrideId: 'override-model',
        modelDisplayName: 'provider/override-model',
      });
      expect(vi.mocked(mockStore.setChatParams).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(mockStore.sendMessageWithIds).mock.invocationCallOrder[0]);
    });

    it('should disable thinking parameters when the effective model does not support reasoning', async () => {
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'get_api_configurations') {
          return [
            {
              id: 'plain-model',
              name: 'Plain Model',
              model: 'provider/plain-model',
              enabled: true,
              isReasoning: false,
            },
          ];
        }
        if (command === 'chat_v2_send_message') {
          return 'assistant-msg-id';
        }
        return undefined;
      });

      (mockStore as any).chatParams = {
        ...(mockStore as any).chatParams,
        modelId: 'plain-model',
        enableThinking: true,
        reasoningEffort: 'high',
        thinkingBudget: 8192,
      };

      await adapter.sendMessage('Hello without reasoning support');

      const backendCall = vi.mocked(invoke).mock.calls.find(([command]) => command === 'chat_v2_send_message');
      expect(backendCall).toBeTruthy();

      const request = (backendCall?.[1] as { request: { options: Record<string, unknown> } }).request;
      expect(request.options.modelId).toBe('plain-model');
      expect(request.options.enableThinking).toBe(false);
      expect(request.options.reasoningEffort).toBeUndefined();
      expect(request.options.thinkingBudget).toBeUndefined();
    });
  });

  describe('abortStream', () => {
    beforeEach(async () => {
      await adapter.setup();
    });

    it('should abort stream and notify backend', async () => {
      vi.mocked(invoke).mockResolvedValue(undefined);

      // Set currentStreamingMessageId so abort will proceed
      (mockStore as any).currentStreamingMessageId = 'streaming-msg-id';

      await adapter.abortStream();

      // Should call store.abortStream
      // Note: The actual backend call happens inside store.abortStream() via _abortCallback
      // which was injected during setup. Since mockStore.abortStream is a mock,
      // it won't call the callback, so we only verify the store method was called.
      expect(mockStore.abortStream).toHaveBeenCalled();
    });

    it('should return early if no streaming message', async () => {
      // currentStreamingMessageId is null by default
      await adapter.abortStream();

      // Should not call backend
      expect(invoke).not.toHaveBeenCalledWith('chat_v2_cancel_stream', expect.anything());
    });
  });

  describe('buildSendOptions', () => {
    it('should build send options from store', async () => {
      await adapter.setup();

      // Use reflection to access private method
      const options = (adapter as any).buildSendOptions();

      expect(options).toMatchObject({
        modelId: 'test-model',
        temperature: 0.7,
        maxTokens: 4096,
        enableThinking: false,
        disableTools: false,
        ragEnabled: true,
        webSearchEnabled: false,
      });
    });

    it('passes the multimodal retrieval switch and route settings to the request snapshot', async () => {
      await adapter.setup();
      (mockStore as any).chatParams = {
        ...(mockStore as any).chatParams,
        multimodalRagEnabled: true,
        multimodalTopK: 7,
        multimodalEnableReranking: true,
        multimodalLibraryIds: ['folder-a'],
      };

      const options = (adapter as any).buildSendOptions();

      expect(options).toMatchObject({
        multimodalRagEnabled: true,
        multimodalTopK: 7,
        multimodalEnableReranking: true,
        multimodalLibraryIds: ['folder-a'],
      });
    });

    it('should pass DeepSeek V4 runtime reasoning effort without mutating model defaults', async () => {
      await adapter.setup();

      (mockStore as any).chatParams = {
        ...(mockStore as any).chatParams,
        enableThinking: true,
        reasoningEffort: 'max',
        thinkingBudget: undefined,
      };

      const options = (adapter as any).buildSendOptions();

      expect(options).toMatchObject({
        enableThinking: true,
        reasoningEffort: 'max',
      });
      expect(options.thinkingBudget).toBeUndefined();
    });

    it('should map OpenAI Codex runtime reasoning effort into send options', async () => {
      await adapter.setup();

      (mockStore as any).chatParams = {
        ...(mockStore as any).chatParams,
        modelId: 'builtin-codex-gpt-5.6-sol',
        enableThinking: true,
        reasoningEffort: 'xhigh',
        thinkingBudget: undefined,
      };

      const options = (adapter as any).buildSendOptions();

      expect(options).toMatchObject({
        modelId: 'builtin-codex-gpt-5.6-sol',
        enableThinking: true,
        reasoningEffort: 'xhigh',
      });
      expect(options.thinkingBudget).toBeUndefined();
    });

    it('should pass SiliconFlow V3.2 runtime thinking budget preset', async () => {
      await adapter.setup();

      (mockStore as any).chatParams = {
        ...(mockStore as any).chatParams,
        enableThinking: true,
        reasoningEffort: 'xhigh',
        thinkingBudget: 32768,
      };

      const options = (adapter as any).buildSendOptions();

      expect(options).toMatchObject({
        enableThinking: true,
        reasoningEffort: 'xhigh',
        thinkingBudget: 32768,
      });
    });

    it('should derive context limit from the current dialog model override', async () => {
      vi.mocked(invoke).mockResolvedValueOnce([
        {
          id: 'wide-model',
          name: 'Wide Model',
          model: 'wide-model',
          enabled: true,
          contextWindow: 100_000,
          maxOutputTokens: 4096,
        },
        {
          id: 'compact-model',
          name: 'Compact Model',
          model: 'compact-model',
          enabled: true,
          contextWindow: 50_000,
          maxOutputTokens: 4096,
        },
      ]);
      await ensureModelsCacheLoaded(true);
      await adapter.setup();

      (mockStore as any).chatParams = {
        ...(mockStore as any).chatParams,
        modelId: 'wide-model',
        model2OverrideId: 'compact-model',
        contextLimit: undefined,
        maxTokens: 4096,
      };

      const options = (adapter as any).buildSendOptions();

      expect(options.contextLimit).toBe(41_904);
    });

    it('should include current group scope in send options', async () => {
      await adapter.setup();

      (mockStore as any).groupId = 'group-math';
      groupCache.set('group-math', {
        id: 'group-math',
        name: 'Math',
        defaultSkillIds: [],
        pinnedResourceIds: ['fld_math', 'res_formula_sheet'],
        defaultRuntimeRootId: 'authorized_math_root',
        sortOrder: 0,
        persistStatus: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      });

      const options = (adapter as any).buildSendOptions();

      expect(options.groupId).toBe('group-math');
      expect(options.groupName).toBe('Math');
      expect(options.groupPinnedResourceIds).toEqual(['fld_math', 'res_formula_sheet']);
      expect(options.groupDefaultRuntimeRootId).toBe('authorized_math_root');
    });

    it('falls back to groupDefaultRuntimeRootIdSnapshot when group cache lacks runtime root', async () => {
      await adapter.setup();

      (mockStore as any).groupId = 'group-physics';
      (mockStore as any).sessionMetadata = {
        groupDefaultRuntimeRootIdSnapshot: 'authorized_physics_root',
      };
      groupCache.set('group-physics', {
        id: 'group-physics',
        name: 'Physics',
        defaultSkillIds: [],
        pinnedResourceIds: [],
        defaultRuntimeRootId: null,
        sortOrder: 0,
        persistStatus: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      });

      const options = (adapter as any).buildSendOptions();

      expect(options.groupDefaultRuntimeRootId).toBe('authorized_physics_root');
    });

    it('prefers live group defaultRuntimeRootId over stale session snapshot', async () => {
      await adapter.setup();

      (mockStore as any).groupId = 'group-chem';
      (mockStore as any).sessionMetadata = {
        groupDefaultRuntimeRootIdSnapshot: 'authorized_stale_root',
      };
      groupCache.set('group-chem', {
        id: 'group-chem',
        name: 'Chem',
        defaultSkillIds: [],
        pinnedResourceIds: [],
        defaultRuntimeRootId: 'authorized_live_root',
        sortOrder: 0,
        persistStatus: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      });

      const options = (adapter as any).buildSendOptions();

      expect(options.groupDefaultRuntimeRootId).toBe('authorized_live_root');
    });

    it('should use the current dialog model override for multimodal context handling', async () => {
      vi.mocked(invoke).mockResolvedValue([
        {
          id: 'text-model',
          name: 'Text Model',
          model: 'provider/text-model',
          enabled: true,
          isMultimodal: false,
        },
        {
          id: 'vision-model',
          name: 'Vision Model',
          model: 'provider/vision-model',
          enabled: true,
          isMultimodal: true,
        },
      ]);
      await adapter.setup();

      const isMultimodal = await (adapter as any).shouldResolveContextAsMultimodal({
        modelId: 'text-model',
        model2OverrideId: 'vision-model',
      });

      expect(isMultimodal).toBe(true);
    });

    it('should prefer structured skill state over local cache', async () => {
      await adapter.setup();

      (mockStore as any).skillStateJson = JSON.stringify({
        manualPinnedSkillIds: ['manual-skill'],
        agenticSessionSkillIds: ['agentic-skill'],
        version: 5,
      });

      const options = (adapter as any).buildSendOptions();

      expect(options.activeSkillIds).toEqual(['manual-skill']);
      expect(options.skillStateVersion).toBe(5);
    });

    it('should inject embeddedTools for structured loaded skills', async () => {
      await adapter.setup();

      const skillId = 'test-loaded-skill';
      const skill: SkillDefinition = {
        id: skillId,
        name: 'Test Loaded Skill',
        description: 'Regression test skill',
        location: 'builtin',
        sourcePath: 'builtin://test-loaded-skill',
        content: 'test content',
        allowedTools: ['builtin-test_loaded_tool'],
        embeddedTools: [
          {
            name: 'builtin-test_loaded_tool',
            description: 'Regression tool schema',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' },
              },
              required: ['query'],
            },
          },
        ],
      };
      skillRegistry.register(skill);

      try {
        (mockStore as any).skillStateJson = JSON.stringify({
          manualPinnedSkillIds: ['manual-skill'],
          agenticSessionSkillIds: [skillId],
          version: 6,
        });

        const options = (adapter as any).buildSendOptions();

        expect(options.mcpToolSchemas).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'load_skills' }),
            expect.objectContaining({ name: 'builtin-test_loaded_tool' }),
          ]),
        );
        // ★ allowedTools 执行策略已收归后端（tool_policy / send_message），
        // 前端不再发送 skillAllowedTools（types.rs 有 boundary 断言）
        expect(options.skillAllowedTools).toBeUndefined();
      } finally {
        skillRegistry.unregister(skillId);
      }
    });

    it('should inject embedded tool schemas for embedded-only skills without a frontend policy', async () => {
      await adapter.setup();

      const skillId = 'embedded-only-skill';
      const skill: SkillDefinition = {
        id: skillId,
        name: 'Embedded Only Skill',
        description: 'Regression test embedded-only skill',
        location: 'builtin',
        sourcePath: 'builtin://embedded-only-skill',
        content: 'embedded-only content',
        embeddedTools: [
          {
            name: 'builtin-embedded_only_tool',
            description: 'Embedded-only regression tool schema',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' },
              },
            },
          },
        ],
      };
      skillRegistry.register(skill);

      try {
        (mockStore as any).skillStateJson = JSON.stringify({
          manualPinnedSkillIds: [skillId],
          agenticSessionSkillIds: [],
          version: 13,
        });

        const options = (adapter as any).buildSendOptions();

        // 嵌入式工具 schema 仍由前端注入；执行白名单由后端从技能状态推导
        expect(options.mcpToolSchemas).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'builtin-embedded_only_tool' }),
          ]),
        );
        expect(options.skillAllowedTools).toBeUndefined();
      } finally {
        skillRegistry.unregister(skillId);
      }
    });

    it('should include runtime loaded skills when structured skill state is stale', async () => {
      await adapter.setup();

      const skillId = 'runtime-loaded-skill';
      const skill: SkillDefinition = {
        id: skillId,
        name: 'Runtime Loaded Skill',
        description: 'Regression test skill loaded by backend tool result',
        location: 'builtin',
        sourcePath: 'builtin://runtime-loaded-skill',
        content: 'runtime loaded instructions',
        allowedTools: ['builtin-runtime_loaded_tool'],
        embeddedTools: [
          {
            name: 'builtin-runtime_loaded_tool',
            description: 'Runtime loaded tool schema',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' },
              },
              required: ['query'],
            },
          },
        ],
      };
      skillRegistry.register(skill);

      try {
        (mockStore as any).skillStateJson = JSON.stringify({
          manualPinnedSkillIds: [],
          agenticSessionSkillIds: [],
          branchLocalSkillIds: [],
          version: 11,
        });
        syncLoadedSkillsFromBackend('test-session-id', [skillId], { replace: true });

        const options = (adapter as any).buildSendOptions();

        expect(options.skillContents).toMatchObject({
          [skillId]: 'runtime loaded instructions',
        });
        expect(options.mcpToolSchemas).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'builtin-runtime_loaded_tool' }),
          ]),
        );
        expect(options.skillAllowedTools).toBeUndefined();
      } finally {
        skillRegistry.unregister(skillId);
        clearSessionSkills('test-session-id');
      }
    });

    it('should expose package roots only for runtime-enabled trusted skills', async () => {
      await adapter.setup();

      const activeSkillId = 'active-package-skill';
      const inactiveSkillId = 'inactive-package-skill';
      const untrustedSkillId = 'untrusted-package-skill';
      const activeSkill: SkillDefinition = {
        id: activeSkillId,
        name: 'Active Package Skill',
        description: 'Regression test active package root',
        location: 'project',
        sourcePath: 'E:/study/.skills/active-package-skill/SKILL.md',
        packageRoot: 'E:/study/.skills/active-package-skill',
        trustStatus: 'trusted',
        content: 'active package content',
        allowedTools: ['builtin-workspace_file_read'],
      };
      const inactiveSkill: SkillDefinition = {
        id: inactiveSkillId,
        name: 'Inactive Package Skill',
        description: 'Regression test inactive package root',
        location: 'project',
        sourcePath: 'E:/study/.skills/inactive-package-skill/SKILL.md',
        packageRoot: 'E:/study/.skills/inactive-package-skill',
        trustStatus: 'trusted',
        content: 'inactive package content',
        allowedTools: ['builtin-workspace_file_read'],
      };
      const untrustedSkill: SkillDefinition = {
        id: untrustedSkillId,
        name: 'Untrusted Package Skill',
        description: 'Regression test untrusted package root',
        location: 'project',
        sourcePath: 'E:/study/.agents/skills/untrusted-package-skill/SKILL.md',
        packageRoot: 'E:/study/.agents/skills/untrusted-package-skill',
        trustStatus: 'untrusted',
        content: 'untrusted package content',
        allowedTools: ['builtin-workspace_file_read'],
      };
      skillRegistry.register(activeSkill);
      skillRegistry.register(inactiveSkill);
      skillRegistry.register(untrustedSkill);

      try {
        (mockStore as any).skillStateJson = JSON.stringify({
          manualPinnedSkillIds: [activeSkillId, untrustedSkillId],
          agenticSessionSkillIds: [],
          version: 15,
        });

        const options = (adapter as any).buildSendOptions();

        expect(options.skillPackageRoots).toEqual({
          [activeSkillId]: 'E:/study/.skills/active-package-skill',
        });
      } finally {
        skillRegistry.unregister(activeSkillId);
        skillRegistry.unregister(inactiveSkillId);
        skillRegistry.unregister(untrustedSkillId);
      }
    });

    it('should expose selected external MCP schemas without frontend policy filtering', async () => {
      await adapter.setup();

      const skillId = 'external-mcp-policy-skill';
      const skill: SkillDefinition = {
        id: skillId,
        name: 'External MCP Policy Skill',
        description: 'Regression test external MCP filtering',
        location: 'builtin',
        sourcePath: 'builtin://external-mcp-policy-skill',
        content: 'external mcp policy content',
        allowedTools: ['server-a::builtin-allowed_tool'],
      };
      skillRegistry.register(skill);
      const getCachedToolsFor = vi.spyOn(McpService, 'getCachedToolsFor').mockReturnValue([
        {
          name: 'allowed_tool',
          description: 'Allowed external tool',
          input_schema: { type: 'object' },
        },
        {
          name: 'blocked_tool',
          description: 'Blocked external tool',
          input_schema: { type: 'object' },
        },
      ] as any);

      try {
        (mockStore as any).chatParams = {
          ...(mockStore as any).chatParams,
          selectedMcpServers: ['server-a'],
        };
        (mockStore as any).skillStateJson = JSON.stringify({
          manualPinnedSkillIds: [skillId],
          agenticSessionSkillIds: [],
          version: 14,
        });

        const options = (adapter as any).buildSendOptions();

        // ★ 白名单裁剪已收归后端执行策略：前端如实上报选中服务器的全部 schema，
        // 不发送 skillAllowedTools；越权调用由后端 tool_policy 在执行时拦截
        expect(options.skillAllowedTools).toBeUndefined();
        expect(options.mcpToolSchemas).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'load_skills' }),
            expect.objectContaining({ name: 'allowed_tool', serverId: 'server-a' }),
            expect.objectContaining({ name: 'blocked_tool', serverId: 'server-a' }),
          ]),
        );
      } finally {
        getCachedToolsFor.mockRestore();
        skillRegistry.unregister(skillId);
      }
    });

    it('should not send any skillAllowedTools policy for active skills without allowed tools', async () => {
      await adapter.setup();

      const skillId = 'instruction-only-skill';
      const skill: SkillDefinition = {
        id: skillId,
        name: 'Instruction Only Skill',
        description: 'Regression test instruction-only skill',
        location: 'builtin',
        sourcePath: 'builtin://instruction-only-skill',
        content: 'instruction-only content',
      };
      skillRegistry.register(skill);

      try {
        (mockStore as any).skillStateJson = JSON.stringify({
          manualPinnedSkillIds: [skillId],
          agenticSessionSkillIds: [],
          version: 12,
        });

        const options = (adapter as any).buildSendOptions();

        expect(options.activeSkillIds).toEqual([skillId]);
        expect(options.skillAllowedTools).toBeUndefined();
      } finally {
        skillRegistry.unregister(skillId);
      }
    });
  });

  describe('session events', () => {
    let sessionEventCallback: (event: { payload: SessionEventPayload }) => void;

    beforeEach(async () => {
      vi.mocked(listen).mockImplementation(async (channel, callback) => {
        if (channel === 'chat_v2_session_test-session-id') {
          sessionEventCallback = callback as typeof sessionEventCallback;
        }
        return mockUnlisten;
      });

      await adapter.setup();
    });

    it('should handle stream_complete event', async () => {
      vi.useFakeTimers();
      try {
        (mockStore as any).currentStreamingMessageId = 'msg-1';
        sessionEventCallback({
          payload: {
            sessionId: 'test-session-id',
            eventType: 'stream_complete',
            messageId: 'msg-1',
            durationMs: 1000,
            timestamp: Date.now(),
          },
        });

        expect(mockStore.completeStream).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(50);
        expect(mockStore.completeStream).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should handle stream_error event', () => {
      (mockStore as any).currentStreamingMessageId = 'msg-1';
      sessionEventCallback({
        payload: {
          sessionId: 'test-session-id',
          eventType: 'stream_error',
          messageId: 'msg-1',
          error: 'Test error',
          timestamp: Date.now(),
        },
      });

      // Should call completeStream to reset state
      expect(mockStore.completeStream).toHaveBeenCalled();
    });

    it('should handle stream_cancelled event', () => {
      (mockStore as any).currentStreamingMessageId = 'msg-1';
      sessionEventCallback({
        payload: {
          sessionId: 'test-session-id',
          eventType: 'stream_cancelled',
          messageId: 'msg-1',
          timestamp: Date.now(),
        },
      });

      // Should call completeStream to reset state
      expect(mockStore.completeStream).toHaveBeenCalled();
    });
  });

  describe('session operations', () => {
    beforeEach(async () => {
      await adapter.setup();
    });

    it('should load session and call restoreFromBackend', async () => {
      const mockResponse = {
        session: {
          id: 'test-session-id',
          mode: 'general_chat',
          persistStatus: 'active',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        messages: [],
        blocks: [],
      };
      vi.mocked(invoke).mockResolvedValue(mockResponse);

      await adapter.loadSession();

      expect(invoke).toHaveBeenCalledWith('chat_v2_load_session', {
        sessionId: 'test-session-id',
        tailLimit: 80,
      });

      // 验证调用了 store.restoreFromBackend
      expect(mockStore.restoreFromBackend).toHaveBeenCalledWith(
        mockResponse,
        expect.objectContaining({
          messageIds: expect.any(Set),
          blockIds: expect.any(Set),
          sessionStatus: 'idle',
          currentStreamingMessageId: null,
        }),
      );
    });

    it('runs full-history completion through a watchdog when idle callbacks never fire', async () => {
      vi.useFakeTimers();
      const idleCallback = vi.fn(() => 77);
      const cancelIdleCallback = vi.fn();
      Object.defineProperty(window, 'requestIdleCallback', {
        configurable: true,
        value: idleCallback,
      });
      Object.defineProperty(window, 'cancelIdleCallback', {
        configurable: true,
        value: cancelIdleCallback,
      });
      const tailResponse = {
        session: {
          id: 'test-session-id',
          mode: 'general_chat',
          persistStatus: 'active' as const,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        messages: [],
        blocks: [],
        totalMessageCount: 1,
      };
      const fullResponse = { ...tailResponse, totalMessageCount: undefined };
      let loadCalls = 0;
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'chat_v2_load_session') {
          loadCalls += 1;
          return loadCalls === 1 ? tailResponse : fullResponse;
        }
        return undefined;
      });

      await adapter.loadSession();
      expect(loadCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1_100);

      expect(loadCalls).toBe(2);
      expect(mockStore.prependHistoryFromBackend).toHaveBeenCalledWith(
        fullResponse,
        expect.objectContaining({ messageIds: expect.any(Set) }),
      );
      expect(cancelIdleCallback).toHaveBeenCalledWith(77);

      delete (window as any).requestIdleCallback;
      delete (window as any).cancelIdleCallback;
      vi.useRealTimers();
    });

    it('retries a transient full-history load failure', async () => {
      vi.useFakeTimers();
      delete (window as any).requestIdleCallback;
      delete (window as any).cancelIdleCallback;
      const tailResponse = {
        session: {
          id: 'test-session-id',
          mode: 'general_chat',
          persistStatus: 'active' as const,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        messages: [],
        blocks: [],
        totalMessageCount: 1,
      };
      const fullResponse = { ...tailResponse, totalMessageCount: undefined };
      let loadCalls = 0;
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command !== 'chat_v2_load_session') return undefined;
        loadCalls += 1;
        if (loadCalls === 1) return tailResponse;
        if (loadCalls === 2) throw new Error('transient history failure');
        return fullResponse;
      });

      await adapter.loadSession();
      await vi.advanceTimersByTimeAsync(120);
      expect(loadCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(620);

      expect(loadCalls).toBe(3);
      expect(mockStore.prependHistoryFromBackend).toHaveBeenCalledWith(
        fullResponse,
        expect.objectContaining({ messageIds: expect.any(Set) }),
      );
      vi.useRealTimers();
    });

    it('should hydrate empty loaded sessions with the default chat model before the first send', async () => {
      vi.clearAllMocks();

      const mockResponse = {
        session: {
          id: 'test-session-id',
          mode: 'general_chat',
          persistStatus: 'active',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        messages: [],
        blocks: [],
      };

      vi.mocked(mockStore.restoreFromBackend).mockImplementation(() => {
        (mockStore as any).chatParams = {
          ...(mockStore as any).chatParams,
          modelId: '',
          modelDisplayName: '',
          model2OverrideId: null,
        };
      });

      vi.mocked(invoke).mockImplementation((command: string) => {
        if (command === 'chat_v2_load_session') {
          return Promise.resolve(mockResponse);
        }
        if (command === 'get_api_configurations') {
          return Promise.resolve([
            { id: 'deepseek-default-id', name: 'DeepSeek Default', model: 'deepseek-v4-pro' },
          ]);
        }
        if (command === 'get_model_assignments') {
          return Promise.resolve({ model2_config_id: 'deepseek-default-id' });
        }
        return Promise.resolve(undefined);
      });

      await adapter.loadSession();

      expect(mockStore.setChatParams).toHaveBeenCalledWith(expect.objectContaining({
        modelId: 'deepseek-default-id',
        model2OverrideId: null,
      }));
    });

    it('should save session with session state', async () => {
      vi.mocked(invoke).mockResolvedValue(undefined);
      (mockStore as any).skillStateJson = '{"manualPinnedSkillIds":["cached-skill"],"version":9}';
      (mockStore as any).pendingContextRefs = [
        {
          resourceId: 'res_1234567890',
          hash: 'a'.repeat(64),
          typeId: 'skill_instruction',
          isSticky: true,
          skillId: 'cached-skill',
        },
        {
          resourceId: 'res_abcdefghij',
          hash: 'b'.repeat(64),
          typeId: 'file',
        },
      ];

      await adapter.saveSession();

      // 验证调用了带有 sessionState 参数的 chat_v2_save_session
      expect(invoke).toHaveBeenCalledWith('chat_v2_save_session', {
        sessionId: 'test-session-id',
        sessionState: expect.objectContaining({
          sessionId: 'test-session-id',
          chatParams: expect.objectContaining({
            modelId: 'test-model',
            temperature: 0.7,
          }),
          features: { rag: true, webSearch: false },
          modeState: null,
          inputValue: null,
          panelStates: expect.objectContaining({
            rag: false,
            mcp: false,
          }),
          pendingContextRefsJson: JSON.stringify([
            {
              resourceId: 'res_abcdefghij',
              hash: 'b'.repeat(64),
              typeId: 'file',
            },
          ]),
          loadedSkillIdsJson: null,
          activeSkillIdsJson: null,
          skillStateJson: '{"manualPinnedSkillIds":["cached-skill"],"version":9}',
          updatedAt: expect.any(String),
        }),
      });
    });

    it('should restore original replay runtime from variant snapshot first', async () => {
      await adapter.setup();

      (mockStore.messageMap as Map<string, unknown>).set('msg-replay-1', {
        id: 'msg-replay-1',
        _meta: {
          skillRuntimeAfter: {
            activeSkillIds: ['message-skill'],
            skillAllowedTools: ['server-b::fetch'],
            mcpToolSchemas: [{ name: 'fetch', serverId: 'server-b', description: 'b', inputSchema: { type: 'object' } }],
            selectedMcpServers: ['server-b'],
          },
        },
        activeVariantId: 'var-a',
        variants: [
          {
            id: 'var-a',
            meta: {
              skillRuntimeAfter: {
                activeSkillIds: ['variant-skill'],
                skillAllowedTools: ['server-a::fetch'],
                mcpToolSchemas: [{ name: 'fetch', serverId: 'server-a', description: 'a', inputSchema: { type: 'object' } }],
                selectedMcpServers: ['server-a'],
              },
            },
          },
        ],
      });

      const options = (adapter as any).applyOriginalReplaySkillState(
        'msg-replay-1',
        { replayMode: 'original' },
        ['fallback-server'],
        'var-a',
      );

      expect(options.activeSkillIds).toEqual(['variant-skill']);
      // ★ 执行白名单快照恢复已收归后端（send_message.rs 从 runtime snapshot 恢复
      // execution_allowed_tools，含 Rust 单测），前端回放不再设置 skillAllowedTools
      expect(options.skillAllowedTools).toBeUndefined();
      expect(options.mcpTools).toEqual(['server-a']);
      expect(options.mcpToolSchemas).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'fetch', serverId: 'server-a' }),
        ]),
      );
    });

    it('should leave caller skillAllowedTools untouched when replaying runtime snapshot (policy is backend-only)', async () => {
      await adapter.setup();

      (mockStore.messageMap as Map<string, unknown>).set('msg-replay-empty-policy', {
        id: 'msg-replay-empty-policy',
        _meta: {
          skillRuntimeAfter: {
            activeSkillIds: ['instruction-only-skill'],
            skillAllowedTools: [],
          },
        },
      });

      const options = (adapter as any).applyOriginalReplaySkillState(
        'msg-replay-empty-policy',
        {
          replayMode: 'original',
          skillAllowedTools: ['current-tool'],
        },
        [],
      );

      expect(options.activeSkillIds).toEqual(['instruction-only-skill']);
      // 空策略的保留/恢复由后端 send_message.rs 负责
      // （test_apply_original_skill_snapshot_overrides_preserves_explicit_empty_execution_allowed_tools），
      // 前端仅透传调用方字段
      expect(options.skillAllowedTools).toEqual(['current-tool']);
    });

    it('should not merge legacy effective tools into caller skillAllowedTools during replay', async () => {
      await adapter.setup();

      (mockStore.messageMap as Map<string, unknown>).set('msg-replay-empty-policy-with-legacy', {
        id: 'msg-replay-empty-policy-with-legacy',
        _meta: {
          skillRuntimeAfter: {
            activeSkillIds: ['instruction-only-skill'],
            skillAllowedTools: [],
          },
          skillSnapshotAfter: {
            manualPinnedSkillIds: ['legacy-skill'],
            effectiveAllowedInternalTools: ['builtin-legacy_tool'],
            effectiveAllowedExternalTools: ['server-a::legacy_tool'],
          },
        },
      });

      const options = (adapter as any).applyOriginalReplaySkillState(
        'msg-replay-empty-policy-with-legacy',
        {
          replayMode: 'original',
          skillAllowedTools: ['current-tool'],
        },
        [],
      );

      // 旧快照的 effectiveAllowed* 不得混入前端字段；执行约束由后端策略推导
      expect(options.skillAllowedTools).toEqual(['current-tool']);
    });

    it('should not invent an empty skillAllowedTools policy from legacy replay skill snapshot', async () => {
      await adapter.setup();

      (mockStore.messageMap as Map<string, unknown>).set('msg-replay-legacy-policy', {
        id: 'msg-replay-legacy-policy',
        _meta: {
          skillSnapshotAfter: {
            manualPinnedSkillIds: ['legacy-skill'],
            effectiveAllowedInternalTools: [],
            effectiveAllowedExternalTools: [],
          },
        },
      });

      const options = (adapter as any).applyOriginalReplaySkillState(
        'msg-replay-legacy-policy',
        {
          replayMode: 'original',
          skillAllowedTools: ['current-tool'],
        },
        [],
      );

      expect(options.activeSkillIds).toEqual(['legacy-skill']);
      expect(options.skillAllowedTools).toEqual(['current-tool']);
    });

    it('should use current skill environment for retry(current)', async () => {
      await adapter.setup();

      (adapter as any).ensureModelMetadataReady = vi.fn().mockResolvedValue(undefined);
      (adapter as any).buildSendOptions = vi.fn(() => ({
        replayMode: 'current',
        activeSkillIds: ['current-skill'],
        modelId: 'test-model',
      }));
      (adapter as any).normalizeChatModelSelection = vi.fn().mockResolvedValue({
        modelId: 'test-model',
        model2OverrideId: undefined,
        modelDisplayName: 'Test Model',
      });
      (adapter as any).getValidChatModelIdSet = vi.fn().mockResolvedValue(new Set<string>());
      vi.mocked(invoke).mockResolvedValue({ message_id: 'msg-1' });

      (mockStore.messageMap as Map<string, unknown>).set('msg-1', {
        _meta: {
          skillRuntimeAfter: {
            activeSkillIds: ['historical-skill'],
          },
        },
      });

      await (adapter as any).executeRetry('msg-1');

      expect(invoke).toHaveBeenCalledWith(
        'chat_v2_retry_message',
        expect.objectContaining({
          options: expect.objectContaining({
            replayMode: 'current',
            activeSkillIds: ['current-skill'],
          }),
        }),
      );
    });

    it('should restore original skill environment for continue(original)', async () => {
      await adapter.setup();

      (adapter as any).ensureModelMetadataReady = vi.fn().mockResolvedValue(undefined);
      (adapter as any).buildSendOptions = vi.fn(() => ({
        replayMode: 'original',
        modelId: 'test-model',
      }));
      (adapter as any).normalizeChatModelSelection = vi.fn().mockResolvedValue({
        modelId: 'test-model',
        model2OverrideId: undefined,
        modelDisplayName: 'Test Model',
      });
      vi.mocked(invoke).mockResolvedValue('msg-continue-1');

      (mockStore.messageMap as Map<string, unknown>).set('msg-continue-1', {
        _meta: {
          skillRuntimeAfter: {
            activeSkillIds: ['original-skill'],
            selectedMcpServers: ['server-a'],
          },
        },
      });

      await adapter.continueMessage('msg-continue-1');

      expect(invoke).toHaveBeenCalledWith(
        'chat_v2_continue_message',
        expect.objectContaining({
          options: expect.objectContaining({
            replayMode: 'original',
            activeSkillIds: ['original-skill'],
            mcpTools: ['server-a'],
          }),
        }),
      );
    });

    it('should use variant snapshot for retryVariant(original)', async () => {
      await adapter.setup();

      (adapter as any).ensureModelMetadataReady = vi.fn().mockResolvedValue(undefined);
      (adapter as any).buildSendOptions = vi.fn(() => ({
        replayMode: 'original',
        modelId: 'test-model',
      }));
      (adapter as any).normalizeChatModelSelection = vi.fn().mockResolvedValue({
        modelId: 'test-model',
        model2OverrideId: undefined,
        modelDisplayName: 'Test Model',
      });
      vi.mocked(invoke).mockResolvedValue(undefined);

      (mockStore.messageMap as Map<string, unknown>).set('msg-variant-retry', {
        _meta: {
          skillRuntimeAfter: {
            activeSkillIds: ['message-skill'],
          },
        },
        variants: [
          {
            id: 'var-1',
            meta: {
              skillRuntimeAfter: {
                activeSkillIds: ['variant-skill'],
                selectedMcpServers: ['server-a'],
              },
            },
          },
        ],
      });

      await (adapter as any).executeRetryVariant('msg-variant-retry', 'var-1');

      expect(invoke).toHaveBeenCalledWith(
        'chat_v2_retry_variant',
        expect.objectContaining({
          options: expect.objectContaining({
            replayMode: 'original',
            activeSkillIds: ['variant-skill'],
            mcpTools: ['server-a'],
          }),
        }),
      );
    });

    it('should create session', async () => {
      vi.mocked(invoke).mockResolvedValue({ id: 'new-session-id' });

      const sessionId = await adapter.createSession('general_chat', 'New Chat');

      expect(invoke).toHaveBeenCalledWith('chat_v2_create_session', {
        mode: 'general_chat',
        title: 'New Chat',
        metadata: null,
      });

      expect(sessionId).toBe('new-session-id');
    });
  });

  describe('getters', () => {
    it('should return session id', () => {
      expect(adapter.id).toBe('test-session-id');
    });

    it('should return initialized state', async () => {
      expect(adapter.initialized).toBe(false);

      await adapter.setup();

      expect(adapter.initialized).toBe(true);
    });
  });

  describe('anki_generation_event routing (P1)', () => {
    let ankiEventCallback: (event: { payload: unknown }) => void;

    const seedAnkiBlock = (
      id: string,
      opts: {
        documentId?: string;
        status?: 'pending' | 'running' | 'success' | 'error';
        cards?: Array<{ id: string; front: string; back: string }>;
      } = {},
    ) => {
      const block = {
        id,
        type: 'anki_cards' as const,
        status: opts.status ?? 'running',
        messageId: 'msg-anki',
        toolOutput: {
          ...(opts.documentId ? { documentId: opts.documentId } : {}),
          cards: opts.cards ?? [],
        },
      };
      mockStore.blocks.set(id, block as any);
      return block;
    };

    beforeEach(async () => {
      vi.mocked(listen).mockImplementation(async (channel, callback) => {
        if (channel === 'anki_generation_event') {
          ankiEventCallback = callback as typeof ankiEventCallback;
        }
        return mockUnlisten;
      });

      // Make updateBlock mutate the in-memory blocks map so routing assertions can read results.
      vi.mocked(mockStore.updateBlock).mockImplementation((blockId, updates) => {
        const existing = mockStore.blocks.get(blockId);
        if (!existing) return;
        mockStore.blocks.set(blockId, {
          ...existing,
          ...updates,
          toolOutput:
            updates.toolOutput !== undefined
              ? updates.toolOutput
              : existing.toolOutput,
        } as any);
      });
      vi.mocked(mockStore.updateBlockStatus).mockImplementation((blockId, status) => {
        const existing = mockStore.blocks.get(blockId);
        if (!existing) return;
        mockStore.blocks.set(blockId, { ...existing, status } as any);
      });

      await adapter.setup();
    });

    it('drops event with documentId when no matching block (does not write any block)', () => {
      seedAnkiBlock('anki-block-active', { status: 'running' }); // no documentId — must NOT receive fallback

      ankiEventCallback({
        payload: {
          type: 'NewCard',
          data: {
            document_id: 'doc-missing',
            card: { id: 'card-1', front: 'Q', back: 'A' },
          },
        },
      });

      expect(mockStore.updateBlock).not.toHaveBeenCalled();
      const active = mockStore.blocks.get('anki-block-active') as any;
      expect(active.toolOutput.cards).toEqual([]);
      expect(active.toolOutput.documentId).toBeUndefined();
    });

    it('routes by documentId and does not cross-write between two anki blocks', () => {
      seedAnkiBlock('anki-block-a', { documentId: 'doc-a', status: 'running' });
      seedAnkiBlock('anki-block-b', { documentId: 'doc-b', status: 'running' });

      ankiEventCallback({
        payload: {
          type: 'NewCard',
          data: {
            document_id: 'doc-a',
            card: { id: 'card-a1', front: 'Qa', back: 'Aa' },
          },
        },
      });
      ankiEventCallback({
        payload: {
          type: 'NewCard',
          data: {
            documentId: 'doc-b',
            card: { id: 'card-b1', front: 'Qb', back: 'Ab' },
          },
        },
      });

      const blockA = mockStore.blocks.get('anki-block-a') as any;
      const blockB = mockStore.blocks.get('anki-block-b') as any;

      expect(blockA.toolOutput.documentId).toBe('doc-a');
      expect(blockA.toolOutput.cards).toHaveLength(1);
      expect(blockA.toolOutput.cards[0].id).toBe('card-a1');

      expect(blockB.toolOutput.documentId).toBe('doc-b');
      expect(blockB.toolOutput.cards).toHaveLength(1);
      expect(blockB.toolOutput.cards[0].id).toBe('card-b1');
    });

    it('keeps the document running when only one task completes', async () => {
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'get_document_tasks') {
          return [
            { id: 'task-done', status: 'Completed' },
            { id: 'task-running', status: 'Processing' },
          ];
        }
        return undefined;
      });
      seedAnkiBlock('anki-block-multi', { documentId: 'doc-multi', status: 'running' });

      ankiEventCallback({
        payload: {
          type: 'TaskCompleted',
          data: { document_id: 'doc-multi', task_id: 'task-done' },
        },
      });

      await vi.waitFor(() => {
        const block = mockStore.blocks.get('anki-block-multi') as any;
        expect(block.status).toBe('running');
        expect(block.toolOutput.finalStatus).toBe('generating');
        expect(block.toolOutput.workflowStatus).toBe('running');
      });
    });

    it('does not stamp foreign documentId onto an unmatched active block', () => {
      // Active block without documentId — old bug would fallback + ensureDocumentId write doc-x here
      seedAnkiBlock('anki-block-orphan', { status: 'running' });

      ankiEventCallback({
        payload: {
          type: 'TaskStatusUpdate',
          data: {
            document_id: 'doc-x',
            status: 'streaming',
          },
        },
      });

      expect(mockStore.updateBlock).not.toHaveBeenCalled();
      const orphan = mockStore.blocks.get('anki-block-orphan') as any;
      expect(orphan.toolOutput.documentId).toBeUndefined();
    });

    it('allows latest-active fallback only when event has no documentId (owner)', () => {
      seedAnkiBlock('anki-block-1', { documentId: 'doc-1', status: 'running' });
      seedAnkiBlock('anki-block-2', { status: 'running' }); // latest active without doc id

      ankiEventCallback({
        payload: {
          type: 'NewCard',
          data: {
            card: { id: 'card-fallback', front: 'Qf', back: 'Af' },
          },
        },
      });

      const block1 = mockStore.blocks.get('anki-block-1') as any;
      const block2 = mockStore.blocks.get('anki-block-2') as any;
      expect(block1.toolOutput.cards).toEqual([]);
      expect(block2.toolOutput.cards).toHaveLength(1);
      expect(block2.toolOutput.cards[0].id).toBe('card-fallback');
    });

    it('recovers a terminal error block when its retried task completes', async () => {
      let tasks: Array<Record<string, unknown>> = [
        { id: 'task-retry', status: 'Processing' },
      ];
      let cards: Array<Record<string, unknown>> = [];
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'get_document_tasks') return tasks;
        if (command === 'get_document_cards') return cards;
        return undefined;
      });
      const seeded = seedAnkiBlock('anki-block-retry', {
        documentId: 'doc-retry',
        status: 'error',
      });
      (seeded as any).error = 'generation_failed';
      (seeded.toolOutput as any).finalStatus = 'error';
      (seeded.toolOutput as any).finalError = 'generation_failed';
      (seeded.toolOutput as any).syncStatus = 'error';
      (seeded.toolOutput as any).syncError = 'generation_failed';

      ankiEventCallback({
        payload: {
          type: 'TaskStatusUpdate',
          data: { document_id: 'doc-retry', task_id: 'task-retry', status: 'Processing' },
        },
      });

      await vi.waitFor(() => {
        expect((mockStore.blocks.get('anki-block-retry') as any).status).toBe('running');
      });

      tasks = [{ id: 'task-retry', status: 'Completed' }];
      cards = [{ id: 'card-retried', front: 'Q', back: 'A', is_error_card: false }];
      ankiEventCallback({
        payload: {
          type: 'TaskCompleted',
          data: { document_id: 'doc-retry', task_id: 'task-retry' },
        },
      });

      await vi.waitFor(() => {
        const block = mockStore.blocks.get('anki-block-retry') as any;
        expect(block.status).toBe('success');
        expect(block.error).toBeUndefined();
        expect(block.toolOutput.finalStatus).toBe('completed');
        expect(block.toolOutput.syncStatus).toBe('pending');
        expect(block.toolOutput.syncError).toBeUndefined();
        expect(block.toolOutput.cards).toEqual([
          expect.objectContaining({ id: 'card-retried' }),
        ]);
      });
    });

    it('keeps a multi-task retry partial when one task completes and another still fails', async () => {
      let tasks: Array<Record<string, unknown>> = [
        { id: 'task-old', status: 'Completed' },
        { id: 'task-retry-a', status: 'Processing' },
        { id: 'task-retry-b', status: 'Processing' },
      ];
      const cards = [{ id: 'card-old', front: 'Q1', back: 'A1', is_error_card: false }];
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'get_document_tasks') return tasks;
        if (command === 'get_document_cards') return cards;
        return undefined;
      });
      const seeded = seedAnkiBlock('anki-block-partial-retry', {
        documentId: 'doc-partial-retry',
        status: 'success',
        cards: cards as any,
      });
      (seeded.toolOutput as any).finalStatus = 'completed_with_errors';

      ankiEventCallback({
        payload: {
          type: 'TaskStatusUpdate',
          data: { document_id: 'doc-partial-retry', task_id: 'task-retry-a', status: 'Processing' },
        },
      });
      await vi.waitFor(() => {
        expect((mockStore.blocks.get('anki-block-partial-retry') as any).status).toBe('running');
      });

      tasks = [
        { id: 'task-old', status: 'Completed' },
        { id: 'task-retry-a', status: 'Completed' },
        { id: 'task-retry-b', status: 'Processing' },
      ];
      ankiEventCallback({
        payload: {
          type: 'TaskCompleted',
          data: { document_id: 'doc-partial-retry', task_id: 'task-retry-a' },
        },
      });

      await vi.waitFor(() => {
        const block = mockStore.blocks.get('anki-block-partial-retry') as any;
        expect(block.status).toBe('running');
        expect(block.toolOutput.finalStatus).toBe('generating');
        expect(block.toolOutput.progress.stage).toBe('generating');
      });

      tasks = [
        { id: 'task-old', status: 'Completed' },
        { id: 'task-retry-a', status: 'Completed' },
        { id: 'task-retry-b', status: 'Failed', error_message: 'still failed' },
      ];
      ankiEventCallback({
        payload: {
          type: 'TaskCompleted',
          data: { document_id: 'doc-partial-retry', task_id: 'task-retry-a' },
        },
      });

      await vi.waitFor(() => {
        const block = mockStore.blocks.get('anki-block-partial-retry') as any;
        expect(block.status).toBe('success');
        expect(block.toolOutput.finalStatus).toBe('completed_with_errors');
        expect(block.toolOutput.progress.stage).toBe('completed_with_errors');
        expect(block.toolOutput.progress.counts).toEqual(
          expect.objectContaining({ completed: 2, failed: 1 }),
        );
        expect(block.toolOutput.finalError).toBeUndefined();
        expect(block.toolOutput.workflowStatus).toBe('completed_with_warnings');
        expect(block.toolOutput.deliveryStatus).toBe('ready');
        expect(block.toolOutput.issues).toEqual([
          expect.objectContaining({
            code: 'generation_failed',
            severity: 'warning',
            retryable: true,
            recovered: true,
          }),
        ]);
      });
    });

    it('keeps an all-failed retry as error when the document has no usable cards', async () => {
      let tasks: Array<Record<string, unknown>> = [
        { id: 'task-a', status: 'Processing' },
        { id: 'task-b', status: 'Processing' },
      ];
      const cards = [
        { id: 'card-error', front: '', back: '', is_error_card: true },
      ];
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'get_document_tasks') return tasks;
        if (command === 'get_document_cards') return cards;
        return undefined;
      });
      const seeded = seedAnkiBlock('anki-block-failed-retry', {
        documentId: 'doc-failed-retry',
        status: 'error',
      });
      (seeded.toolOutput as any).finalStatus = 'error';

      ankiEventCallback({
        payload: {
          type: 'TaskStatusUpdate',
          data: { document_id: 'doc-failed-retry', task_id: 'task-a', status: 'Processing' },
        },
      });
      await vi.waitFor(() => {
        const block = mockStore.blocks.get('anki-block-failed-retry') as any;
        expect(block.status).toBe('running');
        expect(block.toolOutput.workflowStatus).toBe('running');
        expect(block.toolOutput.generationStatus).toBe('running');
      });

      tasks = [
        { id: 'task-a', status: 'Failed', error_message: '401 API key invalid' },
        { id: 'task-b', status: 'Truncated', error_message: 'retry truncated' },
      ];
      ankiEventCallback({
        payload: {
          type: 'TaskProcessingError',
          data: { document_id: 'doc-failed-retry', task_id: 'task-a' },
        },
      });

      await vi.waitFor(() => {
        const block = mockStore.blocks.get('anki-block-failed-retry') as any;
        expect(block.status).toBe('error');
        expect(block.toolOutput.finalStatus).toBe('error');
        expect(block.toolOutput.workflowStatus).toBe('failed');
        expect(block.toolOutput.generationStatus).toBe('failed');
        expect(block.toolOutput.issues).toEqual([
          expect.objectContaining({
            code: 'provider_auth_failed',
            severity: 'error',
            retryable: false,
            recovered: false,
          }),
        ]);
        expect(block.toolOutput.progress.counts).toEqual(
          expect.objectContaining({ failed: 1, truncated: 1 }),
        );
      });
    });

    it('does not classify a late event for an ordinary completed block as retry', async () => {
      const seeded = seedAnkiBlock('anki-block-completed', {
        documentId: 'doc-completed',
        status: 'success',
      });
      (seeded.toolOutput as any).finalStatus = 'completed';
      (seeded.toolOutput as any).progress = { stage: 'completed' };

      ankiEventCallback({
        payload: {
          type: 'TaskCompleted',
          data: { document_id: 'doc-completed', task_id: 'task-completed' },
        },
      });

      expect(invoke).not.toHaveBeenCalledWith('get_document_tasks', {
        documentId: 'doc-completed',
      });
      expect((mockStore.blocks.get('anki-block-completed') as any).status).toBe('success');
    });

    it('uses the SQLite card snapshot while preserving a real sync error', async () => {
      const tasks = [
        { id: 'task-completed', status: 'Completed' },
        { id: 'task-failed', status: 'Failed', error_message: 'generation failed' },
      ];
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'get_document_tasks') return tasks;
        if (command === 'get_document_cards') {
          return [{ id: 'card-edited', front: 'backend front', back: 'backend back', is_error_card: false }];
        }
        return undefined;
      });
      const seeded = seedAnkiBlock('anki-block-edited-partial', {
        documentId: 'doc-edited-partial',
        status: 'success',
        cards: [{ id: 'card-edited', front: 'user front', back: 'user back' }],
      });
      (seeded.toolOutput as any).finalStatus = 'completed_with_errors';
      (seeded.toolOutput as any).syncStatus = 'error';
      (seeded.toolOutput as any).syncError = 'anki-connect-down';

      ankiEventCallback({
        payload: {
          type: 'TaskProcessingError',
          data: { document_id: 'doc-edited-partial', task_id: 'task-failed' },
        },
      });

      await vi.waitFor(() => {
        const block = mockStore.blocks.get('anki-block-edited-partial') as any;
        expect(block.toolOutput.cards).toEqual([
          expect.objectContaining({ id: 'card-edited', front: 'backend front', back: 'backend back' }),
        ]);
        expect(block.toolOutput.syncStatus).toBe('error');
        expect(block.toolOutput.syncError).toBe('anki-connect-down');
        expect(block.toolOutput.finalStatus).toBe('completed_with_errors');
      });
    });
  });
});
