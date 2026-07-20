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
import { COMPOSER_PANEL_KEYS, type AttachmentMeta, type PanelStates, type PdfProcessingStatus } from '../../core/types/common';
import { QUEUE_HARD_CAP } from '../../core/types/queue';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import i18n from 'i18next';
import type { ModelInfo } from '../../utils/parseModelMentions';
import { isMultiModelSelectEnabled } from '@/config/featureFlags';
import { usePdfProcessingStore } from '@/features/pdf/stores/pdfProcessingStore';
import {
  getMissingInjectModesForAttachment,
  getMediaTypeForAttachment,
  hasAnySelectedInjectModeReady,
  resolveExplicitInjectModes,
} from './injectModeUtils';
import { resolveChatReadiness, triggerOpenSettingsModels } from '@/features/chat/readiness/readinessGate';
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
  /** 队列是否启用（来自设置开关）。默认 false（关闭则保持原冻结行为）。 */
  queueEnabled?: boolean;
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
) {
  // 使用 ref 保持回调的最新引用，避免闭包陈旧问题
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // 发送重入保护：sendMessage 在真正落库/入队前有多个 await（readiness、模型能力查询），
  // 期间快速连按 Enter / 连点发送会并发进入，队列模式下会把同一内容重复入队
  const sendInFlightRef = useRef(false);
  // 🔧 订阅合并：使用单个聚合选择器 + shallow 比较
  const {
    inputValue,
    attachments,
    panelStates,
    sessionStatus,
    queueLength,
  } = useStore(
    store,
    useShallow((s) => ({
      inputValue: s.inputValue,
      attachments: s.attachments,
      panelStates: s.panelStates,
      sessionStatus: s.sessionStatus,
      queueLength: s.queuedMessages?.length ?? 0,
    }))
  );

  // ========== 派生状态 ==========

  // 是否正在流式生成（包含 aborting，避免“可输入但无法发送”的中间态错觉）
  const isStreaming = sessionStatus === 'streaming' || sessionStatus === 'aborting';

  // 是否可以发送：idle 状态下可发送
  const canSend = sessionStatus === 'idle';

  // 是否可以中断：streaming 状态下可中断
  const canAbort = sessionStatus === 'streaming';

  // 队列设置（来自外部）
  const queueEnabled = options?.queueEnabled ?? false;

  // 是否可提交（idle 直发 OR streaming 且队列未满）
  const canSubmit = sessionStatus === 'idle'
    || (queueEnabled && queueLength < QUEUE_HARD_CAP);

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
    if (sendInFlightRef.current) {
      return;
    }
    sendInFlightRef.current = true;
    try {
      await sendMessageInner();
    } finally {
      sendInFlightRef.current = false;
    }

    async function sendMessageInner() {
    // 🆕 维护模式检查：阻止发送消息
    if (useSystemStatusStore.getState().maintenanceMode) {
      showGlobalNotification('warning', i18n.t('common:maintenance.blocked_chat_send', '维护模式下无法发送消息，请稍后再试。'));
      return;
    }

    const state = store.getState();

    // 守卫检查
    // ★ B5 修复：所有 early-return 路径统一给出可见反馈（与注入模式守卫一致），
    // 竞态下用户点发送不再「无声失败」
    // 队列模式：sessionStatus 为 streaming 时也允许（会走 enqueue 分支）
    const willEnqueue = state.sessionStatus !== 'idle';
    if (willEnqueue) {
      // 队列守卫：必须启用且未满
      if (!queueEnabled || (state.queuedMessages?.length ?? 0) >= QUEUE_HARD_CAP) {
        console.warn('[useInputBarV2] Cannot enqueue: queue disabled or full');
        showGlobalNotification(
          'warning',
          !queueEnabled
            ? i18n.t('chatV2:inputBar.sendGuard.streaming', '正在回复中，请等待完成或点击停止')
            : i18n.t('chatV2:queue.fullTooltip', '队列已满，请稍候')
        );
        return;
      }
    } else if (!state.canSend()) {
      console.warn('[useInputBarV2] Cannot send: guard check failed');
      showGlobalNotification(
        'warning',
        i18n.t('chatV2:inputBar.sendGuard.notReady', '当前会话暂时无法发送，请稍后再试')
      );
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

    // 自动分配模型的提示通知
    if (readiness.code === 'MODEL2_AUTO_ASSIGNED' && readiness.message) {
      showGlobalNotification('info', readiness.message);
    }

    const currentAttachments = state.attachments;
    const effectiveAttachments = currentAttachments;
    
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
      const mediaTypeKey = getMediaTypeForAttachment(attachment) === 'pdf' ? 'pdf' : 'image';
      const modeLabels = missingModes.map((mode) => i18n.t(`chatV2:injectMode.${mediaTypeKey}.${mode}`, {
        defaultValue: mode,
      }));
      return modeLabels.join(i18n.t('chatV2:inputBar.modeSeparator', { defaultValue: '、' }));
    };

    // 源附件的注入选择不随 TM/MM 切换而改写。Rust context compiler 会为每个
    // 目标模型分别选择原图直读、辅助 MM 观察、OCR 或无视觉文本降级。

    // 检查是否有附件正在上传
    const hasUploadingAttachments = effectiveAttachments.some(
      a => a.status === 'uploading' || a.status === 'pending'
    );
    if (hasUploadingAttachments) {
      console.warn('[useInputBarV2] Cannot send: attachments still uploading');
      showGlobalNotification(
        'warning',
        i18n.t('chatV2:inputBar.attachmentsUploading', '附件上传中，请稍候')
      );
      return;
    }

    const blockingModeAttachment = effectiveAttachments.find((attachment) => {
      // SSOT 媒体识别：MIME OR 扩展名（含空 mime 的图片文件）
      const isMedia = getMediaTypeForAttachment(attachment) !== null;
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

    // ★ P2：error 附件不再静默剔除——发送前明确列出被排除的文件名
    const errorAttachments = effectiveAttachments.filter((a) => a.status === 'error');
    if (errorAttachments.length > 0) {
      const separator = i18n.t('chatV2:inputBar.modeSeparator', { defaultValue: '、' });
      const names = errorAttachments.map((a) => a.name).join(separator);
      showGlobalNotification(
        'warning',
        i18n.t('chatV2:inputBar.errorAttachmentsExcluded', {
          count: errorAttachments.length,
          names,
          defaultValue: `${errorAttachments.length} 个失败附件未随消息发送：${names}`,
        })
      );
    }

    // 只发送 ready 状态，或 processing 但所选模式已就绪的附件。
    const readyAttachments = effectiveAttachments.filter((attachment) => {
      const isMedia = getMediaTypeForAttachment(attachment) !== null;

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
      showGlobalNotification(
        'warning',
        i18n.t('common:messages.error.empty_input', '请输入内容')
      );
      return;
    }

    try {
      // 路由：streaming 时入队，idle 时直发
      if (willEnqueue) {
        // 入队：将当前 pending contextRefs（非 sticky）随消息一起快照入队，
        // 但保留 pendingContextRefs 不清除 —— 用户还在为后续消息组合上下文。
        const nonStickyRefs = state.pendingContextRefs.filter((r) => r.isSticky !== true);
        state.enqueueMessage(finalContent, allAttachments, nonStickyRefs);
        // 清空输入框和附件（与直发路径行为一致），但保留 pendingContextRefs
        state.setInputValue('');
        state.clearAttachments();
      } else {
        // 直发：sendMessage 内部已清空 inputValue/attachments/contextRefs（保留 sticky）
        await state.sendMessage(finalContent, allAttachments);
      }

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
    }
  }, [store, queueEnabled]);

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
  // ★ P0 契约（注入模式 SSOT）：附件与其 ContextRef 的 injectModes 必须始终一致，
  //   且 ContextRef 上永远显式携带（后端缺省逻辑不触发）。三条同步路径：
  //   1) updates.injectModes —— 用户在选择器中变更模式；
  //   2) updates.resourceId —— 上传完成建立 ContextRef 关联；
  //   3) 附件缺省 —— 兜底补写 UI 默认模式（PDF=['text'] / 图片=['image']）。
  const updateAttachment = useCallback(
    (attachmentId: string, updates: Partial<AttachmentMeta>) => {
      store.getState().updateAttachment(attachmentId, updates);

      // 统一读取更新后的最新状态（旧实现读更新前快照，附件刚创建时会漏同步）
      const state = store.getState();
      const attachment = state.attachments.find(a => a.id === attachmentId);
      if (!attachment) return;

      const modesTouched = updates.injectModes !== undefined;
      const refLinked = updates.resourceId !== undefined;
      if (!modesTouched && !refLinked) return;

      const resourceId = updates.resourceId ?? attachment.resourceId;
      if (!resourceId) return;

      // 显式解析生效模式：用户已选则用之，否则补 UI 默认（不允许 undefined 落到后端）
      const effectiveModes = resolveExplicitInjectModes(attachment);
      if (!effectiveModes) return; // 非 PDF/图片附件无注入模式概念

      // 附件本体缺省时回填，保持 SSOT 一致（避免 UI 读默认、快照读 undefined 的分裂）
      if (!attachment.injectModes) {
        state.updateAttachment(attachmentId, { injectModes: effectiveModes });
      }

      state.updateContextRefInjectModes(resourceId, {
        image: effectiveModes.image,
        pdf: effectiveModes.pdf,
      });
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
      canSubmit,
      canAbort,
      isStreaming,
      queueLength,
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
      canSubmit,
      canAbort,
      isStreaming,
      queueLength,
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
        COMPOSER_PANEL_KEYS.forEach((panel) => {
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
