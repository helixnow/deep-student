/** In-memory turn boundaries only; callers own durable inbox/media processing. */
export const PHOTO_QUIET_MS = 10_000;
export const PHOTO_MAX_WAIT_MS = 120_000;
export const PHOTO_MAX_ATTACHMENTS = 99;
/** 对外公开名（`host/plugins/ilink/api.ts` 按此名再导出）。 */
export const PHOTO_BATCH_MAX_ATTACHMENTS = PHOTO_MAX_ATTACHMENTS;
/** 每个会话作用域记住的 message_id 上限；长期运行不能无限增长。 */
export const MAX_SEEN_IDS_PER_SCOPE = 2000;

export interface IlinkPhotoScope {
  accountId: string;
  peer: string;
  sessionId: string | null;
}

export interface IlinkPhotoMessage<T = unknown> extends IlinkPhotoScope {
  messageId: string | number | bigint;
  text?: string;
  /** Image attachments, in platform arrival order. */
  attachments?: readonly T[];
}

export interface IlinkPhotoBatch<T = unknown> extends IlinkPhotoScope {
  messages: IlinkPhotoMessage<T>[];
  attachments: T[];
  text: string;
  startedAt: number;
  lastReceivedAt: number;
}

export interface IlinkPhotoBatchOptions<T = unknown> {
  quietMs?: number;
  maxWaitMs?: number;
  now?: () => number;
  /** Called synchronously on every sealed batch, including timer expiry. */
  onBatch?: (batch: IlinkPhotoBatch<T>) => void;
}

export interface IlinkPhotoPushResult<T = unknown> {
  kind: 'duplicate' | 'collecting' | 'submitted' | 'bypass' | 'cancelled';
  /** Also delivered to onBatch, if installed. */
  batches: IlinkPhotoBatch<T>[];
}

type Pending<T> = { batch: IlinkPhotoBatch<T>; timer: ReturnType<typeof setTimeout> | null };
const keyOf = (scope: IlinkPhotoScope) => JSON.stringify([scope.accountId, scope.peer, scope.sessionId]);
const continuation = (text: string) => /(?:还有|還有|等一下|稍等|没发完|沒發完|还没发完|等一会)/.test(text);
const finish = (text: string) => !continuation(text) && /^(?:开始(?:吧|处理|回答|分析)?|就这些|可以了|发完了)[。！!\s]*$/.test(text);
const control = (text: string) => /^\/(?:stop|status|approve|reject|pair)(?:\s|$)/i.test(text);

export class IlinkPhotoBatchAggregator<T = unknown> {
  private readonly pending = new Map<string, Pending<T>>();
  private readonly seen = new Map<string, Set<string>>();
  private readonly quietMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly options: IlinkPhotoBatchOptions<T>;

  constructor(options: IlinkPhotoBatchOptions<T> = {}) {
    this.options = options;
    this.maxWaitMs = Math.min(PHOTO_MAX_WAIT_MS, Math.max(1, options.maxWaitMs ?? PHOTO_MAX_WAIT_MS));
    this.quietMs = Math.min(this.maxWaitMs, Math.max(1, options.quietMs ?? PHOTO_QUIET_MS));
    this.now = options.now ?? Date.now;
  }

  isCollecting(scope: IlinkPhotoScope): boolean {
    return this.pending.has(keyOf(scope));
  }

  private seal(key: string): IlinkPhotoBatch<T> | undefined {
    const pending = this.pending.get(key);
    if (!pending) return undefined;
    if (pending.timer !== null) clearTimeout(pending.timer);
    this.pending.delete(key);
    this.options.onBatch?.(pending.batch);
    return pending.batch;
  }

  private arm(key: string, pending: Pending<T>): void {
    if (pending.timer !== null) clearTimeout(pending.timer);
    const deadline = Math.min(pending.batch.lastReceivedAt + this.quietMs, pending.batch.startedAt + this.maxWaitMs);
    pending.timer = setTimeout(() => this.seal(key), Math.max(0, deadline - this.now()));
  }

  push(message: IlinkPhotoMessage<T>): IlinkPhotoPushResult<T> {
    const key = keyOf(message);
    const seen = this.seen.get(key) ?? new Set<string>();
    const id = String(message.messageId);
    if (seen.has(id)) return { kind: 'duplicate', batches: [] };
    seen.add(id);
    // Set 保留插入序：超出上限时淘汰最早记住的 id，内存占用有界。
    if (seen.size > MAX_SEEN_IDS_PER_SCOPE) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    this.seen.set(key, seen);
    const batches: IlinkPhotoBatch<T>[] = [];
    const seal = () => { const batch = this.seal(key); if (batch) batches.push(batch); };
    const text = message.text?.trim() ?? '';
    if (control(text)) {
      if (/^\/stop(?:\s|$)/i.test(text)) {
        this.cancel(message);
        return { kind: 'cancelled', batches };
      }
      seal();
      return { kind: 'bypass', batches };
    }
    const now = this.now();
    const previous = this.pending.get(key)?.batch;
    if (previous && (now - previous.lastReceivedAt >= this.quietMs || now - previous.startedAt >= this.maxWaitMs)) seal();
    const images = [...(message.attachments ?? [])];
    if (!images.length && !this.pending.has(key)) {
      const batch: IlinkPhotoBatch<T> = { ...message, messages: [message], attachments: [], text: message.text ?? '', startedAt: now, lastReceivedAt: now };
      this.options.onBatch?.(batch);
      return { kind: 'submitted', batches: [...batches, batch] };
    }
    let offset = 0;
    do {
      let pending = this.pending.get(key);
      if (pending && pending.batch.attachments.length === PHOTO_MAX_ATTACHMENTS && offset < images.length) {
        seal();
        pending = undefined;
      }
      if (!pending) {
        pending = { batch: { accountId: message.accountId, peer: message.peer, sessionId: message.sessionId, messages: [], attachments: [], text: '', startedAt: now, lastReceivedAt: now }, timer: null };
        this.pending.set(key, pending);
      }
      const slice = images.slice(offset, offset + PHOTO_MAX_ATTACHMENTS - pending.batch.attachments.length);
      const part = { ...message, text: offset === 0 ? message.text : '', attachments: slice };
      pending.batch.messages.push(part);
      pending.batch.attachments.push(...slice);
      if (part.text) pending.batch.text += `${pending.batch.text ? '\n' : ''}${part.text}`;
      pending.batch.lastReceivedAt = now;
      offset += slice.length;
      this.arm(key, pending);
      if (offset < images.length) seal();
    } while (offset < images.length);
    if (finish(text)) seal();
    return { kind: this.pending.has(key) ? 'collecting' : 'submitted', batches };
  }

  flush(scope: IlinkPhotoScope): IlinkPhotoBatch<T> | undefined {
    return this.seal(keyOf(scope));
  }

  cancel(scope: IlinkPhotoScope): boolean {
    const key = keyOf(scope), pending = this.pending.get(key);
    if (!pending) return false;
    if (pending.timer !== null) clearTimeout(pending.timer);
    return this.pending.delete(key);
  }

  /** Cancel without submitting; release timers and dedup state on owner shutdown. */
  dispose(): void {
    for (const pending of this.pending.values()) if (pending.timer !== null) clearTimeout(pending.timer);
    this.pending.clear();
    this.seen.clear();
  }
}

// 对外别名：`host/plugins/ilink/api.ts` 以这两个名字再导出。
export type IlinkPhotoInbound<T = unknown> = IlinkPhotoMessage<T>;
export type IlinkPhotoBatchResult<T = unknown> = IlinkPhotoPushResult<T>;
