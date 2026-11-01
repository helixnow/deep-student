/**
 * Chat V2 - TauriAdapter 拆分模块 —— 共享类型（host 接口与事件/响应载荷类型）
 */

import type { UnlistenFn } from '@tauri-apps/api/event';
import type { AdapterErrorStoreApi } from '../errors/adapterErrorChannel';
import type { StoreApi } from 'zustand';
import type {
  ChatStore,
  AttachmentMeta,
  LoadSessionResponseType,
  SessionRestoreBaseline,
  DeliverOutcome,
} from '../../core/types';
import type { BackendEvent } from '../../core/middleware/eventBridge';
import type { AnkiCard } from '@/types';
import type {
  SendOptions,
  SessionEventPayload,
  EditMessageResult,
  RetryMessageResult,
  BranchSessionResult,
} from '../types';
import type { ContextRef } from '../../resources/types';
import type { NormalizedChatModelSelection } from './requestHelpers';
import type { StreamExpectation, PendingStreamCompletion } from './streamLifecycle';

/** chat_v2_load_messages_page 响应（messages/blocks 结构与 load_session 一致） */
export interface LoadMessagesPageResponseType {
  messages: LoadSessionResponseType['messages'];
  blocks: LoadSessionResponseType['blocks'];
  totalMessageCount: number;
  offset: number;
  limit: number;
}

export interface LlmRequestBodyEventPayload {
  streamEvent: string;
  model: string;
  url: string;
  requestBody: unknown;
  logFilePath?: string | null;
  messageId?: string;
}

export interface BuildSendOptionsSnapshot {
  state?: ChatStore;
  pendingContextRefs?: ContextRef[];
}

/**
 * 拆分模块通过 host 访问适配器实例状态与方法（host 即 ChatV2TauriAdapter 实例本身，
 * 经 asHost() 收窄类型），保证实例上的方法替换/spy 与原 this 调用语义一致。
 */
export interface TauriAdapterHost {
  sessionId: string;
  notifiedUnavailablePinnedModels: Set<string>;
  storeApi: StoreApi<ChatStore> | null;
  store: ChatStore;
  unlisteners: UnlistenFn[];
  isSetup: boolean;
  setupGeneration: number;
  readonly adapterInstanceId: number;
  unregisterStreamingBlockSaver: (() => void) | null;
  cancelScheduledFullHistoryLoad: (() => void) | null;
  fullHistoryLoadInFlight: boolean;
  fullHistoryLoadComplete: boolean;
  historyWindowStartOffset: number;
  lastLoadedSessionInfo: LoadSessionResponseType['session'] | null;
  onDataRestored: (() => void) | null;
  listenersReadyPromise: Promise<void> | null;
  listenerRegistrationError: Error | null;
  isRetryingListeners: boolean;
  streamExpectation: StreamExpectation | null;
  lastStreamGenerationByMessageId: Map<string, number>;
  pendingStreamCompletion: PendingStreamCompletion | null;
  chatAnkiChunkLogCounter: Map<string, number>;
  variantChunkLogCounter: number;
  retryingAnkiDocumentIds: Set<string>;
  ankiRetryReconcileRevisions: Map<string, number>;
  ankiCardFlushQueue: Map<
    string,
    { cards: AnkiCard[]; cardIds: Set<string>; documentId?: string; timer: ReturnType<typeof setTimeout> | null }
  >;
  unregisterBridgeStoreResolver: (() => void) | null;

  getCurrentState(): ChatStore;
  ensureBridgeStoreResolver(): void;
  getErrorStoreApi(): AdapterErrorStoreApi | null;
  claimSessionRuntimeOwnership(): boolean;
  isSessionRuntimeOwner(): boolean;
  releaseSessionRuntimeOwnershipIfHeld(): void;
  captureRestoreBaseline(): SessionRestoreBaseline;
  beginStreamExpectation(messageId: string): void;
  setStreamExpectationMessageId(messageId: string): void;
  syncStreamExpectationFromEvent(
    messageId: string,
    timestamp?: number,
    streamGeneration?: number,
  ): void;
  clearStreamExpectation(messageId?: string): void;
  cancelPendingStreamCompletion(): void;
  armPendingStreamCompletion(pending: PendingStreamCompletion): void;
  settleStreamCompletion(payload: SessionEventPayload): void;
  forceSettlePendingStreamCompletion(): void;
  scheduleStreamCompletion(payload: SessionEventPayload): void;
  touchPendingStreamCompletion(): void;
  isStaleByExpectationTimestamp(payload: SessionEventPayload): boolean;
  isStaleByStreamGeneration(payload: SessionEventPayload): boolean;
  isTargetingCurrentStreamMessage(messageId?: string): boolean;
  canAdoptRetryReboundStreamStart(
    state: ChatStore,
    incomingMessageId: string,
    currentStreamingMessageId: string | null,
    expectedMessageId: string | null,
  ): boolean;
  claimAnkiEventOwnership(source: string): void;
  releaseAnkiEventOwnershipIfHeld(source: string): void;
  waitForListenersReady(): Promise<void>;
  registerEventListenersWithRollback(): Promise<UnlistenFn[]>;
  releaseUnlisteners(unlisteners: UnlistenFn[], reason: string): void;
  retrySetupListeners(): Promise<boolean>;
  scheduleAnkiRetryReconcile(blockId: string, documentId: string): void;
  reconcileLoadedAnkiBlocks(): void;
  reconcileAnkiRetryState(
    blockId: string,
    documentId: string,
    revision: number,
  ): Promise<void>;
  extractAnkiCardQuestion(card: AnkiCard): string;
  buildAnkiCardsSignature(cards: AnkiCard[]): string;
  recordAnkiSourceSnapshot(
    targetBlock: { id: string },
    source: string,
    cards: AnkiCard[],
    status: string | undefined,
    docId: string | undefined,
  ): void;
  flushAnkiCardBuffer(blockId: string): void;
  handleAnkiGenerationEvent(payload: unknown): void;
  handleBlockEvent(event: BackendEvent): void;
  handleLlmRequestBody(payload: LlmRequestBodyEventPayload): void;
  handleSessionEvent(payload: SessionEventPayload): void;
  handleVariantDeleted(payload: SessionEventPayload): void;
  generateMessageId(): string;
  executeWakeSession(
    content: string,
    assistantMessageId: string,
  ): Promise<void>;
  executeDeliverInbox(
    userMessageId: string,
    assistantMessageId: string,
    force: boolean,
  ): Promise<DeliverOutcome>;
  executeSendMessage(
    content: string,
    attachments: AttachmentMeta[] | undefined,
    userMessageId: string,
    assistantMessageId: string
  ): Promise<void>;
  executeAbort(): Promise<void>;
  executeRetry(
    messageId: string,
    modelOverride?: string
  ): Promise<RetryMessageResult>;
  executeDelete(messageId: string): Promise<void>;
  executeEditAndResend(
    messageId: string,
    newContent: string,
    newContextRefs?: ContextRef[]
  ): Promise<EditMessageResult>;
  continueMessage(messageId: string, variantId?: string): Promise<void>;
  loadSession(): Promise<void>;
  loadEarlierMessages(): Promise<void>;
  loadFullHistoryFallback(generation: number): Promise<boolean>;
  scheduleFullHistoryLoad(attempt?: number): void;
  backfillHistoryByPages(
    generation: number,
  ): Promise<'done' | 'capped' | 'stale' | 'unsupported'>;
  saveSession(): Promise<void>;
  branchSession(upToMessageId: string): Promise<BranchSessionResult>;
  executeSwitchVariant(
    messageId: string,
    variantId: string
  ): Promise<void>;
  executeDeleteVariant(
    messageId: string,
    variantId: string
  ): Promise<{ variantDeleted?: boolean; messageDeleted?: boolean; newActiveId?: string }>;
  executeRetryVariant(
    messageId: string,
    variantId: string,
    modelOverride?: string
  ): Promise<void>;
  executeRetryAllVariants(
    messageId: string,
    variantIds: string[]
  ): Promise<void>;
  executeCancelVariant(variantId: string): Promise<void>;
  executeUpdateBlockContent(blockId: string, content: string): Promise<void>;
  executeUpdateSessionSettings(settings: { title?: string }): Promise<void>;
  executeUpsertStreamingBlock(
    blockId: string,
    messageId: string,
    blockType: string,
    content: string,
    sessionId?: string
  ): Promise<void>;
  ensureModelMetadataReady(modelId: string | undefined): Promise<void>;
  hydrateDefaultChatModelIfMissing(): Promise<void>;
  getEffectiveRuntimeModelId(options: {
    modelId?: string;
    model2OverrideId?: string;
  }): string | undefined;
  resolveModelSupportsRuntimeThinking(modelId: string | undefined): boolean | undefined;
  applyRuntimeThinkingCapability(options: SendOptions): void;
  shouldResolveContextAsMultimodal(options: {
    modelId?: string;
    model2OverrideId?: string;
    parallelModelIds?: string[];
  }): Promise<boolean>;
  getValidChatModelIdSet(): Promise<Set<string>>;
  resolveEffectiveChatModelId(modelId: string | undefined, validIds?: Set<string>): Promise<string>;
  normalizeChatModelSelection(
    modelId: string | undefined,
    model2OverrideId: string | undefined,
    pinnedByUser?: boolean
  ): Promise<NormalizedChatModelSelection>;
  applyRuntimeModelSelection(options: SendOptions): Promise<NormalizedChatModelSelection>;
  resolveReplaySkillSnapshot(
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
  } | null;
  applyOriginalReplaySkillState(
    messageId: string,
    options: SendOptions,
    selectedServerIds?: string[],
    variantId?: string
  ): SendOptions;
  getStructuredSkillStateFromStore(): {
    manualPinnedSkillIds: string[];
    modeRequiredBundleIds: string[];
    agenticSessionSkillIds: string[];
    branchLocalSkillIds: string[];
  } | null;
  resolveInputContextLimit(
    modelId: string | undefined,
    model2OverrideId: string | undefined,
    maxTokens: number,
    userContextLimit: number | undefined
  ): number;
  getContextTruncateLimit(contextLimit: number | undefined): number;
  notifyContextTruncated(removedCount: number): void;
  buildSendOptions(snapshot?: BuildSendOptionsSnapshot): Promise<SendOptions>;
  collectMcpToolSchemas(
    selectedServerIds?: string[],
    loadedSkillIds?: string[],
  ): Promise<Array<{ name: string; serverId?: string; description?: string; inputSchema?: unknown }>>;
  buildSystemPromptWithSkills(
    basePrompt: string | undefined
  ): Promise<string | undefined>;
  ensureAvailableSkillsSnapshotFrozen(): Promise<string>;
  getAnkiEventOwnerAdapterId(): number | null;
}
