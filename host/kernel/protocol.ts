/**
 * 冻结边界 ①：Electron（main / preload）与 Desktop Host 之间的消息协议。
 *
 * 拓扑：renderer ⇄(contextBridge)⇄ preload ⇄(ipcRenderer)⇄ main ⇄(MessagePort)⇄ Host(utilityProcess)
 *
 * - preload 只负责把 `window.__TAURI_INTERNALS__` 的调用翻译成本协议，不含业务。
 * - main 只做转发、窗口路由与 Tauri 事件目标（target）的扇出，不含业务。
 * - Host 内的业务插件永远看不到 Electron 对象；窗口信息以 {@link WindowRef} 传入。
 *
 * 修改本文件 = 修改 G0 冻结契约，必须走 contracts/CHANGES.md 变更单。
 */

/** 协议版本。任何不兼容修改都要递增，Host 与 main 握手时校验。 */
export const HOST_PROTOCOL_VERSION = 1 as const;

/** 与 Tauri 的 window/webview label 一一对应。 */
export interface WindowRef {
  /** Tauri window label（如 "main"）。 */
  window: string;
  /** Tauri webview label；单 webview 窗口与 window 相同。 */
  webview: string;
  /** Main-authenticated IPC origin. Omitted for local app pages; remote pages carry their URL. */
  origin?: string;
  /**
   * 只出现在 Host 监听者收到的前端事件 `source` 上：该事件是 main 自己产生的原生回调（{@link FrontendEvent.native}），
   * 不是页面发出的。kernel 只按消息级的 `native` 设置它，`source` 里自带的同名字段会被丢弃（SEC-E05）。
   */
  native?: true;
}

/**
 * Tauri 事件目标，语义对齐 `tauri::EventTarget` 的 JSON 形状
 * （`{ kind: 'Any' } | { kind: 'Window', label } | ...`）。
 */
export type EventTarget =
  | { kind: 'Any' }
  | { kind: 'AnyLabel'; label: string }
  | { kind: 'App' }
  | { kind: 'Window'; label: string }
  | { kind: 'Webview'; label: string }
  | { kind: 'WebviewWindow'; label: string };

// ---------------------------------------------------------------- main → Host

/** 前端 `invoke(cmd, args)`。`plugin:<name>|<cmd>` 形式的 Tauri 插件命令也走这里。 */
export interface InvokeRequest {
  kind: 'invoke';
  /** main 分配的唯一 id，用于配对响应与取消。 */
  id: string;
  cmd: string;
  /** 前端传入的原始参数对象（Tauri 默认 camelCase 键）。原样转发，不做改写。 */
  args: unknown;
  /** JSON body source, when available. Authoritative over args for JSON invokes;
   * omit for raw bytes. Host parses without rounding before contract decoding. */
  argsJson?: string;
  /** 调用来源窗口，对应 Rust 命令中注入的 Window / WebviewWindow。 */
  source: WindowRef;
  /**
   * （增补，可选）main 转发的原始 IPC 请求头。Rust 命令注入 `tauri::ipc::Request`
   * 时可读取；普通命令忽略。旧版 main 不发送该字段时视为没有请求头。
   */
  headers?: Record<string, string>;
}

/**
 * 调用方已经不再等待（窗口关闭、页面重载）时发出。
 * Tauri 本身没有前端取消 invoke 的 API；Host 收到后只中止 `CallContext.signal`，
 * 是否真正停止由命令实现按原 Rust 语义决定（Rust 中 future 不会因页面关闭被 drop
 * 的命令，迁移后也不得因此停止）。
 */
export interface InvokeAbandon {
  kind: 'abandon';
  id: string;
  reason: 'window-closed' | 'reloaded';
}

/** 前端 `emit(event, payload)` / `emitTo(...)` 发往后端（Rust 侧 `app.listen(...)`）。 */
export interface FrontendEvent {
  kind: 'frontend-event';
  event: string;
  payload: unknown;
  target: EventTarget;
  source: WindowRef;
  /**
   * main 自己产生的原生回调（browser-content 的页面加载、标题变化、导航被拦，`electron/shell/browser-content-events.ts`）
   * 才带 `true`；页面经 `plugin:event|emit` 转来的事件从不带。Host 以监听者 `source.native` 的形式交给插件（SEC-E05）。
   * 旧版 main 不发送该字段。
   */
  native?: true;
}

/**
 * 窗口生命周期，供需要感知窗口的后端逻辑使用（对应 Rust 的 WindowEvent 监听）。
 *
 * （增补）`page-load-started` 对应 Rust `Builder::on_page_load` 的 `PageLoadEvent::Started`
 * （`src-tauri/src/lib.rs:487-491`）：某个 webview 的主框架开始加载新文档（首次加载、刷新、跨文档导航）。
 * 该 webview 由 `ref.webview` 标识；同文档导航、子框架、focus/close-requested 与 invoke 都不是页面加载。
 * 旧版 main 不发送该状态。
 */
export interface WindowLifecycle {
  kind: 'window';
  ref: WindowRef;
  state: 'created' | 'focused' | 'blurred' | 'close-requested' | 'destroyed' | 'page-load-started';
}

export interface Handshake {
  kind: 'handshake';
  protocol: typeof HOST_PROTOCOL_VERSION;
  /** 应用数据根目录；必须与 Tauri 版 `app_data_dir()` 解析结果一致（老用户数据原地复用）。 */
  appDataDir: string;
  appVersion: string;
  platform: 'darwin' | 'win32' | 'linux';
  /** 对应 Tauri `cfg!(debug_assertions)`。 */
  debug: boolean;
  /**
   * （增补，可选）要加载的 profile 文件绝对路径，优先于 Host 进程参数 `--profile=<path>`。
   * 两者都没有时 Host 只装 kernel 服务，不加载任何插件。格式见 host/kernel/API.md。
   */
  profile?: string;
}

/**
 * 自定义协议请求（pdfstream / filestream / bilistream 等）。main 的 `protocol.handle`
 * 把请求转给 Host，由业务插件通过 `ctx.protocols.register(scheme, handler)` 处理。
 * Range 等语义由处理方按原 Rust 实现负责，main 不解析。
 */
export interface ProtocolRequest {
  kind: 'protocol';
  id: string;
  scheme: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export type MainToHost = Handshake | InvokeRequest | InvokeAbandon | FrontendEvent | WindowLifecycle | ProtocolRequest;

// ---------------------------------------------------------------- Host → main

/**
 * invoke 结果。
 * - `ok: true`：`value` 为 Rust `Ok(T)` 的 serde 序列化值（`()` → `null`）；契约为 `x-binary` 时
 *   为 `Uint8Array`/`ArrayBuffer`（Rust `tauri::ipc::Response`），由传输层的 structured clone 原样搬运；
 *   纯 JSON 传输上也可以是 `{ "__dstuRawBytes": "<base64>" }` 信封，由 main 解码后再回写字节。
 * - `ok: false`：`error` 为前端 Promise reject 的值，必须与 Tauri 版逐字节一致：
 *   命令返回 `Err(E)` 时为 E 的 serde 序列化值；未知命令、参数反序列化失败等
 *   框架错误为 Tauri 生成的原始字符串（由 kernel 统一产生，见 contract.ts）。
 */
export type InvokeResponse =
  | { kind: 'result'; id: string; ok: true; value: unknown; json?: string }
  | { kind: 'result'; id: string; ok: false; error: unknown; json?: string };

// `json` is present when the original non-binary value contains a bigint or native
// JSON.rawJSON atom (including root values). value/error === JSON.parse(json). Main must forward this
// text as its existing JSON response body without parsing/stringifying again.

/** 后端发往前端的事件（Rust `emit` / `emit_to` / `emit_filter`）。 */
export interface BackendEvent {
  kind: 'event';
  event: string;
  payload: unknown;
  /** Same source-preserving contract as InvokeResponse.json; absent for ordinary payloads. */
  payloadJson?: string;
  target: EventTarget;
}

/** Host 需要 main 代办的平台操作（窗口、对话框等只能在 main 完成的事情）。 */
export interface ShellRequest {
  kind: 'shell-request';
  id: string;
  op: string;
  args: unknown;
}

export interface HostReady {
  kind: 'ready';
  protocol: typeof HOST_PROTOCOL_VERSION;
}

export interface HostFatal {
  kind: 'fatal';
  message: string;
  stack?: string;
}

/** {@link ProtocolRequest} 的响应。大文件分块发送：先发头（`final: false`），再发若干 `protocol-chunk`，最后一块 `final: true`。 */
export interface ProtocolResponse {
  kind: 'protocol-result';
  id: string;
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  final: boolean;
}

export interface ProtocolChunk {
  kind: 'protocol-chunk';
  id: string;
  body: Uint8Array;
  final: boolean;
  /**
   * （增补，可选）只出现在 `final: true` 的块上：处理方产出响应体时抛错，响应体不完整。
   * main 收到后应以错误中止该响应流，而不是把截断的内容当作完整响应。
   */
  error?: string;
}

export type HostToMain = InvokeResponse | BackendEvent | ShellRequest | HostReady | HostFatal | ProtocolResponse | ProtocolChunk;

/** main 显式提供的结构化错误数据；独立于用于显示的 error 字符串。 */
export interface ShellErrorData {
  code: string;
  message: string;
  details?: unknown;
}

/** main 对 {@link ShellRequest} 的回复。 */
export type ShellResponse =
  | { kind: 'shell-result'; id: string; ok: true; value: unknown }
  | { kind: 'shell-result'; id: string; ok: false; error: string; errorData?: ShellErrorData };

// ---------------------------------------------------------------- 增补（G0 后新增，均为可选能力）

/**
 * （增补）main 请求 Host 有序退出：拒绝新调用 → 中止进行中的调用并等待 → 按加载逆序卸载插件，
 * 然后 Host 进程以退出码 0 结束。连接断开（端口关闭 / 父进程断开）按同样流程处理。
 */
export interface ShutdownRequest {
  kind: 'shutdown';
}

/** Host 接收的全部消息：{@link MainToHost} 加上 shell 回复与退出请求。 */
export type MainToHostMessage = MainToHost | ShellResponse | ShutdownRequest;
