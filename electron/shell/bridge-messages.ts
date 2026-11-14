/**
 * preload ⇄ main 的内部消息（renderer 侧 Tauri 兼容桥与 main 之间）。只在 electron/ 内部使用。
 */
import type { EventTarget } from '../../host/kernel/protocol.ts';

export const IPC_CHANNEL_TO_MAIN = 'dstu-shell:to-main';
export const IPC_CHANNEL_TO_RENDERER = 'dstu-shell:to-renderer';
export const IPC_CHANNEL_INIT = 'dstu-shell:init';

/** 与 Tauri `process-ipc-message-fn.js` 输出一致的载荷。 */
export type IpcPayload =
  | { contentType: 'application/json'; data: string }
  | { contentType: 'application/octet-stream'; data: Uint8Array };

export interface InvokeMessage {
  type: 'invoke';
  cmd: string;
  callback: number;
  error: number;
  payload: IpcPayload;
  /** `invoke(cmd, args, { headers })` 的请求头（已转为小写键的普通对象）。 */
  headers: Record<string, string>;
}

/** preload 捕获的外部文件拖放（Tauri `DragDropEvent`）。坐标为物理像素。 */
export interface DragDropMessage {
  type: 'drag-drop';
  phase: 'enter' | 'over' | 'drop' | 'leave';
  paths?: string[];
  position?: { x: number; y: number };
}

/** `start_dragging` 模拟拖动时页面上松开鼠标。 */
export interface DragEndMessage {
  type: 'window-drag-end';
}

/** preload 执行 `initializationScript` 失败（浏览器 content 的桥注入）。 */
export interface ScriptErrorMessage {
  type: 'script-error';
  message: string;
}

export type RendererToMain = InvokeMessage | DragDropMessage | DragEndMessage | ScriptErrorMessage;

// ---------------------------------------------------------------- renderer 消息的运行时校验
//
// 消息来自页面可控的主世界（`__TAURI_INTERNALS__.ipc` / `postMessage` 接受任意 cmd、回调 id，页面也能替换
// `JSON.stringify`、`Headers`），main 不能信任它的形状。

export const MAX_INVOKE_CMD_LENGTH = 1024;
/** 请求头总长（键 + 值，UTF-16 码元）。请求头只承载路径与选项（如 fs `write_file` 的 `path`、`options`）。 */
export const MAX_INVOKE_HEADERS_LENGTH = 1024 * 1024;
/**
 * 本地应用页面的载荷上限（JSON 按 UTF-16 码元、二进制按字节）。依据：Host 接受的单文件上限是 200 MiB
 * （vfs-repos `MAX_FILE_BYTES`、vfs `dstu-create` `MAX_FILE_SIZE`），`vfs_upload_attachment` 以 base64 JSON
 * 传送时约 266.7 MiB；二进制载荷（fs `write_file` 保存导出文件、`staged_upload_chunk` 的 4 MiB 分块）不超过 200 MiB。
 * 320 MiB 在最大正常载荷上留约 20% 余量，且低于 V8 字符串长度上限，对 JSON 仍然有效。
 */
export const MAX_LOCAL_INVOKE_PAYLOAD = 320 * 1024 * 1024;
/**
 * 远程页面（browser-content 等）的载荷上限。依据：capability 只授予远程页面 `browser_content_user_input`，
 * 其参数是 `{ sessionId, nonce, kind }`（host/plugins/browser/src/browser-bridge.js），不足 1 KiB。
 */
export const MAX_REMOTE_INVOKE_PAYLOAD = 1024 * 1024;
export const MAX_DRAG_DROP_PATHS = 10_000;
export const MAX_SCRIPT_ERROR_LENGTH = 64 * 1024;

/** 可以回复错误时的回调 id；为 null 表示消息连回调都无法确定，只能丢弃。 */
export interface InvokeReplyIds {
  callback: number;
  error: number;
}

export type RendererMessageCheck =
  | { ok: true; message: RendererToMain }
  | { ok: false; reason: string; reply: InvokeReplyIds | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** preload 的 `transformCallback` 用 `crypto.getRandomValues(new Uint32Array(1))` 生成 id。 */
function isCallbackId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 校验 invoke 消息并复制成干净的对象；`payloadLimit` 见 {@link MAX_LOCAL_INVOKE_PAYLOAD} / {@link MAX_REMOTE_INVOKE_PAYLOAD}。 */
export function checkInvokeMessage(value: unknown, payloadLimit: number): RendererMessageCheck {
  if (!isRecord(value)) return { ok: false, reason: 'message must be an object', reply: null };
  const reply = isCallbackId(value.callback) && isCallbackId(value.error) ? { callback: value.callback, error: value.error } : null;
  const fail = (reason: string): RendererMessageCheck => ({ ok: false, reason, reply });
  if (value.type !== 'invoke') return fail('type must be "invoke"');
  if (reply === null) return fail('callback and error must be u32 callback ids');
  const cmd = value.cmd;
  if (typeof cmd !== 'string' || cmd === '') return fail('cmd must be a non-empty string');
  if (cmd.length > MAX_INVOKE_CMD_LENGTH) return fail(`cmd is longer than ${MAX_INVOKE_CMD_LENGTH} characters`);
  const payload = value.payload;
  if (!isRecord(payload)) return fail('payload must be an object');
  let copy: IpcPayload;
  let size: number;
  if (payload.contentType === 'application/json') {
    if (typeof payload.data !== 'string') return fail('application/json payload data must be a string');
    copy = { contentType: 'application/json', data: payload.data };
    size = payload.data.length;
  } else if (payload.contentType === 'application/octet-stream') {
    if (!(payload.data instanceof Uint8Array)) return fail('application/octet-stream payload data must be a Uint8Array');
    copy = { contentType: 'application/octet-stream', data: payload.data };
    size = payload.data.byteLength;
  } else {
    return fail('payload contentType must be application/json or application/octet-stream');
  }
  if (size > payloadLimit) return fail(`payload size ${size} exceeds the limit of ${payloadLimit}`);
  if (!isRecord(value.headers)) return fail('headers must be an object');
  const headers: Record<string, string> = {};
  let headersLength = 0;
  for (const [key, header] of Object.entries(value.headers)) {
    if (typeof header !== 'string') return fail(`header ${JSON.stringify(key.slice(0, 64))} must be a string`);
    headersLength += key.length + header.length;
    if (headersLength > MAX_INVOKE_HEADERS_LENGTH) return fail(`headers are longer than ${MAX_INVOKE_HEADERS_LENGTH} characters`);
    headers[key] = header;
  }
  return { ok: true, message: { type: 'invoke', cmd, callback: reply.callback, error: reply.error, payload: copy, headers } };
}

function checkDragDrop(value: Record<string, unknown>): RendererMessageCheck {
  const fail = (reason: string): RendererMessageCheck => ({ ok: false, reason, reply: null });
  const phase = value.phase;
  if (phase !== 'enter' && phase !== 'over' && phase !== 'drop' && phase !== 'leave') return fail('drag-drop phase is invalid');
  const message: DragDropMessage = { type: 'drag-drop', phase };
  if (value.paths !== undefined) {
    const paths = value.paths;
    if (!Array.isArray(paths) || paths.length > MAX_DRAG_DROP_PATHS) return fail('drag-drop paths must be an array of strings');
    if (!paths.every((path): path is string => typeof path === 'string' && path !== '' && !path.includes('\0'))) {
      return fail('drag-drop paths must be non-empty strings');
    }
    message.paths = [...paths];
  }
  if (value.position !== undefined) {
    const position = value.position;
    if (!isRecord(position) || !isFiniteNumber(position.x) || !isFiniteNumber(position.y)) return fail('drag-drop position must be {x, y} numbers');
    message.position = { x: position.x, y: position.y };
  }
  return { ok: true, message };
}

/** main 入口（`IPC_CHANNEL_TO_MAIN`）的整体校验：按 `type` 分派，未知类型拒绝。 */
export function checkRendererMessage(value: unknown, payloadLimit: number): RendererMessageCheck {
  if (!isRecord(value)) return { ok: false, reason: 'message must be an object', reply: null };
  switch (value.type) {
    case 'invoke':
      return checkInvokeMessage(value, payloadLimit);
    case 'drag-drop':
      return checkDragDrop(value);
    case 'window-drag-end':
      return { ok: true, message: { type: 'window-drag-end' } };
    case 'script-error':
      return typeof value.message === 'string'
        ? { ok: true, message: { type: 'script-error', message: value.message.slice(0, MAX_SCRIPT_ERROR_LENGTH) } }
        : { ok: false, reason: 'script-error message must be a string', reply: null };
    default:
      return { ok: false, reason: 'unknown message type', reply: null };
  }
}

export type ResponseBody = { kind: 'json'; data: string } | { kind: 'raw'; data: Uint8Array };

export interface InvokeResultMessage {
  type: 'result';
  /** 要执行的回调 id（成功为 callback，失败为 error），另一个回调随之注销。 */
  callbackId: number;
  otherId: number;
  diagnostic?: { id: string; operation: string };
  body: ResponseBody;
}

/** 对应 Rust `listen_js_script` 在页面中登记监听。 */
export interface ListenJsMessage {
  type: 'listen-js';
  event: string;
  eventId: number;
  target: EventTarget;
  handlerId: number;
}

/** 对应 Rust `emit_js_script`。payload 为已序列化的 JSON 文本。 */
export interface EmitJsMessage {
  type: 'emit-js';
  event: string;
  payload: string;
  ids: number[];
}

/** 对应 Rust `Channel::send` / 直接 `runCallback`。data 为 JSON 文本或原始字节。 */
export interface CallbackMessage {
  type: 'callback';
  id: number;
  body: ResponseBody;
}

/** 对应 Rust `Channel::send`（`{ message, index }`）与 drop 时的 `{ end: true, index }`。 */
export interface ChannelMessage {
  type: 'channel';
  id: number;
  index: number;
  /** 缺省表示通道结束。 */
  body?: ResponseBody;
}

/** main 开始模拟窗口拖动（`start_dragging`），preload 需在松开鼠标时回报 {@link DragEndMessage}。 */
export interface WindowDragStartMessage {
  type: 'window-drag-start';
}

export type MainToRenderer = InvokeResultMessage | ListenJsMessage | EmitJsMessage | CallbackMessage | ChannelMessage | WindowDragStartMessage;

export interface BridgeInit {
  /**
   * Tauri 注入脚本的 `__TEMPLATE_os_name__`（`std::env::consts::OS`）。Deep Student 也构建 Android / iOS，移动端外壳传真实平台；
   * `convertFileSrc` 在 `windows` 与 `android` 上用 `<scheme>://<protocol>.localhost/`（tauri-2.11.5 `scripts/core.js:16`）。
   */
  osName: 'macos' | 'windows' | 'linux' | 'android' | 'ios';
  windowLabel: string;
  webviewLabel: string;
  /** asset 等协议 URL 在 Windows 上的 http/https 前缀（Tauri `use_https_scheme`，默认 http）。 */
  protocolScheme: 'http' | 'https';
  sep: string;
  delimiter: string;
  /** 是否接管外部文件拖放（窗口配置 `dragDropEnabled`）。 */
  dragDropEnabled: boolean;
  /** content Webview 的初始化脚本（Tauri `initialization_script`），由 preload 在页面脚本前执行。 */
  initializationScript?: string;
}
