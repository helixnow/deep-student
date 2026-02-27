/**
 * Chat V2 - InputBar Hook
 *
 * 从 V2 Store 订阅状态并封装 Actions。
 * 遵循 SSOT 原则：UI 只订阅 Store，不直接修改状态。
 */

import { useCallback, useMemo, useRef } from 'react';
import { useStore, type StoreApi } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { ChatStore } from '../../core/types/store';
import type { AttachmentMeta, PanelStates, PdfProcessingStatus } from '../../core/types/common';
import type { UseInputBarV2Return } from './types';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import i18n from 'i18next';
import type { ModelInfo } from '../../utils/parseModelMentions';
import { isMultiModelSelectEnabled } from '@/config/featureFlags';
import { usePdfProcessingStore } from '@/stores/pdfProcessingStore';
import { isModelMultimodalAsync } from '@/chat-v2/hooks/useAvailableModels';
import {
  areAttachmentInjectModesReady,
  downgradeInjectModesForNonMultimodal,
  getMissingInjectModesForAttachment,
  hasAnySelectedInjectModeReady,
} from './injectModeUtils';
import { resolveChatReadiness, triggerOpenSettingsModels } from '@/chat-v2/readiness/readinessGate';
// ============================================================================
// InputBar 选项
// ============================================================================

export interface UseInputBarV2Options {
  /** 可用模型列表（用于 @模型 解析，多变体支持） */
  availableModels?: ModelInfo[];
  /** 获取已选中的模型（chips）- 发送前调用 */
  getSelectedModels?: () => ModelInfo[];
  /** 清空已选中的模型 - 发送成功后调用 */
  clearSelectedModels?: () => void;
  /** ★ 构建 PDF 页码引用标签字符串（如 [PDF@sourceId:1][PDF@sourceId:3]） */
  buildPdfRefTags?: () => string;
  /** ★ 清除 PDF 页码选择（发送成功后调用） */
  clearPdfPageRefs?: () => void;
}

/**
 * useInputBarV2 - V2 输入栏 Hook
 *
 * 细粒度订阅 Store 状态，封装 Actions。
 *
 * @param store - V2 Store 引用
 * @param options - 可选配置（教材页面注入等）
 * @returns 状态和 Actions
 */
export function useInputBarV2(
  store: StoreApi<ChatStore>,
  options?: UseInputBarV2Options
): UseInputBarV2Return {
  // 使用 ref 保持回调的最新引用，避免闭包陈旧问题
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // 🔧 订阅合并：使用单个聚合选择器 + shallow 比较
  const {
    inputValue,
    attachments,
    panelStates,
    sessionStatus,
  } = useStore(
    store,
    useShallow((s) => ({
      inputValue: s.inputValue,
      attachments: s.attachments,
      panelStates: s.panelStates,
      sessionStatus: s.sessionStatus,
    }))
  );

  // ========== 派生状态 ==========

  // 是否正在流式生成
  const isStreaming = sessionStatus === 'streaming';

  // 是否可以发送：idle 状态下可发送
  const canSend = sessionStatus === 'idle';

  // 是否可以中断：streaming 状态下可中断
  const canAbort = sessionStatus === 'streaming';

  // ========== 封装 Actions ==========

  // 设置输入内容
  const setInputValue = useCallback(
    (value: string) => {
      store.getState().setInputValue(value);
    },
    [store]
  );

  // 发送消息
  const sendMessage = useCallback(async () => {
    // 🆕 维护模式检查：阻止发送消息
    if (useSystemStatusStore.getState().maintenanceMode) {
      showGlobalNotification('warning', i18n.t('common:maintenance.blocked_chat_send', '维护模式下无法发送消息，请稍后再试。'));
      return;
    }

    const state = store.getState();

    // 守卫检查
    if (!state.canSend()) {
      console.warn('[useInputBarV2] Cannot send: guard check failed');
      return;
    }

    const rawContent = state.inputValue.trim();

    const readiness = await resolveChatReadiness();
    if (!readiness.ok) {
      showGlobalNotification('warning', readiness.message || i18n.t('chatV2:readiness.not_ready', '当前会话尚未就绪'));
      if (readiness.cta === 'OPEN_SETTINGS_MODELS') {
        triggerOpenSettingsModels();
      }
      return;
    }

    const currentAttachments = state.attachments;
    let effectiveAttachments = currentAttachments;
    
    // ========== 多变体支持（chips 模式） ==========
    const content = rawContent; // 输入内容已是纯文本（不含 @模型）
    const opts = optionsRef.current;
    
    // 🔧 Feature Flag：检查多模型选择是否启用
    const multiModelSelectEnabled = isMultiModelSelectEnabled();
    const selectedModels = opts?.getSelectedModels ? opts.getSelectedModels() : undefined;
    
    // 🔧 Chip 模式：从 getSelectedModels 获取选中的模型
    // 🚩 当 enableMultiModelSelect 为 false 时，仍允许单模型覆盖，但不触发 parallel
    if (opts?.getSelectedModels) {
      // 🔧 调试日志
      if ((window as any).__multiVariantDebug?.log) {
        (window as any).__multiVariantDebug.log('hook', 'getSelectedModels', {
          count: selectedModels?.length ?? 0,
          modelIds: selectedModels?.map(m => m.id) ?? [],
          featureFlagEnabled: multiModelSelectEnabled,
        });
      }

      if (selectedModels && selectedModels.length >= 2 && multiModelSelectEnabled) {
        // 🔧 多变体模式：选择 >= 2 个模型
        // 使用 id 字段（API 配置数据库 ID）因为后端需要它来查找模型配置
        // 后端会从配置中提取真正的模型名称传递给前端用于 UI 显示
        const modelIds = selectedModels.map(m => m.id);
        console.log('[useInputBarV2] 🚀 Multi-variant mode (chips):', modelIds);
        
        // 🔧 调试日志
        if ((window as any).__multiVariantDebug?.log) {
          (window as any).__multiVariantDebug.log('hook', 'setPendingParallelModelIds', {
            modelIds,
            count: modelIds.length,
          }, 'success');
        }
        
        state.setPendingParallelModelIds(modelIds);
      } else if (selectedModels && selectedModels.length >= 1) {
        // 🔧 单模型覆盖：选择 1 个模型时，覆盖当前使用的模型
        const selectedModel = selectedModels[selectedModels.length - 1];
        const selectedModelId = selectedModel.id;
        console.log('[useInputBarV2] 🔄 Single model override:', selectedModelId);
        
        // 🔧 调试日志
        if ((window as any).__multiVariantDebug?.log) {
          (window as any).__multiVariantDebug.log('hook', 'singleModelOverride', {
            modelId: selectedModelId,
            modelName: selectedModel.name,
          }, 'info');
        }
        
        // 设置单个模型为当前使用的模型
        // modelId: API 配置 ID，用于后端调用
        // modelDisplayName: 模型标识符（如 "Qwen/Qwen3-8B"），用于前端显示
        state.setChatParams({ 
          modelId: selectedModelId,
          modelDisplayName: selectedModel.model || selectedModel.name,
        });
        state.setPendingParallelModelIds(null);
      } else {
        // 无选择，使用默认模型
        state.setPendingParallelModelIds(null);
      }
    } else {
      // 🔧 调试日志
      if ((window as any).__multiVariantDebug?.log) {
        (window as any).__multiVariantDebug.log('hook', 'noGetSelectedModels', {
          featureFlagEnabled: multiModelSelectEnabled,
          hasGetSelectedModels: !!opts?.getSelectedModels,
        }, 'warning');
      }
      // 清空（Feature Flag 关闭或无选择回调时）
      state.setPendingParallelModelIds(null);
    }
    
    const getAttachmentStatus = (attachment: AttachmentMeta): PdfProcessingStatus | undefined => {
      if (!attachment.sourceId) {
        return attachment.processingStatus;
      }
      return usePdfProcessingStore.getState().get(attachment.sourceId) || attachment.processingStatus;
    };

    const getMissingModesLabel = (attachment: AttachmentMeta, missingModes: string[]): string => {
      const isPdf = attachment.mimeType === 'application/pdf' || attachment.name.toLowerCase().endsWith('.pdf');
      const mediaTypeKey = isPdf ? 'pdf' : 'image';
      const modeLabels = missingModes.map((mode) => i18n.t(`chatV2:injectMode.${mediaTypeKey}.${mode}`, {
        defaultValue: mode,
      }));
      return modeLabels.join(i18n.t('chatV2:inputBar.modeSeparator', { defaultValue: '、' }));
    };

    // 非多模态模型下，自动将图片注入模式回退为文本/OCR，避免发送后图片被模型忽略。
    const selectedModelIds = selectedModels && selectedModels.length > 0
      ? (selectedModels.length >= 2 && multiModelSelectEnabled
          ? selectedModels.map(m => m.id)
          : [selectedModels[selectedModels.length - 1].id])
      : (state.chatParams.modelId ? [state.chatParams.modelId] : []);

    let hasNonMultimodalTarget = false;
    if (selectedModelIds.length > 0) {
      const capabilities = await Promise.all(
        selectedModelIds.map(async (id) => ({ id, isMultimodal: await isModelMultimodalAsync(id) }))
      );
      hasNonMultimodalTarget = capabilities.some(c => !c.isMultimodal);
    }

    if (hasNonMultimodalTarget) {
      let adjustedCount = 0;
      let unresolvedCount = 0;
      effectiveAttachments = currentAttachments.map((attachment) => {
        const injectModes = downgradeInjectModesForNonMultimodal(attachment);
        if (!injectModes) {
          return attachment;
        }

        const nextAttachment: AttachmentMeta = { ...attachment, injectModes };
        const status = getAttachmentStatus(attachment);
        if (!areAttachmentInjectModesReady(nextAttachment, status)) {
          unresolvedCount += 1;
          return attachment;
        }

        adjustedCount += 1;
        state.updateAttachment(attachment.id, { injectModes });
        if (attachment.resourceId) {
          state.updateContextRefInjectModes(attachment.resourceId, {
            image: injectModes.image,
            pdf: injectModes.pdf,
          });
        }
        return nextAttachment;
      });

      if (adjustedCount > 0) {
        showGlobalNotification(
          'warning',
          i18n.t('chatV2:inputBar.nonMultimodalImageFallback', {
            count: adjustedCount,
            defaultValue: '当前模型不支持图片输入，已自动切换为文本/OCR 模式。可切换到支持多模态的模型后再启用图片模式。',
          })
        );
      }

      if (unresolvedCount > 0) {
        showGlobalNotification(
          'warning',
          i18n.t('chatV2:inputBar.nonMultimodalImageFallbackUnavailable', {
            count: unresolvedCount,
            defaultValue: '当前模型不支持图片输入，且有附件尚未准备好可用的文本/OCR模式。请切换到多模态模型，或等待 OCR 完成后重试。',
          })
        );
        return;
      }
    }

    // 检查是否有附件正在上传
    const hasUploadingAttachments = effectiveAttachments.some(
      a => a.status === 'uploading' || a.status === 'pending'
    );
    if (hasUploadingAttachments) {
      console.warn('[useInputBarV2] Cannot send: attachments still uploading');
      return;
    }

    const blockingModeAttachment = effectiveAttachments.find((attachment) => {
      const isMedia = attachment.mimeType === 'application/pdf'
        || attachment.name.toLowerCase().endsWith('.pdf')
        || attachment.mimeType?.startsWith('image/');
      if (!isMedia) {
        return false;
      }
      if (attachment.status !== 'ready' && attachment.status !== 'processing') {
        return false;
      }
      const status = getAttachmentStatus(attachment);
      return !hasAnySelectedInjectModeReady(attachment, status);
    });

    if (blockingModeAttachment) {
      const status = getAttachmentStatus(blockingModeAttachment);
      const missingModes = getMissingInjectModesForAttachment(blockingModeAttachment, status);
      const missingLabel = getMissingModesLabel(blockingModeAttachment, missingModes);
      showGlobalNotification(
        'warning',
        i18n.t('chatV2:inputBar.attachmentNotReady', {
          name: blockingModeAttachment.name,
          modes: missingLabel || missingModes.join(', '),
          defaultValue: `附件未就绪：${blockingModeAttachment.name}`,
        })
      );
      return;
    }

    // 只发送 ready 状态，或 processing 但所选模式已就绪的附件。
    const readyAttachments = effectiveAttachments.filter((attachment) => {
      const isMedia = attachment.mimeType === 'application/pdf'
        || attachment.name.toLowerCase().endsWith('.pdf')
        || attachment.mimeType?.startsWith('image/');

      if (!isMedia) {
        return attachment.status === 'ready';
      }

      if (attachment.status !== 'ready' && attachment.status !== 'processing') {
        return false;
      }

      const status = getAttachmentStatus(attachment);
      return hasAnySelectedInjectModeReady(attachment, status);
    });

    // ========== PDF 页码引用注入 ==========
    // 如果用户选中了 PDF 页码，在消息末尾追加引用标签
    let finalContent = content;
    const pdfRefTags = opts?.buildPdfRefTags?.() || '';
    if (pdfRefTags) {
      finalContent = content ? `${content}\n${pdfRefTags}` : pdfRefTags;
      console.log('[useInputBarV2] 📄 Appending PDF page ref tags:', pdfRefTags);
    }

    // 合并附件
    const allAttachments = [...readyAttachments];

    // 内容检查
    if (!finalContent && allAttachments.length === 0) {
      console.warn('[useInputBarV2] Cannot send: no content');
      return;
    }

    try {
      // 调用 Store Action 发送消息
      // 注意：sendMessage 内部已经会清空 inputValue 和 attachments
      await state.sendMessage(finalContent, allAttachments);
      
      // ★ 发送成功后清除 PDF 页码选择
      if (pdfRefTags && opts?.clearPdfPageRefs) {
        console.log('[useInputBarV2] 📄 PDF page refs consumed, clearing selection');
        opts.clearPdfPageRefs();
      }

      // 🔧 发送成功后清空模型 chips
      if (opts?.clearSelectedModels) {
        console.log('[useInputBarV2] 🏷️ Clearing model chips');
        opts.clearSelectedModels();
      }
    } catch (error: unknown) {
      console.error('[useInputBarV2] Send message failed:', error);
      throw error;
    }
  }, [store]);

  // 中断流式
  const abortStream = useCallback(async () => {
    const state = store.getState();

    // 守卫检查
    if (!state.canAbort()) {
      console.warn('[useInputBarV2] Cannot abort: guard check failed');
      return;
    }

    try {
      await state.abortStream();
    } catch (error: unknown) {
      console.error('[useInputBarV2] Abort stream failed:', error);
      throw error;
    }
  }, [store]);

  // 添加附件
  const addAttachment = useCallback(
    (attachment: AttachmentMeta) => {
      store.getState().addAttachment(attachment);
    },
    [store]
  );

  // 更新附件（原地更新，避免闪烁）
  // ★ 如果更新包含 injectModes，同时更新对应的 ContextRef
  // ★ 如果更新包含 resourceId（上传完成），同步附件的 injectModes 到 ContextRef
  const updateAttachment = useCallback(
    (attachmentId: string, updates: Partial<AttachmentMeta>) => {
      const state = store.getState();
      state.updateAttachment(attachmentId, updates);
      
      // ★ 如果更新包含 injectModes，同时更新对应的 ContextRef
      if (updates.injectModes !== undefined) {
        // 找到对应的附件以获取 resourceId
        const attachment = state.attachments.find(a => a.id === attachmentId);
        if (attachment?.resourceId) {
          // 将 AttachmentInjectModes 转换为 ResourceInjectModes
          const resourceInjectModes = updates.injectModes ? {
            image: updates.injectModes.image,
            pdf: updates.injectModes.pdf,
          } : undefined;
          state.updateContextRefInjectModes(attachment.resourceId, resourceInjectModes);
        }
      }
      
      // ★ 如果更新包含 resourceId（上传完成），同步附件的 injectModes 到 ContextRef
      // 这处理了用户在上传完成前修改 injectModes 的情况
      if (updates.resourceId !== undefined) {
        // 获取更新后的附件状态
        const updatedState = store.getState();
        const updatedAttachment = updatedState.attachments.find(a => a.id === attachmentId);
        if (updatedAttachment?.injectModes) {
          const resourceInjectModes = {
            image: updatedAttachment.injectModes.image,
            pdf: updatedAttachment.injectModes.pdf,
          };
          updatedState.updateContextRefInjectModes(updates.resourceId, resourceInjectModes);
        }
      }
    },
    [store]
  );

  // 移除附件
  const removeAttachment = useCallback(
    (attachmentId: string) => {
      store.getState().removeAttachment(attachmentId);
    },
    [store]
  );

  // 清空附件
  const clearAttachments = useCallback(() => {
    store.getState().clearAttachments();
  }, [store]);

  // 设置面板状态
  const setPanelState = useCallback(
    (panel: keyof PanelStates, open: boolean) => {
      store.getState().setPanelState(panel, open);
    },
    [store]
  );

  // 完成流式（正常结束时由外部调用，如 eventBridge）
  const completeStream = useCallback(() => {
    store.getState().completeStream();
  }, [store]);

  // ========== 返回 ==========

  return useMemo(
    () => ({
      // 状态
      inputValue,
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
      completeStream,
    }),
    [
      inputValue,
      canSend,
      canAbort,
      isStreaming,
      attachments,
      panelStates,
      setInputValue,
      sendMessage,
      abortStream,
      addAttachment,
      updateAttachment,
      removeAttachment,
      clearAttachments,
      setPanelState,
      completeStream,
    ]
  );
}

/**
 * 创建面板互斥关闭函数
 *
 * 打开一个面板时关闭其他面板
 */
export function useTogglePanelExclusive(
  store: StoreApi<ChatStore>,
  currentPanel: keyof PanelStates
) {
  return useCallback(
    (open: boolean) => {
      const state = store.getState();

      if (open) {
        // 关闭其他所有面板
        const panels: (keyof PanelStates)[] = [
          'rag',
          'mcp',
          'search',
          'learn',
          'model',
          'advanced',
          'attachment',
        ];
        panels.forEach((panel) => {
          if (panel !== currentPanel && state.panelStates[panel]) {
            state.setPanelState(panel, false);
          }
        });
      }

      // 设置当前面板状态
      state.setPanelState(currentPanel, open);
    },
    [store, currentPanel]
  );
}
