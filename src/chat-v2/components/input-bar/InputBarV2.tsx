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
import { modeRegistry } from '../../registry';
import { MultiSelectModelPanel } from '../../plugins/chat/MultiSelectModelPanel';
import { SkillSelector } from '../../skills/components/SkillSelector';
import { reloadSkills } from '../../skills/loader';
import { useLoadedSkills } from '../../skills/hooks/useLoadedSkills';
import type { InputBarV2Props, ModelMentionState, ModelMentionActions } from './types';
import { usePdfPageRefs } from './usePdfPageRefs';
import { useDialogControl } from '@/contexts/DialogControlContext';
import { isBuiltinServer } from '@/mcp/builtinMcpServer';
import type { ModelInfo } from '../../utils/parseModelMentions';
import { isMultiModelSelectEnabled } from '@/config/featureFlags';

/**
 * InputBarV2 - V2 输入栏入口组件
 *
 * @example
 * ```tsx
 * import { InputBarV2 } from '@/chat-v2/components/input-bar';
 * import { useChatStore } from '@/chat-v2/core/store';
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
  modelRetryTarget: string | null;
  setChatParams: (params: any) => void;
}

export const InputBarV2: React.FC<InputBarV2Props> = memo(
  ({ store, placeholder, sendShortcut, leftAccessory, extraButtonsRight, className, onFilesUpload, textbookOpen, onTextbookToggle, availableModels }) => {
    // 🔧 订阅合并：使用单个聚合选择器 + shallow 比较，避免多次重渲染
    const {
      sessionId,
      mode,
      inputValue,
      enableThinking,
      modelRetryTarget,
      setChatParams,
      // ★ Skills 系统（多选模式）
      activeSkillIds,
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
        modelRetryTarget: s.modelRetryTarget,
        setChatParams: s.setChatParams,
        // ★ 2026-01 改造：Anki 工具已迁移到内置 MCP 服务器，移除 enableAnkiTools
        // ☆ Skills 系统（多选模式）
        activeSkillIds: s.activeSkillIds,
        activateSkill: s.activateSkill,
        deactivateSkill: s.deactivateSkill,
        // 🔧 P1-27: 上下文引用列表
        pendingContextRefs: s.pendingContextRefs,
        removeContextRef: s.removeContextRef,
        clearContextRefs: s.clearContextRefs,
        // 🆕 工具审批请求
        pendingApprovalRequest: s.pendingApprovalRequest,
      }))
    );

    // 🔧 从 DialogControlContext 获取 MCP 选中状态和清除方法
    const { selectedMcpServers, setSelectedMcpServers } = useDialogControl();
    
    // 🔧 计算非内置服务器的数量（只有内置服务器时不显示气泡数字）
    const nonBuiltinMcpServerCount = useMemo(() => {
      return selectedMcpServers.filter(id => !isBuiltinServer(id)).length;
    }, [selectedMcpServers]);
    
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

    // ★ 2026-01 改造：Anki 工具已迁移到内置 MCP 服务器，移除 handleToggleAnkiTools
    // Anki 工具现在始终可用，无需单独开关

    // 获取模式插件（自动合并继承链）
    const modePlugin = useMemo(() => modeRegistry.getResolved(mode), [mode]);

    // 🔧 多选模型状态（使用外部面板，不再使用 @mention 弹窗）
    const [selectedModels, setSelectedModels] = useState<ModelInfo[]>([]);

    // 使用 ref 存储 selectedModels，让回调能访问最新值
    const selectedModelsRef = useRef(selectedModels);
    selectedModelsRef.current = selectedModels;

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
      return opts;
    }, [availableModels, clearSelectedModels, buildPdfRefTags, clearPdfPageRefs]);

    // 从 Store 订阅状态和 Actions
    const {
      // 状态
      canSend,
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

    // 🔧 模型选择面板渲染函数（支持普通多选和重试模式）
    // hideHeader 参数用于移动端底部抽屉模式
    const renderModelPanel = useMemo(() => {
      // 优先使用多选面板
      if (availableModels && availableModels.length > 0) {
        return (hideHeader = false) => (
          <MultiSelectModelPanel
            selectedModels={selectedModels}
            onSelectModel={handleSelectModel}
            onDeselectModel={handleDeselectModel}
            onClose={handleCloseModelPanel}
            disabled={isStreaming}
            // 🔧 重试模式支持
            retryMessageId={modelRetryTarget}
            onRetry={handleRetryWithModels}
            hideHeader={hideHeader}
          />
        );
      }
      // 回退到模式插件的面板
      if (!modePlugin?.renderModelPanel) return undefined;
      const ModelPanel = modePlugin.renderModelPanel;
      return () => <ModelPanel store={store} onClose={handleCloseModelPanel} />;
    }, [availableModels, selectedModels, handleSelectModel, handleDeselectModel, isStreaming, modePlugin?.renderModelPanel, store, handleCloseModelPanel, modelRetryTarget, handleRetryWithModels]);

    // 高级设置面板渲染函数
    const renderAdvancedPanel = useMemo(() => {
      if (!modePlugin?.renderAdvancedPanel) return undefined;
      const AdvancedPanel = modePlugin.renderAdvancedPanel;
      return () => <AdvancedPanel store={store} onClose={() => setPanelState('advanced', false)} />;
    }, [modePlugin?.renderAdvancedPanel, store, setPanelState]);

    // MCP 工具面板渲染函数
    const renderMcpPanel = useMemo(() => {
      if (!modePlugin?.renderMcpPanel) return undefined;
      const McpPanel = modePlugin.renderMcpPanel;
      return () => <McpPanel store={store} onClose={() => setPanelState('mcp', false)} />;
    }, [modePlugin?.renderMcpPanel, store, setPanelState]);

    // ★ Skills 技能选择面板渲染函数（多选模式）
    const handleToggleSkill = useCallback(async (skillId: string) => {
      if (activeSkillIds.includes(skillId)) {
        await deactivateSkill(skillId);
      } else {
        await activateSkill(skillId);
      }
    }, [activeSkillIds, activateSkill, deactivateSkill]);

    const handleRefreshSkills = useCallback(async () => {
      await reloadSkills();
    }, []);

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
      <InputBarUI
        // 状态
        inputValue={inputValue}
        canSend={canSend}
        canAbort={canAbort}
        isStreaming={isStreaming}
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
        className={className}
        // 模式插件面板
        renderRagPanel={renderRagPanel}
        renderModelPanel={renderModelPanel}
        renderAdvancedPanel={renderAdvancedPanel}
        renderMcpPanel={renderMcpPanel}
        renderSkillPanel={renderSkillPanel}
        // 🔧 MCP 选中状态
        mcpEnabled={selectedMcpServers.length > 0}
        selectedMcpServerCount={nonBuiltinMcpServerCount}
        onClearMcpServers={handleClearMcpServers}
        // ★ Skills 系统（多选模式）
        activeSkillIds={activeSkillIds}
        hasLoadedSkills={hasLoadedSkills}
        onToggleSkill={handleToggleSkill}
        // 教材侧栏控制
        textbookOpen={textbookOpen}
        onTextbookToggle={onTextbookToggle}
        // 模型 @mention 自动完成
        modelMentionState={modelMentionState}
        modelMentionActions={modelMentionActions}
        // 推理模式
        enableThinking={enableThinking}
        onToggleThinking={handleToggleThinking}
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
    );
  }
);

InputBarV2.displayName = 'InputBarV2';

export default InputBarV2;
