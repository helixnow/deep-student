/**
 * `dstu-media/src/media/bilibili_transport/bridge.rs`: the in-memory pairing and
 * lease state machine for the browser bridge. WebSocket handling, request slots
 * and stream acknowledgement stay unmigrated (they need the Electron transport
 * and the bridge server socket).
 */
import { BiliRequestError } from './bilibili-policy.ts';
import { responseHeader, validateRequest, validateUrl } from './bilibili-policy.ts';
import type { RequestKind } from '../api.ts';

export const FRAME_LIMIT = 64 * 1024;

/** `types.rs::BiliRequest`；`cancel` 对应 tokio `CancellationToken`。 */
export interface BridgeCancellation {
  readonly isCancelled: boolean;
  whenCancelled(): Promise<'cancelled'>;
}

export interface BridgeRequest {
  id: number;
  attemptId: string;
  kind: RequestKind;
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Uint8Array;
  maxBytes: number;
  deadlineMs: number;
  cancel: BridgeCancellation;
}

export interface BridgeHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  finalUrl: string;
  setCookies: string[];
}

/** `bridge.rs::Reply`：控制帧（浏览器 → Host）。 */
export type BridgeReply =
  | { type: 'head'; status: number; headers: Record<string, string>; finalUrl: string }
  | { type: 'chunk'; sequence: number; bytes: Uint8Array }
  | { type: 'end' }
  | { type: 'error'; code: string };

class BridgeSemaphore {
  private readonly permits: boolean[];
  private readonly waiters: Array<() => void> = [];
  constructor(size: number) {
    this.permits = Array.from({ length: size }, () => true);
  }
  available(): number {
    return this.permits.filter(Boolean).length;
  }
  acquire(): Promise<void> {
    const free = this.permits.indexOf(true);
    if (free >= 0) {
      this.permits[free] = false;
      return Promise.resolve();
    }
    return new Promise(resolve => this.waiters.push(resolve));
  }
  release(): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter();
      return;
    }
    const free = this.permits.indexOf(false);
    if (free >= 0) this.permits[free] = true;
  }
}

interface ReplyQueue {
  push(reply: BridgeReply): boolean;
  next(signal: Promise<'cancelled'>): Promise<BridgeReply | 'cancelled'>;
  close(): void;
}


export interface BridgeAccount {
  loggedIn: boolean;
  mid: number | null;
  uname: string | null;
}

export interface BridgeStatus {
  state: string;
  connectionId: string | null;
  scriptVersion: string | null;
  parsing: boolean;
  media: boolean;
  account: BridgeAccount | null;
  generation: number;
  lastError: { code: string; message: string } | null;
}

/** 连接对端只用这三条消息：ready / revoked / close；测试只关心状态机。 */
export interface BridgeChannel {
  send(text: string): void;
  close(): void;
}

interface Connection {
  id: string;
  channel: BridgeChannel;
  approved: boolean;
}

const PAIRING_TTL_MS = 120_000;

function newToken(): string {
  return `${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
}

function createReplyQueue(): ReplyQueue {
  const replies: BridgeReply[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  return {
    push(reply) {
      if (closed) return false;
      replies.push(reply);
      notify();
      return true;
    },
    async next(signal) {
      for (;;) {
        if (replies.length > 0) return replies.shift()!;
        if (closed) throw new BiliRequestError('bridge-offline', '浏览器桥已断开，请返回浏览器重新配对');
        const arrived = new Promise<'reply'>((resolve) => {
          wake = () => resolve('reply');
        });
        const winner = await Promise.race([arrived, signal]);
        if (winner === 'cancelled') return 'cancelled';
      }
    },
    close() {
      closed = true;
      notify();
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function authError(code: string, message: string): BiliRequestError {
  return new BiliRequestError(code, message);
}

export class BridgeHub {
  private statusValue: BridgeStatus = {
    state: 'unavailable',
    connectionId: null,
    scriptVersion: null,
    parsing: false,
    media: false,
    account: null,
    generation: 0,
    lastError: null,
  };
  private pairing: { challenge: string; expires: number; port: number } | null = null;
  private connection: Connection | null = null;
  private resume: { token: string; expires: number; account: BridgeAccount | null } | null = null;
  private readonly pending = new Map<number, { connection: string; queue: ReplyQueue }>();
  readonly slots = new BridgeSemaphore(4);
  readonly mediaSlots = new BridgeSemaphore(2);

  status(): BridgeStatus {
    return {
      ...this.statusValue,
      account: this.statusValue.account === null ? null : { ...this.statusValue.account },
      lastError: this.statusValue.lastError === null ? null : { ...this.statusValue.lastError },
    };
  }

  shouldRenewLease(): boolean {
    return this.connection !== null && this.connection.approved;
  }

  startPairing(port: number): string {
    this.resume = null;
    this.disconnect(null);
    const challenge = newToken();
    this.pairing = { challenge, expires: Date.now() + PAIRING_TTL_MS, port };
    this.statusValue.state = 'pairing';
    this.statusValue.lastError = null;
    return challenge;
  }

  authenticate(
    challenge: string,
    port: number,
    scriptVersion: string,
    channel: BridgeChannel,
  ): string {
    const pairing = this.pairing;
    if (pairing === null || pairing.port !== port || pairing.expires <= Date.now()
      || pairing.challenge !== challenge) {
      throw authError('bridge-auth', '浏览器配对已失效，请重新连接');
    }
    this.pairing = null; // Consume once, including refreshes and parallel tabs.
    const id = crypto.randomUUID();
    this.connection = { id, channel, approved: false };
    this.statusValue.state = 'awaiting_approval';
    this.statusValue.connectionId = id;
    this.statusValue.scriptVersion = scriptVersion;
    return id;
  }

  reconnect(token: string, channel: BridgeChannel): string {
    const grant = this.resume;
    if (grant === null || grant.expires <= Date.now() || grant.token !== token) {
      throw authError('bridge-auth', '浏览器桥重连授权已失效');
    }
    grant.token = ''; // One use; a successful handshake rotates it.
    if (this.connection !== null) throw authError('bridge-auth', '浏览器桥已连接');
    const id = crypto.randomUUID();
    this.connection = { id, channel, approved: true };
    this.statusValue.connectionId = id;
    this.statusValue.state = 'probing';
    return id;
  }

  resumeToken(id: string): string {
    if (!this.approved(id)) throw authError('bridge-auth', '浏览器桥未经确认');
    const token = newToken();
    this.resume = {
      token,
      expires: Date.now() + PAIRING_TTL_MS,
      account: this.resume?.account ?? null,
    };
    return token;
  }

  checkResumedAccount(account: BridgeAccount): void {
    const granted = this.resume?.account ?? null;
    if (granted !== null
      && (granted.mid !== account.mid || granted.loggedIn !== account.loggedIn)) {
      throw authError('identity-changed', '重连后的浏览器账号不同，请重新配对');
    }
  }

  failProbe(id: string, error: BiliRequestError): void {
    if (this.statusValue.connectionId !== id) return;
    if (error.payload.retryable) this.disconnect(id);
    else this.revoke();
    if (this.statusValue.connectionId === null) {
      this.statusValue.lastError = { code: error.payload.code, message: error.message };
    }
  }

  approve(id: string): void {
    if (this.connection === null || this.connection.id !== id) {
      throw authError('bridge-auth', '配对请求已失效');
    }
    this.connection.approved = true;
    this.statusValue.state = 'probing';
  }

  approved(id: string): boolean {
    return this.connection !== null && this.connection.id === id && this.connection.approved;
  }

  ready(id: string, account: BridgeAccount, media: boolean): void {
    if (this.connection === null || this.connection.id !== id || !this.connection.approved) return;
    this.statusValue.state = 'ready';
    this.statusValue.lastError = null;
    this.statusValue.parsing = true;
    this.statusValue.media = media;
    this.statusValue.account = { ...account };
    this.statusValue.generation += 1;
    this.connection.channel.send(JSON.stringify({ type: 'ready', media }));
    if (this.resume !== null) this.resume.account = { ...account };
  }

  verifyAccount(id: string, account: BridgeAccount): void {
    const status = this.statusValue;
    const current = status.account;
    if (status.connectionId !== id || current === null
      || current.mid !== account.mid || current.loggedIn !== account.loggedIn) {
      this.revoke();
      throw authError('identity-changed', '浏览器账号已变化，请重新配对');
    }
  }

  disconnect(id: string | null): void {
    if (id !== null && (this.connection === null || this.connection.id !== id)) return;
    if (this.connection !== null) {
      this.connection.channel.close();
      this.connection = null;
    }
    for (const pending of this.pending.values()) pending.queue.close();
    this.pending.clear();
    this.statusValue.state = 'offline';
    this.statusValue.connectionId = null;
    this.statusValue.account = null;
    this.statusValue.parsing = false;
    this.statusValue.media = false;
    this.statusValue.generation += 1;
  }

  heartbeat(): void {
    if (this.resume !== null) this.resume.expires = Date.now() + PAIRING_TTL_MS;
  }

  /** `bridge.rs::deliver`：把浏览器控制帧投递到等待中的请求。 */
  deliver(connection: string, id: number, reply: BridgeReply): boolean {
    const pending = this.pending.get(id);
    return pending !== undefined && pending.connection === connection && pending.queue.push(reply);
  }

  /** 诊断：仍在等待浏览器控制帧的请求数（Rust 测试读取 `pending`）。 */
  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * `bridge.rs::execute_on`：在指定浏览器桥连接上执行一次请求。
   * 非 probe 请求先做出口/请求头策略校验。
   */
  async executeOn(connection: string, request: BridgeRequest, probe: boolean): Promise<BridgeHttpResponse> {
    if (!probe) validateRequest(request);
    try {
      return await this.exchange(connection, request, probe);
    } catch (error) {
      throw contextError(error, request);
    }
  }

  private async exchange(
    connection: string,
    request: BridgeRequest,
    probe: boolean,
  ): Promise<BridgeHttpResponse> {
    await this.slots.acquire();
    let mediaAcquired = false;
    try {
      if (request.kind === 'media') {
        await this.mediaSlots.acquire();
        mediaAcquired = true;
      }
      const channel = this.connection;
      if (channel === null || channel.id !== connection || !channel.approved) {
        throw new BiliRequestError('bridge-offline', '浏览器桥已断开，请返回浏览器恢复连接');
      }
      const queue = createReplyQueue();
      this.pending.set(request.id, { connection, queue });
      try {
        const remainingMs = Math.min(Math.max(request.deadlineMs - Date.now(), 0), 24_000);
        try {
          channel.channel.send(JSON.stringify({
            type: 'request',
            id: request.id,
            attemptId: request.attemptId,
            kind: request.kind,
            method: request.method,
            url: request.url.href,
            headers: request.headers,
            body: Buffer.from(request.body).toString('base64'),
            maxBytes: request.maxBytes,
            timeoutMs: remainingMs,
            probe,
          }));
        } catch (error) {
          throw new BiliRequestError('bridge-offline', errorText(error));
        }

        let head: { status: number; headers: Record<string, string>; finalUrl: string } | null = null;
        const bytes: Uint8Array[] = [];
        let total = 0;
        let sequence = 0;
        const cancelled = request.cancel.whenCancelled();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'),
            Math.max(request.deadlineMs - Date.now(), 0));
        });
        try {
          for (;;) {
            const reply = await Promise.race([queue.next(cancelled), timeout]);
            if (reply === 'cancelled') throw new BiliRequestError('cancelled', '请求已取消');
            if (reply === 'timeout') throw new BiliRequestError('timeout', '浏览器桥请求超时');
          switch (reply.type) {
            case 'head': {
              if (head !== null) throw new BiliRequestError('bridge-protocol', '浏览器桥帧顺序无效');
              let finalUrl: URL;
              try { finalUrl = new URL(reply.finalUrl); }
              catch { throw new BiliRequestError('bridge-protocol', '浏览器桥返回无效地址'); }
              if (!probe) validateUrl(finalUrl, request.kind);
              if (finalUrl.href !== request.url.href) {
                throw new BiliRequestError('bridge-redirect', '浏览器管理器自动跟随了未经校验的跳转');
              }
              const headers: Record<string, string> = {};
              for (const [name, value] of Object.entries(reply.headers)) {
                if (!responseHeader(name) || Buffer.byteLength(value, 'utf8') > 4096
                  || value.includes('\r') || value.includes('\n')) continue;
                headers[name] = value;
              }
              const declared = Number.parseInt(headers['content-length'] ?? '', 10);
              if (Number.isFinite(declared) && declared > request.maxBytes) {
                throw new BiliRequestError('response-too-large', '浏览器响应超过大小限制');
              }
              head = { status: reply.status, headers, finalUrl: finalUrl.href };
              this.sendCredit(channel.channel, request.id);
              break;
            }
            case 'chunk': {
              if (head === null || reply.sequence !== sequence
                || reply.bytes.length > FRAME_LIMIT - 12) {
                throw new BiliRequestError('bridge-protocol', '浏览器桥帧顺序无效');
              }
              if (total + reply.bytes.length > request.maxBytes) {
                throw new BiliRequestError('response-too-large', '浏览器响应超过大小限制');
              }
              bytes.push(reply.bytes);
              total += reply.bytes.length;
              sequence += 1;
              this.sendCredit(channel.channel, request.id);
              break;
            }
            case 'end': {
              if (head === null) {
                throw new BiliRequestError('bridge-protocol', '浏览器桥响应缺少头信息');
              }
              const declared = Number.parseInt(head.headers['content-length'] ?? '', 10);
              if (request.kind === 'media' && Number.isFinite(declared) && declared !== total
                && request.method !== 'HEAD' && !(head.status >= 300 && head.status < 400)) {
                throw new BiliRequestError('short-read', '浏览器桥返回的数据不完整');
              }
              const body = Buffer.concat(bytes.map(chunk => Buffer.from(chunk)));
              return {
                status: head.status,
                headers: head.headers,
                body,
                finalUrl: head.finalUrl,
                setCookies: [],
              };
            }
            case 'error': {
              const code = ['response-too-large', 'range-unsupported', 'stream-unsupported',
                'redirect-unsupported', 'timeout', 'cancelled'].includes(reply.code)
                ? reply.code : 'bridge-request-failed';
              throw new BiliRequestError(code, '浏览器桥请求未完成，请检查桥能力或浏览器状态');
            }
          }
          }
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      } finally {
        this.pending.delete(request.id);
        try {
          channel.channel.send(JSON.stringify({ type: 'cancel', id: request.id }));
        // boundary-allow empty-catch: Rust `try_send(cancel)` 忽略断开连接的失败
        } catch {
        }
      }
    } finally {
      if (mediaAcquired) this.mediaSlots.release();
      this.slots.release();
    }
  }

  private sendCredit(channel: BridgeChannel, id: number): void {
    try {
      channel.send(JSON.stringify({ type: 'credit', id }));
    } catch (error) {
      throw new BiliRequestError('bridge-offline', '浏览器桥已断开');
    }
  }

  revoke(): void {
    this.resume = null;
    this.pairing = null;
    this.connection?.channel.send(JSON.stringify({ type: 'revoked' }));
    this.disconnect(null);
  }
}

function contextError(error: unknown, request: BridgeRequest): BiliRequestError {
  if (!(error instanceof BiliRequestError)) {
    return new BiliRequestError('bridge-request-failed', errorText(error));
  }
  error.payload.requestId = request.id;
  error.payload.attemptId = request.attemptId;
  error.payload.stage = request.kind;
  error.payload.route = 'browser_bridge';
  return error;
}

/** `bridge.rs::parse_control`：解析浏览器控制帧（chunk 走二进制帧，不在其中）。 */
export function parseBridgeControl(value: unknown): { id: number; reply: BridgeReply } | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) return null;
  const type = record.type;
  if (type === 'response_head') {
    const status = record.status;
    const headers = record.headers;
    const finalUrl = record.finalUrl;
    if (typeof status !== 'number' || !Number.isInteger(status)
      || status < 0 || status > 0xffff) return null;
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)
      || typeof finalUrl !== 'string') return null;
    const normalized: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value !== 'string') return null;
      normalized[name] = value;
    }
    return { id, reply: { type: 'head', status, headers: normalized, finalUrl } };
  }
  if (type === 'response_end') return { id, reply: { type: 'end' } };
  if (type === 'error') {
    const code = record.code;
    if (typeof code !== 'string') return null;
    return { id, reply: { type: 'error', code } };
  }
  return null;
}
