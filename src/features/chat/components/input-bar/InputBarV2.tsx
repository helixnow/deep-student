/**
 * Chat V2 - InputBarV2 入口组件
 *
 * 接收 Store，调用 useInputBarV2 获取状态和 Actions，渲染 InputBarUI。
 * 遵循 SSOT 原则：所有状态从 Store 订阅。
 *
 * 模式扩展：通过 ModePlugin 注入自定义按钮和面板
 */

import React, { memo, useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { InputBarUI } from './InputBarUI';
import { useInputBarV2 } from './useInputBarV2';
import { useQueueSettings } from '../../queue/useQueueSettings';
import { QueuedMessageStack } from './QueuedMessageStack';
import { modeRegistry } from '../../registry';
import { ModelPicker, type ModelPickerMode } from './ModelPicker';
import { SkillSelector } from '../../skills/components/SkillSelector';
import { ThreadContentShell } from '../ui/ThreadContentShell';
import { reloadSkills } from '../../skills/loader';
import { useLoadedSkills } from '../../skills/hooks/useLoadedSkills';
import type { InputBarV2Props, ModelMentionState, ModelMentionActions } from './types';
import { COMPOSER_PANEL_KEYS } from '../../core/types/common';
import { QUEUE_HARD_CAP } from '../../core/types/queue';
import { usePdfPageRefs } from './usePdfPageRefs';
import { useDialogControl } from '@/contexts/DialogControlContext';
import { isBuiltinServer } from '@/mcp/builtinMcpServer';
import type { ModelInfo } from '../../utils/parseModelMentions';
import { isMultiModelSelectEnabled } from '@/config/featureFlags';
import { inferCapabilities, inferInputContextBudget } from '@/utils/modelCapabilities';
import { deriveContextWindowUsage } from './contextWindowUsage';
import {
  deepSeekV32EffortToBudget,
  normalizeDeepSeekV4Effort,
  resolveDeepSeekRuntimeReasoningControl,
  resolveDeepSeekRuntimeReasoningSelection,
  type DeepSeekReasoningControlKind,
  type DeepSeekReasoningOptionValue,
} from '@/utils/deepseekReasoningControls';

/**
 * InputBarV2 - V2 输入栏入口组件
 *
 * @example
 * ```tsx
 * import { InputBarV2 } from '@/features/chat/components/input-bar';
 * import { useChatStore } from '@/features/chat/core/store';
 *
 * function ChatView() {
 *   const store = useChatStore();
 *   return <InputBarV2 store={store} />;
 * }
 * ```
 */
/**
 * 🔧 聚合选择器返回类型
 * 合并多个 useStore 订阅为单个，使用 shallow 比较避免多次重渲染
 */
interface AggregatedStoreState {
  mode: string;
  inputValue: string;
  enableThinking: boolean;
  modelId: string;
  modelDisplayName?: string;
  model2OverrideId: string | null;
  maxTokens: number;
  contextLimit?: number;
  reasoningEffort?: string;
  thinkingBudget?: number;
  modelRetryTarget: string | null;
  setChatParams: (params: any) => void;
}

const THINKING_DEPTH_LABELS: Record<DeepSeekReasoningControlKind, Partial<Record<DeepSeekReasoningOptionValue, string>>> = {
  'openai-effort': {
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
  },
  'v4-effort': {
    high: '高',
    max: '最大',
  },
  'v32-budget-effort': {
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最高',
  },
  'toggle-only': {},
};

function getThinkingDepthLabel(kind: DeepSeekReasoningControlKind, value: DeepSeekReasoningOptionValue | undefined): string {
  if (!value) return '开启';
  return THINKING_DEPTH_LABELS[kind][value] ?? value;
}

function normalizeModelIdentity(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function matchesModelIdentity(model: ModelInfo, candidates: unknown[]): boolean {
  const normalizedCandidates = new Set(candidates.map(normalizeModelIdentity).filter(Boolean));
  if (normalizedCandidates.size === 0) return false;

  const aliases = Array.isArray(model.aliases) ? model.aliases : [];
  return [model.id, model.model, model.name, ...aliases].some((value) =>
    normalizedCandidates.has(normalizeModelIdentity(value))
  );
}

function getModelDisplayLabel(model: ModelInfo | undefined): string | undefined {
  return model?.model || model?.name || model?.id || undefined;
}

function getModelProviderLabel(model: ModelInfo | undefined): string | undefined {
  return (
    getModelStringField(model, 'vendorName') ||
    getModelStringField(model, 'providerName') ||
    getModelStringField(model, 'provider') ||
    getModelStringField(model, 'providerScope') ||
    getModelStringField(model, 'providerType')
  );
}

function getModelStringField(model: ModelInfo | undefined, key: string): string | undefined {
  const value = model?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getModelBooleanField(model: ModelInfo | undefined, key: string): boolean | undefined {
  const value = model?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function resolveModelReasoningSupport(model: ModelInfo | undefined): boolean {
  if (!model) {
    return true;
  }

  const explicitReasoning =
    getModelBooleanField(model, 'isReasoning') ??
    getModelBooleanField(model, 'supportsReasoning');
  if (typeof explicitReasoning === 'boolean') {
    return explicitReasoning;
  }

  return inferCapabilities({
    id: model.model || model.id,
    name: model.name,
    providerScope: getModelStringField(model, 'providerScope'),
  }).supportsReasoning;
}

function getManualPinnedSkillIds(
  skillStateJson: string | null | undefined,
  _fallbackActiveSkillIds: string[]
): string[] {
  if (!skillStateJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(skillStateJson) as { manualPinnedSkillIds?: unknown };
    if (Array.isArray(parsed?.manualPinnedSkillIds)) {
      return parsed.manualPinnedSkillIds.filter(
        (skillId): skillId is string => typeof skillId === 'string' && skillId.length > 0
      );
    }
  } catch {
    return [];
  }

  return [];
}

export const InputBarV2: React.FC<InputBarV2Props> = memo(
  ({ store, placeholder, sendShortcut, leftAccessory, extraButtonsRight, inputToolSlot, composerInlinePanel, className, autoFocus, onFilesUpload, textbookOpen, onTextbookToggle, availableModels }) => {
    // 🔧 订阅合并：使用单个聚合选择器 + shallow 比较，避免多次重渲染
    const {
      sessionId,
      mode,
      inputValue,
      enableThinking,
      modelId,
      modelDisplayName,
      model2OverrideId,
      maxTokens,
      contextLimit,
      reasoningEffort,
      thinkingBudget,
      lastAssistantUsage,
      modelRetryTarget,
      setChatParams,
      // ★ Skills 系统（多选模式）
      activeSkillIds,
      skillStateJson,
      activateSkill,
      deactivateSkill,
      // 🔧 P1-27: 上下文引用
      pendingContextRefs,
      removeContextRef,
      clearContextRefs,
      // 🆕 工具审批请求
      pendingApprovalRequest,
    } = useStore(
      store,
      useShallow((s) => ({
        sessionId: s.sessionId,
        mode: s.mode,
        inputValue: s.inputValue,
        enableThinking: s.chatParams.enableThinking,
        modelId: s.chatParams.modelId,
        modelDisplayName: s.chatParams.modelDisplayName,
        model2OverrideId: s.chatParams.model2OverrideId ?? null,
        maxTokens: s.chatParams.maxTokens,
        contextLimit: s.chatParams.contextLimit,
        reasoningEffort: s.chatParams.reasoningEffort,
        thinkingBudget: s.chatParams.thinkingBudget,
        lastAssistantUsage: (() => {
          const messageOrder = Array.isArray(s.messageOrder) ? s.messageOrder : [];
          const messageMap = s.messageMap instanceof Map ? s.messageMap : new Map();
          for (let i = messageOrder.length - 1; i >= 0; i -= 1) {
            const message = messageMap.get(messageOrder[i]);
            if (message?.role === 'assistant' && message._meta?.usage) {
              return message._meta.usage;
            }
          }
          return undefined;
        })(),
        modelRetryTarget: s.modelRetryTarget,
        setChatParams: s.setChatParams,
        // ★ 2026-01 改造：Anki 工具已迁移到内置 MCP 服务器，移除 enableAnkiTools
        // ☆ Skills 系统（多选模式）
        activeSkillIds: s.activeSkillIds,
        skillStateJson: s.skillStateJson,
        activateSkill: s.activateSkill,
        deactivateSkill: s.deactivateSkill,
        // 🔧 P1-27: 上下文引用列表
        pendingContextRefs: s.pendingContextRefs,
        removeContextRef: s.removeContextRef,
        clearContextRefs: s.clearContextRefs,
        // 🆕 阻塞交互请求
        pendingApprovalRequest: s.pendingBlockingInteraction,
      }))
    );

    // 🆕 队列模式设置（来自本地存储）
    const queueSettings = useQueueSettings();

    // 🔧 从 DialogControlContext 获取 MCP 选中状态、可用服务器列表和清除方法
    const { availableMcpServers, selectedMcpServers, setSelectedMcpServers } = useDialogControl();

    // 🔧 计算非内置服务器的数量（只有内置服务器时不显示气泡数字）
    const nonBuiltinMcpServerCount = useMemo(() => {
      return selectedMcpServers.filter(id => !isBuiltinServer(id)).length;
    }, [selectedMcpServers]);

    // 🔧 是否存在任何非内置 MCP 服务器（可用列表或已选列表里有都算）
    // 用途：用户从未在设置里配置任何非内置 MCP 服务器时，隐藏 chat 栏的扳手按钮，
    // 减少新用户首屏的工具栏噪音；built-in server 一直自动启用，无 UI 也不影响行为。
    const hasAnyNonBuiltinMcp = useMemo(() => {
      return (
        availableMcpServers.some(s => !isBuiltinServer(s.id)) ||
        selectedMcpServers.some(id => !isBuiltinServer(id))
      );
    }, [availableMcpServers, selectedMcpServers]);
    
    // 🔧 清除所有选中的 MCP 服务器
    const handleClearMcpServers = useCallback(() => {
      setSelectedMcpServers([]);
    }, [setSelectedMcpServers]);

    // 🔧 订阅工具调用加载的技能状态
    const { loadedSkillIds } = useLoadedSkills(sessionId);
    const hasLoadedSkills = loadedSkillIds.size > 0;

    // ★ PDF 页码引用（精准提问）
    const {
      pageRefs: pdfPageRefs,
      clearPageRefs: clearPdfPageRefs,
      removePageRef: removePdfPageRef,
      buildRefTags: buildPdfRefTags,
      hasPageRefs: hasPdfPageRefs,
    } = usePdfPageRefs();

    // 🔧 会话切换检测：用于通知子组件重置状态
    const prevSessionIdRef = useRef(sessionId);
    const [sessionSwitchKey, setSessionSwitchKey] = useState(0);
    
    React.useEffect(() => {
      if (prevSessionIdRef.current !== sessionId) {
        prevSessionIdRef.current = sessionId;
        // 会话切换时增加 key，触发子组件重置
        setSessionSwitchKey((k) => k + 1);
      }
    }, [sessionId]);

    const handleContextRefCreated = useCallback((payload: { contextRef: { resourceId: string; hash: string; typeId: string }; attachmentId: string }) => {
      const state = store.getState();
      const attachmentStillExists = state.attachments.some((attachment) => attachment.id === payload.attachmentId);
      if (!attachmentStillExists) {
        console.warn('[InputBarV2] Drop stale context ref creation after attachment removed:', payload);
        return;
      }
      state.addContextRef(payload.contextRef);
    }, [store]);

    // 切换推理模式回调（使用 store.getState 避免闭包陈旧）
    const handleToggleThinking = useCallback(() => {
      const state = store.getState();
      state.setChatParams({ enableThinking: !state.chatParams.enableThinking });
    }, [store]);

    const currentModelInfo = useMemo(
      () => availableModels?.find((model) => matchesModelIdentity(model, [modelId, modelDisplayName])),
      [availableModels, modelDisplayName, modelId]
    );

    const runtimeOverrideModelInfo = useMemo(
      () =>
        model2OverrideId
          ? availableModels?.find((model) => matchesModelIdentity(model, [model2OverrideId]))
          : undefined,
      [availableModels, model2OverrideId]
    );
    const activeRuntimeModelInfo = model2OverrideId ? runtimeOverrideModelInfo : currentModelInfo;

    const contextUsageLimitTokens = useMemo(() => {
      const inferredModelMaxOutput =
        typeof activeRuntimeModelInfo?.maxOutputTokens === 'number' && Number.isFinite(activeRuntimeModelInfo.maxOutputTokens)
          ? activeRuntimeModelInfo.maxOutputTokens
          : undefined;
      const providerScope = typeof activeRuntimeModelInfo?.providerScope === 'string'
        ? activeRuntimeModelInfo.providerScope
        : undefined;
      const configContextWindow =
        typeof activeRuntimeModelInfo?.contextWindow === 'number' && Number.isFinite(activeRuntimeModelInfo.contextWindow)
          ? activeRuntimeModelInfo.contextWindow
          : undefined;
      const effectiveModelId = model2OverrideId || modelId;
      const effectiveModelDisplayName = model2OverrideId ? undefined : modelDisplayName;

      return inferInputContextBudget({
        modelLike: {
          id: activeRuntimeModelInfo?.model ?? effectiveModelDisplayName ?? effectiveModelId,
          name: activeRuntimeModelInfo?.name ?? effectiveModelDisplayName ?? effectiveModelId,
          providerScope,
        },
        userContextLimit: contextLimit,
        maxOutputTokens: Math.max(maxTokens || 0, inferredModelMaxOutput || 0),
        configContextWindow,
      });
    }, [
      activeRuntimeModelInfo?.contextWindow,
      activeRuntimeModelInfo?.maxOutputTokens,
      activeRuntimeModelInfo?.model,
      activeRuntimeModelInfo?.name,
      activeRuntimeModelInfo?.providerScope,
      contextLimit,
      maxTokens,
      model2OverrideId,
      modelDisplayName,
      modelId,
    ]);

    const contextWindowUsage = useMemo(
      () => deriveContextWindowUsage(lastAssistantUsage, contextUsageLimitTokens),
      [contextUsageLimitTokens, lastAssistantUsage]
    );

    const thinkingControl = useMemo(
      () =>
        resolveDeepSeekRuntimeReasoningControl({
          model: activeRuntimeModelInfo?.model ?? model2OverrideId ?? modelDisplayName ?? modelId,
          modelId: activeRuntimeModelInfo?.id ?? model2OverrideId ?? modelId,
          providerType: activeRuntimeModelInfo?.providerType,
          providerScope: activeRuntimeModelInfo?.providerScope,
          baseUrl: activeRuntimeModelInfo?.baseUrl,
        }),
      [
        activeRuntimeModelInfo?.model,
        activeRuntimeModelInfo?.id,
        activeRuntimeModelInfo?.providerType,
        activeRuntimeModelInfo?.providerScope,
        activeRuntimeModelInfo?.baseUrl,
        model2OverrideId,
        modelDisplayName,
        modelId,
      ]
    );

    const runtimeModelSupportsReasoning = useMemo(
      () => resolveModelReasoningSupport(activeRuntimeModelInfo),
      [activeRuntimeModelInfo]
    );
    const effectiveEnableThinking = runtimeModelSupportsReasoning && enableThinking;
    const effectiveReasoningEffort = reasoningEffort ?? (activeRuntimeModelInfo?.reasoningEffort as string | undefined);
    const effectiveThinkingBudget = thinkingBudget ?? (activeRuntimeModelInfo?.thinkingBudget as number | undefined);
    const normalizedThinkingSelection = useMemo(
      () =>
        resolveDeepSeekRuntimeReasoningSelection({
          control: thinkingControl,
          enableThinking: effectiveEnableThinking,
          reasoningEffort: effectiveReasoningEffort,
          thinkingBudget: effectiveThinkingBudget,
        }),
      [thinkingControl, effectiveEnableThinking, effectiveReasoningEffort, effectiveThinkingBudget]
    );
    const runtimeDepthIsSet = reasoningEffort !== undefined || thinkingBudget !== undefined;

    useEffect(() => {
      if (!runtimeModelSupportsReasoning) {
        if (!enableThinking && reasoningEffort === undefined && thinkingBudget === undefined) return;

        setChatParams({
          enableThinking: false,
          reasoningEffort: undefined,
          thinkingBudget: undefined,
        });
        return;
      }

      if (!runtimeDepthIsSet && thinkingControl.kind !== 'toggle-only') return;

      const nextReasoningEffort = normalizedThinkingSelection.reasoningEffort;
      const nextThinkingBudget = normalizedThinkingSelection.thinkingBudget;
      if (reasoningEffort === nextReasoningEffort && thinkingBudget === nextThinkingBudget) return;

      setChatParams({
        enableThinking,
        reasoningEffort: nextReasoningEffort,
        thinkingBudget: nextThinkingBudget,
      });
    }, [
      enableThinking,
      normalizedThinkingSelection.reasoningEffort,
      normalizedThinkingSelection.thinkingBudget,
      reasoningEffort,
      runtimeDepthIsSet,
      runtimeModelSupportsReasoning,
      setChatParams,
      thinkingBudget,
      thinkingControl.kind,
    ]);

    const handleSetThinkingDepth = useCallback(
      (value: DeepSeekReasoningOptionValue | 'off') => {
        if (!runtimeModelSupportsReasoning) {
          store.getState().setChatParams({
            enableThinking: false,
            reasoningEffort: undefined,
            thinkingBudget: undefined,
          });
          return;
        }

        if (value === 'off') {
          store.getState().setChatParams({ enableThinking: false });
          return;
        }

        if (thinkingControl.kind === 'v4-effort') {
          store.getState().setChatParams({
            enableThinking: true,
            reasoningEffort: normalizeDeepSeekV4Effort(value),
            thinkingBudget: undefined,
          });
          return;
        }

        if (thinkingControl.kind === 'v32-budget-effort') {
          const effort = value === 'max' ? 'xhigh' : value;
          store.getState().setChatParams({
            enableThinking: true,
            reasoningEffort: effort,
            thinkingBudget: deepSeekV32EffortToBudget(effort),
          });
          return;
        }

        store.getState().setChatParams({ enableThinking: true });
      },
      [store, thinkingControl.kind, runtimeModelSupportsReasoning]
    );

    const thinkingStateLabel = useMemo(() => {
      if (!runtimeModelSupportsReasoning) return '推理: 不支持';
      if (!effectiveEnableThinking) return '推理: 关闭';
      return `推理: ${getThinkingDepthLabel(
        thinkingControl.kind,
        normalizedThinkingSelection.reasoningEffort as DeepSeekReasoningOptionValue | undefined
      )}`;
    }, [effectiveEnableThinking, normalizedThinkingSelection.reasoningEffort, runtimeModelSupportsReasoning, thinkingControl.kind]);

    // ★ 2026-01 改造：Anki 工具已迁移到内置 MCP 服务器，移除 handleToggleAnkiTools
    // Anki 工具现在始终可用，无需单独开关

    // 获取模式插件（自动合并继承链）
    const modePlugin = useMemo(() => modeRegistry.getResolved(mode), [mode]);

    // 🔧 多选模型状态（使用外部面板，不再使用 @mention 弹窗）
    const [selectedModels, setSelectedModels] = useState<ModelInfo[]>([]);
    // 🆕 ModelPicker 模式：single 替换会话模型；compare 多选并行
    const [compareMode, setCompareMode] = useState(false);

    // 使用 ref 存储 selectedModels，让回调能访问最新值
    const selectedModelsRef = useRef(selectedModels);
    selectedModelsRef.current = selectedModels;

    const runtimeModelLabel = useMemo(() => {
      return (
        getModelDisplayLabel(runtimeOverrideModelInfo) ||
        (model2OverrideId ? modelDisplayName : undefined) ||
        model2OverrideId ||
        getModelDisplayLabel(currentModelInfo) ||
        modelDisplayName ||
        modelId ||
        undefined
      );
    }, [currentModelInfo, model2OverrideId, modelDisplayName, modelId, runtimeOverrideModelInfo]);
    const runtimeModelProviderLabel = useMemo(
      () => getModelProviderLabel(activeRuntimeModelInfo),
      [activeRuntimeModelInfo]
    );
    const runtimeModelIconId = useMemo(() => {
      return (
        activeRuntimeModelInfo?.model ||
        activeRuntimeModelInfo?.name ||
        activeRuntimeModelInfo?.id ||
        runtimeModelLabel ||
        modelDisplayName ||
        model2OverrideId ||
        modelId ||
        ''
      );
    }, [
      activeRuntimeModelInfo?.id,
      activeRuntimeModelInfo?.model,
      activeRuntimeModelInfo?.name,
      model2OverrideId,
      modelDisplayName,
      modelId,
      runtimeModelLabel,
    ]);

    // 🚩 Feature Flag：关闭时仅允许单模型选中
    const multiModelSelectEnabled = isMultiModelSelectEnabled();

    // 选中模型回调
    const handleSelectModel = useCallback((model: ModelInfo) => {
      setSelectedModels(prev => {
        if (!multiModelSelectEnabled) {
          if (prev.length === 1 && prev[0].id === model.id) return prev;
          return [model];
        }
        if (prev.some(m => m.id === model.id)) return prev;
        return [...prev, model];
      });
    }, [multiModelSelectEnabled]);

    // 取消选中模型回调
    const handleDeselectModel = useCallback((modelId: string) => {
      setSelectedModels(prev => prev.filter(m => m.id !== modelId));
    }, []);

    // 清空所有选中模型
    const clearSelectedModels = useCallback(() => {
      setSelectedModels([]);
    }, []);

    // 🆕 对比模式 toggle：开启时维持 selectedModels；关闭时清空
    const handleCompareModeChange = useCallback((nextMode: ModelPickerMode) => {
      setCompareMode(nextMode === 'compare');
      if (nextMode === 'single') {
        setSelectedModels([]);
      }
    }, []);

    // 🆕 单选模式：选中即替换会话模型并关闭面板
    const handlePickSingleModel = useCallback((model: ModelInfo) => {
      setChatParams({
        model2OverrideId: model.id,
        modelDisplayName: model.model || model.name || model.id,
      });
      setSelectedModels([]);
      setCompareMode(false);
      store.getState().setPanelState('model', false);
    }, [setChatParams, store]);

    // 🆕 对比/重试模式行点击：切换选中
    const handleToggleCompareModel = useCallback((model: ModelInfo) => {
      setSelectedModels(prev => {
        const existing = prev.findIndex(m => m.id === model.id);
        if (existing >= 0) {
          return prev.filter((_, i) => i !== existing);
        }
        if (!multiModelSelectEnabled) {
          return [model];
        }
        return [...prev, model];
      });
    }, [multiModelSelectEnabled]);

    // 🔧 重试模式：使用选中的模型重试指定消息
    const handleRetryWithModels = useCallback(async (modelIds: string[]) => {
      const retryMessageId = store.getState().modelRetryTarget;
      if (!retryMessageId || modelIds.length === 0) return;

      try {
        // 与正常发送路径保持一致：多模型时走 parallelModelIds，多变体并行重试
        if (multiModelSelectEnabled && modelIds.length >= 2) {
          store.getState().setPendingParallelModelIds(modelIds);
          await store.getState().retryMessage(retryMessageId);
        } else {
          await store.getState().retryMessage(retryMessageId, modelIds[0]);
        }
      } finally {
        // 清理状态
        store.getState().setModelRetryTarget(null);
        store.getState().setPanelState('model', false);
        clearSelectedModels();
      }
    }, [store, clearSelectedModels, multiModelSelectEnabled]);

    // 🔧 面板关闭时清理重试状态
    const handleCloseModelPanel = useCallback(() => {
      // 先检查是否是重试模式，再清除状态
      const wasRetryMode = store.getState().modelRetryTarget !== null;
      store.getState().setModelRetryTarget(null);
      store.getState().setPanelState('model', false);
      // 如果是重试模式，清空选中的模型
      if (wasRetryMode) {
        clearSelectedModels();
      }
      // 关闭后重置对比模式（若未在 compare 中保留选择）
      if (selectedModelsRef.current.length === 0) {
        setCompareMode(false);
      }
    }, [store, clearSelectedModels]);

    // 构建 useInputBarV2 选项（多变体支持 + PDF 页码引用）
    const inputBarOptions = useMemo(() => {
      const opts: Parameters<typeof useInputBarV2>[1] = {};
      if (availableModels && availableModels.length > 0) opts.availableModels = availableModels;
      // 🔧 面板模式：传递获取/清空选中模型的回调
      opts.getSelectedModels = () => selectedModelsRef.current;
      opts.clearSelectedModels = clearSelectedModels;
      // ★ PDF 页码引用
      opts.buildPdfRefTags = buildPdfRefTags;
      opts.clearPdfPageRefs = clearPdfPageRefs;
      // 🆕 队列模式启用开关（控制 useInputBarV2 内部 submit 路由）
      opts.queueEnabled = queueSettings.queueEnabled;
      return opts;
    }, [availableModels, clearSelectedModels, buildPdfRefTags, clearPdfPageRefs, queueSettings.queueEnabled]);

    // 从 Store 订阅状态和 Actions
    const {
      // 状态
      canSend,
      canSubmit,
      queueLength,
      canAbort,
      isStreaming,
      attachments,
      panelStates,
      // Actions
      setInputValue,
      sendMessage,
      abortStream,
      addAttachment,
      updateAttachment,
      removeAttachment,
      clearAttachments,
      setPanelState,
    } = useInputBarV2(store, inputBarOptions);

    const handleOpenRuntimeModelPanel = useCallback((mode: 'single' | 'compare' = 'single') => {
      const currentState = store.getState();
      const isOpen = currentState.panelStates?.model === true;
      setCompareMode(mode === 'compare');

      if (isOpen) {
        currentState.setPanelState('model', false);
        return;
      }

      COMPOSER_PANEL_KEYS.forEach((panel) => {
        if (panel !== 'model') {
          currentState.setPanelState(panel, false);
        }
      });
      currentState.setPanelState('model', true);
    }, [store]);

    // 🔧 监听 model 面板关闭，自动清除 modelRetryTarget
    // 解决：点击面板外部关闭时 closeAllPanels 不会调用 handleCloseModelPanel 的问题
    useEffect(() => {
      if (!panelStates.model && modelRetryTarget) {
        store.getState().setModelRetryTarget(null);
        clearSelectedModels();
      }
    }, [panelStates.model, modelRetryTarget, store, clearSelectedModels]);

    // 🔧 构建模型状态和操作（使用外部面板，不再显示 @mention 弹窗）
    // 🚩 Feature Flag：当 enableMultiModelSelect 为 false 时，不显示多选 chips
    const modelMentionState: ModelMentionState | undefined = useMemo(() => {
      if (!availableModels || availableModels.length === 0) return undefined;
      return {
        showAutoComplete: false, // 🔧 禁用 @mention 弹窗
        query: '',
        suggestions: [],
        selectedIndex: 0,
        // 🔧 重试模式下不显示 chips（选中的模型仅在面板内显示）
        // 🚩 Feature Flag：当 enableMultiModelSelect 为 false 时，不显示 chips
        selectedModels: (!multiModelSelectEnabled || modelRetryTarget) ? [] : selectedModels,
      };
    }, [availableModels, selectedModels, modelRetryTarget, multiModelSelectEnabled]);

    const modelMentionActions: ModelMentionActions | undefined = useMemo(() => {
      if (!availableModels || availableModels.length === 0) return undefined;
      return {
        selectSuggestion: (model: ModelInfo) => {
          handleSelectModel(model);
          return inputValue; // 不修改输入值
        },
        removeSelectedModel: handleDeselectModel,
        setSelectedIndex: () => {},
        moveSelectionUp: () => {},
        moveSelectionDown: () => {},
        confirmSelection: () => null,
        closeAutoComplete: () => {},
        updateCursorPosition: () => {},
        removeLastSelectedModel: () => {
          setSelectedModels(prev => prev.slice(0, -1));
        },
      };
    }, [availableModels, handleSelectModel, handleDeselectModel, inputValue]);

    // 合并模式插件的扩展组件
    const ModeLeftAccessory = modePlugin?.renderInputBarLeft;
    const ModeRightAccessory = modePlugin?.renderInputBarRight;

    const mergedLeftAccessory = useMemo(() => (
      <>
        {leftAccessory}
        {ModeLeftAccessory && <ModeLeftAccessory store={store} />}
      </>
    ), [leftAccessory, ModeLeftAccessory, store]);

    const mergedRightAccessory = useMemo(() => (
      <>
        {ModeRightAccessory && <ModeRightAccessory store={store} />}
        {extraButtonsRight}
      </>
    ), [extraButtonsRight, ModeRightAccessory, store]);

    // RAG 面板渲染函数
    const renderRagPanel = useMemo(() => {
      if (!modePlugin?.renderRagPanel) return undefined;
      const RagPanel = modePlugin.renderRagPanel;
      return () => <RagPanel store={store} onClose={() => setPanelState('rag', false)} />;
    }, [modePlugin?.renderRagPanel, store, setPanelState]);

    // 🔧 模型选择面板渲染函数（统一 ModelPicker：单选/对比/重试）
    // hideHeader 参数用于移动端底部抽屉模式
    const renderModelPanel = useMemo(() => {
      const RuntimeModelPanel = modePlugin?.renderModelPanel;
      if (!RuntimeModelPanel && (!availableModels || availableModels.length === 0)) {
        return undefined;
      }

      return (options?: { hideHeader?: boolean; onClose?: () => void }) => {
        const hideHeader = options?.hideHeader ?? false;
        const handleClose = options?.onClose ?? handleCloseModelPanel;
        if (availableModels && availableModels.length > 0) {
          // 推导面板模式：retry 强制 compare；显式 compareMode 或已有 selectedModels 时进入 compare
          const pickerMode: ModelPickerMode =
            compareMode || selectedModels.length > 0 ? 'compare' : 'single';
          return (
            <ModelPicker
              mode={pickerMode}
              onModeChange={handleCompareModeChange}
              allowCompareToggle={multiModelSelectEnabled}
              singleSelectedId={model2OverrideId}
              compareSelected={selectedModels}
              onSelectSingle={handlePickSingleModel}
              onToggleCompare={handleToggleCompareModel}
              onClose={handleClose}
              disabled={isStreaming}
              hideHeader={hideHeader}
              retryMessageId={modelRetryTarget}
              onRetry={handleRetryWithModels}
            />
          );
        }

        if (!RuntimeModelPanel) return null;
        return <RuntimeModelPanel store={store} onClose={handleClose} />;
      };
    }, [
      availableModels,
      compareMode,
      selectedModels,
      multiModelSelectEnabled,
      model2OverrideId,
      handleCompareModeChange,
      handlePickSingleModel,
      handleToggleCompareModel,
      handleCloseModelPanel,
      handleRetryWithModels,
      isStreaming,
      modelRetryTarget,
      modePlugin?.renderModelPanel,
      store,
    ]);

    const runtimeModelOptions = useMemo(() => {
      if (!availableModels || availableModels.length === 0) return [];
      return availableModels.map((model) => ({
        id: model.id,
        label: model.model || model.name || model.id,
        providerLabel: model.vendorName,
        iconId: model.model || model.name || model.id,
      }));
    }, [availableModels]);

    const handleSelectRuntimeModel = useCallback((modelId: string) => {
      const selected = availableModels?.find((model) => model.id === modelId);
      if (!selected) return;
      handlePickSingleModel(selected);
    }, [availableModels, handlePickSingleModel]);

    // 高级设置面板渲染函数
    const renderAdvancedPanel = useMemo(() => {
      if (!modePlugin?.renderAdvancedPanel) return undefined;
      const AdvancedPanel = modePlugin.renderAdvancedPanel;
      return () => <AdvancedPanel store={store} onClose={() => setPanelState('advanced', false)} />;
    }, [modePlugin?.renderAdvancedPanel, store, setPanelState]);

    // MCP 工具面板渲染函数
    // 🔧 当用户没有配置任何非内置 MCP 服务器时，整体禁用面板（按钮 / ⌘⇧M 快捷键 /
    // 面板渲染都会因 renderMcpPanel === undefined 而自动跳过）。built-in server
    // 一直自动启用，没有 UI 也不影响调用行为。
    const renderMcpPanel = useMemo(() => {
      if (!modePlugin?.renderMcpPanel) return undefined;
      if (!hasAnyNonBuiltinMcp) return undefined;
      const McpPanel = modePlugin.renderMcpPanel;
      return () => <McpPanel store={store} onClose={() => setPanelState('mcp', false)} />;
    }, [modePlugin?.renderMcpPanel, hasAnyNonBuiltinMcp, store, setPanelState]);

    // ★ Skills 技能选择面板渲染函数（多选模式）
    const handleToggleSkill = useCallback(async (skillId: string) => {
      if (activeSkillIds.includes(skillId)) {
        await deactivateSkill(skillId);
      } else {
        await activateSkill(skillId);
      }
    }, [activeSkillIds, activateSkill, deactivateSkill]);

    const handleClearAllSkills = useCallback(async () => {
      await deactivateSkill();
    }, [deactivateSkill]);

    const handleRefreshSkills = useCallback(async () => {
      await reloadSkills();
    }, []);

    const displayActiveSkillIds = useMemo(
      () => getManualPinnedSkillIds(skillStateJson, activeSkillIds),
      [skillStateJson, activeSkillIds]
    );

    const renderSkillPanel = useMemo(() => {
      return () => (
        <SkillSelector
          activeSkillIds={activeSkillIds}
          onToggleSkill={handleToggleSkill}
          onClose={() => setPanelState('skill', false)}
          onRefresh={handleRefreshSkills}
          disabled={isStreaming}
          sessionId={sessionId}
        />
      );
    }, [activeSkillIds, handleToggleSkill, setPanelState, handleRefreshSkills, isStreaming, sessionId]);

    return (
      <>
        {/* 🆕 排队气泡的横向布局与 InputBarUI 内部容器保持一致：
            外层 px-4 / md:px-8 + 内层 mx-auto max-w-thread，
            使「引导」气泡和下方 chat 输入栏左右边对齐。 */}
        <div className="w-full px-4 md:px-8">
          <ThreadContentShell>
            <QueuedMessageStack store={store} allowSteer={queueSettings.allowSteer} />
          </ThreadContentShell>
        </div>
        <InputBarUI
        // 状态
        inputValue={inputValue}
        canSend={canSend}
        canAbort={canAbort}
        isStreaming={isStreaming}
        // 🆕 队列模式：允许流式时入队，并在队列满时禁用发送
        queueEnabled={queueSettings.queueEnabled}
        queueFull={queueLength >= QUEUE_HARD_CAP}
        canSubmit={canSubmit}
        contextWindowUsage={contextWindowUsage}
        attachments={attachments}
        panelStates={panelStates}
        // 回调
        onInputChange={setInputValue}
        onSend={sendMessage}
        onAbort={abortStream}
        onAddAttachment={addAttachment}
        onUpdateAttachment={updateAttachment}
        onRemoveAttachment={removeAttachment}
        onClearAttachments={clearAttachments}
        onFilesUpload={onFilesUpload}
        onSetPanelState={setPanelState}
        // UI 配置
        placeholder={placeholder}
        sendShortcut={sendShortcut}
        leftAccessory={mergedLeftAccessory}
        extraButtonsRight={mergedRightAccessory}
        inputToolSlot={inputToolSlot}
        composerInlinePanel={composerInlinePanel}
        className={className}
        autoFocus={autoFocus}
        // 模式插件面板
        renderRagPanel={renderRagPanel}
        renderModelPanel={renderModelPanel}
        renderAdvancedPanel={renderAdvancedPanel}
        renderMcpPanel={renderMcpPanel}
        renderSkillPanel={renderSkillPanel}
        onOpenRuntimeModelPanel={handleOpenRuntimeModelPanel}
        // 🔧 MCP 选中状态
        mcpEnabled={selectedMcpServers.length > 0}
        selectedMcpServerCount={nonBuiltinMcpServerCount}
        onClearMcpServers={handleClearMcpServers}
        // ★ Skills 系统（多选模式）
        activeSkillIds={displayActiveSkillIds}
        hasLoadedSkills={hasLoadedSkills}
        onToggleSkill={handleToggleSkill}
        onClearAllSkills={handleClearAllSkills}
        // 教材侧栏控制
        textbookOpen={textbookOpen}
        onTextbookToggle={onTextbookToggle}
        // 模型 @mention 自动完成
        modelMentionState={modelMentionState}
        modelMentionActions={modelMentionActions}
        runtimeModelLabel={runtimeModelLabel}
        runtimeModelProviderLabel={runtimeModelProviderLabel}
        runtimeModelIconId={runtimeModelIconId}
        runtimeCurrentModelId={model2OverrideId}
        runtimeModelOptions={runtimeModelOptions}
        onSelectRuntimeModel={handleSelectRuntimeModel}
        // 推理模式
        enableThinking={effectiveEnableThinking}
        thinkingStateLabel={thinkingStateLabel}
        thinkingUnsupported={!runtimeModelSupportsReasoning}
        thinkingDepthOptions={runtimeModelSupportsReasoning ? thinkingControl.options : []}
        thinkingDepthValue={runtimeModelSupportsReasoning ? normalizedThinkingSelection.reasoningEffort as DeepSeekReasoningOptionValue | undefined : undefined}
        onToggleThinking={handleToggleThinking}
        onSetThinkingDepth={handleSetThinkingDepth}
        // ★ 2026-01 改造：Anki 工具已迁移到内置 MCP 服务器，移除开关
        // 🔧 会话切换 key（用于重置内部状态）
        sessionSwitchKey={sessionSwitchKey}
        // 🔧 P1-27: 上下文引用可视化
        pendingContextRefs={pendingContextRefs}
        onRemoveContextRef={removeContextRef}
        onClearContextRefs={clearContextRefs}
        onContextRefCreated={handleContextRefCreated}
        // 🆕 工具审批请求
        pendingApprovalRequest={pendingApprovalRequest}
        sessionId={sessionId}
        // ★ PDF 页码引用
        pdfPageRefs={pdfPageRefs}
        onRemovePdfPageRef={removePdfPageRef}
        onClearPdfPageRefs={clearPdfPageRefs}
        />
      </>
    );
  }
);

InputBarV2.displayName = 'InputBarV2';

export default InputBarV2;
