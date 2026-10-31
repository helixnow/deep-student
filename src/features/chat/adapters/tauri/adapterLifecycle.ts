/**
 * Chat V2 - TauriAdapter 拆分模块 —— 适配器生命周期：事件监听注册/回滚/重试、setup 回调注入、cleanup 资源释放
 *
 * 自 TauriAdapter.ts 拆出（行为不变）；函数首参 host 为适配器实例，
 * 由 ChatV2TauriAdapter 同名方法委托调用。
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import i18n from 'i18next';
import { getErrorMessage } from '@/utils/errorUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { clearAdapterErrorFlag, reportAdapterError } from '../errors/adapterErrorChannel';
import { streamingBlockSaver } from '../../core/middleware/autoSave';
import type { BackendEvent } from '../../core/middleware/eventBridge';
import { clearEventContext } from '../../core/middleware/eventBridge';
import { logMultiVariant } from '@/debug-panel/plugins/MultiVariantDebugPlugin';
import { autoSave } from '../../core/middleware/autoSave';
import { chunkBuffer } from '../../core/middleware/chunkBuffer';
// 🔧 优化：sessionManager 仅用于获取元数据，不再用于获取 Store 状态
// 构造函数现在接收 storeApi 参数，消除了循环依赖的核心问题
import { sessionManager } from '../../core/session/sessionManager';
import { sessionSwitchPerf } from '../../debug/sessionSwitchPerf';
import type { SessionEventPayload } from '../types';
import { isTauriRuntimeAvailable } from './runtime';
import { LOG_PREFIX, adapterConsole as console } from './diagnostics';
import { blockEventChannel, sessionEventChannel } from './sessionEvents';
import type { TauriAdapterHost, LlmRequestBodyEventPayload } from './adapterHost';

/**
 * 🔧 P1 修复（2026-07-08 审阅 20 P1-2）：逐个注册监听器并收集 unlisten，失败时回滚。
 *
 * 原实现用 Promise.all：任一 listen reject 时整体 reject，已 resolve 的 unlisten
 * 函数被丢弃，无法再释放（监听器闭包持有 adapter → store 引用链，既是事件重复
 * 处理源也是内存泄漏）。改用 allSettled：部分失败时先释放全部已成功注册的
 * 监听器，再抛出首个失败原因，保证"要么全部注册成功、要么零残留"。
 */
export async function registerEventListenersWithRollback(host: TauriAdapterHost): Promise<UnlistenFn[]> {
  const blockChannel = blockEventChannel(host.sessionId);
  const sessionChannel = sessionEventChannel(host.sessionId);

  const results = await Promise.allSettled([
    listen<BackendEvent>(blockChannel, (event) => {
      host.handleBlockEvent(event.payload);
    }),
    listen<SessionEventPayload>(sessionChannel, (event) => {
      host.handleSessionEvent(event.payload);
    }),
    listen<unknown>('anki_generation_event', (event) => {
      host.handleAnkiGenerationEvent(event.payload);
    }),
    // ★ 2026-02-14: 监听后端真实 LLM 请求体，替换前端 rawRequest
    listen<LlmRequestBodyEventPayload>('chat_v2_llm_request_body', (event) => {
      host.handleLlmRequestBody(event.payload);
    }),
  ]);

  const fulfilledUnlisteners = results
    .filter((r): r is PromiseFulfilledResult<UnlistenFn> => r.status === 'fulfilled')
    .map((r) => r.value);
  const firstRejection = results.find(
    (r): r is PromiseRejectedResult => r.status === 'rejected'
  );

  if (firstRejection) {
    console.warn(
      LOG_PREFIX,
      `Listener registration partially failed (${fulfilledUnlisteners.length}/${results.length} succeeded), rolling back`
    );
    host.releaseUnlisteners(fulfilledUnlisteners, 'partial registration rollback');
    throw firstRejection.reason instanceof Error
      ? firstRejection.reason
      : new Error(getErrorMessage(firstRejection.reason));
  }

  return fulfilledUnlisteners;
}

/** 逐个安全释放 unlisten 函数（单个失败不影响其余释放）。 */
export function releaseUnlisteners(host: TauriAdapterHost, unlisteners: UnlistenFn[], reason: string): void {
  for (const unlisten of unlisteners) {
    try {
      unlisten();
    } catch (error) {
      console.error(LOG_PREFIX, `Error during unlisten (${reason}):`, getErrorMessage(error));
    }
  }
}

export async function retrySetupListeners(host: TauriAdapterHost): Promise<boolean> {
  // 🔧 重入检查：防止并发调用导致重复监听器注册
  if (host.isRetryingListeners) {
    console.warn(LOG_PREFIX, 'retrySetupListeners already in progress, skipping');
    return false;
  }

  host.isRetryingListeners = true;
  console.log(LOG_PREFIX, 'Retrying event listener setup...');

  try {
    // 清理旧的监听器（如果有）
    for (const unlisten of host.unlisteners) {
      try {
        unlisten();
      } catch (error) {
        console.error(LOG_PREFIX, 'Error during unlisten in retry:', getErrorMessage(error));
      }
    }
    host.unlisteners = [];
    host.listenerRegistrationError = null;

    const currentGeneration = ++host.setupGeneration;

    // 重新注册监听器（🔧 P1: 逐个注册 + 部分失败回滚，见 registerEventListenersWithRollback）
    const listenPromise = host.registerEventListenersWithRollback();

    host.listenersReadyPromise = listenPromise.then((unlistenFns) => {
      if (host.setupGeneration !== currentGeneration) {
        console.warn(LOG_PREFIX, `Releasing stale retry listeners (gen=${currentGeneration}, current=${host.setupGeneration})`);
        host.releaseUnlisteners(unlistenFns, 'stale retry generation');
        throw new Error(`Retry listener setup became stale for session ${host.sessionId}`);
      }

      host.unlisteners.push(...unlistenFns);
      host.claimAnkiEventOwnership('retrySetupListeners');
      host.listenerRegistrationError = null;
      clearAdapterErrorFlag(host.sessionId, host.getErrorStoreApi(), [
        'listener_registration_failed',
        'listener_retry_failed',
      ]);
    }).catch((err) => {
      const isStaleSetupError = err instanceof Error && err.message.includes('Retry listener setup became stale');
      if (isStaleSetupError) {
        console.warn(LOG_PREFIX, 'Retry listener setup cancelled due to stale generation');
        throw err;
      }

      const errorMsg = getErrorMessage(err);
      host.listenerRegistrationError = err instanceof Error ? err : new Error(errorMsg);
      throw host.listenerRegistrationError;
    });

    await host.waitForListenersReady();

    console.log(LOG_PREFIX, `Retry successful: ${host.unlisteners.length} event listeners registered`);
    clearAdapterErrorFlag(host.sessionId, host.getErrorStoreApi(), [
      'listener_registration_failed',
      'listener_retry_failed',
    ]);
    
    showGlobalNotification(
      'success',
      i18n.t('chatV2:success.listenerRetrySuccessMessage'),
      i18n.t('chatV2:success.listenerRetrySuccess')
    );
    
    return true;
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    host.listenerRegistrationError = error instanceof Error ? error : new Error(errorMsg);

    reportAdapterError({
      code: 'listener_retry_failed',
      level: 'user',
      sessionId: host.sessionId,
      message: i18n.t('chatV2:error.listenerRetryFailedMessage'),
      title: i18n.t('chatV2:error.listenerRetryFailed'),
      cause: error,
      retryable: true,
      retry: () => { void host.retrySetupListeners(); },
      storeApi: host.getErrorStoreApi(),
    });
    
    return false;
  } finally {
    // 🔧 确保标志在方法结束时被重置
    host.isRetryingListeners = false;
  }
}

export async function setup(host: TauriAdapterHost): Promise<void> {
  host.ensureBridgeStoreResolver();
  if (host.isSetup) {
    console.warn(LOG_PREFIX, 'Already setup, skipping...');
    // 📊 性能打点：适配器已初始化，快速路径
    sessionSwitchPerf.mark('adapter_already_setup', { fromCache: true });
    sessionSwitchPerf.endTrace();
    return;
  }

  if (!isTauriRuntimeAvailable()) {
    console.warn(LOG_PREFIX, 'Tauri runtime not available, skip setup.');
    host.isSetup = true;
    sessionSwitchPerf.mark('adapter_setup_skipped', { reason: 'not_tauri' });
    sessionSwitchPerf.endTrace();
    return;
  }

  if (!host.claimSessionRuntimeOwnership()) {
    throw new Error(`A newer adapter owns the runtime for session ${host.sessionId}`);
  }

  // 📊 性能打点：adapter_setup_start
  const alreadyLoadedBefore = host.store.isDataLoaded;
  sessionSwitchPerf.mark('adapter_setup_start', { fromCache: alreadyLoadedBefore });

  try {
    // 监听块级事件: chat_v2_event_{session_id}（通道构造收敛在 registerEventListenersWithRollback）
    const blockEventChannel = `chat_v2_event_${host.sessionId}`;
    
    // 🔧 调试打点：确认事件监听通道
    logMultiVariant('adapter', 'setup_listening', {
      sessionId: host.sessionId,
      blockEventChannel,
    }, 'info');

    // 🚀 性能优化 V2：事件监听、数据加载、回调注入三者并行
    // 检查是否需要加载数据
    const alreadyLoaded = host.getCurrentState().isDataLoaded;
    let isNewSession = false;
    let loadError: Error | null = null;
    const loadStartTs = performance.now();

    // 📊 细粒度打点：listen 开始
    sessionSwitchPerf.mark('listen_start');
    
    // 🔧 P0修复：记录当前 setup generation，防止 cleanup→re-setup 场景下旧 listener 泄漏到新 session
    const currentGeneration = ++host.setupGeneration;
    host.listenerRegistrationError = null;
    
    // 启动事件监听（不立即 await，后台注册）
    // 🔧 P1: 逐个注册 + 部分失败回滚，见 registerEventListenersWithRollback
    const listenPromise = host.registerEventListenersWithRollback();

    host.listenersReadyPromise = listenPromise.then((unlistenFns) => {
      // 守卫：如果 cleanup/re-setup 已使当前 generation 失效，立即释放过期监听器
      if (host.setupGeneration !== currentGeneration) {
        console.warn(LOG_PREFIX, `Releasing stale listeners (gen=${currentGeneration}, current=${host.setupGeneration})`);
        host.releaseUnlisteners(unlistenFns, 'stale setup generation');
        throw new Error(`Listener setup became stale for session ${host.sessionId}`);
      }

      host.unlisteners.push(...unlistenFns);
      host.claimAnkiEventOwnership('setup');
      sessionSwitchPerf.mark('listen_end');
      host.listenerRegistrationError = null;
      clearAdapterErrorFlag(host.sessionId, host.getErrorStoreApi(), [
        'listener_registration_failed',
        'listener_retry_failed',
      ]);
      console.log(LOG_PREFIX, `Listeners ready for session: ${host.sessionId}`);
      console.log(LOG_PREFIX, `Successfully registered ${host.unlisteners.length} event listeners`);
    }).catch((err) => {
      const isStaleSetupError = err instanceof Error && err.message.includes('Listener setup became stale');
      if (isStaleSetupError) {
        console.warn(LOG_PREFIX, 'Listener setup cancelled due to stale generation');
        throw err;
      }

      // 🆕 P1 修复：事件监听注册失败处理
      const errorMsg = getErrorMessage(err);
      
      // 保存错误状态，供健康检查和重试使用
      host.listenerRegistrationError = err instanceof Error ? err : new Error(errorMsg);

      reportAdapterError({
        code: 'listener_registration_failed',
        level: 'user',
        sessionId: host.sessionId,
        message: i18n.t('chatV2:error.listenerRegistrationFailedMessage'),
        title: i18n.t('chatV2:error.listenerRegistrationFailed'),
        cause: err,
        retryable: true,
        retry: () => { void host.retrySetupListeners(); },
        storeApi: host.getErrorStoreApi(),
      });
      throw host.listenerRegistrationError;
    });

    // 📊 细粒度打点：loadSession 开始
    sessionSwitchPerf.mark('load_start', { alreadyLoaded });
    
    // 启动数据加载（不立即 await）
    const loadPromise = alreadyLoaded 
      ? Promise.resolve('cached' as const)
      : host.loadSession().then(() => {
          // 📊 精确打点：loadSession Promise 的 .then() 回调被调用
          sessionSwitchPerf.mark('load_then_callback', { timing: 'entered' });
          return 'loaded' as const;
        }).catch((err) => {
          loadError = err;
          return 'error' as const;
        });

    // 同时注入回调（同步操作，不阻塞）
    host.store.setSaveCallback(() => host.saveSession());
    host.store.setRetryCallback((messageId, modelOverride) =>
      host.executeRetry(messageId, modelOverride)
    );
    host.store.setDeleteCallback((messageId) =>
      host.executeDelete(messageId)
    );
    // 🆕 P1-2: 支持传递新的上下文引用
    host.store.setEditAndResendCallback((messageId, newContent, newContextRefs) =>
      host.executeEditAndResend(messageId, newContent, newContextRefs)
    );
    host.store.setSendCallback((content, attachments, userMessageId, assistantMessageId) =>
      host.executeSendMessage(content, attachments, userMessageId, assistantMessageId)
    );
    host.store.setWakeSessionCallback((content, assistantMessageId) =>
      host.executeWakeSession(content, assistantMessageId)
    );
    host.store.setAbortCallback(() => host.executeAbort());
    // 🔧 P0 修复：注入 continueMessage 回调，让 store.continueMessage 调用后端 chat_v2_continue_message
    host.store.setContinueMessageCallback((messageId, variantId) =>
      host.continueMessage(messageId, variantId)
    );
    host.store.setLoadCallback(() => host.loadSession());
    host.store.setLoadEarlierMessagesCallback(() => host.loadEarlierMessages());
    host.store.setSwitchVariantCallback((messageId, variantId) =>
      host.executeSwitchVariant(messageId, variantId)
    );
    host.store.setDeleteVariantCallback((messageId, variantId) =>
      host.executeDeleteVariant(messageId, variantId)
    );
    host.store.setRetryVariantCallback((messageId, variantId, modelOverride) =>
      host.executeRetryVariant(messageId, variantId, modelOverride)
    );
    host.store.setRetryAllVariantsCallback((messageId, variantIds) =>
      host.executeRetryAllVariants(messageId, variantIds)
    );
    host.store.setCancelVariantCallback((variantId) =>
      host.executeCancelVariant(variantId)
    );
    host.store.setUpdateBlockContentCallback((blockId, content) =>
      host.executeUpdateBlockContent(blockId, content)
    );
    host.store.setUpdateSessionSettingsCallback((settings) =>
      host.executeUpdateSessionSettings(settings)
    );
    // 🆕 P0 分支模型：注入分支回调（store.branchSession → chat_v2_branch_session）
    host.store.setBranchSessionCallback?.((upToMessageId) =>
      host.branchSession(upToMessageId)
    );
    host.unregisterStreamingBlockSaver?.();
    host.unregisterStreamingBlockSaver = streamingBlockSaver.registerSaveCallback(
      host.sessionId,
      (blockId, messageId, blockType, content, sessionId) =>
        host.executeUpsertStreamingBlock(blockId, messageId, blockType, content, sessionId),
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

    // setup 的就绪语义与监听真正挂载一致：这里必须等待 listenersReadyPromise
    await host.waitForListenersReady();

    host.isSetup = true;
    console.log(LOG_PREFIX, 'Setup complete');

    // 处理加载结果
    if (loadResult === 'cached') {
      console.log(LOG_PREFIX, '✅ Session already loaded (cached), skipping loadSession:', host.sessionId);
      sessionSwitchPerf.mark('adapter_setup_end', { fromCache: true });
      sessionSwitchPerf.endTrace();
    } else if (loadResult === 'loaded') {
      console.log(LOG_PREFIX, 'Session loaded after setup');
      sessionSwitchPerf.mark('adapter_setup_end');
    } else {
      // loadResult === 'error'
      isNewSession = true;
      // 🔧 用户通知：会话加载失败时提示用户（降级为新会话）
      reportAdapterError({
        code: 'session_load_failed',
        level: 'user',
        sessionId: host.sessionId,
        message: i18n.t('chatV2:error.sessionLoadFailedMessage'),
        title: i18n.t('chatV2:error.sessionLoadFailed'),
        cause: loadError,
        notificationType: 'warning',
        retryable: true,
        retry: () => host.loadSession(),
        storeApi: host.getErrorStoreApi(),
      });
      // 🔧 P27 修复：新会话加载失败时也要标记 isDataLoaded=true
      // 否则 ChatContainer 会一直显示空白（因为 isDataLoaded 永远是 false）
      // 对于新会话，数据为空但状态是"已加载"，UI 应该正常渲染空态
      // 
      // 注意：AdapterManager 创建 adapter 时总是传递 storeApi，所以这里一定存在
      // 但为安全起见添加 null 检查
      if (host.storeApi) {
        host.storeApi.setState({ isDataLoaded: true });
        console.log(LOG_PREFIX, '✅ New session marked as loaded (empty state) via storeApi');
      } else {
        console.warn(LOG_PREFIX, '⚠️ storeApi is null, cannot mark isDataLoaded');
      }
      sessionSwitchPerf.mark('adapter_setup_end', { error: true, markedAsLoaded: !!host.storeApi });
      sessionSwitchPerf.endTrace();
    }

    // 🔧 性能优化：已缓存的会话无需再执行 initSession
    // initSession 只在首次加载时执行，后续切换回该会话时跳过
    if (!alreadyLoaded) {
      // M2 修复：在 initSession 之前确保监听器就绪（autoSendFirstMessage 会立即触发消息发送）
      await host.waitForListenersReady();

      const meta = sessionManager.getSessionMeta(host.sessionId);
      if (meta?.pendingInitConfig) {
        const mode = meta.mode;
        const initConfig = meta.pendingInitConfig;
        console.log(LOG_PREFIX, `Executing pending initSession for mode '${mode}'`, initConfig);
        
        try {
          await host.store.initSession(mode, initConfig);
          console.log(LOG_PREFIX, `Mode '${mode}' initialized successfully`);
        } catch (initError) {
          console.error(LOG_PREFIX, `Failed to init mode '${mode}':`, getErrorMessage(initError));
        } finally {
          // 清除待执行配置，避免重复执行
          sessionManager.clearPendingInitConfig(host.sessionId);
        }
      } else if (isNewSession) {
        // 新会话且没有 pendingInitConfig，使用默认模式初始化
        const mode = meta?.mode || 'chat';
        if (mode !== 'chat') {
          console.log(LOG_PREFIX, `Initializing new session with mode '${mode}'`);
          try {
            await host.store.initSession(mode);
          } catch (initError) {
            console.error(LOG_PREFIX, `Failed to init mode '${mode}':`, getErrorMessage(initError));
          }
        }
      }
    }
  } catch (error) {
    // Listener failures already report at user level; keep outer catch as dev breadcrumb.
    reportAdapterError({
      code: 'setup_failed',
      level: 'dev',
      sessionId: host.sessionId,
      message: 'Setup failed',
      cause: error,
    });
    throw error;
  }
}

export async function cleanup(host: TauriAdapterHost): Promise<void> {
  console.log(LOG_PREFIX, 'Cleaning up...');
  host.unregisterBridgeStoreResolver?.();
  host.unregisterBridgeStoreResolver = null;
  host.cancelPendingStreamCompletion();
  // 🚀 性能修复（2026-09-06）：清理前冲刷所有制卡合并缓冲，避免待写卡片丢失
  for (const blockId of [...host.ankiCardFlushQueue.keys()]) {
    host.flushAnkiCardBuffer(blockId);
  }
  // 使正在进行的 setup/listener 注册代际失效，防止过期监听器被挂回当前实例
  host.setupGeneration += 1;
  host.cancelScheduledFullHistoryLoad?.();
  host.cancelScheduledFullHistoryLoad = null;
  host.fullHistoryLoadComplete = false;
  host.historyWindowStartOffset = 0;
  host.lastLoadedSessionInfo = null;

  // 等待监听器注册完成，确保 unlisteners 已填充
  if (host.listenersReadyPromise) {
    try {
      await host.listenersReadyPromise;
    } catch {
      // 注册失败的情况已由 .catch() 分支处理
    }
  }

  const ownsSessionRuntime = host.isSessionRuntimeOwner();
  if (ownsSessionRuntime) {
    if (host.getCurrentState().compactionInProgress) {
      host.store.setCompactionInProgress(false);
    }

  // 🔧 同步修复：cleanup 前先保存会话状态（fire-and-forget）
  // 确保 idle 状态下修改的 UI 设置（chatParams, features 等）不丢失
  try {
    host.saveSession().catch((error) => {
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
    chunkBuffer.flushAndCleanupSession(host.sessionId);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error flushing chunkBuffer:', getErrorMessage(error));
  }

  // 🔧 P3修复：清理自动保存相关的所有状态
  // 不仅取消待执行保存，还清理 lastSaveTime 和 savingPromise
  try {
    autoSave.cleanup(host.sessionId);
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
    clearEventContext(host.sessionId);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing eventContext:', getErrorMessage(error));
  }

  // 清除保存回调
  try {
    host.store.setSaveCallback(null);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing save callback:', getErrorMessage(error));
  }

  // 清除重试回调
  try {
    host.store.setRetryCallback(null);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing retry callback:', getErrorMessage(error));
  }

  // 清除删除回调
  try {
    host.store.setDeleteCallback(null);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing delete callback:', getErrorMessage(error));
  }

  // 清除编辑并重发回调
  try {
    host.store.setEditAndResendCallback(null);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing editAndResend callback:', getErrorMessage(error));
  }

  // 清除发送回调
  try {
    host.store.setSendCallback(null);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing send callback:', getErrorMessage(error));
  }

  try {
    host.store.setWakeSessionCallback(null);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing wakeSession callback:', getErrorMessage(error));
  }

  // 清除中断回调
  try {
    host.store.setAbortCallback(null);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing abort callback:', getErrorMessage(error));
  }

  // 🔧 P0 修复：清除继续执行回调
  try {
    host.store.setContinueMessageCallback(null);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing continueMessage callback:', getErrorMessage(error));
  }

  // 清除加载回调
  try {
    host.store.setLoadCallback(null);
    host.store.setLoadEarlierMessagesCallback(null);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing load callback:', getErrorMessage(error));
  }

  // 🔧 P0修复：清除变体操作回调
  try {
    host.store.setSwitchVariantCallback(null);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing switchVariant callback:', getErrorMessage(error));
  }

  try {
    host.store.setDeleteVariantCallback(null);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing deleteVariant callback:', getErrorMessage(error));
  }

  try {
    host.store.setRetryVariantCallback(null);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing retryVariant callback:', getErrorMessage(error));
  }

  try {
    host.store.setRetryAllVariantsCallback(null);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing retryAllVariants callback:', getErrorMessage(error));
  }

  try {
    host.store.setCancelVariantCallback(null);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing cancelVariant callback:', getErrorMessage(error));
  }

  // 🔧 同步修复：清除更新块内容回调
  try {
    host.store.setUpdateBlockContentCallback(null);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing updateBlockContent callback:', getErrorMessage(error));
  }

  // 🔧 同步修复：清除更新会话设置回调
  try {
    host.store.setUpdateSessionSettingsCallback(null);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing updateSessionSettings callback:', getErrorMessage(error));
  }

  // 🆕 P0 分支模型：清除分支回调
  try {
    host.store.setBranchSessionCallback?.(null);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing branchSession callback:', getErrorMessage(error));
  }

  try {
    streamingBlockSaver.cleanup(host.sessionId);
  } catch (error) {
    console.error(LOG_PREFIX, 'Error cleaning streamingBlockSaver state:', getErrorMessage(error));
  }
  }

  // Identity-safe unregister: an old generation cannot clear the callback
  // installed by a newer adapter for the same session.
  try {
    host.unregisterStreamingBlockSaver?.();
    host.unregisterStreamingBlockSaver = null;
  } catch (error) {
    console.error(LOG_PREFIX, 'Error clearing streamingBlockSaver callback:', getErrorMessage(error));
  }

  for (const unlisten of host.unlisteners) {
    try {
      unlisten();
    } catch (error) {
      console.error(LOG_PREFIX, 'Error during unlisten:', getErrorMessage(error));
    }
  }

  host.unlisteners = [];
  host.releaseAnkiEventOwnershipIfHeld('cleanup');
  host.chatAnkiChunkLogCounter.clear();
  host.retryingAnkiDocumentIds.clear();
  host.ankiRetryReconcileRevisions.clear();
  host.clearStreamExpectation();
  host.lastStreamGenerationByMessageId.clear();
  if (ownsSessionRuntime) {
    host.releaseSessionRuntimeOwnershipIfHeld();
  }
  host.isSetup = false;
  console.log(LOG_PREFIX, 'Cleanup complete');
}
