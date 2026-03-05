import i18n from 'i18next';
import type { AttachmentMeta } from '../types/message';
import type { ContextRef } from '../../resources/types';
import type { EditMessageResult, RetryMessageResult } from '../../adapters/types';
import type { ChatStore } from '../types';
import type { ChatParams, PanelStates } from '../types/common';
import type { ChatStoreState, SetState, GetState } from './types';
import { createDefaultChatParams, createDefaultPanelStates } from './types';
import { getErrorMessage } from '../../../utils/errorUtils';
import { logAttachment } from '../../debug/chatV2Logger';
import { modeRegistry } from '../../registry';
import { usePdfProcessingStore } from '../../../stores/pdfProcessingStore';
import { debugLog } from '../../../debug-panel/debugMasterSwitch';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export function createSessionActions(
  set: SetState,
  getState: GetState,
  scheduleAutoSaveIfReady: () => void,
) {
  return {
        setChatParams: (params: Partial<ChatParams>): void => {
          set((s) => ({
            chatParams: { ...s.chatParams, ...params },
          }));
          scheduleAutoSaveIfReady();
        },

        resetChatParams: (): void => {
          // 🔧 R1-2: 重置时保留当前 modelId/modelDisplayName，避免 API 调用失败
          const current = getState().chatParams;
          const defaults = createDefaultChatParams();
          set({
            chatParams: {
              ...defaults,
              modelId: current.modelId,
              modelDisplayName: current.modelDisplayName,
            },
          });
          scheduleAutoSaveIfReady();
        },

        // ========== 功能开关 Actions ==========

        setFeature: (key: string, enabled: boolean): void => {
          set((s) => {
            const newFeatures = new Map(s.features);
            newFeatures.set(key, enabled);
            return { features: newFeatures };
          });
        },

        toggleFeature: (key: string): void => {
          set((s) => {
            const newFeatures = new Map(s.features);
            newFeatures.set(key, !s.features.get(key));
            return { features: newFeatures };
          });
        },

        getFeature: (key: string): boolean => {
          return getState().features.get(key) ?? false;
        },

        // ========== 模式状态 Actions ==========

        setModeState: (state: Record<string, unknown> | null): void => {
          set({ modeState: state });
        },

        updateModeState: (updates: Record<string, unknown>): void => {
          set((s) => ({
            modeState: s.modeState ? { ...s.modeState, ...updates } : updates,
          }));
        },

        // ========== 会话元信息 Actions ==========

        setTitle: (title: string): void => {
          set({ title });
          console.log('[ChatStore] Title set:', title);

          // 调用后端同步会话设置
          const updateSessionSettingsCallback = (getState() as ChatStoreState & ChatStore & {
            _updateSessionSettingsCallback?: ((settings: { title?: string }) => Promise<void>) | null
          })._updateSessionSettingsCallback;

          if (updateSessionSettingsCallback) {
            updateSessionSettingsCallback({ title }).catch((error) => {
              console.error('[ChatStore] setTitle sync failed:', getErrorMessage(error));
            });
          }
        },

        setDescription: (description: string): void => {
          set({ description });
          console.log('[ChatStore] Description set:', description);
          // 注意：description 由后端自动生成，不需要回调同步
        },

        setSummary: (title: string, description: string): void => {
          set({ title, description });
          console.log('[ChatStore] Summary set:', { title, description });
          // 注意：summary 由后端自动生成并通过事件通知，不需要回调同步
        },

        // ========== 输入框 Actions ==========

        setInputValue: (value: string): void => {
          set({ inputValue: value });
          // P2 修复：触发自动保存，防止崩溃时草稿丢失
          scheduleAutoSaveIfReady();
        },

        addAttachment: (attachment: AttachmentMeta): void => {
          set((s) => {
            // ★ Bug3 修复：按 resourceId 去重，避免从资源库重复引用时附件列表重复
            if (attachment.resourceId) {
              const exists = s.attachments.some(a => a.resourceId === attachment.resourceId);
              if (exists) {
                console.log('[ChatStore] addAttachment: 相同 resourceId 已存在（跳过）', attachment.resourceId);
                return {};
              }
            }
            return { attachments: [...s.attachments, attachment] };
          });
        },

        updateAttachment: (attachmentId: string, updates: Partial<AttachmentMeta>): void => {
          set((s) => ({
            attachments: s.attachments.map((a) =>
              a.id === attachmentId ? { ...a, ...updates } : a
            ),
          }));
        },

        removeAttachment: (attachmentId: string): void => {
          const state = getState();
          // 查找要删除的附件，获取其 resourceId
          const attachment = state.attachments.find((a) => a.id === attachmentId);

          // ★ 调试日志：记录 Store 移除操作
          logAttachment('store', 'remove_attachment', {
            attachmentId,
            sourceId: attachment?.sourceId,
            resourceId: attachment?.resourceId,
            fileName: attachment?.name,
            status: attachment?.status,
          });

          set((s) => ({
            attachments: s.attachments.filter((a) => a.id !== attachmentId),
          }));

          // 同步移除对应的 ContextRef（如果存在 resourceId）
          if (attachment?.resourceId) {
            state.removeContextRef(attachment.resourceId);
            console.log('[ChatStore] removeAttachment: Removed ContextRef for', attachment.resourceId);
            
            // ★ P0 修复：清理 pdfProcessingStore 中的状态，防止内存泄漏和状态污染
            // ★ P0 修复：使用 sourceId 作为 key（与后端事件一致）
            if (attachment.sourceId) {
              usePdfProcessingStore.getState().remove(attachment.sourceId);
              // ★ 调试日志：记录 Store 清理
              logAttachment('store', 'processing_store_cleanup', {
                sourceId: attachment.sourceId,
                attachmentId,
              });
              console.log('[ChatStore] removeAttachment: Removed pdfProcessingStore status for sourceId', attachment.sourceId);
            }
          }

          // 🔧 P1-25: 释放 Blob URL，避免内存泄漏
          if (attachment?.previewUrl?.startsWith('blob:')) {
            URL.revokeObjectURL(attachment.previewUrl);
            console.log('[ChatStore] removeAttachment: Revoked Blob URL');
          }
        },

        clearAttachments: (): void => {
          const state = getState();

          // ★ 调试日志：记录清空操作
          const attachmentCount = state.attachments.length;
          const attachmentInfo = state.attachments.map(a => ({
            id: a.id,
            sourceId: a.sourceId,
            name: a.name,
            status: a.status,
          }));
          logAttachment('store', 'clear_attachments_start', {
            count: attachmentCount,
            attachments: attachmentInfo,
          });

          // 🔧 P1-25: 释放所有 Blob URLs，避免内存泄漏
          const blobUrls = state.attachments
            .filter((a) => a.previewUrl?.startsWith('blob:'))
            .map((a) => a.previewUrl!);
          for (const url of blobUrls) {
            URL.revokeObjectURL(url);
          }
          if (blobUrls.length > 0) {
            console.log('[ChatStore] clearAttachments: Revoked', blobUrls.length, 'Blob URLs');
          }

          // 获取所有附件的 resourceId，用于清除对应的 ContextRefs
          const resourceIds = state.attachments
            .filter((a) => a.resourceId)
            .map((a) => a.resourceId!);
          
          // ★ P0 修复：获取 sourceId 用于清理 pdfProcessingStore
          const sourceIds = state.attachments
            .filter((a) => a.sourceId)
            .map((a) => a.sourceId!);

          set({ attachments: [] });

          // 同步清除对应的 ContextRefs
          for (const resourceId of resourceIds) {
            state.removeContextRef(resourceId);
          }
          if (resourceIds.length > 0) {
            console.log('[ChatStore] clearAttachments: Removed', resourceIds.length, 'ContextRefs');
          }
          
          // ★ P0 修复：使用 sourceId 清理 pdfProcessingStore（与后端事件 key 一致）
          for (const sourceId of sourceIds) {
            usePdfProcessingStore.getState().remove(sourceId);
          }
          if (sourceIds.length > 0) {
            // ★ 调试日志：记录 Store 清理
            logAttachment('store', 'processing_store_batch_cleanup', {
              sourceIds,
              count: sourceIds.length,
            });
            console.log('[ChatStore] clearAttachments: Cleared', sourceIds.length, 'pdfProcessingStore entries (sourceIds)');
          }
        },

        setPanelState: (panel: keyof PanelStates, open: boolean): void => {
          set((s) => ({
            panelStates: { ...s.panelStates, [panel]: open },
          }));
        },

        // ========== 🆕 工具审批 Actions（文档 29 P1-3） ==========

        setPendingApproval: (request: {
          toolCallId: string;
          toolName: string;
          arguments: Record<string, unknown>;
          sensitivity: 'low' | 'medium' | 'high';
          description: string;
          timeoutSeconds: number;
          resolvedStatus?: 'approved' | 'rejected' | 'timeout' | 'expired' | 'error';
          resolvedReason?: string;
        } | null): void => {
          set({ pendingApprovalRequest: request });
          if (request) {
            console.log('[ChatStore] setPendingApproval:', request.toolName, request.toolCallId);
          }
        },

        clearPendingApproval: (): void => {
          set({ pendingApprovalRequest: null });
          console.log('[ChatStore] clearPendingApproval');
        },

        // ========== 会话 Actions ==========

        initSession: async (mode: string, initConfig?: Record<string, unknown>): Promise<void> => {
          // 🔧 P0修复：保存当前 modeState（如果外部已预设）
          const presetModeState = getState().modeState;

          set({
            mode,
            sessionStatus: 'idle',
            messageMap: new Map(),
            messageOrder: [],
            blocks: new Map(),
            currentStreamingMessageId: null,
            activeBlockIds: new Set(),
            streamingVariantIds: new Set(), // 🔧 变体状态初始化
            pendingContextRefs: [], // 🆕 上下文引用初始化
            pendingContextRefsDirty: false,
            chatParams: createDefaultChatParams(),
            features: new Map(),
            // 🔧 P0修复：保留预设的 modeState，让 onInit 决定如何处理
            modeState: presetModeState,
            inputValue: '',
            attachments: [],
            panelStates: createDefaultPanelStates(),
          });

          // 调用模式插件初始化，传递 initConfig
          // 🔧 P1修复：使用 getResolved 获取合并了继承链的完整插件
          const modePlugin = modeRegistry.getResolved(mode);
          if (modePlugin?.onInit) {
            try {
              // 🔧 P0修复：传递 initConfig 给 onInit
              await modePlugin.onInit(getState(), initConfig as Record<string, unknown> | undefined);
              console.log('[ChatV2:Store] Mode plugin initialized:', mode, 'config:', initConfig);
            } catch (error) {
              console.error('[ChatV2:Store] Mode plugin init failed:', mode, error);
            }
          }
        },

        loadSession: async (_sessionId: string): Promise<void> => {
          // 🔧 严重修复：通过回调调用后端加载
          const loadCallback = (getState() as ChatStoreState & ChatStore & {
            _loadCallback?: (() => Promise<void>) | null
          })._loadCallback;

          if (loadCallback) {
            await loadCallback();
          } else {
            console.warn(
              '[ChatStore] loadSession: No load callback set. Use setLoadCallback() to inject load logic.'
            );
          }
        },

        saveSession: async (): Promise<void> => {
          const state = getState() as ChatStoreState & ChatStore & { _saveCallback?: (() => Promise<void>) | null };
          if (state._saveCallback) {
            try {
              await state._saveCallback();
              console.log('[ChatStore] saveSession completed via callback');
            } catch (error) {
              console.error('[ChatStore] saveSession failed:', error);
              throw error;
            }
          } else {
            console.warn(
              '[ChatStore] saveSession: No save callback set. Use setSaveCallback() to inject save logic.'
            );
          }
        },

        setSaveCallback: (
          callback: (() => Promise<void>) | null
        ): void => {
          // 将回调存储在状态中（使用下划线前缀表示内部字段）
          set({ _saveCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] Save callback',
            callback ? 'set' : 'cleared'
          );
        },

        setRetryCallback: (
          // 🆕 P1 状态同步修复: 回调返回 RetryMessageResult
          callback: ((messageId: string, modelOverride?: string) => Promise<RetryMessageResult>) | null
        ): void => {
          // 将重试回调存储在状态中（使用下划线前缀表示内部字段）
          set({ _retryCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] Retry callback',
            callback ? 'set' : 'cleared'
          );
        },

        setDeleteCallback: (
          callback: ((messageId: string) => Promise<void>) | null
        ): void => {
          set({ _deleteCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] Delete callback',
            callback ? 'set' : 'cleared'
          );
        },

        setEditAndResendCallback: (
          // 🆕 P1-2: 支持传递新的上下文引用（ContextRef[] 类型）
          // 🆕 P1 状态同步修复: 回调返回 EditMessageResult
          callback: ((messageId: string, newContent: string, newContextRefs?: ContextRef[]) => Promise<EditMessageResult>) | null
        ): void => {
          set({ _editAndResendCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] EditAndResend callback',
            callback ? 'set' : 'cleared'
          );
        },

        setSendCallback: (
          callback: ((
            content: string,
            attachments: AttachmentMeta[] | undefined,
            userMessageId: string,
            assistantMessageId: string
          ) => Promise<void>) | null
        ): void => {
          set({ _sendCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] Send callback',
            callback ? 'set' : 'cleared'
          );
        },

        setAbortCallback: (
          callback: (() => Promise<void>) | null
        ): void => {
          set({ _abortCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] Abort callback',
            callback ? 'set' : 'cleared'
          );
        },

        // 🔧 P0 修复：继续执行中断的消息（回调注入 + fallback）
        setContinueMessageCallback: (
          callback: ((messageId: string, variantId?: string) => Promise<void>) | null
        ): void => {
          set({ _continueMessageCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] ContinueMessage callback',
            callback ? 'set' : 'cleared'
          );
        },

        continueMessage: async (messageId: string, variantId?: string): Promise<void> => {
          const continueCallback = (getState() as ChatStoreState & ChatStore & {
            _continueMessageCallback?: ((messageId: string, variantId?: string) => Promise<void>) | null
          })._continueMessageCallback;

          if (continueCallback) {
            try {
              await continueCallback(messageId, variantId);
              console.log('[ChatStore] continueMessage succeeded (same-message continue):', messageId);
              return;
            } catch (error) {
              const errorMsg = getErrorMessage(error);
              // 🔧 竞态修复：区分"流已存在"（后端正在执行）和"无 TodoList"（可 fallback）
              // 流已存在时不应 fallback 到 sendMessage，否则会再次失败并显示混淆错误
              const isStreamConflict = errorMsg.includes('register stream') ||
                errorMsg.includes('already') ||
                getState().sessionStatus === 'streaming';
              if (isStreamConflict) {
                console.warn(
                  '[ChatStore] continueMessage failed due to active stream, NOT falling back:',
                  errorMsg
                );
                throw error;
              }
              // 非流冲突错误（如无 TodoList）：回退到 sendMessage('继续') 作为兜底
              console.warn(
                '[ChatStore] continueMessage callback failed, falling back to sendMessage:',
                errorMsg
              );
            }
          }

          // Fallback：发送"继续"消息（创建新轮次）
          await getState().sendMessage(i18n.t('chatV2:store.continueMessage', { defaultValue: 'continue' }));
        },

        setLoadCallback: (
          callback: (() => Promise<void>) | null
        ): void => {
          set({ _loadCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] Load callback',
            callback ? 'set' : 'cleared'
          );
        },

        setUpdateBlockContentCallback: (
          callback: ((blockId: string, content: string) => Promise<void>) | null
        ): void => {
          set({ _updateBlockContentCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] UpdateBlockContent callback',
            callback ? 'set' : 'cleared'
          );
        },

        setUpdateSessionSettingsCallback: (
          callback: ((settings: { title?: string }) => Promise<void>) | null
        ): void => {
          set({ _updateSessionSettingsCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] UpdateSessionSettings callback',
            callback ? 'set' : 'cleared'
          );
        },

  };
}
