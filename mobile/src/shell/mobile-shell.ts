/**
 * 移动端外壳主线程路由：在 WebView 主线程里扮演桌面 Electron main 的角色。
 *
 * - renderer 侧直接复用桌面 preload 的 `installTauriBridge`（`window.__TAURI_INTERNALS__.invoke/transformCallback`、
 *   `listen-js` / `emit-js`），所以前端 `@tauri-apps/api` 的 `invoke` / `listen` 不需要任何改动；
 * - `invoke` 转成 Host 协议的 `InvokeRequest`（经 MessagePort 发给 Worker 中的 Host），结果按 Tauri
 *   回调 id 回送，编码规则与桌面 `ShellRuntime.dispatchInvoke` / `encodeBody` 相同；
 * - `plugin:event|listen/unlisten/emit/emit_to` 在主线程处理（JS 监听表复用桌面 `JsListenerRegistry`），
 *   emit 同时作为 `frontend-event` 转给 Host；Host 的 `event` 按 target 扇出给 JS 监听者；
 * - Host 的 `shell-request`（只能在主线程完成的平台操作）交给 {@link MobileShellOptions.onShellRequest}：
 *   Capacitor 原生插件只能在主线程调用，Host 侧插件经 `ctx.shell.request(op, args)` 到这里代办。
 * - Host 连接由 `host-supervisor.ts` 管理：每个 Worker 一条端口（{@link MobileShell.attach}），Worker 退出时
 *   进行中的调用以退出原因结束（{@link MobileShell.detach}），放弃重启后调用立即失败（{@link MobileShell.markUnavailable}）。
 */
import { JsListenerRegistry, emitToFilter, isEventNameValid, parseEventTarget, type TargetFilter } from '../../../electron/shell/events.ts';
import type { BridgeTransport } from '../../../electron/preload/bridge.ts';
import type { InvokeMessage, MainToRenderer, RendererToMain, ResponseBody } from '../../../electron/shell/bridge-messages.ts';
import {
  HOST_PROTOCOL_VERSION,
  type EventTarget,
  type Handshake,
  type HostToMain,
  type MainToHostMessage,
  type ShellRequest,
} from '../../../host/kernel/protocol.ts';
import { isWorkerExitReport } from '../worker/exit-report.ts';

export interface MobileShellOptions {
  readonly handshake: Omit<Handshake, 'kind' | 'protocol'>;
  readonly windowLabel?: string;
  readonly webviewLabel?: string;
  /** Host 请求主线程代办的平台操作；未提供或抛错时以错误回复 Host。 */
  readonly onShellRequest?: (request: ShellRequest) => Promise<unknown>;
  readonly log?: (message: string) => void;
}

interface PendingInvoke {
  readonly callback: number;
  readonly error: number;
}

/** 当前连接的 Host 生命周期通知（供 supervisor 判断就绪与 fatal）。 */
export interface HostLifecycle {
  onReady(): void;
  onFatal(message: string): void;
  /** Worker 在同一端口上报告 Host 已结束（`mobile/src/worker/exit-report.ts`），排在 Host 的全部消息之后。 */
  onExit(code: number): void;
}

function encodeBody(value: unknown): ResponseBody {
  if (value instanceof Uint8Array) return { kind: 'raw', data: value };
  if (value instanceof ArrayBuffer) return { kind: 'raw', data: new Uint8Array(value) };
  const json = JSON.stringify(value === undefined ? null : value);
  return { kind: 'json', data: json === undefined ? 'null' : json };
}

class EventCommandError extends Error {}

export class MobileShell {
  /** 第一次 HostReady 时 resolve；在那之前放弃重启则 reject。 */
  readonly ready: Promise<void>;
  readonly listeners = new JsListenerRegistry();
  private port: MessagePort | null = null;
  private lifecycle: HostLifecycle | null = null;
  private unavailableReason: string | null = null;
  private readonly options: MobileShellOptions;
  private readonly windowLabel: string;
  private readonly webviewLabel: string;
  private readonly renderers = new Set<(message: MainToRenderer) => void>();
  private readonly pending = new Map<string, PendingInvoke>();
  private nextId = 0;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  constructor(options: MobileShellOptions) {
    this.options = options;
    this.windowLabel = options.windowLabel ?? 'main';
    this.webviewLabel = options.webviewLabel ?? 'main';
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => undefined);
  }

  /** 连到一个新的 Host（新 Worker 的端口）并发送握手。 */
  attach(port: MessagePort, lifecycle: HostLifecycle): void {
    this.port = port;
    this.lifecycle = lifecycle;
    port.addEventListener('message', (event) => {
      if (this.port !== port) return;
      if (isWorkerExitReport(event.data)) this.lifecycle?.onExit(event.data.code);
      else this.fromHost(event.data as HostToMain);
    });
    port.addEventListener('messageerror', () => {
      if (this.port === port) this.failInFlight('Host message could not be deserialized');
    });
    port.start();
    this.toHost({ kind: 'handshake', protocol: HOST_PROTOCOL_VERSION, ...this.options.handshake });
  }

  /** 当前 Host 已退出：关闭端口，进行中的调用以 `reason` 结束。 */
  detach(reason: string): void {
    this.port?.close();
    this.port = null;
    this.lifecycle = null;
    this.failInFlight(reason);
  }

  /** 不再有 Host：进行中与之后的调用都以 `reason` 失败。 */
  markUnavailable(reason: string): void {
    this.unavailableReason = reason;
    this.failInFlight(reason);
    this.rejectReady(new Error(reason));
  }

  private failInFlight(reason: string): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) this.reply(entry, false, encodeBody(reason));
  }

  /** 交给 `installTauriBridge` 的传输。 */
  bridgeTransport(): BridgeTransport {
    return {
      send: message => this.fromRenderer(message),
      subscribe: (listener) => { this.renderers.add(listener); },
    };
  }

  /** 有序退出请求：通知 Host 关闭（插件 dispose、连接关闭、WAL checkpoint）；等待退出由 supervisor 负责。 */
  sendShutdown(): void {
    this.toHost({ kind: 'shutdown' });
  }

  private toHost(message: MainToHostMessage): void {
    this.port?.postMessage(message);
  }

  private toRenderer(message: MainToRenderer): void {
    for (const listener of this.renderers) listener(message);
  }

  private reply(pending: PendingInvoke, ok: boolean, body: ResponseBody): void {
    this.toRenderer({ type: 'result', callbackId: ok ? pending.callback : pending.error, otherId: ok ? pending.error : pending.callback, body });
  }

  private fromRenderer(message: RendererToMain): void {
    if (message.type !== 'invoke') {
      this.options.log?.(`mobile shell: ignoring renderer message ${message.type}`);
      return;
    }
    if (message.cmd.startsWith('plugin:event|')) {
      this.handleEventCommand(message);
      return;
    }
    const shellResults: Record<string, unknown> = {
      'plugin:window|is_visible': true,
      'plugin:window|is_focused': true,
      'plugin:window|is_minimized': false,
      'plugin:window|set_focus': null,
      'plugin:window|show': null,
      'plugin:window|unminimize': null,
      'plugin:notification|is_permission_granted': false,
      'plugin:notification|request_permission': 'denied',
      'plugin:notification|notify': null,
    };
    if (Object.hasOwn(shellResults, message.cmd)) {
      this.reply({ callback: message.callback, error: message.error }, true, encodeBody(shellResults[message.cmd]));
      return;
    }
    const notRunning = this.unavailableReason ?? (this.port === null ? 'Mobile Host is not running' : null);
    if (notRunning !== null) {
      this.reply({ callback: message.callback, error: message.error }, false, encodeBody(notRunning));
      return;
    }
    const id = `m${++this.nextId}`;
    this.pending.set(id, { callback: message.callback, error: message.error });
    // 外壳只承载打包进应用的本地前端（Tauri `is_local_url` 为 Local），与桌面一样不带 origin；
    // 若以后在 WebView 中加载远程页面，需要按 `electron/shell/frame-origin.ts` 的规则传入其 origin。
    const source = { window: this.windowLabel, webview: this.webviewLabel };
    if (message.payload.contentType === 'application/json') {
      let args: unknown;
      try {
        args = JSON.parse(message.payload.data);
      } catch (error) {
        this.pending.delete(id);
        this.reply({ callback: message.callback, error: message.error }, false, encodeBody(`invalid args JSON: ${(error as Error).message}`));
        return;
      }
      this.toHost({ kind: 'invoke', id, cmd: message.cmd, args, argsJson: message.payload.data, source, headers: message.headers });
    } else {
      this.toHost({ kind: 'invoke', id, cmd: message.cmd, args: message.payload.data, source, headers: message.headers });
    }
  }

  private fromHost(message: HostToMain): void {
    switch (message.kind) {
      case 'ready':
        this.lifecycle?.onReady();
        this.resolveReady();
        return;
      case 'fatal':
        this.options.log?.(`[host] fatal: ${message.message}${message.stack ? `\n${message.stack}` : ''}`);
        this.lifecycle?.onFatal(message.message);
        return;
      case 'result': {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        const body: ResponseBody = message.json !== undefined ? { kind: 'json', data: message.json } : encodeBody(message.ok ? message.value : message.error);
        this.reply(pending, message.ok, body);
        return;
      }
      case 'event':
        this.emitJs(message.event, message.payloadJson ?? JSON.stringify(message.payload ?? null), emitToFilter(message.target));
        return;
      case 'shell-request': {
        const handler = this.options.onShellRequest;
        const run = Promise.resolve().then(() => {
          if (!handler) throw new Error(`shell operation "${message.op}" is not available on mobile`);
          return handler(message);
        });
        const port = this.port;
        const answer = (result: MainToHostMessage) => {
          if (this.port === port) this.toHost(result);
        };
        run.then(
          value => answer({ kind: 'shell-result', id: message.id, ok: true, value: value ?? null }),
          (error: unknown) => answer({ kind: 'shell-result', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
        );
        return;
      }
      default:
        this.options.log?.(`mobile shell: unhandled Host message ${message.kind}`);
    }
  }

  private emitJs(event: string, payloadJson: string, filter: TargetFilter | null): void {
    for (const [, ids] of this.listeners.collect(event, filter, [this.webviewLabel])) {
      this.toRenderer({ type: 'emit-js', event, payload: payloadJson, ids });
    }
  }

  /** `plugin:event|*`（tauri `src/event/plugin.rs`，同桌面 `electron/shell/plugins/event.ts`）。 */
  private handleEventCommand(message: InvokeMessage): void {
    const pending = { callback: message.callback, error: message.error };
    try {
      if (message.payload.contentType !== 'application/json') throw new EventCommandError('event commands take JSON arguments');
      const args = JSON.parse(message.payload.data) as Record<string, unknown>;
      const command = message.cmd.slice('plugin:event|'.length);
      const event = (): string => {
        const name = args.event;
        if (typeof name !== 'string' || !isEventNameValid(name)) throw new EventCommandError(`invalid args \`event\` for command \`${command}\``);
        return name;
      };
      const target = (): EventTarget => {
        const parsed = parseEventTarget(args.target);
        if (!parsed) throw new EventCommandError(`invalid args \`target\` for command \`${command}\`: invalid EventTarget`);
        return parsed;
      };
      const payload = (): string => JSON.stringify(args.payload === undefined ? null : args.payload);
      const forward = (name: string, json: string, to: EventTarget) => this.toHost({
        kind: 'frontend-event', event: name, payload: JSON.parse(json) as unknown, target: to,
        source: { window: this.windowLabel, webview: this.webviewLabel },
      });
      let result: unknown = null;
      switch (command) {
        case 'listen': {
          const name = event();
          const to = target();
          const handler = args.handler;
          if (typeof handler !== 'number' || !Number.isInteger(handler) || handler < 0) throw new EventCommandError('invalid args `handler` for command `listen`');
          const eventId = this.listeners.listen(this.webviewLabel, name, to);
          this.toRenderer({ type: 'listen-js', event: name, eventId, target: to, handlerId: handler });
          result = eventId;
          break;
        }
        case 'unlisten': {
          const eventId = args.eventId;
          if (typeof eventId !== 'number') throw new EventCommandError('invalid args `eventId` for command `unlisten`');
          this.listeners.unlisten(event(), eventId);
          break;
        }
        case 'emit': {
          const name = event();
          const json = payload();
          this.emitJs(name, json, null);
          forward(name, json, { kind: 'Any' });
          break;
        }
        case 'emit_to': {
          const to = target();
          const name = event();
          const json = payload();
          this.emitJs(name, json, to.kind === 'Any' ? null : emitToFilter(to));
          forward(name, json, to);
          break;
        }
        default:
          throw new EventCommandError(`command ${command} not found`);
      }
      this.reply(pending, true, encodeBody(result));
    } catch (error) {
      this.reply(pending, false, encodeBody(error instanceof Error ? error.message : String(error)));
    }
  }
}
