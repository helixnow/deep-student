/**
 * Rust: src/plugins/ilink_bot/{client,guard,mod}.rs. Transport, credentials, QR login,
 * configuration and the polling safety rails are ported here. Message dispatch is delegated
 * to the remote-task bridge (task_command + headless turn are L06-owned).
 */
import { AppError } from '../../../kernel/error-model.ts';
import type { PluginJsonValue as JsonValue } from '../../../kernel/plugin-types.ts';
import type { BackendEvents } from '../../../kernel/api.ts';
import { createPluginEventSink, type PluginEventSink } from '../../../kernel/plugin-events.ts';
import { RateLimiter, isBoundUser } from '../../../kernel/plugin-guard.ts';
import {
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  IlinkClient,
  chunkText,
  extractText,
  isApiError,
  isSessionExpired,
  type IlinkCredentials,
  type IlinkInteger,
  type QrcodeStatusResponse,
  type WeixinMessage,
} from './client.ts';
import { IlinkPhotoBatchAggregator } from './photo-batch.ts';
import { IlinkPairingGuard, normalizeIlinkPairingCode } from './pairing-guard.ts';

export { IlinkPhotoBatchAggregator } from './photo-batch.ts';
export { IlinkPairingGuard, evaluateChannelReadiness } from './pairing-guard.ts';
import {
  emptyStatusSnapshot,
  type ChannelPlugin,
  type PluginDescriptor,
  type PluginRuntimeContext,
  type PluginSettings,
  type PluginState,
  type PluginStatusSnapshot,
} from '../../../kernel/plugin-types.ts';
import { qrcodePngBase64 } from '../../../platform/util/qr.ts';
import { decodeIlink } from './decode.ts';
import { rustTrim } from '../../../platform/util/portable.ts';

export const PLUGIN_ID = 'ilinkbot';
export const CREDENTIALS_KEY = 'plugin.ilinkbot.credentials';
export const SETTINGS_PREFIX = 'plugin.ilinkbot.';

/** 出站文本分片上限（微信单条消息长度约束） */
const OUTBOUND_CHUNK_LIMIT = 2000;
const DEFAULT_REMOTE_SYSTEM_APPEND =
  '你正在通过微信 iLink 机器人远程协助用户。回复使用简洁、友善的简体中文纯文本（微信不渲染 Markdown 表格/图片），结论先行、长度适中。你没有本地文件写入/命令执行权限；涉及写操作的请求请告知用户在桌面端确认。';
/** 同时运行的远程任务上限 */
const MAX_CONCURRENT_TASKS = 3;

const DESC: PluginDescriptor = {
  id: PLUGIN_ID,
  label: '微信 iLink Bot',
  blurb: '通过官方 ClawBot / iLink 协议收发微信消息，并由本地 AI 自动回复。',
  kind: 'channel',
};

function errorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error && typeof (error as { message: unknown }).message === 'string'
    ? (error as { message: string }).message
    : String(error);
}

function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: { [key: string]: JsonValue } | null, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}

function readBoolean(record: { [key: string]: JsonValue } | null, key: string): boolean {
  return record?.[key] === true;
}

/** `IlinkCredentials` serde camelCase, with `#[serde(default)]` on the two optional fields. */
function parseCredentials(raw: string): IlinkCredentials {
  try {
    return decodeIlink(raw, 'credentials');
  } catch (error) {
    throw AppError.validation(`凭证损坏: ${errorMessage(error)}`);
  }
}

export interface RemoteDispatchInput {
  readonly credentials: IlinkCredentials;
  readonly peer: string;
  readonly text: string;
  readonly contextToken: string;
  readonly sessionId: string | null;
  readonly messageId: IlinkInteger | null;
  readonly seq: IlinkInteger | null;
  readonly clientId: string | null;
}

export type RemoteDispatchOutcome =
  | { kind: 'ignored' }
  | { kind: 'reply'; text: string }
  | { kind: 'stop'; text: string; sessionId: string | null };

/** Cross-lane bridge to chat_v2::task_command + headless (L06). */
export interface RemoteTaskBridge {
  isControlMessage(text: string): boolean;
  dispatch(input: RemoteDispatchInput): Promise<RemoteDispatchOutcome>;
  cancelSession(sessionId: string): Promise<boolean>;
}

export interface IlinkBotOptions {
  events: Pick<BackendEvents, 'emit'>;
  client?: IlinkClient;
  tasks?: RemoteTaskBridge;
  /** Opt-in normalized media path. Configure aggregator.onBatch to process sealed images.
   * The legacy protocol decoder is text-only; media-aware transports supply attachments. */
  photoBatch?: {
    aggregator: IlinkPhotoBatchAggregator;
    attachments: (message: WeixinMessage) => readonly unknown[];
  };
  /** Opt-in owner pairing, separate from QR/platform login. Caller owns guard lifetime. */
  pairingGuard?: IlinkPairingGuard;
  onState?: (state: PluginState, error: string | null) => void;
  /** Rust `tracing::warn`; the Cordis entry injects `ctx.logger`. Required, never a silent no-op. */
  log: (message: string) => void;
  /** Rust `tracing::debug` (unknown QR status); defaults to `log`. */
  debug?: (message: string) => void;
  now?: () => number;
  /** tokio::time::Instant for elapsed time; `now` remains UTC event time. */
  monotonicNow?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export class IlinkBotPlugin implements ChannelPlugin {
  private readonly client: IlinkClient;
  private readonly events: PluginEventSink;
  private readonly tasks: RemoteTaskBridge | undefined;
  private readonly photoBatch: IlinkBotOptions['photoBatch'];
  private readonly pairingGuard: IlinkPairingGuard | undefined;
  private readonly onState: (state: PluginState, error: string | null) => void;
  private readonly log: (message: string) => void;
  private readonly debug: (message: string) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private qrcodePng: string | null = null;
  private qrcodeStatus: string | null = null;
  private lastActivity: string | null = null;
  private loginCancel: AbortController | null = null;
  private loginRunning = false;

  constructor(options: IlinkBotOptions) {
    this.client = options.client ?? new IlinkClient();
    this.events = createPluginEventSink(options.events, { ...(options.now ? { now: options.now } : {}), warn: options.log });
    this.tasks = options.tasks;
    this.photoBatch = options.photoBatch;
    this.pairingGuard = options.pairingGuard;
    this.onState = options.onState ?? (() => undefined);
    this.log = options.log;
    this.debug = options.debug ?? this.log;
    this.now = options.monotonicNow ?? (() => performance.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  descriptor(): PluginDescriptor {
    return DESC;
  }

  isConfigured(config: JsonValue): boolean {
    return readBoolean(isJsonObject(config) ? config : null, 'bound');
  }

  private async loadCredentials(settings: PluginSettings): Promise<IlinkCredentials | null> {
    let raw: string | null;
    try {
      raw = await settings.getSecret(CREDENTIALS_KEY);
    } catch (error) {
      throw AppError.database(`读取凭证失败: ${errorMessage(error)}`);
    }
    if (raw === null || rustTrim(raw).length === 0) return null;
    const credentials = parseCredentials(raw);
    return credentials.token.length === 0 ? null : credentials;
  }

  private async saveCredentials(settings: PluginSettings, credentials: IlinkCredentials): Promise<void> {
    try {
      await settings.saveSecret(CREDENTIALS_KEY, JSON.stringify(credentials));
    } catch (error) {
      throw AppError.database(`保存凭证失败: ${errorMessage(error)}`);
    }
  }

  private async clearCredentials(settings: PluginSettings): Promise<void> {
    try {
      await settings.deleteSecret(CREDENTIALS_KEY);
    } catch (error) {
      this.log(`[ilinkbot] delete secret failed: ${errorMessage(error)}`);
    }
    try {
      settings.delete(CREDENTIALS_KEY);
    } catch (error) {
      this.log(`[ilinkbot] delete legacy setting failed: ${errorMessage(error)}`);
    }
  }

  private readSetting(settings: PluginSettings, key: string): string | null {
    try {
      return settings.get(key);
    } catch (error) {
      this.log(`[ilinkbot] read setting ${key} failed: ${errorMessage(error)}`);
      return null;
    }
  }

  private readRateLimit(settings: PluginSettings): number | bigint {
    const raw = this.readSetting(settings, 'plugin.ilinkbot.rate_limit_per_min');
    // Rust: `s.parse::<usize>().ok().unwrap_or(10)` — no prefix parsing, no whitespace.
    if (raw === null || !/^\+?\d+$/.test(raw)) return 10;
    const parsed = BigInt(raw);
    if (parsed > 18446744073709551615n) return 10;
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed;
  }

  private setActivity(summary: string): void {
    this.lastActivity = summary;
  }

  private async sendReply(
    settings: PluginSettings,
    credentials: IlinkCredentials,
    peer: string,
    contextToken: string,
    text: string,
  ): Promise<void> {
    let sendFailures = 0;
    for (const chunk of chunkText(text, OUTBOUND_CHUNK_LIMIT)) {
      try {
        await this.client.sendText(credentials, peer, contextToken, chunk);
        sendFailures = 0;
        const out = `已回复: ${Array.from(chunk).slice(0, 40).join('')}`;
        this.setActivity(out);
        this.events.emitActivity(PLUGIN_ID, 'msg_out', out);
      } catch (error) {
        const detail = errorMessage(error);
        if (detail.includes('-14') || detail.includes('session expired')) {
          await this.clearCredentials(settings);
          this.onState('waiting_login', detail);
          throw AppError.configuration(detail);
        }
        sendFailures += 1;
        const delay = sendFailures >= 3 ? 30 : 2;
        this.log(`[ilinkbot] send failed: ${detail}`);
        await this.sleep(delay * 1000);
      }
    }
  }

  private async runLoginFlow(ctx: PluginRuntimeContext): Promise<void> {
    while (this.loginRunning) {
      if (ctx.signal.aborted) return;
      await this.sleep(50);
    }
    this.loginRunning = true;
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener('abort', forward, { once: true });
    this.loginCancel = controller;
    try {
      await this.loginLoop(ctx, controller.signal);
    } finally {
      ctx.signal.removeEventListener('abort', forward);
      this.loginRunning = false;
      this.loginCancel = null;
    }
  }

  private async loginLoop(ctx: PluginRuntimeContext, cancel: AbortSignal): Promise<void> {
    this.onState('waiting_login', null);
    let refreshCount = 0;
    const maxRefreshes = 3;
    const overallDeadline = this.now() + 480_000;

    while (true) {
      if (ctx.signal.aborted || cancel.aborted) return;
      if (this.now() > overallDeadline) throw AppError.validation('扫码登录超时，请重试');

      let qr;
      try {
        qr = await this.client.getBotQrcode(cancel);
      } catch (error) {
        // Cancellation is an `Ok(())` return in the Rust select, not a login failure.
        if (ctx.signal.aborted || cancel.aborted) return;
        throw error;
      }
      const png = qrcodePngBase64(qr.qrcode_img_content);
      this.qrcodePng = png;
      this.qrcodeStatus = 'wait';
      this.events.emitQrcode(PLUGIN_ID, png, 'wait');

      let refresh = false;
      while (!refresh) {
        if (ctx.signal.aborted || cancel.aborted) return;
        if (this.now() > overallDeadline) throw AppError.validation('扫码登录超时，请重试');

        let status: QrcodeStatusResponse;
        try {
          status = await this.client.getQrcodeStatus(qr.qrcode, cancel);
        } catch (error) {
          if (ctx.signal.aborted || cancel.aborted) return;
          this.log(`[ilinkbot] qr status error: ${errorMessage(error)}`);
          await abortableSleep(1000, cancel);
          continue;
        }

        this.qrcodeStatus = status.status;
        if (this.qrcodePng !== null) this.events.emitQrcode(PLUGIN_ID, this.qrcodePng, status.status);

        switch (status.status) {
          case 'wait':
          case 'scaned':
            await abortableSleep(1000, cancel);
            break;
          case 'expired':
            refreshCount += 1;
            if (refreshCount > maxRefreshes) throw AppError.validation('二维码多次过期，请稍后重试');
            refresh = true;
            break;
          case 'confirmed': {
            const token = status.bot_token && status.bot_token.length > 0 ? status.bot_token : null;
            if (token === null) throw AppError.validation('确认成功但缺少 bot_token');
            const accountId = status.ilink_bot_id && status.ilink_bot_id.length > 0 ? status.ilink_bot_id : null;
            if (accountId === null) throw AppError.validation('确认成功但缺少 ilink_bot_id');
            const userId = status.ilink_user_id ?? '';
            const baseUrl = status.baseurl && status.baseurl.length > 0 ? status.baseurl : 'https://ilinkai.weixin.qq.com';
            const credentials: IlinkCredentials = {
              token,
              baseUrl,
              accountId,
              userId,
              getUpdatesBuf: '',
              contextTokens: {},
            };
            await this.saveCredentials(ctx.settings, credentials);
            this.setActivity('已绑定微信账号');
            this.events.emitActivity(PLUGIN_ID, 'login', '扫码绑定成功');
            this.qrcodePng = null;
            this.qrcodeStatus = 'confirmed';
            // Bound but not yet polling — Start/enable will enter poll_loop.
            this.onState('stopped', null);
            return;
          }
          default:
            // mod.rs:328 `tracing::debug!("[ilinkbot] unknown qr status: {}")`.
            this.debug(`[ilinkbot] unknown qr status: ${status.status}`);
            await abortableSleep(1000, cancel);
            break;
        }
      }
    }
  }

  private async pollLoop(ctx: PluginRuntimeContext, credentials: IlinkCredentials): Promise<void> {
    this.onState('running', null);
    const rate = new RateLimiter(this.readRateLimit(ctx.settings));
    let timeoutMs: IlinkInteger = DEFAULT_LONG_POLL_TIMEOUT_MS;
    let failures = 0;
    let runningTasks = 0;

    while (!ctx.signal.aborted) {
      let response;
      try {
        response = await this.client.getUpdates(credentials, timeoutMs, ctx.signal);
      } catch (error) {
        if (ctx.signal.aborted) return;
        failures += 1;
        const delay = failures >= 3 ? 30 : 2;
        if (failures >= 3) failures = 0;
        this.log(`[ilinkbot] getupdates error: ${errorMessage(error)}`);
        await abortableSleep(delay * 1000, ctx.signal);
        continue;
      }

      const longPoll = response.longpolling_timeout_ms;
      if (longPoll !== null && longPoll !== undefined && longPoll > 0) timeoutMs = longPoll;
      if (isSessionExpired(response.ret, response.errcode)) {
        await this.clearCredentials(ctx.settings);
        this.events.emitActivity(PLUGIN_ID, 'warn', '登录已失效，请重新扫码');
        this.onState('waiting_login', 'session expired');
        throw AppError.configuration('session expired (-14)');
      }
      if (isApiError(response.ret, response.errcode)) {
        failures += 1;
        const delay = failures >= 3 ? 30 : 2;
        if (failures >= 3) failures = 0;
        this.log(`[ilinkbot] getupdates api error ret=${String(response.ret)} err=${String(response.errcode)}`);
        await abortableSleep(delay * 1000, ctx.signal);
        continue;
      }
      failures = 0;

      for (const message of response.msgs) {
        if (message.message_type === 2) continue;
        const peer = message.from_user_id ?? '';
        if (peer.length === 0) continue;
        const contextToken = message.context_token;
        if (contextToken !== null && contextToken !== undefined) {
          credentials.contextTokens[peer] = contextToken;
          try {
            await this.saveCredentials(ctx.settings, credentials);
          } catch (error) {
            this.log(`[ilinkbot] persist context token failed: ${errorMessage(error)}`);
          }
        }
        const text = extractText(message);
        if (!this.photoBatch && rustTrim(text).length === 0) continue;
        if (this.pairingGuard && !this.pairingGuard.boundUserId(credentials.accountId)) {
          if (normalizeIlinkPairingCode(text) !== null || /^\/pair(?:\s|$)/i.test(text.trim())) {
            const result = this.pairingGuard.verify(credentials.accountId, text, peer);
            if (result.ok) {
              credentials.userId = peer;
              await this.saveCredentials(ctx.settings, credentials);
              const token = credentials.contextTokens[peer] ?? '';
              if (token) await this.sendReply(ctx.settings, credentials, peer, token, '绑定成功，可以开始使用。');
            }
          }
          continue;
        }
        const boundUserId = this.pairingGuard?.boundUserId(credentials.accountId) ?? credentials.userId;
        if (!isBoundUser(boundUserId, peer)) {
          this.setActivity('已忽略非绑定用户消息');
          this.events.emitActivity(PLUGIN_ID, 'warn', '非绑定用户消息已忽略');
          continue;
        }
        if (this.photoBatch) {
          const scope = { accountId: credentials.accountId, peer, sessionId: message.session_id ?? null };
          const attachments = this.photoBatch.attachments(message);
          const batchControl = /^\/(?:stop|status|approve|reject|pair)(?:\s|$)/i.test(text.trim());
          if (attachments.length || this.photoBatch.aggregator.isCollecting(scope) || batchControl) {
            if (message.message_id === null || message.message_id === undefined) {
              this.log('[ilinkbot] photo batching requires message_id');
              if (!batchControl) continue;
              if (/^\/stop(?:\s|$)/i.test(text.trim())) this.photoBatch.aggregator.cancel(scope);
              else this.photoBatch.aggregator.flush(scope);
            } else {
              const result = this.photoBatch.aggregator.push({ ...scope, messageId: message.message_id, text, attachments });
              if (!batchControl || result.kind === 'duplicate') continue;
            }
          }
        }
        if (rustTrim(text).length === 0) continue;
        // Rust parses control commands through task_command; Stop/Inspect/Approve/Help never
        // take a task slot, so a stop can never be queued behind running turns.
        const isControlMessage = this.tasks?.isControlMessage(text) ?? false;
        if (!isControlMessage && !rate.checkAndRecord(peer)) {
          const token = credentials.contextTokens[peer] ?? '';
          if (token.length > 0) {
            try {
              await this.client.sendText(credentials, peer, token, '你发送得太快了，请稍后再试。');
            } catch (error) {
              this.log(`[ilinkbot] rate-limit notice failed: ${errorMessage(error)}`);
            }
          }
          continue;
        }

        const summary = `收到消息: ${Array.from(text).slice(0, 40).join('')}`;
        this.setActivity(summary);
        this.events.emitActivity(PLUGIN_ID, 'msg_in', summary);
        const token = credentials.contextTokens[peer] ?? contextToken ?? '';
        if (token.length === 0) {
          this.log(`[ilinkbot] missing context_token for ${peer}`);
          continue;
        }
        if (!this.tasks) {
          this.log('[ilinkbot] remote task bridge is not installed (L06 task_command/headless)');
          this.events.emitActivity(PLUGIN_ID, 'warn', '远程任务通路未就绪');
          continue;
        }
        const occupiesSlot = !isControlMessage;
        if (occupiesSlot && runningTasks >= MAX_CONCURRENT_TASKS) {
          try {
            await this.client.sendText(credentials, peer, token, '同时运行的任务已达上限，请稍后再试');
          } catch (error) {
            this.log(`[ilinkbot] task-limit notice failed: ${errorMessage(error)}`);
          }
          continue;
        }

        if (occupiesSlot) runningTasks += 1;
        const peers = { peer, token };
        void (async () => {
          try {
            const outcome = await this.tasks!.dispatch({
              credentials,
              peer: peers.peer,
              text,
              contextToken: peers.token,
              sessionId: message.session_id ?? null,
              messageId: message.message_id ?? null,
              seq: message.seq ?? null,
              clientId: message.client_id ?? null,
            });
            if (outcome.kind === 'ignored') return;
            if (outcome.kind === 'stop' && outcome.sessionId !== null) await this.tasks!.cancelSession(outcome.sessionId);
            await this.sendReply(ctx.settings, credentials, peers.peer, peers.token, outcome.text);
          } catch (error) {
            this.log(`[ilinkbot] remote task failed: ${errorMessage(error)}`);
          } finally {
            if (occupiesSlot) runningTasks -= 1;
          }
        })();
      }

      // 游标必须在本批消息全部派发之后再落盘：先存游标会让崩溃/重启丢掉这一批
      // `msgs`（服务端已认为它们被消费），而重新拉取时不会再返回。
      const cursor = response.get_updates_buf;
      if (typeof cursor === 'string' && cursor.length > 0 && cursor !== credentials.getUpdatesBuf) {
        credentials.getUpdatesBuf = cursor;
        try {
          await this.saveCredentials(ctx.settings, credentials);
        } catch (error) {
          this.log(`[ilinkbot] persist cursor failed: ${errorMessage(error)}`);
        }
      }
    }
  }

  async isBound(settings: PluginSettings): Promise<boolean> {
    try {
      const credentials = await this.loadCredentials(settings);
      return credentials !== null && credentials.token.length > 0;
    } catch (error) {
      this.log(`[ilinkbot] isBound failed: ${errorMessage(error)}`);
      return false;
    }
  }

  async run(ctx: PluginRuntimeContext): Promise<void> {
    let credentials: IlinkCredentials | null = await this.loadCredentials(ctx.settings);
    if (credentials === null) {
      await this.runLoginFlow(ctx);
      credentials = await this.loadCredentials(ctx.settings);
      if (credentials === null) throw AppError.validation('登录未完成');
    }
    if (ctx.signal.aborted) return;
    await this.pollLoop(ctx, credentials);
  }

  async status(settings: PluginSettings): Promise<PluginStatusSnapshot> {
    let credentials: IlinkCredentials | null = null;
    try {
      credentials = await this.loadCredentials(settings);
    } catch (error) {
      this.log(`[ilinkbot] status credentials failed: ${errorMessage(error)}`);
    }
    const enabledValue = this.readSetting(settings, 'plugin.ilinkbot.enabled');
    const enabled = enabledValue === 'true' || enabledValue === '1';
    let config: JsonValue = null;
    try {
      config = await this.getPublicConfig(settings);
    } catch (error) {
      this.log(`[ilinkbot] status config failed: ${errorMessage(error)}`);
    }
    const snapshot = emptyStatusSnapshot();
    snapshot.state = 'stopped';
    snapshot.enabled = enabled;
    snapshot.configured = this.isConfigured(config);
    snapshot.bound = credentials !== null && credentials.token.length > 0;
    snapshot.loginStatus = this.qrcodeStatus;
    snapshot.accountId = credentials?.accountId ?? null;
    snapshot.userId = credentials?.userId ?? null;
    snapshot.lastError = null;
    snapshot.lastActivity = this.lastActivity;
    snapshot.qrcodePngBase64 = this.qrcodePng;
    snapshot.qrcodeStatus = this.qrcodeStatus;
    return snapshot;
  }

  async getPublicConfig(settings: PluginSettings): Promise<JsonValue> {
    const rate = this.readRateLimit(settings);
    const model = this.readSetting(settings, 'plugin.ilinkbot.model_config_id') ?? '';
    const systemPrompt = this.readSetting(settings, 'plugin.ilinkbot.system_prompt') ?? '';
    const enabledValue = this.readSetting(settings, 'plugin.ilinkbot.enabled');
    const enabled = enabledValue === 'true' || enabledValue === '1';
    const bound = await this.isBound(settings);
    let credentials: IlinkCredentials | null = null;
    try {
      credentials = await this.loadCredentials(settings);
    } catch (error) {
      this.log(`[ilinkbot] config credentials failed: ${errorMessage(error)}`);
    }
    return {
      enabled,
      rateLimitPerMin: rate,
      modelConfigId: model,
      systemPrompt,
      bound,
      hasToken: bound,
      accountId: credentials?.accountId ?? '',
      userId: credentials?.userId ?? '',
      baseUrl: credentials?.baseUrl ?? '',
    };
  }

  async setConfig(settings: PluginSettings, patch: JsonValue): Promise<void> {
    const record = isJsonObject(patch) ? patch : null;
    const enabled = record?.enabled;
    if (typeof enabled === 'boolean') {
      try {
        settings.save('plugin.ilinkbot.enabled', enabled ? 'true' : 'false');
      } catch (error) {
        throw AppError.database(errorMessage(error));
      }
    }
    const rate = record?.rateLimitPerMin;
    // Rust: `patch.get(...).and_then(|x| x.as_u64())`.
    const integer = typeof rate === 'bigint' ? rate
      : typeof rate === 'number' && Number.isInteger(rate) ? BigInt(rate) : null;
    if (integer !== null && integer >= 0n && integer <= 18446744073709551615n) {
      try {
        settings.save('plugin.ilinkbot.rate_limit_per_min', String(integer));
      } catch (error) {
        throw AppError.database(errorMessage(error));
      }
    }
    const model = record?.modelConfigId;
    if (typeof model === 'string') {
      try {
        settings.save('plugin.ilinkbot.model_config_id', model);
      } catch (error) {
        throw AppError.database(errorMessage(error));
      }
    }
    const prompt = record?.systemPrompt;
    if (typeof prompt === 'string') {
      try {
        settings.save('plugin.ilinkbot.system_prompt', prompt);
      } catch (error) {
        throw AppError.database(errorMessage(error));
      }
    }
    // Never accept token via patch from frontend
  }

  async beginLogin(ctx: PluginRuntimeContext): Promise<void> {
    await this.runLoginFlow(ctx);
  }

  async cancelLogin(): Promise<void> {
    this.loginCancel?.abort();
  }

  async logout(settings: PluginSettings): Promise<void> {
    if (this.pairingGuard) {
      const credentials = await this.loadCredentials(settings);
      if (credentials) this.pairingGuard.revoke(credentials.accountId);
    }
    await this.clearCredentials(settings);
    this.qrcodePng = null;
    this.qrcodeStatus = null;
    this.setActivity('已解绑');
  }
}

export { DEFAULT_REMOTE_SYSTEM_APPEND, OUTBOUND_CHUNK_LIMIT };
