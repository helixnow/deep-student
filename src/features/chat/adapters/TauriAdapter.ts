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

import type { UnlistenFn } from '@tauri-apps/api/event';
import type { AdapterErrorStoreApi } from './errors/adapterErrorChannel';
import type { StoreApi } from 'zustand';
import type {
  ChatStore,
  AttachmentMeta,
  LoadSessionResponseType,
  SessionRestoreBaseline,
  DeliverOutcome,
} from '../core/types';
import type { BackendEvent } from '../core/middleware/eventBridge';
import { registerBridgeStoreResolver } from '../core/middleware/eventBridge';
import type { AnkiCard } from '@/types';
import type {
  SendOptions,
  SessionEventPayload,
  SessionSettings,
  EditMessageResult,
  RetryMessageResult,
  BranchSessionResult,
} from './types';
import type { ContextRef } from '../resources/types';
import { emitChatAnkiDebugLifecycle } from './tauri/diagnostics';
import type { NormalizedChatModelSelection } from './tauri/requestHelpers';
import type { StreamExpectation, PendingStreamCompletion } from './tauri/streamLifecycle';
import type {
  TauriAdapterHost,
  LlmRequestBodyEventPayload,
  BuildSendOptionsSnapshot,
} from './tauri/adapterHost';
import * as streamTracking from './tauri/streamTracking';
import * as adapterLifecycle from './tauri/adapterLifecycle';
import * as ankiRetryReconcile from './tauri/ankiRetryReconcile';
import * as ankiGenerationEvents from './tauri/ankiGenerationEvents';
import * as blockEvents from './tauri/blockEvents';
import * as sessionEventHandler from './tauri/sessionEventHandler';
import * as sendOperations from './tauri/sendOperations';
import * as messageOperations from './tauri/messageOperations';
import * as historyLoading from './tauri/historyLoading';
import * as sessionCommands from './tauri/sessionCommands';
import * as variantOperations from './tauri/variantOperations';
import * as modelSelection from './tauri/modelSelection';
import * as skillRuntime from './tauri/skillRuntime';
import * as sendOptions from './tauri/sendOptions';
import * as availableSkillsSnapshot from './tauri/availableSkillsSnapshot';

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
  private static sessionRuntimeOwners = new Map<string, ChatV2TauriAdapter>();

  private sessionId: string;
  /** 已提示过「固定模型失效、已改用其它模型」的 session::modelId，避免每次发送都弹 */
  private notifiedUnavailablePinnedModels = new Set<string>();
  private storeApi: StoreApi<ChatStore> | null = null;
  private store: ChatStore;
  private unlisteners: UnlistenFn[] = [];
  private isSetup = false;
  private setupGeneration = 0;
  private readonly adapterInstanceId: number;
  private unregisterStreamingBlockSaver: (() => void) | null = null;
  private cancelScheduledFullHistoryLoad: (() => void) | null = null;
  private fullHistoryLoadInFlight = false;
  private fullHistoryLoadComplete = false;
  /**
   * 🚀 长会话内存窗口化（2026-09-25）：已加载历史的连续窗口起点（backend
   * offset 语义，按最老消息计）。restore 尾窗后 = total - 已加载数；反向
   * 回填/滚动补页每合并一页就向 0 推进。0 = 全量在内存。窗口始终连续，
   * 不会出现"中间空洞"，补页 offset 因此可以精确推导。
   */
  private historyWindowStartOffset = 0;
  /** 最近一次 loadSession 返回的会话信息（分页补页构造合并响应用） */
  private lastLoadedSessionInfo: LoadSessionResponseType['session'] | null = null;
  
  /** 🚀 性能优化：数据恢复完成回调，在 restoreFromBackend 后立即触发 */
  public onDataRestored: (() => void) | null = null;
  
  /** 🔧 P20 修复：事件监听器就绪 Promise，确保子代理场景下监听器先于消息发送 */
  private listenersReadyPromise: Promise<void> | null = null;

  /** 🆕 P1 修复：事件监听器注册失败时的错误对象，用于诊断和重试 */
  private listenerRegistrationError: Error | null = null;

  /** 🆕 并发控制：防止 retrySetupListeners 重入 */
  private isRetryingListeners = false;
  /** 当前会话预期流式消息（用于过滤 stale session 事件） */
  private streamExpectation: StreamExpectation | null = null;
  /** 最近一次已接受的后端流代次，防止同 messageId retry 被旧终态结束。 */
  private lastStreamGenerationByMessageId = new Map<string, number>();
  private pendingStreamCompletion: PendingStreamCompletion | null = null;
  /** ChatAnki 桥接 chunk 日志节流计数器（按 blockId） */
  private chatAnkiChunkLogCounter = new Map<string, number>();
  /** 多变体 content/thinking chunk 调试日志采样计数器（1/10 采样，避免流式期间刷屏） */
  private variantChunkLogCounter = 0;
  /** 已终态 anki 块收到任务事件时，表示失败分段正在重试。 */
  private retryingAnkiDocumentIds = new Set<string>();
  /** 防止并发查询的旧结果覆盖更新的重试终态。 */
  private ankiRetryReconcileRevisions = new Map<string, number>();
  /** 🚀 性能修复（2026-09-06）：anki 卡片事件合并缓冲（blockId → 待写入卡片）。
   * 100ms 窗口批量写入 store，避免每卡一次 updateBlock 造成 O(N²) 渲染开销。
   * cardIds（2026-09-07 审阅 F3）：窗口内 ID 判重索引，条目创建时从已落盘
   * 卡片播种（每窗口 O(M) 一次），窗口期内判重 O(1)；落盘时仍按最新状态
   * 重新建索引过滤，作为正确性兜底。 */
  private ankiCardFlushQueue = new Map<
    string,
    { cards: AnkiCard[]; cardIds: Set<string>; documentId?: string; timer: ReturnType<typeof setTimeout> | null }
  >();

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

  /** eventBridge 最新 Store 解析器的注销函数（批量回放/冲刷路径防快照过期） */
  private unregisterBridgeStoreResolver: (() => void) | null = null;

  private ensureBridgeStoreResolver(): void {
    if (this.unregisterBridgeStoreResolver || !this.storeApi) return;
    this.unregisterBridgeStoreResolver = registerBridgeStoreResolver(
      this.sessionId,
      () => this.getCurrentState(),
    );
  }

  /** Narrow storeApi for the adapter error channel (optional adapterError flag). */
  private getErrorStoreApi(): AdapterErrorStoreApi | null {
    return (this.storeApi as unknown as AdapterErrorStoreApi | null) ?? null;
  }

  /** 拆分模块的 host 视图：即本实例（经 tauri/ 模块委托时作为首参传入）。 */
  private asHost(): TauriAdapterHost {
    return this as unknown as TauriAdapterHost;
  }

  private getAnkiEventOwnerAdapterId(): number | null {
    return ChatV2TauriAdapter.ankiEventOwnerAdapterId;
  }

  private claimSessionRuntimeOwnership(): boolean {
    const currentOwner = ChatV2TauriAdapter.sessionRuntimeOwners.get(this.sessionId);
    if (!currentOwner || currentOwner.adapterInstanceId <= this.adapterInstanceId) {
      ChatV2TauriAdapter.sessionRuntimeOwners.set(this.sessionId, this);
    }
    return ChatV2TauriAdapter.sessionRuntimeOwners.get(this.sessionId) === this;
  }

  private isSessionRuntimeOwner(): boolean {
    const owner = ChatV2TauriAdapter.sessionRuntimeOwners.get(this.sessionId);
    // Unit tests and direct method use may not call setup(). With no claimed
    // owner, this instance is the only possible handler and remains valid.
    return !owner || owner === this;
  }

  private releaseSessionRuntimeOwnershipIfHeld(): void {
    if (ChatV2TauriAdapter.sessionRuntimeOwners.get(this.sessionId) === this) {
      ChatV2TauriAdapter.sessionRuntimeOwners.delete(this.sessionId);
    }
  }

  private captureRestoreBaseline(): SessionRestoreBaseline {
    return historyLoading.captureRestoreBaseline(this.asHost());
  }

  private beginStreamExpectation(messageId: string): void {
    streamTracking.beginStreamExpectation(this.asHost(), messageId);
  }

  private setStreamExpectationMessageId(messageId: string): void {
    streamTracking.setStreamExpectationMessageId(this.asHost(), messageId);
  }

  private syncStreamExpectationFromEvent(
    messageId: string,
    timestamp?: number,
    streamGeneration?: number,
  ): void {
    streamTracking.syncStreamExpectationFromEvent(this.asHost(), messageId, timestamp, streamGeneration);
  }

  private clearStreamExpectation(messageId?: string): void {
    streamTracking.clearStreamExpectation(this.asHost(), messageId);
  }

  private cancelPendingStreamCompletion(): void {
    streamTracking.cancelPendingStreamCompletion(this.asHost());
  }

  private armPendingStreamCompletion(pending: PendingStreamCompletion): void {
    streamTracking.armPendingStreamCompletion(this.asHost(), pending);
  }

  private settleStreamCompletion(payload: SessionEventPayload): void {
    streamTracking.settleStreamCompletion(this.asHost(), payload);
  }

  private forceSettlePendingStreamCompletion(): void {
    streamTracking.forceSettlePendingStreamCompletion(this.asHost());
  }

  private scheduleStreamCompletion(payload: SessionEventPayload): void {
    streamTracking.scheduleStreamCompletion(this.asHost(), payload);
  }

  private touchPendingStreamCompletion(): void {
    streamTracking.touchPendingStreamCompletion(this.asHost());
  }

  private isStaleByExpectationTimestamp(payload: SessionEventPayload): boolean {
    return streamTracking.isStaleByExpectationTimestamp(this.asHost(), payload);
  }

  private isStaleByStreamGeneration(payload: SessionEventPayload): boolean {
    return streamTracking.isStaleByStreamGeneration(this.asHost(), payload);
  }

  private isTargetingCurrentStreamMessage(messageId?: string): boolean {
    return streamTracking.isTargetingCurrentStreamMessage(this.asHost(), messageId);
  }

  private canAdoptRetryReboundStreamStart(
    state: ChatStore,
    incomingMessageId: string,
    currentStreamingMessageId: string | null,
    expectedMessageId: string | null,
  ): boolean {
    return streamTracking.canAdoptRetryReboundStreamStart(this.asHost(), state, incomingMessageId, currentStreamingMessageId, expectedMessageId);
  }

  private claimAnkiEventOwnership(source: string): void {
    ChatV2TauriAdapter.ankiEventOwnerAdapterId = this.adapterInstanceId;
    emitChatAnkiDebugLifecycle({
      level: 'info',
      phase: 'bridge:event',
      summary: `anki_event ownership claimed by adapter#${this.adapterInstanceId} (${source})`,
      detail: { adapterId: this.adapterInstanceId, sessionId: this.sessionId, source },
    });
  }

  private releaseAnkiEventOwnershipIfHeld(source: string): void {
    if (ChatV2TauriAdapter.ankiEventOwnerAdapterId !== this.adapterInstanceId) return;
    ChatV2TauriAdapter.ankiEventOwnerAdapterId = null;
    emitChatAnkiDebugLifecycle({
      level: 'debug',
      phase: 'bridge:event',
      summary: `anki_event ownership released by adapter#${this.adapterInstanceId} (${source})`,
      detail: { adapterId: this.adapterInstanceId, sessionId: this.sessionId, source },
    });
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

  private registerEventListenersWithRollback(): Promise<UnlistenFn[]> {
    return adapterLifecycle.registerEventListenersWithRollback(this.asHost());
  }

  private releaseUnlisteners(unlisteners: UnlistenFn[], reason: string): void {
    adapterLifecycle.releaseUnlisteners(this.asHost(), unlisteners, reason);
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
  retrySetupListeners(): Promise<boolean> {
    return adapterLifecycle.retrySetupListeners(this.asHost());
  }

  // ========================================================================
  // 生命周期
  // ========================================================================

  /**
   * 初始化适配器
   * 设置事件监听器
   */
  setup(): Promise<void> {
    return adapterLifecycle.setup(this.asHost());
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
  cleanup(): Promise<void> {
    return adapterLifecycle.cleanup(this.asHost());
  }

  // ========================================================================
  // 事件处理
  // ========================================================================

  private scheduleAnkiRetryReconcile(blockId: string, documentId: string): void {
    ankiRetryReconcile.scheduleAnkiRetryReconcile(this.asHost(), blockId, documentId);
  }

  private reconcileLoadedAnkiBlocks(): void {
    ankiRetryReconcile.reconcileLoadedAnkiBlocks(this.asHost());
  }

  private reconcileAnkiRetryState(
    blockId: string,
    documentId: string,
    revision: number,
  ): Promise<void> {
    return ankiRetryReconcile.reconcileAnkiRetryState(this.asHost(), blockId, documentId, revision);
  }

  private extractAnkiCardQuestion(card: AnkiCard): string {
    return ankiGenerationEvents.extractAnkiCardQuestion(this.asHost(), card);
  }

  private buildAnkiCardsSignature(cards: AnkiCard[]): string {
    return ankiGenerationEvents.buildAnkiCardsSignature(this.asHost(), cards);
  }

  private recordAnkiSourceSnapshot(
    targetBlock: { id: string },
    source: string,
    cards: AnkiCard[],
    status: string | undefined,
    docId: string | undefined,
  ): void {
    ankiGenerationEvents.recordAnkiSourceSnapshot(this.asHost(), targetBlock, source, cards, status, docId);
  }

  private flushAnkiCardBuffer(blockId: string): void {
    ankiGenerationEvents.flushAnkiCardBuffer(this.asHost(), blockId);
  }

  private handleAnkiGenerationEvent(payload: unknown): void {
    ankiGenerationEvents.handleAnkiGenerationEvent(this.asHost(), payload);
  }

  private handleBlockEvent(event: BackendEvent): void {
    blockEvents.handleBlockEvent(this.asHost(), event);
  }

  private handleLlmRequestBody(payload: LlmRequestBodyEventPayload): void {
    blockEvents.handleLlmRequestBody(this.asHost(), payload);
  }

  private handleSessionEvent(payload: SessionEventPayload): void {
    sessionEventHandler.handleSessionEvent(this.asHost(), payload);
  }

  private handleVariantDeleted(payload: SessionEventPayload): void {
    sessionEventHandler.handleVariantDeleted(this.asHost(), payload);
  }

  // ========================================================================
  // 消息操作
  // ========================================================================

  private generateMessageId(): string {
    return sendOperations.generateMessageId(this.asHost());
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
  sendMessage(content: string, attachments?: AttachmentMeta[]): Promise<void> {
    return sendOperations.sendMessage(this.asHost(), content, attachments);
  }

  private executeWakeSession(
    content: string,
    assistantMessageId: string,
  ): Promise<void> {
    return sendOperations.executeWakeSession(this.asHost(), content, assistantMessageId);
  }

  private executeDeliverInbox(
    userMessageId: string,
    assistantMessageId: string,
    force: boolean,
  ): Promise<DeliverOutcome> {
    return sendOperations.executeDeliverInbox(this.asHost(), userMessageId, assistantMessageId, force);
  }

  private executeSendMessage(
    content: string,
    attachments: AttachmentMeta[] | undefined,
    userMessageId: string,
    assistantMessageId: string
  ): Promise<void> {
    return sendOperations.executeSendMessage(this.asHost(), content, attachments, userMessageId, assistantMessageId);
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
  abortStream(): Promise<void> {
    return messageOperations.abortStream(this.asHost());
  }

  private executeAbort(): Promise<void> {
    return messageOperations.executeAbort(this.asHost());
  }

  private executeRetry(
    messageId: string,
    modelOverride?: string
  ): Promise<RetryMessageResult> {
    return messageOperations.executeRetry(this.asHost(), messageId, modelOverride);
  }

  /**
   * 重试消息（公开方法）
   * 
   * @deprecated 推荐通过 store.retryMessage() 调用，会自动使用注入的回调
   * 
   * 此方法仅作为后备使用，正常流程应该是：
   * store.retryMessage() -> _retryCallback -> executeRetry()
   */
  retryMessage(messageId: string, modelOverride?: string): Promise<void> {
    return messageOperations.retryMessage(this.asHost(), messageId, modelOverride);
  }

  /**
   * 编辑并重发消息（公开方法）
   * 
   * @deprecated 推荐通过 store.editAndResend() 调用，会自动使用注入的回调
   * 
   * 此方法仅作为后备使用，正常流程应该是：
   * store.editAndResend() -> _editAndResendCallback -> executeEditAndResend()
   */
  editAndResend(messageId: string, newContent: string): Promise<void> {
    return messageOperations.editAndResend(this.asHost(), messageId, newContent);
  }

  private executeDelete(messageId: string): Promise<void> {
    return messageOperations.executeDelete(this.asHost(), messageId);
  }

  /**
   * 删除消息（公开方法）
   * 
   * @deprecated 推荐通过 store.deleteMessage() 调用，会自动使用注入的回调
   * 
   * 此方法仅作为后备使用，正常流程应该是：
   * store.deleteMessage() -> _deleteCallback -> executeDelete()
   */
  deleteMessage(messageId: string): Promise<void> {
    return messageOperations.deleteMessage(this.asHost(), messageId);
  }

  private executeEditAndResend(
    messageId: string,
    newContent: string,
    newContextRefs?: ContextRef[]
  ): Promise<EditMessageResult> {
    return messageOperations.executeEditAndResend(this.asHost(), messageId, newContent, newContextRefs);
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
  continueMessage(messageId: string, variantId?: string): Promise<void> {
    return messageOperations.continueMessage(this.asHost(), messageId, variantId);
  }

  // ========================================================================
  // 会话操作
  // ========================================================================

  /**
   * 加载会话（尾部分块）
   *
   * 第一阶段只取最近 LOAD_SESSION_TAIL_LIMIT 条消息（后端另按载荷体量截短，
   * #469），首屏 IPC/渲染成本与会话总长度/总体量解耦；若后端报告还有缺失历史，首帧空闲后全量拉取并按锚点合并
   * （store.prependHistoryFromBackend，滚动锚定由 MessageList 补偿）。
   */
  loadSession(): Promise<void> {
    return historyLoading.loadSession(this.asHost());
  }

  /** 手动加载更早历史（🚀 长会话内存窗口化）：从连续窗口起点向更老一页
   * 请求 `chat_v2_load_messages_page`，合并后窗口起点向 0 推进（窗口始终
   * 连续）。空闲期自动补页在途时跳过（避免窗口竞态）；全量已完成或窗口
   * 已抵达最老端时无可补。 */
  loadEarlierMessages(): Promise<void> {
    return historyLoading.loadEarlierMessages(this.asHost());
  }

  private loadFullHistoryFallback(generation: number): Promise<boolean> {
    return historyLoading.loadFullHistoryFallback(this.asHost(), generation);
  }

  private scheduleFullHistoryLoad(attempt = 0): void {
    historyLoading.scheduleFullHistoryLoad(this.asHost(), attempt);
  }

  private backfillHistoryByPages(
    generation: number,
  ): Promise<'done' | 'capped' | 'stale' | 'unsupported'> {
    return historyLoading.backfillHistoryByPages(this.asHost(), generation);
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
  saveSession(): Promise<void> {
    return sessionCommands.saveSession(this.asHost());
  }

  /**
   * 创建新会话
   */
  createSession(
    mode: string,
    title?: string
  ): Promise<string> {
    return sessionCommands.createSession(this.asHost(), mode, title);
  }

  /**
   * 更新会话设置
   */
  updateSessionSettings(settings: SessionSettings): Promise<void> {
    return sessionCommands.updateSessionSettings(this.asHost(), settings);
  }

  /**
   * 归档会话
   */
  archiveSession(): Promise<void> {
    return sessionCommands.archiveSession(this.asHost());
  }

  /**
   * 🆕 P0 分支模型：从当前会话分支出新会话
   *
   * 封装 `chat_v2_branch_session`：以 upToMessageId（含）为截断点复制消息、
   * 块与会话状态到新会话，并由后端维护 parentId 血缘与资源引用计数。
   *
   * 通过 setBranchSessionCallback 注入 store，UI 应经由
   * store.branchSession(upToMessageId) 调用而非直接 invoke。
   *
   * @param upToMessageId 分支截断点消息 ID（新会话包含该消息及之前的历史）
   * @returns 新分支会话（含 id，供 UI 导航）
   */
  branchSession(upToMessageId: string): Promise<BranchSessionResult> {
    return sessionCommands.branchSession(this.asHost(), upToMessageId);
  }

  // ========================================================================
  // 变体操作
  // ========================================================================

  private executeSwitchVariant(
    messageId: string,
    variantId: string
  ): Promise<void> {
    return variantOperations.executeSwitchVariant(this.asHost(), messageId, variantId);
  }

  private executeDeleteVariant(
    messageId: string,
    variantId: string
  ): Promise<{ variantDeleted?: boolean; messageDeleted?: boolean; newActiveId?: string }> {
    return variantOperations.executeDeleteVariant(this.asHost(), messageId, variantId);
  }

  private executeRetryVariant(
    messageId: string,
    variantId: string,
    modelOverride?: string
  ): Promise<void> {
    return variantOperations.executeRetryVariant(this.asHost(), messageId, variantId, modelOverride);
  }

  private executeRetryAllVariants(
    messageId: string,
    variantIds: string[]
  ): Promise<void> {
    return variantOperations.executeRetryAllVariants(this.asHost(), messageId, variantIds);
  }

  private executeCancelVariant(variantId: string): Promise<void> {
    return variantOperations.executeCancelVariant(this.asHost(), variantId);
  }

  private executeUpdateBlockContent(blockId: string, content: string): Promise<void> {
    return sessionCommands.executeUpdateBlockContent(this.asHost(), blockId, content);
  }

  private executeUpdateSessionSettings(settings: { title?: string }): Promise<void> {
    return sessionCommands.executeUpdateSessionSettings(this.asHost(), settings);
  }

  private executeUpsertStreamingBlock(
    blockId: string,
    messageId: string,
    blockType: string,
    content: string,
    sessionId?: string
  ): Promise<void> {
    return sessionCommands.executeUpsertStreamingBlock(this.asHost(), blockId, messageId, blockType, content, sessionId);
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  private ensureModelMetadataReady(modelId: string | undefined): Promise<void> {
    return modelSelection.ensureModelMetadataReady(this.asHost(), modelId);
  }

  private hydrateDefaultChatModelIfMissing(): Promise<void> {
    return modelSelection.hydrateDefaultChatModelIfMissing(this.asHost());
  }

  private getEffectiveRuntimeModelId(options: {
    modelId?: string;
    model2OverrideId?: string;
  }): string | undefined {
    return modelSelection.getEffectiveRuntimeModelId(this.asHost(), options);
  }

  private resolveModelSupportsRuntimeThinking(modelId: string | undefined): boolean | undefined {
    return modelSelection.resolveModelSupportsRuntimeThinking(this.asHost(), modelId);
  }

  private applyRuntimeThinkingCapability(options: SendOptions): void {
    modelSelection.applyRuntimeThinkingCapability(this.asHost(), options);
  }

  private applyRuntimeContextBudget(options: SendOptions): void {
    modelSelection.applyRuntimeContextBudget(this.asHost(), options);
  }

  private shouldResolveContextAsMultimodal(options: {
    modelId?: string;
    model2OverrideId?: string;
    parallelModelIds?: string[];
  }): Promise<boolean> {
    return modelSelection.shouldResolveContextAsMultimodal(this.asHost(), options);
  }

  private getValidChatModelIdSet(): Promise<Set<string>> {
    return modelSelection.getValidChatModelIdSet(this.asHost());
  }

  private resolveEffectiveChatModelId(modelId: string | undefined, validIds?: Set<string>): Promise<string> {
    return modelSelection.resolveEffectiveChatModelId(this.asHost(), modelId, validIds);
  }

  private normalizeChatModelSelection(
    modelId: string | undefined,
    model2OverrideId: string | undefined,
    pinnedByUser?: boolean
  ): Promise<NormalizedChatModelSelection> {
    return modelSelection.normalizeChatModelSelection(this.asHost(), modelId, model2OverrideId, pinnedByUser);
  }

  private applyRuntimeModelSelection(options: SendOptions): Promise<NormalizedChatModelSelection> {
    return modelSelection.applyRuntimeModelSelection(this.asHost(), options);
  }

  private resolveReplaySkillSnapshot(
    messageId: string,
    variantId?: string
  ): {
    snapshot: {
      manualPinnedSkillIds?: string[];
      modeRequiredBundleIds?: string[];
      agenticSessionSkillIds?: string[];
      branchLocalSkillIds?: string[];
      effectiveAllowedExternalServers?: string[];
    };
    runtimeSnapshot?: {
      activeSkillIds?: string[];
      skillContents?: Record<string, string>;
      skillDependencies?: Record<string, string[]>;
      skillEmbeddedTools?: Record<string, Array<{ name: string; serverId?: string; description?: string; inputSchema?: unknown }>>;
      mcpToolSchemas?: Array<{ name: string; serverId?: string; description?: string; inputSchema?: unknown }>;
      selectedMcpServers?: string[];
    };
    selectedServerIds?: string[];
  } | null {
    return skillRuntime.resolveReplaySkillSnapshot(this.asHost(), messageId, variantId);
  }

  private applyOriginalReplaySkillState(
    messageId: string,
    options: SendOptions,
    selectedServerIds?: string[],
    variantId?: string
  ): SendOptions {
    return skillRuntime.applyOriginalReplaySkillState(this.asHost(), messageId, options, selectedServerIds, variantId);
  }

  private getStructuredSkillStateFromStore(): {
    manualPinnedSkillIds: string[];
    modeRequiredBundleIds: string[];
    agenticSessionSkillIds: string[];
    branchLocalSkillIds: string[];
  } | null {
    return skillRuntime.getStructuredSkillStateFromStore(this.asHost());
  }

  private resolveInputContextLimit(
    modelId: string | undefined,
    model2OverrideId: string | undefined,
    maxTokens: number,
    userContextLimit: number | undefined
  ): number {
    return sendOptions.resolveInputContextLimit(this.asHost(), modelId, model2OverrideId, maxTokens, userContextLimit);
  }

  private getContextTruncateLimit(contextLimit: number | undefined): number {
    return sendOptions.getContextTruncateLimit(this.asHost(), contextLimit);
  }

  private notifyContextTruncated(removedCount: number): void {
    sendOptions.notifyContextTruncated(this.asHost(), removedCount);
  }

  private buildSendOptions(snapshot?: BuildSendOptionsSnapshot): Promise<SendOptions> {
    return sendOptions.buildSendOptions(this.asHost(), snapshot);
  }


  private collectMcpToolSchemas(
    selectedServerIds?: string[],
    loadedSkillIds?: string[],
  ): Promise<Array<{ name: string; serverId?: string; description?: string; inputSchema?: unknown }>> {
    return sendOptions.collectMcpToolSchemas(this.asHost(), selectedServerIds, loadedSkillIds);
  }

  private buildSystemPromptWithSkills(
    basePrompt: string | undefined
  ): Promise<string | undefined> {
    return sendOptions.buildSystemPromptWithSkills(this.asHost(), basePrompt);
  }

  private ensureAvailableSkillsSnapshotFrozen(): Promise<string> {
    return availableSkillsSnapshot.ensureAvailableSkillsSnapshotFrozen(this.asHost());
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
