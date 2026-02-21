/**
 * Chat V2 - Tauri 适配器
 *
 * 实现前端与后端的连接，处理事件监听和命令调用。
 *
 * 约束：
 * 1. setup() 必须同时监听 chat_v2_event_{id} 和 chat_v2_session_{id}
 * 2. cleanup() 必须移除所有监听器
 * 3. sendMessage 必须先更新本地状态再调用后端
 * 4. abortStream 必须同时更新本地状态和通知后端
 * 5. 所有 invoke 调用必须 try-catch 并记录错误
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import i18n from 'i18next';
import { getErrorMessage } from '../../utils/errorUtils';
import { showGlobalNotification } from '../../components/UnifiedNotification';
import type { StoreApi } from 'zustand';
import type { ChatStore, AttachmentMeta, LoadSessionResponseType } from '../core/types';
import { streamingBlockSaver } from '../core/middleware/autoSave';
import type { BackendEvent } from '../core/middleware/eventBridge';
import {
  handleBackendEventWithSequence,
  handleStreamComplete,
  handleStreamAbort,
  clearEventContext,
  resetBridgeState,
} from '../core/middleware/eventBridge';
import { logMultiVariant } from '../../debug-panel/plugins/MultiVariantDebugPlugin';
import type { AnkiCard } from '@/types';
import { autoSave } from '../core/middleware/autoSave';
import { chunkBuffer } from '../core/middleware/chunkBuffer';
import { modeRegistry } from '../registry';
// 🔧 优化：sessionManager 仅用于获取元数据，不再用于获取 Store 状态
// 构造函数现在接收 storeApi 参数，消除了循环依赖的核心问题
import { sessionManager } from '../core/session';
import { sessionSwitchPerf } from '../debug/sessionSwitchPerf';
import type {
  SendOptions,
  SendMessageRequest,
  SessionEventPayload,
  SessionSettings,
  EditMessageResult,
  RetryMessageResult,
} from './types';
import {
  buildSendContextRefs,
  buildSendContextRefsWithPaths,
  getPendingContextRefs,
  validateAndCleanupContextRefs,
  logSendContextRefsSummary,
  collectContextTypeHints,
  truncateContextByTokens,
} from './contextHelper';
import { ensureModelsCacheLoaded, getModelInfoByConfigId, isModelMultimodal, isModelMultimodalAsync } from '../hooks/useAvailableModels';
import type { ContextRef } from '../resources/types';
import { logAttachment } from '../debug/chatV2Logger';
import { collectSchemaToolIds } from '../tools/collector';
import { McpService } from '../../mcp/mcpService';
import { skillRegistry } from '../skills/registry';
import { SKILL_INSTRUCTION_TYPE_ID } from '../skills/types';
import { groupCache } from '../core/store/groupCache';
import { BUILTIN_SERVER_ID } from '../../mcp/builtinMcpServer';
import { debugLog } from '../../debug-panel/debugMasterSwitch';
import {
  LOAD_SKILLS_TOOL_SCHEMA,
  getLoadedSkills,
  getLoadedToolSchemas,
  generateAvailableSkillsPrompt,
  loadSkillsToSession,
  isSkillLoaded,
  getProgressiveDisclosureConfig,
} from '../skills/progressiveDisclosure';
// 🆕 工作区状态（用于传递 workspaceId 到后端）
import { useWorkspaceStore } from '../workspace/workspaceStore';
import { inferInputContextBudget } from '../../utils/modelCapabilities';
import {
  emitTemplateDesignerToolEvent,
  isTemplateDesignerToolName,
} from '../debug/templateDesignerDebug';
import { buildAttachmentRequestAudit } from '../debug/attachmentRequestAudit';
// 🆕 2026-02-16: 工具调用生命周期调试
import { resetRound as resetToolCallRound } from '../../debug-panel/plugins/ToolCallLifecycleDebugPlugin';

// ============================================================================
// 日志前缀
// ============================================================================

function isTauriRuntimeAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    (Boolean((window as any).__TAURI_INTERNALS__) ||
      Boolean((window as any).__TAURI_IPC__))
  );
}

const LOG_PREFIX = '[ChatV2:TauriAdapter]';
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

// ============================================================================
// 辅助函数
// ============================================================================

// 🆕 附件现在完全通过统一上下文注入系统（userContextRefs）处理
// 旧的 convertAttachmentToInput / convertAttachmentsToInputs 函数已移除

// ============================================================================
// ChatV2TauriAdapter
// ============================================================================

/**
 * Chat V2 Tauri 适配器
 *
 * 负责：
 * - 监听后端事件并分发到 Store
 * - 调用后端命令
 * - 管理事件监听器生命周期
 */
export class ChatV2TauriAdapter {
  private static nextAdapterInstanceId = 1;
  private static ankiEventOwnerAdapterId: number | null = null;

  private sessionId: string;
  private storeApi: StoreApi<ChatStore> | null = null;
  private store: ChatStore;
  private unlisteners: UnlistenFn[] = [];
  private isSetup = false;
  private readonly adapterInstanceId: number;
  
  /** 🚀 性能优化：数据恢复完成回调，在 restoreFromBackend 后立即触发 */
  public onDataRestored: (() => void) | null = null;
  
  /** 🔧 P20 修复：事件监听器就绪 Promise，确保子代理场景下监听器先于消息发送 */
  private listenersReadyPromise: Promise<void> | null = null;

  /** 🆕 P1 修复：事件监听器注册失败时的错误对象，用于诊断和重试 */
  private listenerRegistrationError: Error | null = null;

  /** 🆕 并发控制：防止 retrySetupListeners 重入 */
  private isRetryingListeners = false;
  /** ChatAnki 桥接 chunk 日志节流计数器（按 blockId） */
  private chatAnkiChunkLogCounter = new Map<string, number>();

  constructor(sessionId: string, store: ChatStore, storeApi?: StoreApi<ChatStore>) {
    this.adapterInstanceId = ChatV2TauriAdapter.nextAdapterInstanceId++;
    this.sessionId = sessionId;
    this.store = store;
    this.storeApi = storeApi ?? null;
  }

  /**
   * 🔧 安全获取当前状态
   * 
   * 优先使用 storeApi.getState() 获取最新状态，
   * 如果没有 storeApi 则回退到构造时的快照。
   * 
   * 注意：actions（方法调用）仍然可以直接使用 this.store.xxx()，
   * 因为 Zustand actions 是闭包，会正确更新状态。
   */
  private getCurrentState(): ChatStore {
    return this.storeApi?.getState() ?? this.store;
  }

  private claimAnkiEventOwnership(source: string): void {
    ChatV2TauriAdapter.ankiEventOwnerAdapterId = this.adapterInstanceId;
    try {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
        level: 'info',
        phase: 'bridge:event',
        summary: `anki_event ownership claimed by adapter#${this.adapterInstanceId} (${source})`,
        detail: { adapterId: this.adapterInstanceId, sessionId: this.sessionId, source },
      }}));
    } catch { /* debug only */ }
  }

  private releaseAnkiEventOwnershipIfHeld(source: string): void {
    if (ChatV2TauriAdapter.ankiEventOwnerAdapterId !== this.adapterInstanceId) return;
    ChatV2TauriAdapter.ankiEventOwnerAdapterId = null;
    try {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
        level: 'debug',
        phase: 'bridge:event',
        summary: `anki_event ownership released by adapter#${this.adapterInstanceId} (${source})`,
        detail: { adapterId: this.adapterInstanceId, sessionId: this.sessionId, source },
      }}));
    } catch { /* debug only */ }
  }

  /**
   * 🔧 P20 修复：等待事件监听器就绪
   * 
   * 子代理场景下必须调用此方法，确保监听器在发送消息之前就绪。
   * 正常会话不需要调用，因为用户交互天然提供了足够的等待时间。
   */
  async waitForListenersReady(): Promise<void> {
    if (this.listenersReadyPromise) {
      await this.listenersReadyPromise;
    }
  }

  /**
   * 🆕 P1 修复：检查事件监听器是否健康
   * 
   * 用于诊断事件监听状态，返回 true 表示监听器已成功注册且无错误。
   */
  isListenersHealthy(): boolean {
    return this.unlisteners.length > 0 && this.listenerRegistrationError === null;
  }

  /**
   * 🆕 P1 修复：获取监听器注册错误
   * 
   * 如果监听器注册失败，返回错误对象，否则返回 null。
   */
  getListenerRegistrationError(): Error | null {
    return this.listenerRegistrationError;
  }

  /**
   * 🆕 P1 修复：尝试重新注册事件监听器
   * 
   * 当事件监听注册失败后，可以调用此方法尝试重新注册。
   * 
   * 🔧 并发控制：使用 isRetryingListeners 标志防止重入
   * 
   * @returns 重新注册是否成功
   */
  async retrySetupListeners(): Promise<boolean> {
    // 🔧 重入检查：防止并发调用导致重复监听器注册
    if (this.isRetryingListeners) {
      console.warn(LOG_PREFIX, 'retrySetupListeners already in progress, skipping');
      return false;
    }

    this.isRetryingListeners = true;
    console.log(LOG_PREFIX, 'Retrying event listener setup...');

    try {
      // 清理旧的监听器（如果有）
      for (const unlisten of this.unlisteners) {
        try {
          unlisten();
        } catch (error) {
          console.error(LOG_PREFIX, 'Error during unlisten in retry:', getErrorMessage(error));
        }
      }
      this.unlisteners = [];
      this.listenerRegistrationError = null;

      // 重新注册监听器
      const blockEventChannel = `chat_v2_event_${this.sessionId}`;
      const sessionEventChannel = `chat_v2_session_${this.sessionId}`;

      const [blockUnlisten, sessionUnlisten, ankiUnlisten, llmReqUnlisten] = await Promise.all([
        listen<BackendEvent>(blockEventChannel, (event) => {
          this.handleBlockEvent(event.payload);
        }),
        listen<SessionEventPayload>(sessionEventChannel, (event) => {
          this.handleSessionEvent(event.payload);
        }),
        listen<unknown>('anki_generation_event', (event) => {
          this.handleAnkiGenerationEvent(event.payload);
        }),
        listen<{ streamEvent: string; model: string; url: string; requestBody: unknown }>('chat_v2_llm_request_body', (event) => {
          this.handleLlmRequestBody(event.payload);
        }),
      ]);

      this.unlisteners.push(blockUnlisten, sessionUnlisten, ankiUnlisten, llmReqUnlisten);
      this.claimAnkiEventOwnership('retrySetupListeners');
      
      console.log(LOG_PREFIX, `Retry successful: ${this.unlisteners.length} event listeners registered`);
      
      // 通知用户重试成功
      showGlobalNotification(
        'success',
        i18n.t('chatV2:success.listenerRetrySuccessMessage', '功能已恢复正常'),
        i18n.t('chatV2:success.listenerRetrySuccess', '事件监听恢复成功')
      );
      
      return true;
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'Retry setup listeners failed:', errorMsg);
      this.listenerRegistrationError = error instanceof Error ? error : new Error(errorMsg);
      
      // 通知用户重试失败
      showGlobalNotification(
        'error',
        i18n.t('chatV2:error.listenerRetryFailedMessage', '请尝试刷新页面'),
        i18n.t('chatV2:error.listenerRetryFailed', '事件监听恢复失败')
      );
      
      return false;
    } finally {
      // 🔧 确保标志在方法结束时被重置
      this.isRetryingListeners = false;
    }
  }

  // ========================================================================
  // 生命周期
  // ========================================================================

  /**
   * 初始化适配器
   * 设置事件监听器
   */
  async setup(): Promise<void> {
    if (this.isSetup) {
      console.warn(LOG_PREFIX, 'Already setup, skipping...');
      // 📊 性能打点：适配器已初始化，快速路径
      sessionSwitchPerf.mark('adapter_already_setup', { fromCache: true });
      sessionSwitchPerf.endTrace();
      return;
    }

    if (!isTauriRuntimeAvailable()) {
      console.warn(LOG_PREFIX, 'Tauri runtime not available, skip setup.');
      this.isSetup = true;
      sessionSwitchPerf.mark('adapter_setup_skipped', { reason: 'not_tauri' });
      sessionSwitchPerf.endTrace();
      return;
    }

    // 📊 性能打点：adapter_setup_start
    const alreadyLoadedBefore = this.store.isDataLoaded;
    sessionSwitchPerf.mark('adapter_setup_start', { fromCache: alreadyLoadedBefore });

    try {
      // 监听块级事件: chat_v2_event_{session_id}
      const blockEventChannel = `chat_v2_event_${this.sessionId}`;
      const sessionEventChannel = `chat_v2_session_${this.sessionId}`;
      
      // 🔧 调试打点：确认事件监听通道
      logMultiVariant('adapter', 'setup_listening', {
        sessionId: this.sessionId,
        blockEventChannel,
      }, 'info');

      // 🚀 性能优化 V2：事件监听、数据加载、回调注入三者并行
      // 检查是否需要加载数据
      const alreadyLoaded = this.getCurrentState().isDataLoaded;
      let isNewSession = false;
      let loadError: Error | null = null;
      const loadStartTs = performance.now();

      // 📊 细粒度打点：listen 开始
      sessionSwitchPerf.mark('listen_start');
      
      // 启动事件监听（不立即 await，后台注册）
      const listenPromise = Promise.all([
        listen<BackendEvent>(blockEventChannel, (event) => {
          this.handleBlockEvent(event.payload);
        }),
        listen<SessionEventPayload>(sessionEventChannel, (event) => {
          this.handleSessionEvent(event.payload);
        }),
        listen<unknown>('anki_generation_event', (event) => {
          this.handleAnkiGenerationEvent(event.payload);
        }),
        // ★ 2026-02-14: 监听后端真实 LLM 请求体，替换前端 rawRequest
        listen<{ streamEvent: string; model: string; url: string; requestBody: unknown }>('chat_v2_llm_request_body', (event) => {
          this.handleLlmRequestBody(event.payload);
        }),
      ]);
      
      // 🔧 P20 修复：保存 listenPromise，供子代理场景等待监听器就绪
      this.listenersReadyPromise = listenPromise.then(() => {
        console.log(LOG_PREFIX, `Listeners ready for session: ${this.sessionId}`);
      });

      // 📊 细粒度打点：loadSession 开始
      sessionSwitchPerf.mark('load_start', { alreadyLoaded });
      
      // 启动数据加载（不立即 await）
      const loadPromise = alreadyLoaded 
        ? Promise.resolve('cached' as const)
        : this.loadSession().then(() => {
            // 📊 精确打点：loadSession Promise 的 .then() 回调被调用
            sessionSwitchPerf.mark('load_then_callback', { timing: 'entered' });
            return 'loaded' as const;
          }).catch((err) => {
            loadError = err;
            return 'error' as const;
          });

      // 同时注入回调（同步操作，不阻塞）
      this.store.setSaveCallback(() => this.saveSession());
      this.store.setRetryCallback((messageId, modelOverride) =>
        this.executeRetry(messageId, modelOverride)
      );
      this.store.setDeleteCallback((messageId) =>
        this.executeDelete(messageId)
      );
      // 🆕 P1-2: 支持传递新的上下文引用
      this.store.setEditAndResendCallback((messageId, newContent, newContextRefs) =>
        this.executeEditAndResend(messageId, newContent, newContextRefs)
      );
      this.store.setSendCallback((content, attachments, userMessageId, assistantMessageId) =>
        this.executeSendMessage(content, attachments, userMessageId, assistantMessageId)
      );
      this.store.setAbortCallback(() => this.executeAbort());
      // 🔧 P0 修复：注入 continueMessage 回调，让 store.continueMessage 调用后端 chat_v2_continue_message
      this.store.setContinueMessageCallback((messageId, variantId) =>
        this.continueMessage(messageId, variantId)
      );
      this.store.setLoadCallback(() => this.loadSession());
      this.store.setSwitchVariantCallback((messageId, variantId) =>
        this.executeSwitchVariant(messageId, variantId)
      );
      this.store.setDeleteVariantCallback((messageId, variantId) =>
        this.executeDeleteVariant(messageId, variantId)
      );
      this.store.setRetryVariantCallback((messageId, variantId, modelOverride) =>
        this.executeRetryVariant(messageId, variantId, modelOverride)
      );
      this.store.setRetryAllVariantsCallback((messageId, variantIds) =>
        this.executeRetryAllVariants(messageId, variantIds)
      );
      this.store.setCancelVariantCallback((variantId) =>
        this.executeCancelVariant(variantId)
      );
      this.store.setUpdateBlockContentCallback((blockId, content) =>
        this.executeUpdateBlockContent(blockId, content)
      );
      this.store.setUpdateSessionSettingsCallback((settings) =>
        this.executeUpdateSessionSettings(settings)
      );
      streamingBlockSaver.setSaveCallback((blockId, messageId, blockType, content, sessionId) =>
        this.executeUpsertStreamingBlock(blockId, messageId, blockType, content, sessionId)
      );

      // 🔧 2026-01-15: 移除超时机制，后端工具调用参数累积时会实时发送事件
      // 超时机制已移除，避免长工具调用参数生成期间误杀

      // 📊 性能打点：回调注入完成
      sessionSwitchPerf.mark('callbacks_injected');

      // 📊 细粒度打点：await 开始
      sessionSwitchPerf.mark('await_start');
      
      // 🚀 性能优化 V3：先等待数据加载完成，让 UI 可以立即渲染
      // 事件监听在后台继续注册，不阻塞首次渲染
      const loadResult = await loadPromise;
      const loadElapsedMs = performance.now() - loadStartTs;
      
      // 📊 细粒度打点：数据加载完成（仅数据链路）
      sessionSwitchPerf.mark('await_load_done', { loadElapsedMs, loadResult });
      sessionSwitchPerf.mark('await_resolved');
      sessionSwitchPerf.mark('parallel_done');
      
      // 事件监听在后台继续，不阻塞 setup 完成
      listenPromise.then(([blockUnlisten, sessionUnlisten, ankiUnlisten, llmReqUnlisten]) => {
        this.unlisteners.push(blockUnlisten, sessionUnlisten, ankiUnlisten, llmReqUnlisten);
        this.claimAnkiEventOwnership('setup');
        // 📊 细粒度打点：listen 完成（后台）
        sessionSwitchPerf.mark('listen_end');
        // 🆕 P1 修复：清除可能存在的旧错误状态
        this.listenerRegistrationError = null;
        console.log(LOG_PREFIX, `Successfully registered ${this.unlisteners.length} event listeners`);
      }).catch((err) => {
        // 🆕 P1 修复：事件监听注册失败处理
        const errorMsg = getErrorMessage(err);
        console.error(LOG_PREFIX, 'Failed to setup event listeners:', errorMsg);
        
        // 保存错误状态，供健康检查和重试使用
        this.listenerRegistrationError = err instanceof Error ? err : new Error(errorMsg);
        
        // 通知用户（使用统一通知系统）
        showGlobalNotification(
          'error',
          i18n.t('chatV2:error.listenerRegistrationFailedMessage', '部分功能可能无法正常工作，请刷新页面重试'),
          i18n.t('chatV2:error.listenerRegistrationFailed', '事件监听初始化失败')
        );
      });

      this.isSetup = true;
      console.log(LOG_PREFIX, 'Setup complete');

      // 处理加载结果
      if (loadResult === 'cached') {
        console.log(LOG_PREFIX, '✅ Session already loaded (cached), skipping loadSession:', this.sessionId);
        sessionSwitchPerf.mark('adapter_setup_end', { fromCache: true });
        sessionSwitchPerf.endTrace();
      } else if (loadResult === 'loaded') {
        console.log(LOG_PREFIX, 'Session loaded after setup');
        sessionSwitchPerf.mark('adapter_setup_end');
      } else {
        // loadResult === 'error'
        console.warn(LOG_PREFIX, 'Failed to load session after setup (may be new session):', getErrorMessage(loadError!));
        isNewSession = true;
        // 🔧 用户通知：会话加载失败时提示用户（降级为新会话）
        showGlobalNotification(
          'warning',
          i18n.t('chatV2:error.sessionLoadFailedMessage', '已自动创建新会话，如有需要请检查网络或重启应用'),
          i18n.t('chatV2:error.sessionLoadFailed', '会话加载失败')
        );
        // 🔧 P27 修复：新会话加载失败时也要标记 isDataLoaded=true
        // 否则 ChatContainer 会一直显示空白（因为 isDataLoaded 永远是 false）
        // 对于新会话，数据为空但状态是"已加载"，UI 应该正常渲染空态
        // 
        // 注意：AdapterManager 创建 adapter 时总是传递 storeApi，所以这里一定存在
        // 但为安全起见添加 null 检查
        if (this.storeApi) {
          this.storeApi.setState({ isDataLoaded: true });
          console.log(LOG_PREFIX, '✅ New session marked as loaded (empty state) via storeApi');
        } else {
          console.warn(LOG_PREFIX, '⚠️ storeApi is null, cannot mark isDataLoaded');
        }
        sessionSwitchPerf.mark('adapter_setup_end', { error: true, markedAsLoaded: !!this.storeApi });
        sessionSwitchPerf.endTrace();
      }

      // 🔧 性能优化：已缓存的会话无需再执行 initSession
      // initSession 只在首次加载时执行，后续切换回该会话时跳过
      if (!alreadyLoaded) {
        // 🔧 P0修复：在回调设置完成后，处理待执行的 initSession
        // 这确保 analysis/bridge 模式的 autoSendFirstMessage 能正常工作
        const meta = sessionManager.getSessionMeta(this.sessionId);
        if (meta?.pendingInitConfig) {
          const mode = meta.mode;
          const initConfig = meta.pendingInitConfig;
          console.log(LOG_PREFIX, `Executing pending initSession for mode '${mode}'`, initConfig);
          
          try {
            await this.store.initSession(mode, initConfig);
            console.log(LOG_PREFIX, `Mode '${mode}' initialized successfully`);
          } catch (initError) {
            console.error(LOG_PREFIX, `Failed to init mode '${mode}':`, getErrorMessage(initError));
          } finally {
            // 清除待执行配置，避免重复执行
            sessionManager.clearPendingInitConfig(this.sessionId);
          }
        } else if (isNewSession) {
          // 新会话且没有 pendingInitConfig，使用默认模式初始化
          const mode = meta?.mode || 'chat';
          if (mode !== 'chat') {
            console.log(LOG_PREFIX, `Initializing new session with mode '${mode}'`);
            try {
              await this.store.initSession(mode);
            } catch (initError) {
              console.error(LOG_PREFIX, `Failed to init mode '${mode}':`, getErrorMessage(initError));
            }
          }
        }
      }
    } catch (error) {
      console.error(LOG_PREFIX, 'Setup failed:', getErrorMessage(error));
      throw error;
    }
  }

  /**
   * 清理适配器
   * 移除所有事件监听器并清理关联资源
   * 
   * 🔧 P0修复：防御性清理中间件资源
   * 即使正常流程会通过 handleStreamComplete/handleStreamAbort 清理，
   * 这里仍需防御性处理以下场景：
   * - 组件卸载时流式尚未完成
   * - 会话切换时事件未正常结束
   */
  cleanup(): void {
    console.log(LOG_PREFIX, 'Cleaning up...');

    // 🔧 同步修复：cleanup 前先保存会话状态（fire-and-forget）
    // 确保 idle 状态下修改的 UI 设置（chatParams, features 等）不丢失
    try {
      this.saveSession().catch((error) => {
        console.error(LOG_PREFIX, 'Error saving session on cleanup:', getErrorMessage(error));
      });
    } catch (error) {
      console.error(LOG_PREFIX, 'Error initiating save on cleanup:', getErrorMessage(error));
    }

    // 🔧 2026-01-15: 超时机制已移除

    // 🔧 P1修复：只刷新并清理当前会话的 chunkBuffer
    // chunkBuffer 现在支持多会话并发，每个会话有独立的缓冲区
    // flushAndCleanupSession 会刷新该会话的缓冲并释放资源
    try {
      chunkBuffer.flushAndCleanupSession(this.sessionId);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error flushing chunkBuffer:', getErrorMessage(error));
    }

    // 🔧 P3修复：清理自动保存相关的所有状态
    // 不仅取消待执行保存，还清理 lastSaveTime 和 savingPromise
    try {
      autoSave.cleanup(this.sessionId);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error cleaning up autoSave:', getErrorMessage(error));
    }

    // 🆕 渐进披露优化：不再在会话切换时清空已加载的 Skills
    // 原因：
    // 1. Skills 状态已持久化到后端（saveSession 保存 loadedSkillIdsJson）
    // 2. 会话恢复时会从后端恢复（restoreFromBackend 调用 loadSkillsToSession）
    // 3. loadedSkillsMap 按 sessionId 隔离，不同会话互不影响
    // 4. 保留内存中的 Skills 状态可以加速会话切换（如果 LRU 缓存命中）
    // 
    // 只有在以下情况才需要清空：
    // - 会话被从 LRU 缓存中 evict（由 SessionManager 处理）
    // - 用户主动删除会话

    // 🔧 P0修复：清理事件上下文
    // 防止 activeContexts Map 累积过期条目
    try {
      clearEventContext(this.sessionId);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error clearing eventContext:', getErrorMessage(error));
    }

    // 清除保存回调
    try {
      this.store.setSaveCallback(null);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error clearing save callback:', getErrorMessage(error));
    }

    // 清除重试回调
    try {
      this.store.setRetryCallback(null);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error clearing retry callback:', getErrorMessage(error));
    }

    // 清除删除回调
    try {
      this.store.setDeleteCallback(null);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error clearing delete callback:', getErrorMessage(error));
    }

    // 清除编辑并重发回调
    try {
      this.store.setEditAndResendCallback(null);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error clearing editAndResend callback:', getErrorMessage(error));
    }

    // 清除发送回调
    try {
      this.store.setSendCallback(null);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error clearing send callback:', getErrorMessage(error));
    }

    // 清除中断回调
    try {
      this.store.setAbortCallback(null);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error clearing abort callback:', getErrorMessage(error));
    }

    // 🔧 P0 修复：清除继续执行回调
    try {
      this.store.setContinueMessageCallback(null);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error clearing continueMessage callback:', getErrorMessage(error));
    }

    // 清除加载回调
    try {
      this.store.setLoadCallback(null);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error clearing load callback:', getErrorMessage(error));
    }

    // 🔧 P0修复：清除变体操作回调
    try {
      this.store.setSwitchVariantCallback(null);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error clearing switchVariant callback:', getErrorMessage(error));
    }

    try {
      this.store.setDeleteVariantCallback(null);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error clearing deleteVariant callback:', getErrorMessage(error));
    }

    try {
      this.store.setRetryVariantCallback(null);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error clearing retryVariant callback:', getErrorMessage(error));
    }

    try {
      this.store.setRetryAllVariantsCallback(null);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error clearing retryAllVariants callback:', getErrorMessage(error));
    }

    try {
      this.store.setCancelVariantCallback(null);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error clearing cancelVariant callback:', getErrorMessage(error));
    }

    // 🔧 同步修复：清除更新块内容回调
    try {
      this.store.setUpdateBlockContentCallback(null);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error clearing updateBlockContent callback:', getErrorMessage(error));
    }

    // 🔧 同步修复：清除更新会话设置回调
    try {
      this.store.setUpdateSessionSettingsCallback(null);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error clearing updateSessionSettings callback:', getErrorMessage(error));
    }

    // 🔧 防闪退：清除流式块保存回调
    try {
      streamingBlockSaver.setSaveCallback(null);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error clearing streamingBlockSaver callback:', getErrorMessage(error));
    }

    for (const unlisten of this.unlisteners) {
      try {
        unlisten();
      } catch (error) {
        console.error(LOG_PREFIX, 'Error during unlisten:', getErrorMessage(error));
      }
    }

    this.unlisteners = [];
    this.releaseAnkiEventOwnershipIfHeld('cleanup');
    this.chatAnkiChunkLogCounter.clear();
    this.isSetup = false;
    console.log(LOG_PREFIX, 'Cleanup complete');
  }

  // ========================================================================
  // 事件处理
  // ========================================================================

  /**
   * 处理 ChatAnki 后端事件（anki_generation_event）
   * 将 NewCard/进度事件桥接到 anki_cards 块，实现实时预览
   */
  private handleAnkiGenerationEvent(payload: unknown): void {
    if (ChatV2TauriAdapter.ankiEventOwnerAdapterId !== this.adapterInstanceId) {
      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
          level: 'debug',
          phase: 'bridge:event',
          summary: `drop anki_generation_event: adapter#${this.adapterInstanceId} is not owner`,
          detail: {
            adapterId: this.adapterInstanceId,
            ownerAdapterId: ChatV2TauriAdapter.ankiEventOwnerAdapterId,
            sessionId: this.sessionId,
          },
        }}));
      } catch { /* debug only */ }
      return;
    }

    const raw = (payload as { payload?: unknown })?.payload ?? payload;
    if (!raw || typeof raw !== 'object') return;

    const normalized = 'type' in (raw as Record<string, unknown>) && 'data' in (raw as Record<string, unknown>)
      ? {
          type: (raw as { type: string }).type,
          data: (raw as { data: unknown }).data,
        }
      : (() => {
          const keys = Object.keys(raw as Record<string, unknown>);
          if (keys.length === 0) return null;
          const type = keys[0];
          return { type, data: (raw as Record<string, unknown>)[type] };
        })();

    if (!normalized) return;

    const { type, data } = normalized;
    const dataObj = (data && typeof data === 'object') ? (data as Record<string, unknown>) : undefined;
    const cardData = (dataObj && 'card' in dataObj ? (dataObj.card as AnkiCard) : (data as AnkiCard | undefined));
    const documentId =
      (dataObj?.document_id as string | undefined) ||
      (dataObj?.documentId as string | undefined) ||
      ((cardData as any)?.document_id as string | undefined) ||
      ((raw as any)?.document_id as string | undefined) ||
      ((raw as any)?.documentId as string | undefined);

    const state = this.getCurrentState();
    const blocks = state.blocks;
    // 按 documentId 精确匹配（不限状态 — 块可能已被 chatanki_wait 标记为 success）
    const findBlockByDocumentId = (docId: string) => {
      for (const block of blocks.values()) {
        if (block.type !== 'anki_cards') continue;
        const toolOutput = block.toolOutput as Record<string, unknown> | undefined;
        if (toolOutput?.documentId === docId) return block;
      }
      return undefined;
    };
    // 回退：找任何 running/pending 的 anki_cards 块
    const findLatestActiveAnkiBlock = () => {
      const candidates = Array.from(blocks.values()).filter((block) => {
        if (block.type !== 'anki_cards') return false;
        return block.status === 'running' || block.status === 'pending';
      });
      return candidates.length > 0 ? candidates[candidates.length - 1] : undefined;
    };

    const targetBlock = documentId
      ? findBlockByDocumentId(documentId) ?? findLatestActiveAnkiBlock()
      : findLatestActiveAnkiBlock();
    if (!targetBlock) {
      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
          level: 'warn',
          phase: 'bridge:event',
          summary: `drop anki_generation_event ${type}: no target block`,
          documentId,
          detail: { type, data: dataObj ?? data },
        }}));
      } catch { /* debug only */ }
      // documentId 存在但本 session 没有匹配的块 → 事件属于其他 session，静默忽略
      // documentId 不存在且没有活跃块 → 无处投递，忽略
      return;
    }
    try {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
        level: 'debug',
        phase: 'bridge:event',
        summary: `route anki_generation_event ${type} -> block ${targetBlock.id.slice(0, 8)}`,
        documentId,
        blockId: targetBlock.id,
        detail: {
          type,
          blockStatus: targetBlock.status,
          currentCards: ((targetBlock.toolOutput as any)?.cards ?? []).length,
        },
      }}));
    } catch { /* debug only */ }

    const currentOutput = (targetBlock.toolOutput as Record<string, unknown> | undefined) ?? {};
    const currentCards = (currentOutput.cards as AnkiCard[] | undefined) ?? [];
    const ensureDocumentId = documentId && !currentOutput.documentId ? { documentId } : {};

    const extractCardQuestion = (card: AnkiCard): string => {
      const fields = (card.fields ?? {}) as Record<string, unknown>;
      const extraFields = (card.extra_fields ?? {}) as Record<string, unknown>;
      const fieldQuestion =
        fields.question ??
        fields.Question ??
        extraFields.question ??
        extraFields.Question;
      if (typeof fieldQuestion === 'string' && fieldQuestion.trim()) return fieldQuestion.trim();
      const front = card.front ?? '';
      if (front.trim().startsWith('{') && front.trim().endsWith('}')) {
        try {
          const parsed = JSON.parse(front) as Record<string, unknown>;
          const q = parsed.Question ?? parsed.question ?? parsed.front;
          if (typeof q === 'string' && q.trim()) return q.trim();
        } catch {
          // ignore
        }
      }
      return front.replace(/\s+/g, ' ').trim().slice(0, 80);
    };

    const buildCardsSignature = (cards: AnkiCard[]): string =>
      cards
        .map((card) => `${card.id ?? 'no-id'}::${card.template_id ?? 'no-template'}::${extractCardQuestion(card)}`)
        .join('|');

    const recordSourceSnapshot = (
      source: string,
      cards: AnkiCard[],
      status: string | undefined,
      docId: string | undefined,
    ) => {
      const signature = buildCardsSignature(cards);
      const updatedAt = new Date().toISOString();
      const cardIds = cards.map((card) => card.id ?? 'no-id');

      const win = window as Window & {
        __chatankiCardSourceByBlock?: Record<
          string,
          {
            source: string;
            blockStatus?: string;
            documentId?: string;
            cardIds: string[];
            signature: string;
            updatedAt: string;
          }
        >;
      };
      if (!win.__chatankiCardSourceByBlock) {
        win.__chatankiCardSourceByBlock = {};
      }
      win.__chatankiCardSourceByBlock[targetBlock.id] = {
        source,
        blockStatus: status,
        documentId: docId,
        cardIds,
        signature,
        updatedAt,
      };

      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
          level: 'info',
          phase: 'bridge:source',
          summary: `source snapshot ${source} block=${targetBlock.id.slice(0, 8)} cards=${cards.length} doc=${docId ?? 'null'}`,
          detail: {
            blockId: targetBlock.id,
            source,
            blockStatus: status ?? null,
            documentId: docId ?? null,
            cardsCount: cards.length,
            cardIds,
            signature,
            updatedAt,
          },
        }}));
      } catch { /* debug only */ }
    };

    if (type === 'NewCard' || type === 'NewErrorCard') {
      if (!cardData) return;
      const exists = cardData.id ? currentCards.some((c) => c.id === cardData.id) : false;
      if (exists) {
        try {
          window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
            level: 'debug', phase: 'bridge:event',
            summary: `${type} duplicate dropped: ${cardData.id?.slice(0, 10) ?? 'no-id'}`,
            documentId, blockId: targetBlock.id,
          }}));
        } catch { /* debug only */ }
      }
      if (!exists) {
        try {
          window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
            level: 'debug', phase: 'bridge:card',
            summary: `${type} → block ${targetBlock.id.slice(0, 8)} | template=${(cardData as any).template_id ?? 'null'} | total=${currentCards.length + 1}`,
            documentId, blockId: targetBlock.id,
            detail: { cardId: cardData.id, templateId: (cardData as any).template_id, front: (cardData.front || '').slice(0, 60) },
          }}));
        } catch { /* */ }
      }
      const nextCards = exists ? currentCards : [...currentCards, cardData];
      const nextTemplateId =
        (currentOutput.templateId as string | undefined) ||
        (cardData.template_id ?? undefined) ||
        null;
      const nextProgress = {
        ...(currentOutput.progress as Record<string, unknown> | undefined),
        stage: (currentOutput.progress as any)?.stage ?? 'streaming',
        cardsGenerated: nextCards.length,
        lastUpdatedAt: new Date().toISOString(),
      };
      recordSourceSnapshot(
        'event-new-card',
        nextCards,
        targetBlock.status === 'success' || targetBlock.status === 'error' ? targetBlock.status : 'running',
        (ensureDocumentId.documentId as string | undefined) ?? (currentOutput.documentId as string | undefined),
      );
      state.updateBlock(targetBlock.id, {
        toolOutput: {
          ...currentOutput,
          ...ensureDocumentId,
          cards: nextCards,
          templateId: nextTemplateId,
          progress: nextProgress,
        },
        ...(targetBlock.status === 'success' || targetBlock.status === 'error'
          ? {}
          : { status: 'running' }),
      });
      return;
    }

    if (type === 'TaskStatusUpdate' || type === 'DocumentProcessingStarted') {
      const nextProgress = {
        ...(currentOutput.progress as Record<string, unknown> | undefined),
        stage:
          type === 'TaskStatusUpdate'
            ? ((dataObj?.status as string | undefined) || 'streaming')
            : 'processing',
        lastUpdatedAt: new Date().toISOString(),
      };
      recordSourceSnapshot(
        type === 'TaskStatusUpdate' ? 'event-task-status' : 'event-doc-started',
        currentCards,
        targetBlock.status === 'success' || targetBlock.status === 'error' ? targetBlock.status : 'running',
        (ensureDocumentId.documentId as string | undefined) ?? (currentOutput.documentId as string | undefined),
      );
      state.updateBlock(targetBlock.id, {
        toolOutput: {
          ...currentOutput,
          ...ensureDocumentId,
          progress: nextProgress,
        },
        ...(targetBlock.status === 'success' || targetBlock.status === 'error'
          ? {}
          : { status: 'running' }),
      });
      return;
    }

    if (type === 'TaskCompleted' || type === 'DocumentProcessingCompleted') {
      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
          level: 'info', phase: 'bridge:card',
          summary: `${type} → block ${targetBlock.id.slice(0, 8)} COMPLETED | ${currentCards.length} cards total`,
          documentId, blockId: targetBlock.id,
          detail: { cardsCount: currentCards.length, templateIds: [...new Set(currentCards.map((c: any) => c.template_id).filter(Boolean))] },
        }}));
      } catch { /* */ }
      recordSourceSnapshot(
        type === 'TaskCompleted' ? 'event-task-completed' : 'event-doc-completed',
        currentCards,
        'success',
        (ensureDocumentId.documentId as string | undefined) ?? (currentOutput.documentId as string | undefined),
      );
      state.updateBlock(targetBlock.id, {
        toolOutput: {
          ...currentOutput,
          ...ensureDocumentId,
          finalStatus: 'completed',
        },
      });
      if (targetBlock.status !== 'error') {
        state.updateBlockStatus(targetBlock.id, 'success');
      }
      return;
    }

    if (
      type === 'TaskFailed' ||
      type === 'DocumentProcessingFailed' ||
      type === 'WorkflowFailed' ||
      type === 'DocumentProcessingCancelled'
    ) {
      const errorMessage =
        (dataObj?.message as string | undefined) ||
        (dataObj?.error as string | undefined) ||
        'generation_failed';
      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
          level: 'error', phase: 'bridge:card',
          summary: `${type} → block ${targetBlock.id.slice(0, 8)} FAILED: ${errorMessage}`,
          documentId, blockId: targetBlock.id,
          detail: { error: errorMessage },
        }}));
      } catch { /* */ }
      state.updateBlock(targetBlock.id, {
        toolOutput: {
          ...currentOutput,
          ...ensureDocumentId,
          finalStatus: 'failed',
          finalError: errorMessage,
        },
      });
      state.updateBlockStatus(targetBlock.id, 'error');
    }
  }

  /**
   * 处理块级事件
   */
  private handleBlockEvent(event: BackendEvent): void {
    try {
      // ChatAnki 工具调用拦截 — 捕获 tool_call 的 start/end/error 供调试面板显示
      {
        const payloadToolName = (event.payload as any)?.toolName || '';
        const blockToolName = event.blockId
          ? this.getCurrentState().blocks.get(event.blockId)?.toolName || ''
          : '';
        const toolName = payloadToolName || blockToolName;
        const isChatAnkiTool = toolName.includes('chatanki');
        const isAnkiCardsEvent = event.type === 'anki_cards';
        if (isChatAnkiTool || isAnkiCardsEvent) {
          const chunkSize = typeof event.chunk === 'string' ? event.chunk.length : 0;
          const shouldLogChunk = event.phase !== 'chunk' || (() => {
            const key = event.blockId || `${event.type}:${event.messageId || 'unknown'}`;
            const next = (this.chatAnkiChunkLogCounter.get(key) ?? 0) + 1;
            this.chatAnkiChunkLogCounter.set(key, next);
            return next % 10 === 1; // chunk 日志每 10 条记录 1 条，避免刷屏
          })();
          if (shouldLogChunk) {
            try {
              window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
                level: event.phase === 'error' ? 'error' : 'debug',
                phase: 'bridge:event',
                summary: `${event.type}:${event.phase} ${toolName || ''} ${chunkSize ? `chunk=${chunkSize}` : ''}`.trim(),
                blockId: event.blockId,
                detail: {
                  messageId: event.messageId,
                  sequenceId: event.sequenceId,
                  variantId: event.variantId,
                  payload: event.payload,
                  result: event.result,
                  error: event.error,
                },
              }}));
            } catch { /* debug only */ }
          }
        }
        if (isChatAnkiTool || isAnkiCardsEvent) {
          try {
            window.dispatchEvent(new CustomEvent('chatanki-debug-tool-block', { detail: {
              type: event.type,
              phase: event.phase,
              toolName: toolName || event.type,
              blockId: event.blockId,
              toolInput: (event.payload as any)?.toolInput,
              toolOutput: event.result,
              result: event.result,
              error: event.error,
              payload: event.payload,
            }}));
          } catch { /* */ }
        }

        if (isTemplateDesignerToolName(toolName)) {
          try {
            emitTemplateDesignerToolEvent({
              type: event.type,
              phase: event.phase,
              toolName,
              blockId: event.blockId,
              toolInput: (event.payload as any)?.toolInput,
              toolOutput: event.result,
              result: event.result,
              error: event.error,
              payload: event.payload,
            });
          } catch {
            // ignore debug failures
          }
        }
      }

      // 🔧 调试打点：追踪多变体事件接收
      if (event.variantId || event.type === 'variant_start' || event.type === 'variant_end') {
        logMultiVariant('adapter', 'event_received', {
          type: event.type,
          phase: event.phase,
          variantId: event.variantId,
          messageId: event.messageId,
          blockId: event.blockId,
          sequenceId: event.sequenceId,
          willUseVariantHandler: !!event.variantId,
        }, 'info');
      }

      // 🔧 优化：统一使用带序列号检查的处理器
      // 1. 单变体和多变体模式都使用相同的乱序缓冲和去重机制
      // 2. handleBackendEventWithSequence 内部已有向后兼容逻辑：
      //    - 如果 sequenceId 为 undefined，直接处理（不阻塞）
      //    - 如果有 sequenceId，进行乱序检测、缓冲和去重
      // 3. 这样可以提高单变体模式的鲁棒性，防止网络抖动导致的事件乱序
      // 🔧 2026-01-18 修复：使用 getCurrentState() 获取最新状态
      // 之前使用 this.store（构造时的快照），导致 tool_call 事件处理时
      // 无法找到刚创建的 preparing 块（因为 blocks Map 是旧的）
      handleBackendEventWithSequence(this.getCurrentState(), event);
    } catch (error) {
      logMultiVariant('adapter', 'event_error', {
        type: event.type,
        variantId: event.variantId,
        error: getErrorMessage(error),
      }, 'error');
      console.error(LOG_PREFIX, 'Error handling block event:', getErrorMessage(error), event);
    }
  }

  /**
   * ★ 2026-02-14: 处理后端真实 LLM 请求体事件
   *
   * 后端在构建并脱敏 LLM 请求体后通过 `chat_v2_llm_request_body` 全局事件推送。
   * 此方法按 streamEvent 中的 session_id 过滤，仅处理当前会话的事件，
   * 然后将 rawRequest 更新为后端的真实请求体（替换之前保存的前端请求）。
   */
  private handleLlmRequestBody(payload: { streamEvent: string; model: string; url: string; requestBody: unknown }): void {
    // streamEvent 格式: chat_v2_event_{session_id} 或 chat_v2_event_{session_id}_{variant_id}
    const prefix = `chat_v2_event_${this.sessionId}`;
    if (payload.streamEvent !== prefix && !payload.streamEvent.startsWith(`${prefix}_`)) {
      return; // 不属于当前会话，忽略
    }

    // 找到当前正在流式生成的助手消息
    const state = this.getCurrentState();
    const streamingMessageId = state.currentStreamingMessageId;
    if (!streamingMessageId) {
      // 没有正在流式的消息，尝试用最后一条助手消息
      const lastMsgId = state.messageOrder[state.messageOrder.length - 1];
      if (lastMsgId) {
        const lastMsg = state.messageMap.get(lastMsgId);
        if (lastMsg && lastMsg.role === 'assistant') {
          state.updateMessageMeta(lastMsgId, {
            rawRequest: {
              _source: 'backend_llm',
              model: payload.model,
              url: payload.url,
              body: payload.requestBody,
            },
          });
        }
      }
      return;
    }

    state.updateMessageMeta(streamingMessageId, {
      rawRequest: {
        _source: 'backend_llm',
        model: payload.model,
        url: payload.url,
        body: payload.requestBody,
      },
    });
  }

  /**
   * 处理会话级事件
   * 
   * 注意：此方法是同步的，但内部的保存操作是异步的。
   * 为了确保 UI 响应性，先重置状态再执行保存。
   */
  private handleSessionEvent(payload: SessionEventPayload): void {
    console.log(LOG_PREFIX, 'Session event:', payload.eventType, payload);
    try {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
        level: payload.eventType === 'stream_error' ? 'error' : 'debug',
        phase: 'backend:event',
        summary: `session_event ${payload.eventType} msg=${payload.messageId ?? 'null'}`,
        detail: payload,
      }}));
    } catch { /* debug only */ }

    try {
      switch (payload.eventType) {
        case 'stream_start': {
          // 流式开始
          // 🆕 2026-02-16: 重置工具调用生命周期追踪器的轮次计数器
          try {
            resetToolCallRound();
          } catch { /* debug only */ }

          // 🔧 调试打点：记录 stream_start 事件中的模型名称
          logMultiVariant('adapter', 'stream_start_received', {
            messageId: payload.messageId,
            modelId: payload.modelId,
            hasModelId: !!payload.modelId,
            sessionId: payload.sessionId,
          }, payload.modelId ? 'success' : 'warning');

          const fallbackModelId =
            this.getCurrentState().chatParams.modelDisplayName ||
            this.getCurrentState().chatParams.modelId ||
            undefined;
          
          // 🔧 P29 修复：子代理场景下消息可能不存在（后端创建，前端未同步）
          // 检查消息是否存在，不存在则创建占位消息（与普通会话 sendMessageWithIds 等价）
          const currentState = this.getCurrentState();
          const messageExists = currentState.messageMap.has(payload.messageId);
          
          // 🔧 P31 全链路诊断
          const diagData = {
            messageId: payload.messageId,
            messageExists,
            hasStoreApi: !!this.storeApi,
            storeApiType: this.storeApi ? typeof this.storeApi : 'null',
            hasStoreApiGetState: typeof this.storeApi?.getState === 'function',
            messageMapSize: currentState.messageMap.size,
            messageOrder: currentState.messageOrder,
            sessionStatus: currentState.sessionStatus,
            sessionId: payload.sessionId,
            thisSessionId: this.sessionId,
          };
          console.log(LOG_PREFIX, '[P31] stream_start check:', diagData);
          
          // 调用全局调试日志
          if ((window as any).__subagentFlowLog) {
            (window as any).__subagentFlowLog('stream_start', 'check_state', diagData, 
              !messageExists && this.storeApi ? 'info' : (!this.storeApi ? 'error' : 'warning'));
          }
          
          if (!messageExists && payload.messageId) {
            console.log(LOG_PREFIX, '[P29] Creating placeholder assistant message for subagent:', payload.messageId);
            logMultiVariant('adapter', 'stream_start_create_placeholder', {
              messageId: payload.messageId,
              modelId: payload.modelId,
              sessionId: payload.sessionId,
              hasStoreApi: !!this.storeApi,
            }, 'warning');
            
            // 与 sendMessageWithIds 等价：创建占位助手消息并设置流式状态
            const placeholderMessage = {
              id: payload.messageId,
              role: 'assistant' as const,
              blockIds: [] as string[],
              timestamp: Date.now(),
              _meta: {
                modelId: payload.modelId || fallbackModelId,
              },
            };
            
            // 🔧 P32 修复：不依赖 this.storeApi，从 sessionManager 获取 store 作为后备
            const storeApi = this.storeApi ?? sessionManager.get(this.sessionId);
            
            if (storeApi) {
              storeApi.setState((s) => ({
                sessionStatus: 'streaming' as const,
                messageMap: new Map(s.messageMap).set(payload.messageId, placeholderMessage),
                messageOrder: s.messageOrder.includes(payload.messageId)
                  ? s.messageOrder
                  : [...s.messageOrder, payload.messageId],
                currentStreamingMessageId: payload.messageId,
              }));
              console.log(LOG_PREFIX, '[P32] Placeholder created via', this.storeApi ? 'storeApi' : 'sessionManager fallback');
            } else {
              console.error(LOG_PREFIX, '[P32] Cannot create placeholder: no storeApi available');
            }
          } else if (messageExists && payload.messageId && payload.modelId) {
            // 普通会话：消息已存在，仅更新 modelId
            logMultiVariant('adapter', 'stream_start_update_meta', {
              messageId: payload.messageId,
              modelId: payload.modelId,
            }, 'success');
            this.store.updateMessageMeta(payload.messageId, { modelId: payload.modelId });
          } else if (messageExists && payload.messageId && fallbackModelId) {
            // 🔧 回退：stream_start 未携带 modelId 时使用当前模型
            logMultiVariant('adapter', 'stream_start_fallback_model', {
              messageId: payload.messageId,
              modelId: fallbackModelId,
            }, 'warning');
            this.store.updateMessageMeta(payload.messageId, { modelId: fallbackModelId });
          } else {
            logMultiVariant('adapter', 'stream_start_no_modelId', {
              messageId: payload.messageId,
              hasMessageId: !!payload.messageId,
              hasModelId: !!payload.modelId,
            }, 'warning');
          }
          break;
        }

        case 'stream_complete':
          // 流式完成 - 重置状态为 idle
          console.log(
            LOG_PREFIX,
            'Stream complete for message:',
            payload.messageId,
            'duration:',
            payload.durationMs,
            'ms'
          );
          // 🔧 P2修复：先重置状态确保 UI 响应，再异步保存
          // handleStreamComplete 内部会捕获当前状态快照进行保存
          this.store.completeStream('success');
          // 🆕 Prompt 8: 将 messageId 和 usage 传递给 handleStreamComplete
          // token 统计处理在 eventBridge.handleStreamComplete 中完成
          handleStreamComplete(this.store, {
            messageId: payload.messageId,
            usage: payload.usage,
          }).catch((err) => {
            console.error(LOG_PREFIX, 'Error in handleStreamComplete:', getErrorMessage(err));
          });
          break;

        case 'stream_error':
          // 流式错误 - 重置状态为 idle
          console.error(LOG_PREFIX, 'Stream error:', payload.error);
          // 🔧 P2修复：先重置状态确保 UI 响应，再异步保存
          this.store.completeStream('error');
          handleStreamAbort(this.store).catch((err) => {
            console.error(LOG_PREFIX, 'Error in handleStreamAbort:', getErrorMessage(err));
          });
          // 显示错误提示
          if (payload.error) {
            showGlobalNotification('error', payload.error);
          }
          break;

        case 'stream_cancelled':
          // 流式被取消 - 由 abortStream 处理状态重置
          console.log(LOG_PREFIX, 'Stream cancelled for message:', payload.messageId);
          // 🔧 P2修复：先重置状态确保 UI 响应，再异步保存
          // 用户主动取消时，abortStream 可能已经重置了状态
          // completeStream 内部会检查状态，如果已经是 idle 则不会重复处理
          this.store.completeStream('cancelled');
          // 用户取消时也清空多变体 ID
          this.store.setPendingParallelModelIds(null);
          handleStreamAbort(this.store).catch((err) => {
            console.error(LOG_PREFIX, 'Error in handleStreamAbort:', getErrorMessage(err));
          });
          break;

        case 'save_complete':
          console.log(LOG_PREFIX, 'Session saved successfully');
          break;

        case 'save_error':
          console.error(LOG_PREFIX, 'Session save failed:', payload.error);
          break;

        case 'title_updated':
          // 标题自动生成完成 - 更新 Store 中的标题（向后兼容）
          console.log(LOG_PREFIX, 'Session title updated:', payload.title);
          if (payload.title) {
            this.store.setTitle(payload.title);
          }
          break;

        case 'summary_updated':
          // 摘要自动生成完成 - 同时更新标题和简介
          console.log(LOG_PREFIX, 'Session summary updated:', {
            title: payload.title,
            description: payload.description,
          });
          if (payload.title) {
            this.store.setSummary(payload.title, payload.description ?? '');
          }
          break;

        case 'variant_deleted':
          // 变体删除事件 - 后端已完成删除，前端同步状态
          this.handleVariantDeleted(payload);
          break;

        default:
          console.warn(LOG_PREFIX, 'Unknown session event type:', payload.eventType);
      }
    } catch (error) {
      console.error(LOG_PREFIX, 'Error handling session event:', getErrorMessage(error));
    }
  }

  /**
   * 处理 variant_deleted 事件
   * 
   * 后端删除变体后发射此事件，前端需要同步更新本地状态。
   * 
   * Payload 结构：
   * - messageId: 消息 ID
   * - variantId: 被删除的变体 ID
   * - remainingCount: 剩余变体数量
   * - newActiveVariantId: 新的激活变体 ID（可选）
   */
  private handleVariantDeleted(payload: SessionEventPayload): void {
    const { messageId, variantId, newActiveVariantId, remainingCount } = payload;

    if (!messageId || !variantId) {
      console.warn(LOG_PREFIX, 'variant_deleted event missing messageId or variantId:', payload);
      return;
    }

    console.log(LOG_PREFIX, 'Variant deleted event received:', {
      messageId,
      variantId,
      remainingCount,
      newActiveVariantId,
    });

    // 获取当前状态
    const currentState = this.getCurrentState();
    const message = currentState.messageMap.get(messageId);

    if (!message) {
      console.warn(LOG_PREFIX, 'variant_deleted: Message not found:', messageId);
      return;
    }

    const variants = message.variants ?? [];
    const variantIndex = variants.findIndex((v) => v.id === variantId);

    if (variantIndex === -1) {
      // 变体可能已经被前端删除（例如用户主动调用 deleteVariant）
      // 这种情况下忽略事件，避免重复处理
      console.log(LOG_PREFIX, 'variant_deleted: Variant already removed from frontend:', variantId);
      return;
    }

    // 获取要删除的变体的 blockIds（用于清理 blocks Map）
    const variantToDelete = variants[variantIndex];
    const blockIdsToDelete = variantToDelete.blockIds ?? [];

    // 使用 storeApi 更新状态（如果可用），否则回退到 store
    const storeApi = this.storeApi ?? sessionManager.get(this.sessionId);
    
    if (storeApi) {
      storeApi.setState((s) => {
        const newMessageMap = new Map(s.messageMap);
        const newBlocks = new Map(s.blocks);
        const newStreamingVariantIds = new Set(s.streamingVariantIds);

        const msg = newMessageMap.get(messageId);
        if (msg) {
          // 移除被删除的变体
          const newVariants = (msg.variants ?? []).filter((v) => v.id !== variantId);
          
          // 使用后端返回的 newActiveVariantId，如果没有则保持当前激活状态
          // 如果当前激活的变体被删除，则选择第一个变体
          let newActiveId = msg.activeVariantId;
          if (newActiveVariantId) {
            newActiveId = newActiveVariantId;
          } else if (msg.activeVariantId === variantId && newVariants.length > 0) {
            newActiveId = newVariants[0].id;
          }

          const newActiveVariant = newVariants.find((v) => v.id === newActiveId);

          newMessageMap.set(messageId, {
            ...msg,
            variants: newVariants,
            activeVariantId: newActiveId,
            _meta: newActiveVariant?.modelId
              ? { ...(msg._meta ?? {}), modelId: newActiveVariant.modelId }
              : msg._meta,
          });
        }

        // 清理被删除变体关联的 blocks
        for (const blockId of blockIdsToDelete) {
          newBlocks.delete(blockId);
        }

        // 从 streamingVariantIds 中移除（如果变体正在流式中）
        newStreamingVariantIds.delete(variantId);

        return {
          messageMap: newMessageMap,
          blocks: newBlocks,
          streamingVariantIds: newStreamingVariantIds,
        };
      });

      console.log(LOG_PREFIX, 'variant_deleted: Frontend state synced:', {
        variantId,
        blocksRemoved: blockIdsToDelete.length,
      });
    } else {
      console.error(LOG_PREFIX, 'variant_deleted: Cannot update state - no storeApi available');
    }
  }

  // ========================================================================
  // 消息操作
  // ========================================================================

  /**
   * 生成消息 ID（格式：msg_{uuid}）
   */
  private generateMessageId(): string {
    return `msg_${crypto.randomUUID()}`;
  }

  /**
   * 发送消息（公开方法）
   * 
   * @deprecated 推荐通过 store.sendMessage() 调用，会自动使用注入的回调
   * 
   * 此方法仅作为后备使用，正常流程应该是：
   * store.sendMessage() -> _sendCallback -> executeSendMessage()
   *
   * 实现消息 ID 统一：前端生成 ID 并传给后端使用，确保前后端一致
   */
  async sendMessage(content: string, attachments?: AttachmentMeta[]): Promise<void> {
    console.warn(
      LOG_PREFIX,
      'sendMessage() called directly. Prefer using store.sendMessage() instead.'
    );
    console.log(LOG_PREFIX, 'Sending message:', { content: content.substring(0, 50), attachments });

    try {
      // 🔧 修复：重置事件桥接状态（确保序列号从 0 开始，与 executeSendMessage 保持一致）
      resetBridgeState(this.sessionId);

      // 1. 前端生成消息 ID（消息 ID 统一方案 B）
      const userMessageId = this.generateMessageId();
      const assistantMessageId = this.generateMessageId();

      // ⚠️ 统一上下文注入：先获取 pendingContextRefs（sendMessageWithIds 会清空）
      // ★ 使用 storeApi 获取最新状态
      let pendingContextRefs = getPendingContextRefs(this.storeApi ?? this.store);

      // 🆕 P1 修复：验证并清理已删除的资源引用
      // 在发送前检查资源是否仍然存在，移除无效引用
      if (pendingContextRefs.length > 0) {
        pendingContextRefs = await validateAndCleanupContextRefs(
          this.storeApi ?? this.store,
          pendingContextRefs,
          { notifyUser: true, logDetails: true }
        );
        console.log(LOG_PREFIX, 'After validation:', pendingContextRefs.length, 'valid refs');
      }

      // 2. 使用指定 ID 更新本地状态
      await this.store.sendMessageWithIds(
        content,
        attachments,
        userMessageId,
        assistantMessageId
      );

      // 3. 构建发送选项（包含 parallelModelIds）
      const activeModelId = this.getCurrentState().chatParams.modelId;
      await this.ensureModelMetadataReady(activeModelId);
      const options = this.buildSendOptions();

      // 注意：不在这里清空 pendingParallelModelIds，等待发送成功后再清空
      // 这样如果发送失败，用户可以重试而不会丢失多变体配置

      // 🆕 统一上下文注入：构建 SendContextRef[]（附件已通过 pendingContextRefs 处理）
      // ★ 根据当前模型的多模态能力决定注入图片还是文本
      // ★ 文档28 Prompt10：使用 buildSendContextRefsWithPaths 获取 pathMap
      let userContextRefs = undefined;
      let contextPathMap: Record<string, string> | undefined;
      let isMultimodalModel = false;
      // 🔧 2026-02-22: 过滤掉 skill_instruction 类型 refs
      // 技能内容改由后端 auto-load_skills 工具结果投递（role: tool），不再注入 user message
      const refsForUserMessage = pendingContextRefs.filter(
        (ref) => ref.typeId !== SKILL_INSTRUCTION_TYPE_ID
      );
      if (refsForUserMessage.length > 0) {
        const currentModelId = this.getCurrentState().chatParams.modelId;
        // ★ 2026-02 修复：使用异步版本确保模型缓存已加载
        const isMultimodal = await isModelMultimodalAsync(currentModelId);
        isMultimodalModel = isMultimodal;
        const { sendRefs, pathMap } = await buildSendContextRefsWithPaths(refsForUserMessage, { isMultimodal });

        // Token 预估和截断（防止上下文过长）
        // ✅ 按模型上下文预算截断（优先使用用户覆盖，其次模型推断）
        const truncateResult = truncateContextByTokens(sendRefs, this.getContextTruncateLimit(options.contextLimit));

        if (truncateResult.wasTruncated) {
          console.warn(
            LOG_PREFIX,
            'Context truncated:',
            `original=${truncateResult.originalTokens} tokens,`,
            `final=${truncateResult.finalTokens} tokens,`,
            `removed=${truncateResult.removedCount} refs`
          );
          this.notifyContextTruncated(truncateResult.removedCount);
        }

        userContextRefs = truncateResult.truncatedRefs;

        // ★ 文档28 Prompt10：保存 pathMap 用于传递给后端和更新 store
        if (Object.keys(pathMap).length > 0) {
          contextPathMap = pathMap;
          this.store.updateMessagePathMap(userMessageId, pathMap);
        }
      }

      // 🔧 2026-01-15: 超时机制已移除

      // 🆕 获取当前工作区 ID（多 Agent 协作）
      const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;

      // 5. 调用后端（传递前端生成的消息 ID）
      const request: SendMessageRequest = {
        sessionId: this.sessionId,
        content,
        // 🆕 附件已通过 userContextRefs 传递，不再使用 attachments 字段
        options,
        // 传递前端生成的消息 ID，后端必须使用这些 ID
        userMessageId,
        assistantMessageId,
        userContextRefs, // 🆕 统一上下文注入（包含附件）
        pathMap: contextPathMap, // ★ 文档28 Prompt10：传递路径映射给后端保存
        workspaceId: currentWorkspaceId ?? undefined, // 🆕 工作区 ID（多 Agent 协作）
      };

      const requestAudit = buildAttachmentRequestAudit(request, {
        source: 'frontend',
        modelId: options.modelId,
        isMultimodalModel,
      });
      logAttachment('adapter', 'send_request_audit_frontend', requestAudit as unknown as Record<string, unknown>, requestAudit.expectation.expectationMet ? 'success' : 'warning');

      const returnedAssistantMessageId = await invoke<string>('chat_v2_send_message', {
        request,
      });

      // 发送成功后才清空多变体 ID，确保失败时用户可以重试
      this.store.setPendingParallelModelIds(null);

      console.log(
        LOG_PREFIX,
        'Message sent, assistant message ID:',
        returnedAssistantMessageId,
        '(expected:',
        assistantMessageId,
        ')'
      );

      // 5. 验证 ID 一致性（后端应返回相同的 ID）
      if (returnedAssistantMessageId && returnedAssistantMessageId !== assistantMessageId) {
        console.warn(
          LOG_PREFIX,
          'Backend returned different assistant message ID:',
          returnedAssistantMessageId,
          'expected:',
          assistantMessageId
        );
        // 更新为后端返回的 ID（兼容旧版本后端）
        this.store.setCurrentStreamingMessage(returnedAssistantMessageId);
      }
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'Send message failed:', errorMsg);
      // 尝试恢复状态
      try {
        await this.store.abortStream();
      } catch {
        // 忽略恢复失败
      }
      // 显示错误提示（使用 i18n）
      const sendFailedMsg = i18n.t('chatV2:error.sendFailed');
      showGlobalNotification('error', `${sendFailedMsg}: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * 执行发送消息（内部方法，供 callback 使用）
   * 
   * 与 sendMessage 的区别：使用调用方传入的消息 ID，而不是自己生成。
   * 这确保了 Store.sendMessage() 生成的 ID 与后端使用的 ID 一致。
   */
  private async executeSendMessage(
    content: string,
    attachments: AttachmentMeta[] | undefined,
    userMessageId: string,
    assistantMessageId: string
  ): Promise<void> {
    console.log(LOG_PREFIX, 'Executing sendMessage:', { content: content.substring(0, 50), userMessageId, assistantMessageId });

    try {
      // 🔧 重置事件桥接状态（确保序列号从 0 开始）
      resetBridgeState(this.sessionId);

      // ========== 🆕 统一上下文注入（必须在 sendMessageWithIds 之前获取） ==========
      // 0. 先获取 pendingContextRefs（sendMessageWithIds 会清空它们）
      // ★ 使用 storeApi 获取最新状态，this.store 是构造时的快照，不是响应式的
      let pendingContextRefs = getPendingContextRefs(this.storeApi ?? this.store);
      logAttachment('adapter', 'get_pending_context_refs', {
        count: pendingContextRefs.length,
        refs: pendingContextRefs.map(r => ({ resourceId: r.resourceId, typeId: r.typeId, hash: r.hash })),
      });

      // 🆕 P1 修复：验证并清理已删除的资源引用
      // 在发送前检查资源是否仍然存在，移除无效引用
      if (pendingContextRefs.length > 0) {
        pendingContextRefs = await validateAndCleanupContextRefs(
          this.storeApi ?? this.store,
          pendingContextRefs,
          { notifyUser: true, logDetails: true }
        );
        console.log(LOG_PREFIX, 'After validation:', pendingContextRefs.length, 'valid refs');
      }

      // 1. 使用指定 ID 更新本地状态（这会清空 pendingContextRefs）
      await this.store.sendMessageWithIds(
        content,
        attachments,
        userMessageId,
        assistantMessageId
      );

      // 2. 构建发送选项（包含 parallelModelIds）
      const activeModelId = this.getCurrentState().chatParams.modelId;
      await this.ensureModelMetadataReady(activeModelId);
      const options = this.buildSendOptions();

      // 🔧 调试打点：发送消息时的状态
      if (options.parallelModelIds && options.parallelModelIds.length >= 2) {
        logMultiVariant('adapter', 'executeSendMessage', {
          userMessageId,
          assistantMessageId,
          parallelModelIds: options.parallelModelIds,
          isMultiVariant: true,
        }, 'success');
      }

      // 注意：不在这里清空 pendingParallelModelIds，等待发送成功后再清空
      // 这样如果发送失败，用户可以重试而不会丢失多变体配置

      // ========== 🆕 统一上下文注入 ==========
      // 附件已通过 pendingContextRefs 处理，不再使用旧的 attachments 字段

      // 3. 构建 SendContextRef[]（按优先级排序，获取资源内容，调用 formatToBlocks）
      // ★ 根据当前模型的多模态能力决定注入图片还是文本
      // ★ 文档28 Prompt10：使用 buildSendContextRefsWithPaths 获取 pathMap
      let userContextRefs = undefined;
      let contextPathMap: Record<string, string> | undefined;
      let isMultimodalModel = false;
      // 🔧 2026-02-22: 过滤掉 skill_instruction 类型 refs
      // 技能内容改由后端 auto-load_skills 工具结果投递（role: tool），不再注入 user message
      const refsForUserMessage2 = pendingContextRefs.filter(
        (ref) => ref.typeId !== SKILL_INSTRUCTION_TYPE_ID
      );
      if (refsForUserMessage2.length > 0) {
        console.log(LOG_PREFIX, 'Building SendContextRefs for', refsForUserMessage2.length, 'refs (filtered', pendingContextRefs.length - refsForUserMessage2.length, 'skill_instruction refs)');
        const currentModelId = this.getCurrentState().chatParams.modelId;
        // ★ 2026-02 修复：使用异步版本确保模型缓存已加载
        const isMultimodal = await isModelMultimodalAsync(currentModelId);
        isMultimodalModel = isMultimodal;
        console.debug('[TauriAdapter] send: model =', currentModelId, 'isMultimodal =', isMultimodal);
        const { sendRefs, pathMap } = await buildSendContextRefsWithPaths(refsForUserMessage2, { isMultimodal });

        // 3.1 Token 预估和截断（基于模型预算，防止上下文过长）
        const contextTokenLimit = this.getContextTruncateLimit(options.contextLimit);
        const truncateResult = truncateContextByTokens(sendRefs, contextTokenLimit);

        if (truncateResult.wasTruncated) {
          // 发生截断，记录警告日志
          console.warn(
            LOG_PREFIX,
            'Context truncated:',
            `original=${truncateResult.originalTokens} tokens,`,
            `final=${truncateResult.finalTokens} tokens,`,
            `removed=${truncateResult.removedCount} refs,`,
            `kept=${truncateResult.truncatedRefs.length} refs`
          );

          this.notifyContextTruncated(truncateResult.removedCount);
        } else {
          // 未截断，记录 debug 日志
          console.log(
            LOG_PREFIX,
            'Context within token limit:',
            `${truncateResult.finalTokens} / ${contextTokenLimit} tokens,`,
            `${sendRefs.length} refs`
          );
        }

        // 使用截断后的 sendRefs
        userContextRefs = truncateResult.truncatedRefs;
        logSendContextRefsSummary(userContextRefs);

        // 🔧 修复：同步更新 contextSnapshot，确保与截断后的请求一致
        const keptContextRefs = userContextRefs.map((ref) => ({
          resourceId: ref.resourceId,
          hash: ref.hash,
          typeId: ref.typeId,
          displayName: ref.displayName,
          injectModes: ref.injectModes,
        }));
        const keptResourceIds = new Set(keptContextRefs.map((ref) => ref.resourceId));
        const filteredPathMap = Object.fromEntries(
          Object.entries(pathMap).filter(([resourceId]) => keptResourceIds.has(resourceId))
        );
        const contextSnapshot = keptContextRefs.length > 0
          ? {
              userRefs: keptContextRefs,
              retrievalRefs: [],
              ...(Object.keys(filteredPathMap).length > 0 ? { pathMap: filteredPathMap } : {}),
            }
          : undefined;
        this.store.updateMessageMeta(userMessageId, { contextSnapshot });

        // ★ 文档28 Prompt10：保存 pathMap 用于传递给后端和更新 store
        if (Object.keys(filteredPathMap).length > 0) {
          contextPathMap = filteredPathMap;
          this.store.updateMessagePathMap(userMessageId, filteredPathMap);
        }

        // 3.2 收集上下文类型 Hints（用于 System Prompt 中声明 XML 标签含义）
        // Schema 工具 ID 已在 buildSendOptions 中通过 collectSchemaToolIds 统一收集
        const contextTypeHints = collectContextTypeHints(keptContextRefs);
        if (contextTypeHints.length > 0) {
          options.contextTypeHints = contextTypeHints;
          console.log(LOG_PREFIX, 'Context type hints:', contextTypeHints.length, 'hints');
        }
      }

      // ========== 🆕 统一上下文注入结束 ==========

      // 🔧 2026-01-15: 超时机制已移除

      // 🆕 获取当前工作区 ID（多 Agent 协作）
      const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;

      // 5. 调用后端
      const request: SendMessageRequest = {
        sessionId: this.sessionId,
        content,
        // 🆕 附件已通过 userContextRefs 传递，不再使用 attachments 字段
        options,
        userMessageId,
        assistantMessageId,
        userContextRefs, // 🆕 统一上下文注入（包含附件）
        pathMap: contextPathMap, // ★ 文档28 Prompt10：传递路径映射给后端保存
        workspaceId: currentWorkspaceId ?? undefined, // 🆕 工作区 ID（多 Agent 协作）
      };

      const requestAudit = buildAttachmentRequestAudit(request, {
        source: 'frontend',
        modelId: options.modelId,
        isMultimodalModel,
      });
      logAttachment('adapter', 'send_request_audit_frontend', requestAudit as unknown as Record<string, unknown>, requestAudit.expectation.expectationMet ? 'success' : 'warning');

      const returnedAssistantMessageId = await invoke<string>('chat_v2_send_message', {
        request,
      });

      // 发送成功后才清空多变体 ID，确保失败时用户可以重试
      this.store.setPendingParallelModelIds(null);

      // 🆕 开发者调试：保存完整请求体到助手消息的元数据
      // ★ 2026-02-14: 如果后端已推送真实 LLM 请求体（_source='backend_llm'），则不覆盖
      const existingMeta = this.getCurrentState().messageMap.get(assistantMessageId)?._meta;
      const existingRaw = existingMeta?.rawRequest as { _source?: string } | undefined;
      if (!existingRaw || existingRaw._source !== 'backend_llm') {
        this.store.updateMessageMeta(assistantMessageId, { rawRequest: request });
      }

      console.log(LOG_PREFIX, 'Message sent, assistant ID:', returnedAssistantMessageId);

      // 6. 验证 ID 一致性
      if (returnedAssistantMessageId && returnedAssistantMessageId !== assistantMessageId) {
        console.warn(LOG_PREFIX, 'Backend returned different ID:', returnedAssistantMessageId);
        this.store.setCurrentStreamingMessage(returnedAssistantMessageId);
      }
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'Execute sendMessage failed:', errorMsg);
      try {
        await this.store.abortStream();
      } catch {
        // 忽略恢复失败
      }
      const sendFailedMsg = i18n.t('chatV2:error.sendFailed');
      showGlobalNotification('error', `${sendFailedMsg}: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * 中断流式（外部 API）
   * 
   * 🔧 P0修复：统一通过 Store 中断，后端调用由回调处理
   * 
   * 调用路径：
   * 1. adapter.abortStream() → store.abortStream()
   * 2. store.abortStream() → _abortCallback() → executeAbort() (后端)
   * 3. store.abortStream() → 更新本地状态
   */
  async abortStream(): Promise<void> {
    console.log(LOG_PREFIX, 'Aborting stream...');

    try {
      // 直接调用 Store 的 abortStream，它会通过回调通知后端
      await this.store.abortStream();
      console.log(LOG_PREFIX, 'Stream aborted');
    } catch (error) {
      console.error(LOG_PREFIX, 'Abort stream failed:', getErrorMessage(error));
      // 强制重置前端状态
      console.warn(LOG_PREFIX, 'Forcing frontend state reset');
      this.store.forceResetToIdle?.();
      throw error;
    }
  }

  /**
   * 执行中断操作（内部方法，供 callback 使用）
   * 仅通知后端取消，不更新本地状态（由 Store 的 abortStream 处理）
   * 
   * 包含超时保护机制：如果后端取消请求超过 10 秒未响应，
   * 静默超时让调用方继续执行。
   */
  private async executeAbort(): Promise<void> {
    console.log(LOG_PREFIX, 'Execute abort (backend only)...');

    // 超时时间（毫秒）- 文档规定 10 秒
    const ABORT_TIMEOUT_MS = 10_000;

    // 🔧 2026-01-15: 超时机制已移除

    // 获取当前流式消息 ID（使用 getCurrentState 获取最新状态）
    const currentMessageId = this.getCurrentState().currentStreamingMessageId;
    if (!currentMessageId) {
      console.warn(LOG_PREFIX, 'No streaming message to abort');
      return;
    }

    try {
      // 带超时保护地通知后端取消
      const backendAbort = invoke('chat_v2_cancel_stream', {
        sessionId: this.sessionId,
        messageId: currentMessageId,
      });

      // 创建超时 Promise
      const timeout = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), ABORT_TIMEOUT_MS);
      });

      // 使用 Promise.race 实现超时保护
      const result = await Promise.race([
        backendAbort.then(() => 'success' as const),
        timeout,
      ]);

      if (result === 'timeout') {
        console.warn(
          LOG_PREFIX,
          `Abort backend timeout after ${ABORT_TIMEOUT_MS}ms`
        );
      } else {
        console.log(LOG_PREFIX, 'Backend abort successful');
      }
    } catch (error) {
      console.error(LOG_PREFIX, 'Backend abort failed:', getErrorMessage(error));
      // 不抛出错误，让 Store 继续更新本地状态
    }
  }

  /**
   * 执行重试操作（内部方法，供 callback 使用）
   * 🆕 P1 状态同步修复: 返回完整的 RetryMessageResult
   * @returns 重试结果，包含消息 ID 和状态变更信息
   */
  private async executeRetry(
    messageId: string,
    modelOverride?: string
  ): Promise<RetryMessageResult> {
    console.log(LOG_PREFIX, 'Executing retry for message:', messageId, 'model override:', modelOverride);

    try {
      // 🔧 修复：重置事件桥接状态（确保序列号从 0 开始，与 executeSendMessage 保持一致）
      resetBridgeState(this.sessionId);

      const activeModelId = this.getCurrentState().chatParams.modelId;
      await this.ensureModelMetadataReady(activeModelId);
      const options = this.buildSendOptions();
      if (modelOverride) {
        options.modelId = modelOverride;
      }

      // 🔧 2026-01-15: 超时机制已移除

      // 🆕 P1 状态同步修复: 后端返回增强的结果，包含状态变更信息
      const result = await invoke<{
        message_id?: string;
        new_variant_id?: string;
        deleted_variant_ids?: string[];
      }>('chat_v2_retry_message', {
        sessionId: this.sessionId,
        messageId,
        options,
      });

      // 发送成功后清空多变体 ID
      this.store.setPendingParallelModelIds(null);

      const returnedMessageId = result.message_id ?? messageId;
      const newVariantId = result.new_variant_id;
      const deletedVariantIds = result.deleted_variant_ids ?? [];

      console.log(LOG_PREFIX, 'Retry initiated:', {
        messageId: returnedMessageId,
        newVariantId,
        deletedVariantIds: deletedVariantIds.length,
      });

      // 🆕 P1 状态同步修复: 返回完整的状态变更信息
      return {
        success: true,
        messageId: returnedMessageId,
        newVariantId,
        deletedVariantIds: deletedVariantIds.length > 0 ? deletedVariantIds : undefined,
      };
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'Retry failed:', errorMsg);
      // 显示错误提示（使用 i18n）
      const retryFailedMsg = i18n.t('chatV2:messageItem.actions.retryFailed');
      showGlobalNotification('error', `${retryFailedMsg}: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * 重试消息（公开方法）
   * 
   * @deprecated 推荐通过 store.retryMessage() 调用，会自动使用注入的回调
   * 
   * 此方法仅作为后备使用，正常流程应该是：
   * store.retryMessage() -> _retryCallback -> executeRetry()
   */
  async retryMessage(messageId: string, modelOverride?: string): Promise<void> {
    console.log(LOG_PREFIX, 'Retrying message (direct call):', messageId, 'model override:', modelOverride);
    console.warn(
      LOG_PREFIX,
      'retryMessage() called directly. Prefer using store.retryMessage() instead.'
    );

    try {
      // 通过 store 的 retryMessage 方法处理
      // 它会自动调用注入的 _retryCallback（即 executeRetry）
      // 并正确更新本地状态和启动超时监控
      await this.store.retryMessage(messageId, modelOverride);

      console.log(LOG_PREFIX, 'Retry completed:', messageId);
    } catch (error) {
      console.error(LOG_PREFIX, 'Retry message failed:', getErrorMessage(error));
      throw error;
    }
  }

  /**
   * 编辑并重发消息（公开方法）
   * 
   * @deprecated 推荐通过 store.editAndResend() 调用，会自动使用注入的回调
   * 
   * 此方法仅作为后备使用，正常流程应该是：
   * store.editAndResend() -> _editAndResendCallback -> executeEditAndResend()
   */
  async editAndResend(messageId: string, newContent: string): Promise<void> {
    console.log(LOG_PREFIX, 'Edit and resend (direct call):', messageId);
    console.warn(
      LOG_PREFIX,
      'editAndResend() called directly. Prefer using store.editAndResend() instead.'
    );

    try {
      // 通过 store 的 editAndResend 方法处理
      // 它会自动调用注入的 _editAndResendCallback（即 executeEditAndResend）
      // 并正确更新本地状态和启动超时监控
      await this.store.editAndResend(messageId, newContent);

      console.log(LOG_PREFIX, 'Edit and resend completed:', messageId);
    } catch (error) {
      console.error(LOG_PREFIX, 'Edit and resend failed:', getErrorMessage(error));
      throw error;
    }
  }

  /**
   * 执行删除操作（内部方法，供 callback 使用）
   */
  private async executeDelete(messageId: string): Promise<void> {
    console.log(LOG_PREFIX, 'Executing delete for message:', messageId);

    try {
      await invoke('chat_v2_delete_message', {
        sessionId: this.sessionId,
        messageId,
      });

      console.log(LOG_PREFIX, 'Message deleted from backend:', messageId);
    } catch (error) {
      console.error(LOG_PREFIX, 'Delete message failed:', getErrorMessage(error));
      throw error;
    }
  }

  /**
   * 删除消息（公开方法）
   * 
   * @deprecated 推荐通过 store.deleteMessage() 调用，会自动使用注入的回调
   * 
   * 此方法仅作为后备使用，正常流程应该是：
   * store.deleteMessage() -> _deleteCallback -> executeDelete()
   */
  async deleteMessage(messageId: string): Promise<void> {
    console.log(LOG_PREFIX, 'Deleting message (direct call):', messageId);
    console.warn(
      LOG_PREFIX,
      'deleteMessage() called directly. Prefer using store.deleteMessage() instead.'
    );

    try {
      // 通过 store 的 deleteMessage 方法处理
      // 它会自动调用注入的 _deleteCallback（即 executeDelete）
      // 并正确更新本地状态
      await this.store.deleteMessage(messageId);

      console.log(LOG_PREFIX, 'Message deleted:', messageId);
    } catch (error) {
      console.error(LOG_PREFIX, 'Delete message failed:', getErrorMessage(error));
      throw error;
    }
  }

  /**
   * 执行编辑并重发操作（内部方法，供 callback 使用）
   * 🆕 P1-2: 支持传递新的上下文引用
   * 🆕 P1 状态同步修复: 返回完整的 EditMessageResult
   * @returns 编辑结果，包含新消息 ID 和状态变更信息
   */
  private async executeEditAndResend(
    messageId: string,
    newContent: string,
    newContextRefs?: ContextRef[]
  ): Promise<EditMessageResult> {
    console.log(LOG_PREFIX, 'Executing editAndResend for message:', messageId, 'newContextRefs:', newContextRefs?.length ?? 0);

    try {
      // 🔧 修复：重置事件桥接状态（确保序列号从 0 开始，与 executeSendMessage 保持一致）
      resetBridgeState(this.sessionId);

      const activeModelId = this.getCurrentState().chatParams.modelId;
      await this.ensureModelMetadataReady(activeModelId);
      const options = this.buildSendOptions();

      // 🔧 2026-01-15: 超时机制已移除

      // 🆕 P1-2: 如果有新的上下文引用，构建 SendContextRef[]
      // ★ 根据当前模型的多模态能力决定注入图片还是文本
      // 注意：editAndResend 的新消息由后端创建，pathMap 在后端保存时处理
      let newContextRefsForBackend = undefined;
      let newPathMap: Record<string, string> | undefined;
      if (newContextRefs && newContextRefs.length > 0) {
        // 🆕 P1 修复：验证并清理已删除的资源引用
        const validContextRefs = await validateAndCleanupContextRefs(
          this.storeApi ?? this.store,
          newContextRefs,
          { notifyUser: true, logDetails: true }
        );
        console.log(LOG_PREFIX, 'Building SendContextRefs for editAndResend:', validContextRefs.length, '(validated from', newContextRefs.length, ')');
        
        if (validContextRefs.length > 0) {
          const currentModelId = this.getCurrentState().chatParams.modelId;
          // ★ 2026-02 修复：使用异步版本确保模型缓存已加载
          const isMultimodal = await isModelMultimodalAsync(currentModelId);
          const { sendRefs, pathMap } = await buildSendContextRefsWithPaths(validContextRefs, { isMultimodal });

          // Token 预估和截断（基于模型预算，防止上下文过长）
          const contextTokenLimit = this.getContextTruncateLimit(options.contextLimit);
          const truncateResult = truncateContextByTokens(sendRefs, contextTokenLimit);

          if (truncateResult.wasTruncated) {
            console.warn(
              LOG_PREFIX,
              'Context truncated for editAndResend:',
              `original=${truncateResult.originalTokens} tokens,`,
              `final=${truncateResult.finalTokens} tokens,`,
              `removed=${truncateResult.removedCount} refs`
            );
            this.notifyContextTruncated(truncateResult.removedCount);
          }

          newContextRefsForBackend = truncateResult.truncatedRefs;
          newPathMap = Object.keys(pathMap).length > 0 ? pathMap : undefined;
          if (newPathMap) {
            console.log(LOG_PREFIX, 'PathMap for editAndResend:', Object.keys(newPathMap).length, 'entries');
          }
        }
      }

      // 🆕 P1 状态同步修复: 后端返回增强的结果，包含状态变更信息
      const result = await invoke<{
        new_message_id?: string;
        deleted_message_ids?: string[];
        new_variant_id?: string;
      }>('chat_v2_edit_and_resend', {
        sessionId: this.sessionId,
        messageId,
        newContent,
        // 🆕 P1-2: 传递新的上下文引用给后端
        newContextRefs: newContextRefsForBackend,
        options,
      });

      // 发送成功后清空多变体 ID
      this.store.setPendingParallelModelIds(null);

      const newMessageId = result.new_message_id ?? null;
      const deletedMessageIds = result.deleted_message_ids ?? [];
      const newVariantId = result.new_variant_id;

      console.log(LOG_PREFIX, 'Edit and resend initiated:', {
        newMessageId,
        deletedMessageIds: deletedMessageIds.length,
        newVariantId,
      });

      // 🆕 P1 状态同步修复: 返回完整的状态变更信息
      return {
        success: true,
        newMessageId: newMessageId ?? undefined,
        deletedMessageIds: deletedMessageIds.length > 0 ? deletedMessageIds : undefined,
        newVariantId,
      };
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'Edit and resend failed:', errorMsg);
      // 显示错误提示（使用 i18n）
      const editFailedMsg = i18n.t('chatV2:messageItem.actions.editFailed');
      showGlobalNotification('error', `${editFailedMsg}: ${errorMsg}`);
      // 🆕 P1 状态同步修复: 返回失败结果而不是抛出异常
      // 让 Store 有机会处理失败情况
      throw error;
    }
  }

  // ========================================================================
  // 🆕 消息内继续执行
  // ========================================================================

  /**
   * 继续执行中断的消息
   * 
   * 当消息因网络错误、LLM 超时等原因中断，但有未完成的 TODO 列表时，
   * 可以调用此方法在同一条消息内继续执行。
   * 
   * @param messageId 要继续的助手消息 ID
   * @param variantId 可选的变体 ID
   */
  async continueMessage(messageId: string, variantId?: string): Promise<void> {
    console.log(LOG_PREFIX, 'Continue message:', messageId, 'variant:', variantId);

    try {
      // 重置事件桥接状态
      resetBridgeState(this.sessionId);

      const activeModelId = this.getCurrentState().chatParams.modelId;
      await this.ensureModelMetadataReady(activeModelId);
      const options = this.buildSendOptions();

      // 标记正在继续执行
      this.store.setCurrentStreamingMessage(messageId);

      const resultMessageId = await invoke<string>('chat_v2_continue_message', {
        sessionId: this.sessionId,
        messageId,
        variantId,
        options,
      });

      console.log(LOG_PREFIX, 'Continue message initiated:', resultMessageId);
      
      // 更新流式消息 ID
      if (resultMessageId && resultMessageId !== messageId) {
        this.store.setCurrentStreamingMessage(resultMessageId);
      }
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'Continue message failed:', errorMsg);
      // 清除流式状态
      // 🔧 修复：同时清除 stale currentStreamingMessageId（completeStream 在 idle 时不清除它）
      this.store.completeStream('error');
      this.store.setCurrentStreamingMessage(null);
      // 🔧 修复：不在此处显示通知，让 store.continueMessage 的 fallback（sendMessage）处理
      // 原代码在此显示 "继续执行失败" 通知，但 store 会 fallback 到 sendMessage('继续')，
      // 导致用户看到一个无意义的错误通知
      throw error;
    }
  }

  // ========================================================================
  // 会话操作
  // ========================================================================

  /**
   * 加载会话
   */
  async loadSession(): Promise<void> {
    console.log(LOG_PREFIX, 'Loading session:', this.sessionId);

    // 📊 性能打点：backend_load_start
    sessionSwitchPerf.mark('backend_load_start');
    const t0 = performance.now();

    try {
      // 📊 细粒度打点：invoke 开始
      sessionSwitchPerf.mark('load_invoke_start');
      
      const response = await invoke<LoadSessionResponseType>('chat_v2_load_session', {
        sessionId: this.sessionId,
      });
      const invokeMs = performance.now() - t0;

      // 📊 细粒度打点：invoke 返回
      // 估算 response 体量（避免 JSON.stringify 阻塞主线程）
      const msgCount = response.messages?.length || 0;
      const blkCount = response.blocks?.length || 0;
      const responseSizeEstimate = msgCount * 500 + blkCount * 1000;
      sessionSwitchPerf.mark('load_invoke_end', {
        messageCount: msgCount,
        blockCount: blkCount,
        invokeMs,
        responseSizeKB: Math.round(responseSizeEstimate / 1024),
      });
      
      // 📊 性能打点：backend_load_end
      sessionSwitchPerf.mark('backend_load_end', {
        messageCount: msgCount,
        blockCount: blkCount,
        invokeMs,
      });

      console.log(LOG_PREFIX, 'Session loaded:', {
        messageCount: msgCount,
        blockCount: blkCount,
        invokeMs,
      });

      // 🆕 P37 调试：记录会话加载中的 workspace_status 块
      const logDebug = (window as any).__multiAgentDebug?.log;
      if (logDebug) {
        const blocks = response.blocks || [];
        const workspaceStatusBlocks = blocks.filter((b: any) => b.type === 'workspace_status');
        const messages = response.messages || [];
        
        // 检查消息是否关联了 workspace_status 块
        const messagesWithWsBlocks = messages.filter((m: any) => 
          m.blockIds?.some((id: string) => workspaceStatusBlocks.some((b: any) => b.id === id))
        );

        logDebug('block', 'LOAD_SESSION_RESULT', {
          sessionId: this.sessionId,
          totalBlocks: blocks.length,
          workspaceStatusBlocks: workspaceStatusBlocks.length,
          workspaceStatusBlockIds: workspaceStatusBlocks.map((b: any) => b.id),
          messagesWithWsBlocks: messagesWithWsBlocks.length,
          blockDetails: workspaceStatusBlocks.map((b: any) => ({
            id: b.id,
            messageId: b.messageId,
            type: b.type,
            hasToolOutput: !!b.toolOutput,
            snapshotAgents: b.toolOutput?.snapshotAgents?.length || 0,
          })),
        }, workspaceStatusBlocks.length > 0 ? 'success' : 'warning');
      }

      // 📊 性能打点：restore_start
      sessionSwitchPerf.mark('restore_start');

      // 使用 Store 的 restoreFromBackend 方法恢复状态
      this.store.restoreFromBackend(response);

      // 📊 性能打点：restore_end
      const totalMs = performance.now() - t0;
      sessionSwitchPerf.mark('restore_end', { totalMs });
      console.log(LOG_PREFIX, 'Session restore finished', { totalMs });
      
      // 🚀 性能优化：在 restoreFromBackend 后立即触发回调，不等待 await
      // 这允许 AdapterManager 立即标记 isReady，避免 React 渲染阻塞微任务队列
      if (this.onDataRestored) {
        this.onDataRestored();
      }
    } catch (error) {
      console.error(LOG_PREFIX, 'Load session failed:', getErrorMessage(error));
      throw error;
    }
  }

  /**
   * 保存会话状态
   *
   * 构建 SessionState 对象传递给后端，包含：
   * - chatParams: 对话参数
   * - features: 功能开关 Map
   * - modeState: 模式特定状态
   * - inputValue: 输入框草稿
   * - panelStates: 面板开关状态
   */
  async saveSession(): Promise<void> {
    console.log(LOG_PREFIX, 'Saving session:', this.sessionId);

    if (!isTauriRuntimeAvailable()) {
      console.warn(LOG_PREFIX, 'Skip save session: not in Tauri runtime');
      return;
    }

    try {
      // 从 store 构建 session_state（使用 getCurrentState 获取最新状态）
      const state = this.getCurrentState();
      
      // 🔧 笔记引用持久化
      const modeStateWithCanvas = state.modeState;
      
      // 🆕 Prompt 7: 序列化待发送的上下文引用
      const pendingContextRefsJson = state.pendingContextRefs.length > 0
        ? JSON.stringify(state.pendingContextRefs)
        : null;

      // 🆕 渐进披露：序列化已加载的 Skill IDs
      const { getLoadedSkills } = await import('../skills/progressiveDisclosure');
      const loadedSkills = getLoadedSkills(this.sessionId);
      const loadedSkillIdsJson = loadedSkills.length > 0
        ? JSON.stringify(loadedSkills.map(s => s.id))
        : null;

      const sessionState = {
        sessionId: this.sessionId,
        chatParams: state.chatParams,
        features: Object.fromEntries(state.features),
        modeState: modeStateWithCanvas,
        inputValue: state.inputValue || null,
        panelStates: state.panelStates,
        pendingContextRefsJson, // 🆕 Prompt 7: 上下文引用持久化
        loadedSkillIdsJson, // 🆕 渐进披露：已加载 Skills 持久化
        activeSkillIdsJson: state.activeSkillIds.length > 0 ? JSON.stringify(state.activeSkillIds) : null, // 🆕 手动激活 Skills 持久化（多选）
        updatedAt: new Date().toISOString(),
      };

      await invoke('chat_v2_save_session', {
        sessionId: this.sessionId,
        sessionState,
      });

      console.log(LOG_PREFIX, 'Session saved');
    } catch (error) {
      console.error(LOG_PREFIX, 'Save session failed:', getErrorMessage(error));
      throw error;
    }
  }

  /**
   * 创建新会话
   */
  async createSession(
    mode: string,
    title?: string
  ): Promise<string> {
    console.log(LOG_PREFIX, 'Creating session:', { mode, title });

    try {
      const session = await invoke<{ id: string }>('chat_v2_create_session', {
        mode,
        title,
        metadata: null,
      });

      console.log(LOG_PREFIX, 'Session created:', session.id);
      return session.id;
    } catch (error) {
      console.error(LOG_PREFIX, 'Create session failed:', getErrorMessage(error));
      throw error;
    }
  }

  /**
   * 更新会话设置
   */
  async updateSessionSettings(settings: SessionSettings): Promise<void> {
    console.log(LOG_PREFIX, 'Updating session settings:', settings);

    try {
      await invoke('chat_v2_update_session_settings', {
        sessionId: this.sessionId,
        settings,
      });

      console.log(LOG_PREFIX, 'Session settings updated');
    } catch (error) {
      console.error(LOG_PREFIX, 'Update session settings failed:', getErrorMessage(error));
      throw error;
    }
  }

  /**
   * 归档会话
   */
  async archiveSession(): Promise<void> {
    console.log(LOG_PREFIX, 'Archiving session:', this.sessionId);

    try {
      await invoke('chat_v2_archive_session', {
        sessionId: this.sessionId,
      });

      console.log(LOG_PREFIX, 'Session archived');
    } catch (error) {
      console.error(LOG_PREFIX, 'Archive session failed:', getErrorMessage(error));
      throw error;
    }
  }

  // ========================================================================
  // 变体操作
  // ========================================================================

  /**
   * 执行切换变体操作（内部方法，供 callback 使用）
   */
  private async executeSwitchVariant(
    messageId: string,
    variantId: string
  ): Promise<void> {
    console.log(LOG_PREFIX, 'Executing switch variant:', messageId, '->', variantId);

    try {
      await invoke('chat_v2_switch_variant', {
        messageId,
        variantId,
      });

      console.log(LOG_PREFIX, 'Variant switched successfully:', variantId);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'Switch variant failed:', errorMsg);
      throw error;
    }
  }

  /**
   * 执行删除变体操作（内部方法，供 callback 使用）
   * @returns 删除结果，包含新的激活变体 ID
   */
  private async executeDeleteVariant(
    messageId: string,
    variantId: string
  ): Promise<{ variantDeleted?: boolean; messageDeleted?: boolean; newActiveId?: string }> {
    console.log(LOG_PREFIX, 'Executing delete variant:', messageId, '->', variantId);

    try {
      const result = await invoke<{
        deletedVariantId: string;
        remainingCount: number;
        newActiveVariantId: string | null;
      }>('chat_v2_delete_variant', {
        messageId,
        variantId,
      });

      console.log(LOG_PREFIX, 'Variant deleted successfully:', result);

      return {
        variantDeleted: true,
        messageDeleted: false,
        newActiveId: result.newActiveVariantId ?? undefined,
      };
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'Delete variant failed:', errorMsg);
      throw error;
    }
  }

  /**
   * 执行重试变体操作（内部方法，供 callback 使用）
   */
  private async executeRetryVariant(
    messageId: string,
    variantId: string,
    modelOverride?: string
  ): Promise<void> {
    console.log(LOG_PREFIX, 'Executing retry variant:', messageId, '->', variantId, 'model:', modelOverride);

    try {
      // 🔧 修复：重置事件桥接状态（确保序列号从 0 开始，与 executeSendMessage 保持一致）
      resetBridgeState(this.sessionId);

      const activeModelId = this.getCurrentState().chatParams.modelId;
      await this.ensureModelMetadataReady(activeModelId);
      const options = this.buildSendOptions();
      if (modelOverride) {
        options.modelId = modelOverride;
      }

      // 🔧 2026-01-15: 超时机制已移除

      await invoke('chat_v2_retry_variant', {
        messageId,
        variantId,
        modelOverride: modelOverride ?? null,
        options,
      });

      // 发送成功后清空多变体 ID
      this.store.setPendingParallelModelIds(null);

      console.log(LOG_PREFIX, 'Variant retry initiated:', variantId);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'Retry variant failed:', errorMsg);
      throw error;
    }
  }

  /**
   * 执行批量重试变体操作（内部方法，供 callback 使用）
   */
  private async executeRetryAllVariants(
    messageId: string,
    variantIds: string[]
  ): Promise<void> {
    console.log(
      LOG_PREFIX,
      'Executing retry all variants:',
      messageId,
      'variants:',
      variantIds.length
    );

    try {
      // 🔧 批量重试仅需重置一次事件桥接状态
      resetBridgeState(this.sessionId);

      const activeModelId = this.getCurrentState().chatParams.modelId;
      await this.ensureModelMetadataReady(activeModelId);
      const options = this.buildSendOptions();

      await invoke('chat_v2_retry_variants', {
        messageId,
        variantIds,
        options,
      });

      // 发送成功后清空多变体 ID
      this.store.setPendingParallelModelIds(null);

      console.log(LOG_PREFIX, 'Retry all variants initiated:', variantIds.length);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'Retry all variants failed:', errorMsg);
      throw error;
    }
  }

  /**
   * 执行取消变体操作（内部方法，供 callback 使用）
   */
  private async executeCancelVariant(variantId: string): Promise<void> {
    console.log(LOG_PREFIX, 'Executing cancel variant:', variantId);

    try {
      await invoke('chat_v2_cancel_variant', {
        sessionId: this.sessionId,
        variantId,
      });

      console.log(LOG_PREFIX, 'Variant cancelled successfully:', variantId);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'Cancel variant failed:', errorMsg);
      throw error;
    }
  }

  /**
   * 执行更新块内容操作（内部方法，供 callback 使用）
   * 用于 editMessage 后同步块内容到后端
   */
  private async executeUpdateBlockContent(blockId: string, content: string): Promise<void> {
    console.log(LOG_PREFIX, 'Executing update block content:', blockId, 'len:', content.length);

    try {
      await invoke('chat_v2_update_block_content', {
        blockId,
        content,
      });

      console.log(LOG_PREFIX, 'Block content updated successfully:', blockId);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'Update block content failed:', errorMsg);
      throw error;
    }
  }

  /**
   * 执行更新会话设置操作（内部方法，供 callback 使用）
   * 用于 setTitle 后同步设置到后端
   */
  private async executeUpdateSessionSettings(settings: { title?: string }): Promise<void> {
    console.log(LOG_PREFIX, 'Executing update session settings:', settings);

    try {
      await invoke('chat_v2_update_session_settings', {
        sessionId: this.sessionId,
        settings,
      });

      console.log(LOG_PREFIX, 'Session settings updated successfully');
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'Update session settings failed:', errorMsg);
      throw error;
    }
  }

  /**
   * 执行 UPSERT 流式块操作（内部方法，供防闪退保存使用）
   * 用于流式过程中定期保存块内容到后端
   */
  private async executeUpsertStreamingBlock(
    blockId: string,
    messageId: string,
    blockType: string,
    content: string,
    sessionId?: string
  ): Promise<void> {
    console.log(LOG_PREFIX, 'Executing upsert streaming block:', blockId, 'len:', content.length);

    try {
      await invoke('chat_v2_upsert_streaming_block', {
        blockId,
        messageId,
        blockType,
        content,
        sessionId,
      });

      console.log(LOG_PREFIX, 'Streaming block upserted successfully:', blockId);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'Upsert streaming block failed:', errorMsg);
      // 不抛出错误，防闪退保存失败不应影响流式过程
    }
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  /**
   * 从 Store 状态构建发送选项
   *
   * 集成 modeRegistry：
   * 1. 使用 buildSystemPrompt 生成系统提示
   * 2. 使用 getEnabledTools 获取启用的工具
   */
  private async ensureModelMetadataReady(modelId: string | undefined): Promise<void> {
    if (!modelId) {
      return;
    }

    try {
      await ensureModelsCacheLoaded();
    } catch (error) {
      console.warn(LOG_PREFIX, 'Failed to load model metadata cache:', getErrorMessage(error));
    }
  }

  private resolveInputContextLimit(
    modelId: string | undefined,
    maxTokens: number,
    userContextLimit: number | undefined
  ): number {
    const modelInfo = getModelInfoByConfigId(modelId);
    const modelLike =
      (typeof modelInfo?.model === 'string' ? modelInfo.model : undefined) ||
      (typeof modelInfo?.name === 'string' ? modelInfo.name : undefined) ||
      modelId ||
      '';
    const inferredModelMaxOutput =
      typeof modelInfo?.maxOutputTokens === 'number' && Number.isFinite(modelInfo.maxOutputTokens)
        ? modelInfo.maxOutputTokens
        : undefined;

    // 优先使用 ApiConfig 中用户配置/推断引擎写入的 contextWindow
    const configContextWindow =
      typeof modelInfo?.contextWindow === 'number' && modelInfo.contextWindow > 0
        ? modelInfo.contextWindow
        : undefined;

    return inferInputContextBudget({
      modelLike,
      userContextLimit,
      maxOutputTokens: Math.max(maxTokens || 0, inferredModelMaxOutput || 0),
      configContextWindow,
    });
  }

  private getContextTruncateLimit(contextLimit: number | undefined): number {
    if (typeof contextLimit === 'number' && Number.isFinite(contextLimit) && contextLimit > 0) {
      return Math.max(2048, Math.floor(contextLimit));
    }
    // 回退：基于当前模型动态计算（而非硬编码值）
    const currentState = this.getCurrentState();
    const { chatParams } = currentState;
    return this.resolveInputContextLimit(chatParams.modelId, chatParams.maxTokens, undefined);
  }

  private notifyContextTruncated(removedCount: number): void {
    showGlobalNotification('warning', i18n.t('chatV2:chat.context_truncated', { count: removedCount }));
  }
  private buildSendOptions(): SendOptions {
    // 🔧 使用 getCurrentState() 获取最新状态，而非构造时的快照
    // 这确保了 enableThinking 等用户实时修改的参数能正确传递
    const currentState = this.getCurrentState();
    const { chatParams, features, mode, modeState, sessionId, groupId, sessionMetadata } = currentState;

    // 获取模式插件（使用 getResolved 获取合并了继承链的完整插件）
    const modePlugin = modeRegistry.getResolved(mode);

    // 构建系统提示
    let systemPromptOverride: string | undefined;

    // 1) 分组 System Prompt（同步缓存）
    if (groupId) {
      const group = groupCache.get(groupId);
      if (group?.systemPrompt) {
        systemPromptOverride = group.systemPrompt;
      } else if (sessionMetadata?.groupSystemPromptSnapshot) {
        systemPromptOverride = sessionMetadata.groupSystemPromptSnapshot as string;
      }
    }

    // 2) 模式插件 System Prompt（追加）
    if (modePlugin?.buildSystemPrompt) {
      try {
        const modePrompt = modePlugin.buildSystemPrompt({
          sessionId,
          mode,
          modeState,
        });
        if (modePrompt) {
          systemPromptOverride = systemPromptOverride
            ? `${systemPromptOverride}\n\n${modePrompt}`
            : modePrompt;
        }
      } catch (error) {
        console.error(LOG_PREFIX, 'Error building system prompt:', getErrorMessage(error));
      }
    }

    // 获取模式启用的工具
    let modeEnabledTools: string[] = [];
    if (modePlugin?.getEnabledTools) {
      try {
        modeEnabledTools = modePlugin.getEnabledTools(this.store);
      } catch (error) {
        console.error(LOG_PREFIX, 'Error getting enabled tools:', getErrorMessage(error));
      }
    } else if (modePlugin?.config.enabledTools) {
      // 如果没有 getEnabledTools 方法，使用配置中的静态工具列表
      modeEnabledTools = modePlugin.config.enabledTools;
    }

    // 根据模式工具配置覆盖功能开关
    const ragEnabled = features.get('rag') ?? modeEnabledTools.includes('rag');
    const memoryEnabled = features.get('userMemory') ?? modeEnabledTools.includes('memory');
    const webSearchEnabled = features.get('webSearch') ?? modeEnabledTools.includes('web_search');
    const ankiEnabled = features.get('anki') ?? modeEnabledTools.includes('anki');

    // pendingParallelModelIds 也从 currentState 获取（保持一致性）
    const parallelIds = currentState.pendingParallelModelIds;
    const contextLimit = this.resolveInputContextLimit(
      chatParams.modelId,
      chatParams.maxTokens,
      chatParams.contextLimit
    );

    const options = {
      // ChatParams
      modelId: chatParams.modelId || undefined,
      temperature: chatParams.temperature,
      topP: chatParams.topP,
      frequencyPenalty: chatParams.frequencyPenalty,
      presencePenalty: chatParams.presencePenalty,
      maxTokens: chatParams.maxTokens,
      contextLimit,
      enableThinking: chatParams.enableThinking,
      disableTools: chatParams.disableTools,
      model2OverrideId: chatParams.model2OverrideId || undefined,
      maxToolRecursion: chatParams.maxToolRecursion,

      // 功能开关（结合用户设置和模式配置）
      ragEnabled,
      memoryEnabled,
      webSearchEnabled,
      ankiEnabled,

      // RAG 配置（从 chatParams 获取）
      ragTopK: chatParams.ragTopK,
      ragLibraryIds: chatParams.ragLibraryIds,
      // 🔧 P1-35: 传递 Rerank 开关配置
      ragEnableReranking: chatParams.ragEnableReranking,

      // 🆕 多模态知识库检索配置
      // ★ 多模态索引已禁用，强制关闭多模态检索，避免后端报错。恢复时改回 chatParams.multimodalRagEnabled
      multimodalRagEnabled: false,
      multimodalTopK: chatParams.multimodalTopK,
      multimodalEnableReranking: chatParams.multimodalEnableReranking,
      multimodalLibraryIds: chatParams.multimodalLibraryIds,

      // 🆕 图片压缩策略（不设置时后端使用智能默认策略）
      visionQuality: chatParams.visionQuality,

      // ★ 2026-01 简化：VFS RAG 作为唯一知识检索方案
      // ragTopK 和 ragEnableReranking 直接用于 VFS RAG 检索

      // ★ graphIds/graphTopK 已废弃（图谱模块已移除）

      // MCP 工具（从 chatParams 获取选中的服务器）
      mcpTools: chatParams.selectedMcpServers,
      // ========== MCP 工具 Schema 注入 ==========
      // 从 mcpService 获取选中服务器的工具 Schema，传递给后端
      // 后端直接使用这些 Schema 注入到 LLM，而不需要自己连接 MCP 服务器
      mcpToolSchemas: this.collectMcpToolSchemas(chatParams.selectedMcpServers),

      // 搜索引擎（从 chatParams 获取选中的引擎）
      searchEngines: chatParams.selectedSearchEngines,

      // 系统提示（注入 Skills 元数据）
      systemPromptOverride: this.buildSystemPromptWithSkills(systemPromptOverride),

      // ========== 多变体选项 ==========
      // 从 Store 读取待发送的并行模型 ID，2+ 个模型时触发多变体模式
      parallelModelIds: parallelIds ?? undefined,

      // ========== Schema 工具注入选项（文档 26）==========
      schemaToolIds: undefined as string[] | undefined,

      // 🆕 激活技能列表（用于后端 allowedTools fail-closed 判定）
      activeSkillIds: currentState.activeSkillIds.length > 0 ? currentState.activeSkillIds : undefined,

      // ========== Canvas 智能笔记选项 ==========
      // 从 modeState 获取当前打开的笔记 ID，作为 Canvas 工具的默认目标
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      canvasNoteId: (modeState as any)?.canvasNoteId as string | undefined,
    };

    // ========== Schema 工具收集（文档 26）==========
    // 从多来源收集需要注入的 Schema 工具 ID
    // 🔧 多技能修复：从所有激活的 skill refs 收集 allowedTools 取并集
    let skillAllowedTools: string[] | undefined;
    {
      const mergedAllowedTools: string[] = [];
      // 来源 1：pendingContextRefs 中的 sticky skill refs
      const skillRefs = currentState.pendingContextRefs.filter(
        (ref) => ref.typeId === SKILL_INSTRUCTION_TYPE_ID && ref.isSticky
      );
      const seenSkillIds = new Set<string>();
      for (const ref of skillRefs) {
        const skillId = ref.skillId ?? ref.resourceId.replace(/^skill_/, '');
        seenSkillIds.add(skillId);
        const skill = skillRegistry.get(skillId);
        if (skill) {
          const tools = skill.allowedTools ?? skill.tools;
          if (tools && tools.length > 0) {
            mergedAllowedTools.push(...tools);
          }
        }
      }
      // 来源 2：activeSkillIds（修复 loadSession 竞态导致 pendingContextRefs 为空的情况）
      for (const skillId of currentState.activeSkillIds) {
        if (seenSkillIds.has(skillId)) continue;
        const skill = skillRegistry.get(skillId);
        if (skill) {
          const tools = skill.allowedTools ?? skill.tools;
          if (tools && tools.length > 0) {
            mergedAllowedTools.push(...tools);
          }
        }
      }
      // 🔧 约束规则：
      // - 若任一激活技能声明了 allowedTools（非空），则按所有声明的 allowedTools 并集进行过滤
      // - 若没有任何技能声明 allowedTools，则不进行过滤（保持现有行为）
      if (mergedAllowedTools.length > 0) {
        skillAllowedTools = [...new Set(mergedAllowedTools)]; // 去重
        console.log(LOG_PREFIX, '🛡️ Skill allowedTools constraint (union of', skillRefs.length, 'refs +', currentState.activeSkillIds.length, 'active):', {
          allowedTools: skillAllowedTools,
        });
      }
    }

    const schemaToolResult = collectSchemaToolIds({
      pendingContextRefs: currentState.pendingContextRefs,
      // ★ 2026-01 改造：Anki 工具已迁移到内置 MCP 服务器，无需单独启用
      // 🆕 P1-B: 传递 skill allowedTools 进行过滤
      skillAllowedTools,
    });
    if (schemaToolResult.schemaToolIds.length > 0) {
      options.schemaToolIds = schemaToolResult.schemaToolIds;
      console.log(LOG_PREFIX, 'Schema tools collected:', schemaToolResult);
    }

    // 🆕 P1-C: 传递 skill allowedTools 到后端进行硬约束校验
    if (skillAllowedTools && skillAllowedTools.length > 0) {
      (options as Record<string, unknown>).skillAllowedTools = skillAllowedTools;
    }

    // 🔧 渐进披露优化：只传递尚未加载的技能 content 和 embeddedTools
    // 已加载的技能内容无需重传（后端 load_skills 不会再次请求它们）
    // ⚠️ 例外：activeSkillIds 中的技能必须始终包含 content，
    // 后端 inject_synthetic_load_skills 需要它来合成 role:tool 消息
    const allSkills = skillRegistry.getAll();
    if (allSkills.length > 0) {
      const loadedIds = new Set(getLoadedSkills(this.sessionId).map(s => s.id));
      const activeIdSet = new Set(currentState.activeSkillIds);
      const skillContents: Record<string, string> = {};
      const skillEmbeddedTools: Record<string, Array<{ name: string; description?: string; inputSchema?: unknown }>> = {};
      for (const skill of allSkills) {
        // 跳过已加载且非激活的技能，减少 IPC 传输体积
        // 激活技能必须保留 content（后端合成 load_skills 需要）
        if (loadedIds.has(skill.id) && !activeIdSet.has(skill.id)) continue;
        if (skill.content) {
          skillContents[skill.id] = skill.content;
        }
        if (skill.embeddedTools && skill.embeddedTools.length > 0) {
          skillEmbeddedTools[skill.id] = skill.embeddedTools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          }));
        }
      }
      if (Object.keys(skillContents).length > 0) {
        (options as Record<string, unknown>).skillContents = skillContents;
        console.log(LOG_PREFIX, '[ProgressiveDisclosure] Injected skill contents (excluding', loadedIds.size - activeIdSet.size, 'loaded, keeping', activeIdSet.size, 'active):', Object.keys(skillContents).length);
      }
      if (Object.keys(skillEmbeddedTools).length > 0) {
        (options as Record<string, unknown>).skillEmbeddedTools = skillEmbeddedTools;
        console.log(LOG_PREFIX, '[ProgressiveDisclosure] Injected skill embeddedTools (excluding', loadedIds.size, 'loaded):', Object.keys(skillEmbeddedTools).length);
      }
    }

    // 🔧 调试日志：记录发送选项（包含 modelId）
    logMultiVariant('adapter', 'buildSendOptions', {
      modelId: options.modelId,
      hasModelId: !!options.modelId,
      hasParallelModelIds: !!parallelIds,
      parallelModelIds: parallelIds ?? [],
      count: parallelIds?.length ?? 0,
      willTriggerMultiVariant: (parallelIds?.length ?? 0) >= 2,
      enableThinking: chatParams.enableThinking,
      isSingleVariant: !parallelIds || parallelIds.length < 2,
    }, options.modelId ? 'success' : 'warning');

    // 单独记录思维链状态
    if (chatParams.enableThinking) {
      logMultiVariant('adapter', 'thinking_enabled', {
        modelId: chatParams.modelId,
        enableThinking: true,
      }, 'info');
    }

    return options;
  }


  /**
   * 从 mcpService 收集选中 MCP 服务器的工具 Schema
   *
   * 🔧 2026-01-11 重构：总是注入内置工具，确保工具化检索模式可用
   * 🔧 2026-01-20 重构：支持渐进披露模式，按需加载工具
   *
   * 返回工具 Schema 数组，格式与 OpenAI function calling 兼容：
   * - name: 工具名称（可能带命名空间前缀）
   * - description: 工具描述
   * - inputSchema: JSON Schema 定义参数
   */
  private collectMcpToolSchemas(
    selectedServerIds?: string[]
  ): Array<{ name: string; description?: string; inputSchema?: unknown }> {
    const schemas: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];

    // 渐进披露模式：只注入 load_skills 元工具 + 已加载的 Skills 工具
    // 完全替代 builtinMcpServer.ts，不再支持旧的全量注入模式
    schemas.push(LOAD_SKILLS_TOOL_SCHEMA);
    console.log(LOG_PREFIX, '[ProgressiveDisclosure] Injected load_skills meta-tool');

    // 🆕 自动加载配置中的默认技能（如 learning-resource 含知识导图工具）
    const config = getProgressiveDisclosureConfig();
    if (config.autoLoadSkills && config.autoLoadSkills.length > 0) {
      const toLoad = config.autoLoadSkills.filter(id => !isSkillLoaded(this.sessionId, id));
      if (toLoad.length > 0) {
        const result = loadSkillsToSession(this.sessionId, toLoad);
        console.log(LOG_PREFIX, '[ProgressiveDisclosure] Auto-loaded default skills:', {
          requested: toLoad,
          loadedCount: result.loaded.length,
        });
      }
    }

    // 🆕 P0 修复：工作区模式下自动加载 workspace-tools 技能
    // 确保 coordinator_sleep 等多代理协作工具始终可见
    const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
    if (currentWorkspaceId) {
      const WORKSPACE_TOOLS_SKILL_ID = 'workspace-tools';
      if (!isSkillLoaded(this.sessionId, WORKSPACE_TOOLS_SKILL_ID)) {
        const result = loadSkillsToSession(this.sessionId, [WORKSPACE_TOOLS_SKILL_ID]);
        console.log(LOG_PREFIX, '[ProgressiveDisclosure] Auto-loaded workspace-tools for workspace mode:', {
          workspaceId: currentWorkspaceId,
          loadedCount: result.loaded.length,
        });
      }
    }

    // 注入已加载的 Skills 工具
    const loadedTools = getLoadedToolSchemas(this.sessionId);
    for (const tool of loadedTools) {
      schemas.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
    console.log(LOG_PREFIX, '[ProgressiveDisclosure] Injected loaded skill tools:', loadedTools.length);

    // 收集用户选择的其他 MCP 服务器工具（两种模式都支持）
    if (selectedServerIds && selectedServerIds.length > 0) {
      for (const serverId of selectedServerIds) {
        // 跳过内置服务器（已经注入）
        if (serverId === BUILTIN_SERVER_ID) {
          continue;
        }

        // 从 McpService 缓存获取该服务器的工具列表
        const tools = McpService.getCachedToolsFor(serverId);
        for (const tool of tools) {
          schemas.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.input_schema,
          });
        }
      }
    }

    console.log(LOG_PREFIX, 'Total MCP tool schemas:', {
      progressiveDisclosure: true, // 始终启用渐进披露
      totalCount: schemas.length,
    });

    return schemas;
  }

  /**
   * 构建系统提示（注入 Skills 元数据）
   *
   * 🔧 2026-01-20: 渐进披露模式下，注入 available_skills 列表
   *
   * 将 Skills 元数据追加到系统提示后面，用于 LLM 自动发现和激活技能
   */
  private buildSystemPromptWithSkills(
    basePrompt: string | undefined
  ): string | undefined {
    // 渐进披露模式：使用 available_skills 格式，告知 LLM 可用的技能组
    // 🔧 排除已加载的技能，避免 LLM 重复调用 load_skills
    const skillMetadataPrompt = generateAvailableSkillsPrompt(true, this.sessionId);
    console.log(LOG_PREFIX, '[ProgressiveDisclosure] Generated available_skills prompt (excludeLoaded=true)');

    // 如果没有 skills 元数据，返回原始提示
    if (!skillMetadataPrompt) {
      return basePrompt;
    }

    if (basePrompt) {
      return `${basePrompt}\n\n${skillMetadataPrompt}`;
    }

    return skillMetadataPrompt;
  }

  // ========================================================================
  // Getters
  // ========================================================================

  /**
   * 获取会话 ID
   */
  get id(): string {
    return this.sessionId;
  }

  /**
   * 是否已初始化
   */
  get initialized(): boolean {
    return this.isSetup;
  }
}
