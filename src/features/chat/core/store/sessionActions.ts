import i18n from 'i18next';
import type { AttachmentMeta } from '../types/message';
import type { ContextRef } from '../../resources/types';
import type { EditMessageResult, RetryMessageResult, BranchSessionResult } from '../../adapters/types';
import { invoke } from '@tauri-apps/api/core';
import type { AuthorityMode, ChatStore, BlockingInteraction, PermissionPreset } from '../types';
import { COMPOSER_PANEL_KEYS, type ChatParams, type PanelStates } from '../types/common';
import type { ChatStoreState, SetState, GetState } from './types';
import { createDefaultChatParams, createDefaultPanelStates } from './types';
import { getErrorMessage } from '@/utils/errorUtils';
import { logAttachment } from '../../debug/chatV2Logger';
import { modeRegistry } from '../../registry';
import { usePdfProcessingStore } from '@/features/pdf/stores/pdfProcessingStore';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { eventRegistry, type EventHandler } from '../../registry/eventRegistry';
import { revokeAttachmentBlobUrls } from './attachmentBlobUtils';
import { resetTransientRuntimes } from './transientRuntimeRegistry';
import { isStoreSubagentSession } from '../subagentSession';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

let planGateHandlerRegistered = false;

function ensurePlanGateEventHandlerRegistered(): void {
  if (planGateHandlerRegistered) return;
  planGateHandlerRegistered = true;

  const planGateEventHandler: EventHandler = {
    onStart: (store: ChatStore, _messageId: string, payload: Record<string, unknown>): string => {
      const planId = String(payload.planId ?? '');
      const toolCallId = String(payload.toolCallId ?? '');
      store.handlePlanGateRequest({
        planId,
        toolCallId,
        toolName: String(payload.toolName ?? ''),
        summary: String(payload.summary ?? ''),
        timeoutSeconds: Number(payload.timeoutSeconds ?? 60) || 60,
        arguments: (payload.arguments as Record<string, unknown> | undefined) ?? {},
      });
      return `plan_gate_${toolCallId || planId}`;
    },
    onEnd: (store: ChatStore): void => {
      store.clearPlanGate();
    },
    onError: (store: ChatStore): void => {
      store.clearPlanGate();
    },
  };

  eventRegistry.register('plan_gate', planGateEventHandler);
}

/**
 * 🔧 阻塞交互双轨收敛（SSOT）：
 * `pendingBlockingInteraction` 是唯一事实源；旧字段 `pendingApprovalRequest`
 * 保留仅为兼容仍在读取它的外部消费方（如 workbench agentManifest）。
 * 所有阻塞交互写入都必须经由本 helper，保证旧字段是新字段的严格派生镜像：
 * - tool_approval 交互 → 镜像为旧字段形状（剥离 kind / runtimeScope）
 * - 其他交互或 null → 旧字段为 null
 * 禁止在其他位置单独写 pendingApprovalRequest。
 */
function blockingInteractionPatch(interaction: BlockingInteraction | null): {
  pendingBlockingInteraction: BlockingInteraction | null;
  pendingApprovalRequest: ChatStore['pendingApprovalRequest'];
} {
  if (interaction && interaction.kind === 'tool_approval') {
    const { kind: _kind, runtimeScope: _runtimeScope, ...legacy } = interaction;
    void _kind;
    void _runtimeScope;
    return { pendingBlockingInteraction: interaction, pendingApprovalRequest: legacy };
  }
  return { pendingBlockingInteraction: interaction, pendingApprovalRequest: null };
}

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

        setSkillStateJson: (value: string | null): void => {
          set({ skillStateJson: value });
          scheduleAutoSaveIfReady();
        },

        // ========== 功能开关 Actions ==========

        setFeature: (key: string, enabled: boolean): void => {
          set((s) => {
            const newFeatures = new Map(s.features);
            newFeatures.set(key, enabled);
            return { features: newFeatures };
          });
          scheduleAutoSaveIfReady();
        },

        toggleFeature: (key: string): void => {
          set((s) => {
            const newFeatures = new Map(s.features);
            newFeatures.set(key, !s.features.get(key));
            return { features: newFeatures };
          });
          scheduleAutoSaveIfReady();
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
          set((s) => {
            const nextPanelStates = { ...s.panelStates, [panel]: open };

            if (open) {
              COMPOSER_PANEL_KEYS.forEach((otherPanel) => {
                if (otherPanel !== panel) {
                  nextPanelStates[otherPanel] = false;
                }
              });
            }

            return { panelStates: nextPanelStates };
          });
        },

        // ========== 阻塞交互 Actions ==========

        setBlockingInteraction: (interaction: BlockingInteraction | null): void => {
          set(blockingInteractionPatch(interaction));
          if (interaction) {
            console.log('[ChatStore] setBlockingInteraction:', interaction.kind, 'toolCallId' in interaction ? interaction.toolCallId : interaction.blockId);
          }
        },

        clearBlockingInteraction: (): void => {
          set(blockingInteractionPatch(null));
          console.log('[ChatStore] clearBlockingInteraction');
        },

        // Backward-compat aliases
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
          if (!request) {
            set(blockingInteractionPatch(null));
            return;
          }
          set(blockingInteractionPatch({ kind: 'tool_approval', ...request }));
        },

        clearPendingApproval: (): void => {
          set(blockingInteractionPatch(null));
        },

        setAuthorityMode: async (mode: AuthorityMode): Promise<void> => {
          const sessionId = getState().sessionId;
          if (!sessionId) {
            console.warn('[ChatStore] setAuthorityMode: no sessionId');
            return;
          }
          await invoke('chat_v2_set_authority_mode', { sessionId, mode });
          const prevMeta = getState().sessionMetadata ?? {};
          set({
            authorityMode: mode,
            authorityAskBlockedHint: false,
            sessionMetadata: {
              ...prevMeta,
              authorityMode: mode,
              authority_mode: mode,
              ...(mode === 'plan' ? {} : { plan: undefined }),
            },
          });
        },

        setPermissionPreset: async (preset: PermissionPreset): Promise<void> => {
          const sessionId = getState().sessionId;
          if (!sessionId) return;
          await invoke('chat_v2_set_permission_preset', { sessionId, preset });
          const prevMeta = getState().sessionMetadata ?? {};
          set({
            permissionPreset: preset,
            sessionMetadata: {
              ...prevMeta,
              permissionPreset: preset,
              permission_preset: preset,
            },
          });
        },

        handlePlanGateRequest: (payload: {
          planId: string;
          toolCallId: string;
          toolName: string;
          summary: string;
          timeoutSeconds: number;
          arguments?: Record<string, unknown>;
        }): void => {
          set(blockingInteractionPatch({
            kind: 'plan_gate',
            planId: payload.planId,
            toolCallId: payload.toolCallId,
            toolName: payload.toolName,
            summary: payload.summary,
            timeoutSeconds: payload.timeoutSeconds,
            arguments: payload.arguments,
          }));
        },

        clearPlanGate: (): void => {
          const pending = getState().pendingBlockingInteraction;
          if (pending?.kind === 'plan_gate') {
            set(blockingInteractionPatch(null));
          }
        },

        setAuthorityAskBlockedHint: (show: boolean): void => {
          set({ authorityAskBlockedHint: show });
        },

        // ========== 会话 Actions ==========

        initSession: async (mode: string, initConfig?: Record<string, unknown>): Promise<void> => {
          // 🔧 P0修复：保存当前 modeState（如果外部已预设）
          const presetModeState = getState().modeState;

          ensurePlanGateEventHandlerRegistered();
          resetTransientRuntimes(getState().setPendingApproval);

          // 🔧 P1 内存泄漏修复：重置前释放未发送附件的 blob: 预览 URL
          revokeAttachmentBlobUrls(getState().attachments);

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
            authorityMode: 'craft',
            permissionPreset: 'relaxed',
            authorityAskBlockedHint: false,
            pendingBlockingInteraction: null,
            pendingApprovalRequest: null,
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

        setWakeSessionCallback: (
          callback: ((content: string, assistantMessageId: string) => Promise<void>) | null
        ): void => {
          set({ _wakeSessionCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] WakeSession callback',
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
          if (isStoreSubagentSession(getState())) {
            console.warn('[ChatStore] continueMessage blocked for read-only subagent session:', messageId);
            return;
          }
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
          await getState().sendMessage(i18n.t('chatV2:store.continueMessage'));
        },

        // ========== 🆕 P0 分支模型：会话分支 ==========

        setBranchSessionCallback: (
          callback: ((upToMessageId: string) => Promise<BranchSessionResult>) | null
        ): void => {
          set({ _branchSessionCallback: callback } as Partial<ChatStoreState>);
          console.log(
            '[ChatStore] BranchSession callback',
            callback ? 'set' : 'cleared'
          );
        },

        /**
         * 从当前会话分支出新会话（含 upToMessageId 的历史）。
         * 优先走 TauriAdapter 注入的回调；回调未注入时直接 invoke 兜底，
         * 保证适配器尚未 setup（或测试环境）下能力仍可用。
         */
        branchSession: async (upToMessageId: string): Promise<BranchSessionResult> => {
          const state = getState() as ChatStoreState & ChatStore;
          const branchCallback = state._branchSessionCallback;

          if (branchCallback) {
            const newSession = await branchCallback(upToMessageId);
            console.log('[ChatStore] branchSession completed via callback:', newSession.id);
            return newSession;
          }

          // 兜底路径：直接调用后端命令（与 setAuthorityMode 等既有直连一致）
          const sessionId = state.sessionId;
          if (!sessionId) {
            throw new Error('[ChatStore] branchSession: no sessionId');
          }
          const newSession = await invoke<BranchSessionResult>('chat_v2_branch_session', {
            sourceSessionId: sessionId,
            upToMessageId,
          });
          console.log('[ChatStore] branchSession completed via direct invoke:', newSession.id);
          return newSession;
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

// Register plan_gate handler once when session actions module loads.
ensurePlanGateEventHandlerRegistered();
