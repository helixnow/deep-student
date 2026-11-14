export type SendMode = 'queue' | 'steer';

export type TurnAbortIntent = 'stop' | 'steer' | null;

export interface QueuedFollowupItem<TAttachment = unknown> {
  id: string;
  text: string;
  createdAt: number;
  attachments?: TAttachment[];
  skillIds?: number[];
}

export interface SubmitFollowupInput<TAttachment = unknown> {
  text: string;
  mode?: SendMode;
  attachments?: TAttachment[];
  skillIds?: number[];
  fromQueueId?: string;
}

export interface SubmitFollowupResult<TAttachment = unknown> {
  routedTo: 'answerAsk' | 'enqueued' | 'steered' | 'sent' | 'ignored';
  item?: QueuedFollowupItem<TAttachment>;
}

export interface TurnInterruptMetadata {
  interrupted: boolean;
  interruptReason?: string;
  appendStoppedSuffix: boolean;
}

export interface StreamingFollowupControllerOptions<TAttachment = unknown> {
  defaultSendMode?: SendMode;
  onAnswerAsk: (text: string) => Promise<void> | void;
  onSendTurn: (payload: {
    text: string;
    mode: SendMode;
    attachments?: TAttachment[];
    skillIds?: number[];
    fromQueueId?: string;
  }) => Promise<void> | void;
  onAbortCurrentTurn?: (intent: 'stop' | 'steer') => void;
  onClearDraft?: () => void;
  idGenerator?: () => string;
  now?: () => number;
}

export interface StreamingFollowupSnapshot<TAttachment = unknown> {
  sendMode: SendMode;
  isStreaming: boolean;
  hasPendingAsk: boolean;
  turnIntent: TurnAbortIntent;
  queuedItems: QueuedFollowupItem<TAttachment>[];
}

export const STEER_INTERRUPT_REASON = '你发了一条新消息，这一轮先停下来';

/**
 * 根据中断意图生成当前轮收尾元数据：
 * - steer：保留已生成半截正文，不追加「（已停止生成）」，写入可续写元数据
 * - stop：用户主动停止，按既有行为处理
 */
export function buildTurnInterruptMetadata(intent: TurnAbortIntent): TurnInterruptMetadata {
  if (intent === 'steer') {
    return {
      interrupted: true,
      interruptReason: STEER_INTERRUPT_REASON,
      appendStoppedSuffix: false,
    };
  }
  if (intent === 'stop') {
    return {
      interrupted: false,
      interruptReason: undefined,
      appendStoppedSuffix: true,
    };
  }
  return {
    interrupted: false,
    interruptReason: undefined,
    appendStoppedSuffix: false,
  };
}

/**
 * 输入框按键投递模式计算：
 * - Enter = 当前默认模式（默认 queue）
 * - Ctrl/Cmd + Enter = 切换为插入（或当前默认模式的反模式）
 */
export function resolveFollowupKeyMode(
  event: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean },
  defaultSendMode: SendMode = 'queue',
): SendMode | null {
  if (event.isComposing || event.key !== 'Enter' || event.shiftKey) {
    return null;
  }
  const hasModifier = Boolean(event.ctrlKey || event.metaKey);
  if (!hasModifier) {
    return defaultSendMode;
  }
  return defaultSendMode === 'queue' ? 'steer' : 'queue';
}

/**
 * 流式生成期间「排队（Queue）vs 插入（Steer）」双模状态机控制器。
 *
 * 三条核心不变量：
 * 1. pendingAsk 绝对优先：存在待回答提问卡时，输入直接路由至 answerAsk，绝不进入排队或插入。
 * 2. queue（默认排队）：流式期间追加至内存队列，支持按 ID 编辑（改空即删）、删除、提升为立即插入；当前轮结束后自动弹出队首发送。
 * 3. steer（插入打断）：先置位 turnIntent = 'steer'，再调用 abortCurrentTurn 并等待 inflightDone；若收尾窗口内已有新轮启动则自动降级入队，绝不静默丢消息。
 */
export class StreamingFollowupController<TAttachment = unknown> {
  private sendMode: SendMode;
  private isStreaming = false;
  private hasPendingAsk = false;
  private turnIntent: TurnAbortIntent = null;
  private queuedItems: QueuedFollowupItem<TAttachment>[] = [];
  private inflightPromise: Promise<void> | null = null;
  private resolveInflight: (() => void) | null = null;
  private seq = 0;

  private readonly options: StreamingFollowupControllerOptions<TAttachment>;

  constructor(options: StreamingFollowupControllerOptions<TAttachment>) {
    this.options = options;
    this.sendMode = options.defaultSendMode ?? 'queue';
  }

  getSnapshot(): StreamingFollowupSnapshot<TAttachment> {
    return {
      sendMode: this.sendMode,
      isStreaming: this.isStreaming,
      hasPendingAsk: this.hasPendingAsk,
      turnIntent: this.turnIntent,
      queuedItems: this.queuedItems.map((item) => ({ ...item })),
    };
  }

  setSendMode(mode: SendMode): void {
    this.sendMode = mode;
  }

  setPendingAsk(hasPendingAsk: boolean): void {
    this.hasPendingAsk = hasPendingAsk;
  }

  /**
   * 标记新一轮流式生成启动，建好 inflight 屏障供 steer 等待。
   */
  beginTurn(): void {
    this.isStreaming = true;
    this.turnIntent = null;
    if (!this.inflightPromise) {
      this.inflightPromise = new Promise<void>((resolve) => {
        this.resolveInflight = resolve;
      });
    }
  }

  /**
   * 用户点击停止按钮：标记 turnIntent = 'stop' 并触发中断。
   * 注意：停止当前轮不会清空已排队的后续消息。
   */
  stopCurrentTurn(): void {
    if (!this.isStreaming) return;
    this.turnIntent = 'stop';
    this.options.onAbortCurrentTurn?.('stop');
  }

  /**
   * 当前轮流式生成收尾完成后调用：
   * 1. 置回 isStreaming = false
   * 2. 释放等待 inflightDone 的 steer 协程
   * 3. 若无挂起提问卡且当前未处于新一轮生成，自动弹出队首发送（先出队再发送）
   */
  async onTurnSettled(options?: { skipDrain?: boolean }): Promise<TurnInterruptMetadata> {
    const metadata = buildTurnInterruptMetadata(this.turnIntent);
    this.isStreaming = false;
    const release = this.resolveInflight;
    this.inflightPromise = null;
    this.resolveInflight = null;
    release?.();

    if (!options?.skipDrain) {
      await this.drainQueue();
    }
    return metadata;
  }

  /**
   * 统一提交入口：遵循「pendingAsk > 流式分流（queue / steer）> 空闲直发」顺序。
   */
  async submit(input: SubmitFollowupInput<TAttachment>): Promise<SubmitFollowupResult<TAttachment>> {
    const trimmed = input.text.trim();
    const hasAttachments = Boolean(input.attachments && input.attachments.length > 0);
    if (!trimmed && !hasAttachments) {
      return { routedTo: 'ignored' };
    }

    // 不变量 1：pendingAsk 绝对优先于排队与插入
    if (this.hasPendingAsk) {
      this.options.onClearDraft?.();
      await this.options.onAnswerAsk(trimmed);
      return { routedTo: 'answerAsk' };
    }

    const effectiveMode: SendMode = input.mode ?? this.sendMode;
    this.options.onClearDraft?.();

    if (this.isStreaming) {
      if (effectiveMode === 'steer') {
        return this.steer({
          text: trimmed,
          attachments: input.attachments,
          skillIds: input.skillIds,
          fromQueueId: input.fromQueueId,
        });
      }
      const item = this.enqueue({
        text: trimmed,
        attachments: input.attachments,
        skillIds: input.skillIds,
        id: input.fromQueueId,
      });
      return { routedTo: 'enqueued', item };
    }

    if (this.queuedItems.length > 0) {
      const item = this.enqueue({ text: trimmed, attachments: input.attachments, skillIds: input.skillIds, id: input.fromQueueId });
      await this.drainQueue();
      return { routedTo: 'enqueued', item };
    }

    await this.dispatchTurn({
      text: trimmed,
      mode: effectiveMode,
      attachments: input.attachments,
      skillIds: input.skillIds,
      fromQueueId: input.fromQueueId,
    });
    return { routedTo: 'sent' };
  }

  /**
   * 入队一条待发消息（仅保存在内存中，不提前污染持久化聊天历史）。
   */
  enqueue(input: {
    text: string;
    attachments?: TAttachment[];
    skillIds?: number[];
    id?: string;
  }): QueuedFollowupItem<TAttachment> {
    const id = input.id ?? this.nextId();
    const item: QueuedFollowupItem<TAttachment> = {
      id,
      text: input.text.trim(),
      createdAt: this.options.now ? this.options.now() : Date.now(),
      ...(input.attachments ? { attachments: [...input.attachments] } : {}),
      ...(input.skillIds ? { skillIds: [...input.skillIds] } : {}),
    };
    this.queuedItems.push(item);
    return { ...item };
  }

  /**
   * 按 ID 编辑排队中的消息；若改为空白字符串则直接删除该条。
   */
  updateQueuedItem(id: string, text: string): boolean {
    const idx = this.queuedItems.findIndex((item) => item.id === id);
    if (idx < 0) return false;
    const trimmed = text.trim();
    if (!trimmed) {
      this.queuedItems.splice(idx, 1);
      return true;
    }
    this.queuedItems[idx] = {
      ...this.queuedItems[idx],
      text: trimmed,
    };
    return true;
  }

  /**
   * 按 ID 删除一条排队中的消息。
   */
  removeQueuedItem(id: string): boolean {
    const idx = this.queuedItems.findIndex((item) => item.id === id);
    if (idx < 0) return false;
    this.queuedItems.splice(idx, 1);
    return true;
  }

  /**
   * 清空全部排队消息。
   */
  clearQueue(): void {
    this.queuedItems = [];
  }

  /**
   * 将队列中的某一条立即提升为插入发送（先出队再 steer）。
   */
  async promoteQueuedItemToSteer(id: string): Promise<SubmitFollowupResult<TAttachment>> {
    const idx = this.queuedItems.findIndex((item) => item.id === id);
    if (idx < 0) {
      return { routedTo: 'ignored' };
    }
    const [picked] = this.queuedItems.splice(idx, 1);
    return this.steer({
      text: picked.text,
      attachments: picked.attachments,
      skillIds: picked.skillIds,
      fromQueueId: picked.id,
    });
  }

  /**
   * 插入打断模式（steer）：
   * 1. 先标记 turnIntent = 'steer'
   * 2. 调用 onAbortCurrentTurn('steer')
   * 3. 等待 inflightDone
   * 4. 醒来后若发现已有新一轮在跑或出现 pendingAsk，降级入队以防静默丢消息；否则立即作为新轮发送。
   */
  async steer(input: {
    text: string;
    attachments?: TAttachment[];
    skillIds?: number[];
    fromQueueId?: string;
  }): Promise<SubmitFollowupResult<TAttachment>> {
    const trimmed = input.text.trim();
    if (!trimmed && (!input.attachments || input.attachments.length === 0)) {
      return { routedTo: 'ignored' };
    }

    if (this.hasPendingAsk) {
      await this.options.onAnswerAsk(trimmed);
      return { routedTo: 'answerAsk' };
    }

    if (this.isStreaming) {
      this.turnIntent = 'steer';
      const inflight = this.inflightPromise;
      this.options.onAbortCurrentTurn?.('steer');
      if (inflight) {
        await inflight;
      }
      // 等待收尾期间若又有新轮抢先跑起或进入提问卡，则降级回队列，保证消息绝不丢失
      if (this.isStreaming || this.hasPendingAsk) {
        const item = this.enqueue({
          text: trimmed,
          attachments: input.attachments,
          skillIds: input.skillIds,
          id: input.fromQueueId,
        });
        return { routedTo: 'enqueued', item };
      }
    }

    await this.dispatchTurn({
      text: trimmed,
      mode: 'steer',
      attachments: input.attachments,
      skillIds: input.skillIds,
      fromQueueId: input.fromQueueId,
    });
    return { routedTo: 'steered' };
  }

  /**
   * 若当前空闲且无待答提问卡，弹出队首并发送。
   */
  async drainQueue(): Promise<boolean> {
    if (this.isStreaming || this.hasPendingAsk || this.queuedItems.length === 0) {
      return false;
    }
    // 必须先出队再调用异步发送，防止同一条消息被重复派发
    const head = this.queuedItems.shift()!;
    try {
      await this.dispatchTurn({
        text: head.text,
        mode: 'queue',
        attachments: head.attachments,
        skillIds: head.skillIds,
        fromQueueId: head.id,
      });
    } catch (error) {
      this.queuedItems.unshift(head);
      throw error;
    }
    return true;
  }

  private async dispatchTurn(payload: {
    text: string;
    mode: SendMode;
    attachments?: TAttachment[];
    skillIds?: number[];
    fromQueueId?: string;
  }): Promise<void> {
    this.beginTurn();
    try {
      await this.options.onSendTurn(payload);
    } catch (error) {
      await this.onTurnSettled({ skipDrain: true });
      throw error;
    }
  }

  private nextId(): string {
    if (this.options.idGenerator) {
      return this.options.idGenerator();
    }
    this.seq += 1;
    return `followup-${this.seq}`;
  }
}
