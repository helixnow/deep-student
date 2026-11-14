/**
 * 外壳运行时：持有窗口、事件注册表、作用域、资源表与 Host 连接，并把页面的 invoke 分派到
 * main 内实现的 Tauri 内置插件或转发给 Host。
 *
 * 页面发来的内置插件命令先经 {@link BuiltinAcl} 判定（与 Tauri 的 `resolve_access` 一致，默认拒绝），
 * 再交给插件；插件从 `CommandContext.scope` 取本次调用的作用域。Host 代办的外壳操作（`runBuiltin`）
 * 相当于 Rust 代码直接调用，不经 ACL。
 */
import { diagnosticRecord } from '../../host/platform/log/incidents.ts';
import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import type {} from '../api.ts';
import type { WebContents } from 'electron';
import type { EventTarget, WindowRef } from '../../host/kernel/protocol.ts';
import type { InvokeInput } from './args.ts';
import {
  checkInvokeMessage,
  IPC_CHANNEL_TO_RENDERER,
  MAX_LOCAL_INVOKE_PAYLOAD,
  MAX_REMOTE_INVOKE_PAYLOAD,
  type InvokeMessage,
  type InvokeReplyIds,
  type MainToRenderer,
  type ResponseBody,
} from './bridge-messages.ts';
import { BuiltinAcl, type ScopeEntries } from './capabilities.ts';
import { ShellCommandError } from './errors.ts';
import { emitToFilter, JsListenerRegistry, nativeFrontendEvent, type TargetFilter } from './events.ts';
import { frameOrigin } from './frame-origin.ts';
import type { HostSupervisor } from './host.ts';
import { decodeRawBytes } from '../raw-bytes.ts';
import { pushPath, type PathResolver } from './paths.ts';
import { TAURI_ACL_MANIFESTS } from './plugins/tauri-acl-manifest.ts';
import type { FsScope } from './scope.ts';
import type { EffectiveTauriConfig, ShellPlatform } from './tauri-config.ts';
import type { ShellWindow, WindowManager } from './windows.ts';

export interface CommandContext {
  readonly runtime: ShellRuntime;
  /** 调用方 window/webview label。Host 代办请求时为目标窗口（默认 `main`）。 */
  readonly windowLabel: string;
  readonly webviewLabel: string;
  /**
   * 调用方可用的作用域（ACL 命令作用域 ∪ 插件全局作用域）。参数缺省为本命令，也可取同插件的其他命令
   * （如 fs 以写模式 `open` 时按 `write_file` 判定）。`runBuiltin` 总会填写；直接调用处理函数而未提供时，
   * 插件按空作用域处理。
   */
  readonly scope?: (command?: string) => ScopeEntries;
}

export type BuiltinCommand = (input: InvokeInput, ctx: CommandContext) => unknown;
export type BuiltinPlugin = Record<string, BuiltinCommand>;

const UNSUPPORTED_COMMANDS = new WeakSet<BuiltinCommand>();

/** 实现了但 Electron 无法提供等价行为的命令：明确报错，不返回假成功。 */
export function unsupported(plugin: string, command: string, reason: string): BuiltinCommand {
  const handler: BuiltinCommand = () => {
    throw new ShellCommandError(`[electron-shell] ${plugin}.${command} is not supported: ${reason}`);
  };
  UNSUPPORTED_COMMANDS.add(handler);
  return handler;
}

/** 处理函数是否只是 {@link unsupported} 生成的报错桩。 */
export function isUnsupportedCommand(handler: BuiltinCommand): boolean {
  return UNSUPPORTED_COMMANDS.has(handler);
}

/** 外壳明确不提供的核心插件（见 `UNPROVIDED_PLUGINS`）的报错桩表；其他插件名为 null。 */
export function unprovidedPlugin(name: string): BuiltinPlugin | null {
  return UNPROVIDED_PLUGINS.get(name) ?? null;
}

/**
 * Tauri 桌面版编译、ACL 也放行，但外壳不提供 JS API 的核心插件。页面调用照常先过 ACL，放行后明确报不支持，
 * 不当作应用命令转给 Host；`registerPlugin` 注册同名插件后以注册的为准。
 */
// RUST-FIX(RF-W23-menu-tray-js-api-unprovided): core:default 给 main 与两个小窗放行 core:menu:default / core:tray:default；前端没有调用方，原生菜单由 main 的 menu.ts 构建，应用没有托盘图标。
const UNPROVIDED_PLUGINS: ReadonlyMap<string, BuiltinPlugin> = new Map(
  ([
    ['menu', 'the native menu is built by the Electron main process'],
    ['tray', 'the app has no tray icon'],
  ] as const).map(([plugin, reason]) => [
    plugin,
    Object.fromEntries((TAURI_ACL_MANIFESTS[`core:${plugin}`]?.commands ?? []).map((command) => [command, unsupported(plugin, command, reason)])),
  ]),
);

export interface Resource {
  close(): void | Promise<void>;
}

export interface BrowserWebview {
  readonly label: string;
  readonly windowLabel: string;
  readonly webContents: WebContents;
  readonly initializationScript: string;
}

export interface RuntimeOptions {
  platform: ShellPlatform;
  debug: boolean;
  config: EffectiveTauriConfig;
  paths: PathResolver;
  assetScope: FsScope;
  fsScope: FsScope;
  appVersion: string;
  /** 本地应用页面的 Origin（dev URL、`tauri://localhost` 或 Windows 的 `http://tauri.localhost`）。 */
  localOrigin: string;
  /** 内置插件 ACL；缺省从 {@link DEFAULT_CAPABILITIES_DIR} 加载，加载失败时拒绝全部内置插件命令。 */
  acl?: BuiltinAcl;
  /**
   * Electron userData（`app.getPath('userData')`），即 fs 作用域里 `$ELECTRON_USERDATA` 的值。缺省为 main 设置的默认位置
   * `<appData>/<identifier>.electron`：Electron 的 appData 在三个平台上都等于 `dirs::config_dir()`（`paths.configDir()`）。
   */
  userDataDir?: string;
  log(message: string): void;
}

function defaultUserDataDir(platform: ShellPlatform, paths: PathResolver, identifier: string): string | null {
  const appData = paths.configDir();
  return appData === null ? null : pushPath(platform, appData, `${identifier}.electron`);
}

/** 与 main 的 `tauriDir`（应用根目录下的 `src-tauri`）相同。 */
export const DEFAULT_CAPABILITIES_DIR = resolve(import.meta.dirname, '../../resources/app/capabilities');

/**
 * `DS_CAPABILITIES_DIR` 换用另一套 capability 文件（真实 Electron 测试给夹具页面授予被测命令），
 * 与 `DS_ELECTRON_DEV_URL`、`DS_HOST_ENTRY` 等启动环境变量同级。
 */
function loadDefaultAcl(platform: ShellPlatform, log: (message: string) => void): BuiltinAcl {
  const dir = process.env.DS_CAPABILITIES_DIR || DEFAULT_CAPABILITIES_DIR;
  try {
    return BuiltinAcl.fromDirectory(dir, platform);
  } catch (error) {
    log(`[acl] failed to load ${dir}; every builtin plugin command will be denied: ${error instanceof Error ? error.message : String(error)}`);
    return new BuiltinAcl([], platform);
  }
}

export class ShellRuntime {
  readonly platform: ShellPlatform;
  readonly debug: boolean;
  readonly config: EffectiveTauriConfig;
  readonly paths: PathResolver;
  readonly assetScope: FsScope;
  readonly fsScope: FsScope;
  readonly appVersion: string;
  readonly localOrigin: string;
  readonly acl: BuiltinAcl;
  readonly userDataDir: string | null;
  readonly listeners = new JsListenerRegistry();
  readonly plugins = new Map<string, BuiltinPlugin>();
  readonly log: (message: string) => void;
  windows!: WindowManager;
  host!: HostSupervisor;
  private readonly resources = new Map<string, Map<number, Resource>>();
  private readonly channelIndex = new Map<string, number>();
  private readonly browserWebviews = new Map<number, BrowserWebview>();

  constructor(options: RuntimeOptions) {
    this.platform = options.platform;
    this.debug = options.debug;
    this.config = options.config;
    this.paths = options.paths;
    this.assetScope = options.assetScope;
    this.fsScope = options.fsScope;
    this.appVersion = options.appVersion;
    this.localOrigin = options.localOrigin;
    this.log = options.log;
    this.acl = options.acl ?? loadDefaultAcl(options.platform, options.log);
    // RUST-FIX(RF-W23-fs-deny-webview-data-user-data): deny-default 的 userData 目标在这里确定（Rust 版没有可 deny 的目标）。
    this.userDataDir = options.userDataDir ?? defaultUserDataDir(options.platform, options.paths, options.config.identifier);
  }

  registerPlugin(name: string, commands: BuiltinPlugin): void {
    this.plugins.set(name, commands);
  }

  // ------------------------------------------------------------ renderer 通道

  registerBrowserWebview(entry: BrowserWebview): void {
    this.browserWebviews.set(entry.webContents.id, entry);
  }

  unregisterBrowserWebview(contents: WebContents): void {
    // destroyed 事件里直接读 `contents.id` 会抛 “Object has been destroyed”，按引用比较。
    for (const [id, entry] of this.browserWebviews) {
      if (entry.webContents === contents) this.browserWebviews.delete(id);
    }
  }

  browserWebviewOf(contents: WebContents): BrowserWebview | null {
    return this.browserWebviews.get(contents.id) ?? null;
  }

  private browserByLabel(label: string): BrowserWebview | null {
    for (const entry of this.browserWebviews.values()) {
      if (entry.label === label) return entry;
    }
    return null;
  }

  /**
   * 在用的 browser-content webview 占用的 window / webview label。Tauri 的 window 与 webview label 各是全局唯一的，
   * 应用窗口（每个窗口一个同名 webview）不能与它们重名，否则发往该 label 的回复与事件会被送进内容页。
   */
  browserLabelInUse(label: string): 'window' | 'webview' | null {
    for (const entry of this.browserWebviews.values()) {
      if (entry.windowLabel === label) return 'window';
    }
    return this.browserByLabel(label) === null ? null : 'webview';
  }

  sendToWebview(label: string, message: MainToRenderer): void {
    const browser = this.browserByLabel(label);
    if (browser) {
      if (!browser.webContents.isDestroyed()) browser.webContents.send(IPC_CHANNEL_TO_RENDERER, message);
      return;
    }
    const win = this.windows.get(label);
    if (!win || win.webContents.isDestroyed()) return;
    win.webContents.send(IPC_CHANNEL_TO_RENDERER, message);
  }

  static encodeBody(value: unknown): ResponseBody {
    if (value instanceof Uint8Array) return { kind: 'raw', data: value };
    if (value instanceof ArrayBuffer) return { kind: 'raw', data: new Uint8Array(value) };
    const json = JSON.stringify(value === undefined ? null : value);
    return { kind: 'json', data: json === undefined ? 'null' : json };
  }

  /** Rust `Channel::send`：`{ message, index }`，index 从 0 递增。 */
  sendChannel(webview: string, channelId: number, value: unknown): void {
    const key = `${webview}:${channelId}`;
    const index = this.channelIndex.get(key) ?? 0;
    this.channelIndex.set(key, index + 1);
    this.sendToWebview(webview, { type: 'channel', id: channelId, index, body: ShellRuntime.encodeBody(value) });
  }

  // ------------------------------------------------------------ 事件

  /** 向满足过滤器的 JS 监听发射事件（`emit_js_filter`）。 */
  emitJs(event: string, payloadJson: string, filter: TargetFilter | null): void {
    for (const [label, ids] of this.listeners.collect(event, filter, this.windows.labels())) {
      this.sendToWebview(label, { type: 'emit-js', event, payload: payloadJson, ids });
    }
  }

  /** `emit_to(target, …)`。 */
  emitTo(target: EventTarget, event: string, payloadJson: string): void {
    this.emitJs(event, payloadJson, emitToFilter(target));
  }

  /**
   * main 自己产生的事件交给 Host（Rust 侧代码直接 `app.emit`，Host 插件用 `backendEvents.listen` 接收），带 `native: true`，
   * 与页面经 `plugin:event|emit` 转来的同名事件区分（SEC-E05）。
   */
  sendNativeEvent(event: string, payload: unknown, source: WindowRef, target: EventTarget = { kind: 'App' }): void {
    this.host.sendMessage(nativeFrontendEvent(source, event, payload, target));
  }

  // ------------------------------------------------------------ 资源表（每 webview 一张，rid 随机，对应 tauri ResourceTable）

  addResource(webview: string, resource: Resource): number {
    let table = this.resources.get(webview);
    if (!table) {
      table = new Map();
      this.resources.set(webview, table);
    }
    let rid = randomInt(0, 2 ** 32);
    while (table.has(rid)) rid = randomInt(0, 2 ** 32);
    table.set(rid, resource);
    return rid;
  }

  getResource<T extends Resource>(webview: string, rid: number, guard: (r: Resource) => r is T): T {
    const resource = this.resources.get(webview)?.get(rid);
    if (!resource || !guard(resource)) throw new ShellCommandError(`The resource id ${rid} is invalid.`);
    return resource;
  }

  async closeResource(webview: string, rid: number): Promise<void> {
    const table = this.resources.get(webview);
    const resource = table?.get(rid);
    if (!table || !resource) throw new ShellCommandError(`The resource id ${rid} is invalid.`);
    table.delete(rid);
    await resource.close();
  }

  takeResource(webview: string, rid: number): void {
    this.resources.get(webview)?.delete(rid);
  }

  webviewGone(label: string, reason: 'window-closed' | 'reloaded'): void {
    for (const [id, entry] of this.browserWebviews) {
      if (entry.label === label) this.browserWebviews.delete(id);
    }
    this.host.abandonWebview(label, reason);
    // 重载后旧页面的 rid 已不可达，文件句柄与 HTTP 正文也必须一起释放。
    const table = this.resources.get(label);
    this.resources.delete(label);
    if (table) {
      for (const resource of table.values()) {
        Promise.resolve(resource.close()).catch((error: unknown) => this.log(`[resources] close failed: ${String(error)}`));
      }
    }
    if (reason === 'window-closed') {
      this.listeners.removeWebview(label);
      for (const key of [...this.channelIndex.keys()]) if (key.startsWith(`${label}:`)) this.channelIndex.delete(key);
    }
  }

  // ------------------------------------------------------------ invoke 分派

  private notFound(plugin: string, command: string, fullCmd: string): string {
    return this.debug ? `${plugin}.${command} not allowed. Command not found` : `Command ${fullCmd} not allowed by ACL`;
  }

  /** `plugin:<name>|<cmd>` 中由 main 实现或明确不提供的插件；其他命令返回 null（转发给 Host）。 */
  private builtinTarget(cmd: string): { plugin: string; command: string; table: BuiltinPlugin } | null {
    if (!cmd.startsWith('plugin:')) return null;
    const tokens = cmd.slice('plugin:'.length).split('|');
    const plugin = tokens[0] ?? '';
    const table = this.plugins.get(plugin) ?? UNPROVIDED_PLUGINS.get(plugin);
    return table ? { plugin, command: tokens[1] ?? '', table } : null;
  }

  /**
   * 执行内置插件命令（不做 ACL 判定：页面调用由 `dispatchInvoke` 先判定，Host 代办的外壳操作等同 Rust 代码直接调用）。
   * 返回 `undefined` 表示该插件不由 main 实现（应转发给 Host）。`ctx.scope` 缺省时按调用方窗口的本地来源解析。
   */
  runBuiltin(cmd: string, input: Omit<InvokeInput, 'command'>, ctx: CommandContext): Promise<unknown> | undefined {
    const target = this.builtinTarget(cmd);
    if (!target) return undefined;
    const { plugin, command, table } = target;
    const handler = Object.hasOwn(table, command) ? table[command] : undefined;
    if (!handler) return Promise.reject(new ShellCommandError(this.notFound(plugin, command, cmd)));
    const source: WindowRef = { window: ctx.windowLabel, webview: ctx.webviewLabel };
    const scoped: CommandContext = ctx.scope
      ? ctx
      : { ...ctx, scope: (other = command) => this.acl.scopeFor(`plugin:${plugin}|${other}`, source) };
    return Promise.resolve().then(() => handler({ ...input, command }, scoped));
  }

  /**
   * `frameUrl` 必须是 main 从 `WebFrameMain` / `WebContents` 读到的可信 URL。
   * `message` 是 renderer 发来的原始值，在这里校验（类型标注沿用 {@link InvokeMessage} 只是调用方的期望）。
   */
  handleInvoke(win: ShellWindow, message: InvokeMessage, frameUrl: string): void {
    this.handleWebviewInvoke(win, win.label, message, frameUrl);
  }

  /**
   * 共享窗口中的独立应用 webview，资源与回复按 webview 隔离；来源仍由可信 URL 判定。
   * capabilityWebviewLabel 仅供可信外壳复用父应用的授权身份，不能取自 renderer 的消息。
   */
  handleWebviewInvoke(win: ShellWindow, webviewLabel: string, message: InvokeMessage, frameUrl: string, capabilityWebviewLabel = webviewLabel): void {
    this.dispatchInvoke(
      win.label,
      webviewLabel,
      frameOrigin(frameUrl, this.localOrigin),
      (replyMessage) => this.sendToWebview(webviewLabel, replyMessage),
      message,
      capabilityWebviewLabel,
    );
  }

  /** `browser-content` 的 invoke：窗口归属 `main`，webview 归属自己的 label，且永远按远程来源处理。 */
  handleBrowserInvoke(contents: WebContents, entry: BrowserWebview, message: InvokeMessage, frameUrl: string): void {
    this.dispatchInvoke(
      entry.windowLabel,
      entry.label,
      // 即使内容页停在本地 URL（about:blank 等），也绝不能继承应用的 local ACL。
      frameOrigin(frameUrl, this.localOrigin) ?? 'null',
      (replyMessage) => {
        if (!contents.isDestroyed()) contents.send(IPC_CHANNEL_TO_RENDERER, replyMessage);
      },
      message,
    );
  }

  private dispatchInvoke(
    windowLabel: string,
    webviewLabel: string,
    origin: string | undefined,
    send: (message: MainToRenderer) => void,
    untrusted: unknown,
    capabilityWebviewLabel = webviewLabel,
  ): void {
    const replyTo = (ids: InvokeReplyIds) => (ok: boolean, value: unknown, json?: string, diagnostic?: { id: string; operation: string }) => {
      send({
        type: 'result',
        callbackId: ok ? ids.callback : ids.error,
        otherId: ok ? ids.error : ids.callback,
        ...(diagnostic ? { diagnostic } : {}),
        // Explicit Host raw-source text is already serialized; never infer it from a number.
        body: json === undefined ? ShellRuntime.encodeBody(value) : { kind: 'json', data: json },
      });
    };
    const checked = checkInvokeMessage(untrusted, origin === undefined ? MAX_LOCAL_INVOKE_PAYLOAD : MAX_REMOTE_INVOKE_PAYLOAD);
    if (!checked.ok) {
      this.log(`[invoke] rejected a malformed message from window "${windowLabel}", webview "${webviewLabel}": ${checked.reason}`);
      if (checked.reply !== null) this.settleSafely(replyTo(checked.reply), `invalid IPC message: ${checked.reason}`);
      return;
    }
    const message = checked.message as InvokeMessage;
    const reply = replyTo(message);
    try {
      this.routeInvoke(windowLabel, webviewLabel, origin, message, reply, capabilityWebviewLabel);
    } catch (error) {
      // 同步阶段的任何意外都只回错误，不让异常进入 ipcMain 监听（那会弹出主进程错误对话框）。
      this.log(`[invoke] ${message.cmd} failed synchronously: ${error instanceof Error ? (error.stack ?? error.message) : describeUnknown(error)}`);
      this.settleSafely(reply, error instanceof Error ? error.message : describeUnknown(error));
    }
  }

  private settleSafely(reply: (ok: boolean, value: unknown) => void, error: string): void {
    try {
      reply(false, error);
    } catch (failure) {
      this.log(`[invoke] could not deliver an error reply: ${failure instanceof Error ? failure.message : describeUnknown(failure)}`);
    }
  }

  private routeInvoke(
    windowLabel: string,
    webviewLabel: string,
    origin: string | undefined,
    message: InvokeMessage,
    reply: (ok: boolean, value: unknown, json?: string, diagnostic?: { id: string; operation: string }) => void,
    capabilityWebviewLabel = webviewLabel,
  ): void {
    let json: unknown = null;
    let raw: Uint8Array | null = null;
    if (message.payload.contentType === 'application/json') {
      try {
        json = JSON.parse(message.payload.data);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        reply(false, `invalid IPC message: payload is not valid JSON: ${error.message}`);
        return;
      }
    } else {
      raw = message.payload.data;
    }
    const source: WindowRef = { window: windowLabel, webview: capabilityWebviewLabel, ...(origin === undefined ? {} : { origin }) };
    const target = this.builtinTarget(message.cmd);
    if (target !== null) {
      const scope = this.acl.authorize(message.cmd, source);
      if (scope === null) {
        reply(false, this.acl.denial(message.cmd, source, this.debug));
        return;
      }
      if (!Object.hasOwn(target.table, target.command)) {
        // ACL 放行、但桌面版没有编译的命令（fs watch、app register_listener 等），tauri-2.11.5 `webview/mod.rs:1905`。
        reply(false, `Command ${target.command} not found`);
        return;
      }
      const ctx: CommandContext = {
        runtime: this,
        windowLabel,
        webviewLabel,
        scope: (other = target.command) => (other === target.command ? scope : this.acl.scopeFor(`plugin:${target.plugin}|${other}`, source)),
      };
      const builtin = this.runBuiltin(message.cmd, { json, raw, headers: message.headers }, ctx) as Promise<unknown>;
      // 与 kernel `_unhandled` 一致：任何意外（含返回值无法编码）都回统一内部错误，前端 Promise 必定 settle。
      // Tauri 内置插件的错误序列化为字符串，所以统一内部错误就是消息字符串。
      const shellError = (value: unknown, error: unknown) => {
        const record = diagnosticRecord({ source: 'electron', operation: message.cmd, window: windowLabel, error });
        this.log('[diagnostic] ' + JSON.stringify(record));
        reply(false, value, undefined, origin === undefined ? { id: record.id, operation: record.operation } : undefined);
      };
      const internalError = (error: unknown) => {
        this.log(`[invoke] ${message.cmd} failed; replying with an internal error: ${error instanceof Error ? (error.stack ?? error.message) : describeUnknown(error)}`);
        shellError(error instanceof Error ? error.message : describeUnknown(error), error);
      };
      builtin.then(
        (value) => {
          try {
            reply(true, value);
          } catch (error) {
            internalError(error);
          }
        },
        (error: unknown) => {
          if (error instanceof ShellCommandError) shellError(error.value, error.value);
          else internalError(error);
        },
      );
      return;
    }
    this.host.invoke(
      {
        cmd: message.cmd, args: raw ?? json, source, headers: message.headers,
        // The Host decodes JSON from its source, before any Number rounding in the legacy projection.
        ...(message.payload.contentType === 'application/json' ? { argsJson: message.payload.data } : {}),
      },
      { webview: webviewLabel, resolve: (result) => {
        if (!result.ok) {
          reply(false, result.error, result.json, origin === undefined && result.diagnosticId
            ? { id: result.diagnosticId, operation: message.cmd } : undefined);
          return;
        }
        reply(true, decodeRawBytes(result.value) ?? result.value, result.json);
      } },
    );
  }
}

/** 非 Error 的抛出值：尽量给出 JSON 形式（`String({..})` 只有 `[object Object]`）。 */
function describeUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // 循环引用、BigInt 等没有 JSON 形式：退回 String()。
    return String(value);
  }
}
