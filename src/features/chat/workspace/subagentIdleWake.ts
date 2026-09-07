export interface SubagentCompletionWakePayload {
  workspace_id: string;
  agent_session_id: string;
  parent_session_id?: string;
  task_id?: string;
  run_id?: string;
  completed_at?: string;
  status: string;
  final_output?: string;
  error?: string;
}

export interface ParentWakeState {
  sessionStatus: string;
  currentStreamingMessageId?: string | null;
}

export interface ParentWakeStore {
  getState(): ParentWakeState;
  subscribe(listener: (state: ParentWakeState) => void): () => void;
}

/** wait=true 工具返回值中的终态 status（与后端 subagent_executor 的终态返回一致） */
const SYNC_DELIVERED_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * 判断本次子代理完成是否已通过 wait=true 工具返回值交付过。
 *
 * wait=true 同步调用的结果已随工具返回值写入父会话的 subagent_embed 块
 * （后端 subagent_executor 也会吞掉父会话收件箱里对应的 agent_completion
 * 消息）；完成事件若再唤醒一次，等于把同一子代理既当同步又当异步处理。
 *
 * run_id 双侧齐全时必须匹配，避免续跑场景旧 run 的回执吞掉新 run 的唤醒；
 * 单侧缺失时按 agent + 终态回执兜底匹配（兼容旧历史块）。
 */
export function wasDeliveredViaSyncToolReturn(
  parentStore: ParentWakeStore,
  payload: SubagentCompletionWakePayload,
): boolean {
  const state = parentStore.getState() as ParentWakeState & {
    blocks?: Map<string, { type?: string; toolOutput?: unknown }>;
  };
  if (!state.blocks) return false;
  for (const block of state.blocks.values()) {
    if (block.type !== 'subagent_embed') continue;
    const output = block.toolOutput as
      | { agent_session_id?: unknown; run_id?: unknown; status?: unknown }
      | null
      | undefined;
    if (!output || output.agent_session_id !== payload.agent_session_id) continue;
    const status = typeof output.status === 'string' ? output.status : '';
    if (!SYNC_DELIVERED_TERMINAL_STATUSES.has(status)) continue;
    if (typeof output.run_id === 'string' && payload.run_id && output.run_id !== payload.run_id) {
      continue;
    }
    return true;
  }
  return false;
}

interface IdleWakeControllerOptions {
  resolveParentStore(parentSessionId: string): Promise<ParentWakeStore | undefined>;
  /**
   * Return true only after wakeSession has completed successfully. The
   * controller marks the completion processed only after this returns true.
   */
  sendWake(
    payload: SubagentCompletionWakePayload,
    parentStore: ParentWakeStore,
  ): Promise<boolean>;
  onError?(error: unknown, parentSessionId: string): void;
  onParentUnavailable?(parentSessionId: string): void;
}

const COMPLETION_WAKE_DEDUP_MAX = 200;
const PARENT_LOOKUP_RETRY_MS = 1_000;
const PARENT_LOOKUP_MAX_RETRIES = 120;

function isIdle(state: ParentWakeState): boolean {
  return state.sessionStatus === 'idle' && !state.currentStreamingMessageId;
}

function wakeKey(payload: SubagentCompletionWakePayload): string {
  // task_id identifies distinct dispatches if older envelopes lack both run_id
  // and completed_at. Do not fall back to agent id alone: that collides.
  return `${payload.agent_session_id}:${payload.run_id ?? payload.completed_at ?? payload.task_id ?? 'unknown'}`;
}

/**
 * Serializes completion wakes per parent. Busy or not-yet-loaded parents retain
 * their queue entries until they can be sent; only a successful send is final.
 *
 * G03-a 角色降级：本控制器从"唯一唤醒责任方"降级为**后端账本的投影/快路径**。
 * 权威投递在 chat_v2 主库 `completion_outbox` 表 + 后端 CompletionDispatcher
 * （常驻兜底：claim → 查重/补投 inbox → emit）。本控制器的职责收敛为：
 * 窗口在场时收到 `workspace_agent_completion` 即尽快唤醒父会话。
 * 放弃（父会话长时间不可得）不等于丢弃——不写入 processedWakeKeys，后端
 * dispatcher 重投同一 completion 时本控制器可再次入队尝试；且 inbox Result
 * 消息始终持久，父会话下次任意 turn 的 drain_inbox 也会消费它。
 */
export class SubagentIdleWakeController {
  private readonly pendingWakesByParent = new Map<string, SubagentCompletionWakePayload[]>();
  private readonly queuedWakeKeys = new Set<string>();
  private readonly processedWakeKeys = new Set<string>();
  private readonly drainingParents = new Set<string>();
  private readonly idleUnsubscribers = new Map<string, () => void>();
  private readonly subscribedParentStores = new Map<string, ParentWakeStore>();
  private readonly lookupRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly parentLookupRetryCounts = new Map<string, number>();

  constructor(private readonly options: IdleWakeControllerOptions) {}

  enqueue(payload: SubagentCompletionWakePayload): void {
    const parentSessionId = payload.parent_session_id;
    if (!parentSessionId) return;

    const key = wakeKey(payload);
    if (this.processedWakeKeys.has(key) || this.queuedWakeKeys.has(key)) return;

    const queue = this.pendingWakesByParent.get(parentSessionId) ?? [];
    queue.push(payload);
    this.pendingWakesByParent.set(parentSessionId, queue);
    this.queuedWakeKeys.add(key);
    void this.drain(parentSessionId);
  }

  dispose(): void {
    for (const unsubscribe of this.idleUnsubscribers.values()) unsubscribe();
    for (const timer of this.lookupRetryTimers.values()) clearTimeout(timer);
    this.idleUnsubscribers.clear();
    this.subscribedParentStores.clear();
    this.lookupRetryTimers.clear();
    this.parentLookupRetryCounts.clear();
    this.pendingWakesByParent.clear();
    this.queuedWakeKeys.clear();
    this.drainingParents.clear();
  }

  clearWorkspace(workspaceId: string): void {
    for (const [parentSessionId, queue] of this.pendingWakesByParent) {
      const retained = queue.filter((payload) => payload.workspace_id !== workspaceId);
      const removed = queue.filter((payload) => payload.workspace_id === workspaceId);
      for (const payload of removed) {
        this.queuedWakeKeys.delete(wakeKey(payload));
      }

      if (retained.length > 0) {
        this.pendingWakesByParent.set(parentSessionId, retained);
        continue;
      }

      this.pendingWakesByParent.delete(parentSessionId);
      this.clearParentRuntime(parentSessionId);
    }
  }

  private markProcessed(payload: SubagentCompletionWakePayload): void {
    const key = wakeKey(payload);
    this.queuedWakeKeys.delete(key);
    this.processedWakeKeys.add(key);
    if (this.processedWakeKeys.size > COMPLETION_WAKE_DEDUP_MAX) {
      const oldest = this.processedWakeKeys.values().next().value;
      if (oldest) this.processedWakeKeys.delete(oldest);
    }
  }

  /**
   * 放弃本次内存排队（父会话在本窗口生命周期内不可得）。
   *
   * 与 markProcessed 的关键区别：**不写入 processedWakeKeys**。G03-a 后权威
   * 投递在后端 completion outbox + CompletionDispatcher——账本行保持
   * pending，dispatcher 会在条件具备时重投同一 completion 事件；届时同 key
   * 可重新入队再走一遍投影唤醒。前端不再永久"记住"放弃状态。
   */
  private releaseForBackendFallback(payload: SubagentCompletionWakePayload): void {
    this.queuedWakeKeys.delete(wakeKey(payload));
  }

  private clearParentRuntime(parentSessionId: string): void {
    this.idleUnsubscribers.get(parentSessionId)?.();
    this.idleUnsubscribers.delete(parentSessionId);
    this.subscribedParentStores.delete(parentSessionId);
    const timer = this.lookupRetryTimers.get(parentSessionId);
    if (timer) clearTimeout(timer);
    this.lookupRetryTimers.delete(parentSessionId);
    this.parentLookupRetryCounts.delete(parentSessionId);
  }

  private armIdleSubscription(parentSessionId: string, parentStore: ParentWakeStore): void {
    const subscribedStore = this.subscribedParentStores.get(parentSessionId);
    if (subscribedStore === parentStore && this.idleUnsubscribers.has(parentSessionId)) return;
    if (subscribedStore && subscribedStore !== parentStore) {
      this.idleUnsubscribers.get(parentSessionId)?.();
      this.idleUnsubscribers.delete(parentSessionId);
      this.subscribedParentStores.delete(parentSessionId);
    }
    const unsubscribe = parentStore.subscribe((state) => {
      if (!isIdle(state)) return;
      this.idleUnsubscribers.get(parentSessionId)?.();
      this.idleUnsubscribers.delete(parentSessionId);
      this.subscribedParentStores.delete(parentSessionId);
      void this.drain(parentSessionId);
    });
    this.idleUnsubscribers.set(parentSessionId, unsubscribe);
    this.subscribedParentStores.set(parentSessionId, parentStore);
    // Close the getState→subscribe race: the parent may have become idle
    // immediately before the subscription was installed.
    if (isIdle(parentStore.getState())) {
      unsubscribe();
      this.idleUnsubscribers.delete(parentSessionId);
      this.subscribedParentStores.delete(parentSessionId);
      void Promise.resolve().then(() => this.drain(parentSessionId));
    }
  }

  private scheduleLookupRetry(parentSessionId: string): void {
    if (this.lookupRetryTimers.has(parentSessionId)) return;
    const timer = setTimeout(() => {
      this.lookupRetryTimers.delete(parentSessionId);
      void this.drain(parentSessionId);
    }, PARENT_LOOKUP_RETRY_MS);
    this.lookupRetryTimers.set(parentSessionId, timer);
  }

  private async drain(parentSessionId: string): Promise<void> {
    if (this.drainingParents.has(parentSessionId)) return;
    this.drainingParents.add(parentSessionId);
    try {
      while (this.pendingWakesByParent.get(parentSessionId)?.length) {
        const parentStore = await this.options.resolveParentStore(parentSessionId);
        if (!parentStore) {
          const retryCount = (this.parentLookupRetryCounts.get(parentSessionId) ?? 0) + 1;
          this.parentLookupRetryCounts.set(parentSessionId, retryCount);
          if (retryCount >= PARENT_LOOKUP_MAX_RETRIES) {
            const abandoned = this.pendingWakesByParent.get(parentSessionId) ?? [];
            // G03-a：放弃内存排队 ≠ 丢弃投递。权威账本在后端 outbox，
            // dispatcher 会兜底重投；此处仅结束本窗口的排队与订阅。
            for (const payload of abandoned) this.releaseForBackendFallback(payload);
            this.pendingWakesByParent.delete(parentSessionId);
            this.clearParentRuntime(parentSessionId);
            console.warn(
              `[SubagentIdleWake] Released ${abandoned.length} completion wake(s) to backend dispatcher: parent ${parentSessionId} was unavailable after ${retryCount} retries (delivery remains durable in completion_outbox)`,
            );
            return;
          }
          this.options.onParentUnavailable?.(parentSessionId);
          this.scheduleLookupRetry(parentSessionId);
          return;
        }
        this.parentLookupRetryCounts.delete(parentSessionId);

        const state = parentStore.getState();
        if (!isIdle(state)) {
          this.armIdleSubscription(parentSessionId, parentStore);
          return;
        }

        const payload = this.pendingWakesByParent.get(parentSessionId)?.[0];
        if (!payload) return;
        try {
          const sent = await this.options.sendWake(payload, parentStore);
          if (!sent) {
            if (isIdle(parentStore.getState())) {
              this.scheduleLookupRetry(parentSessionId);
            } else {
              this.armIdleSubscription(parentSessionId, parentStore);
            }
            return;
          }
          this.pendingWakesByParent.get(parentSessionId)?.shift();
          this.markProcessed(payload);
        } catch (error: unknown) {
          // Keep the head queued. A future idle transition or short retry
          // can resend it without losing the wake.
          this.options.onError?.(error, parentSessionId);
          if (!isIdle(parentStore.getState())) {
            this.armIdleSubscription(parentSessionId, parentStore);
          }
          this.scheduleLookupRetry(parentSessionId);
          return;
        }
      }
      this.pendingWakesByParent.delete(parentSessionId);
      this.clearParentRuntime(parentSessionId);
    } finally {
      this.drainingParents.delete(parentSessionId);
    }
  }
}
