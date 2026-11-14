/**
 * 页面主世界中的 Tauri 内部接口（`window.__TAURI_INTERNALS__` 与 `__TAURI_EVENT_PLUGIN_INTERNALS__`）。
 *
 * 逐段对应 Tauri 注入页面的初始化脚本（tauri-2.11.5）：
 * - `src/manager/webview.rs` `prepare_pending_webview`：`isTauri`、`__TAURI_INTERNALS__ = { plugins: {} }`、`metadata`；
 * - `scripts/core.js`：`convertFileSrc`、`transformCallback`/`unregisterCallback`/`runCallback`/`callbacks`、`invoke`；
 * - `scripts/process-ipc-message-fn.js`：载荷序列化（Map、Uint8Array、ArrayBuffer、`__TAURI_TO_IPC_KEY__`）；
 * - `scripts/ipc.js` + `ipc-protocol.js`：`ipc` / `postMessage`（此处的传输是 Electron IPC 而不是 `ipc://` 协议）；
 * - `src/event/mod.rs` `event_initialization_script` / `listen_js_script` / `unlisten_js_script`；
 * - `src/event/init.js`、`src/path/init.js`。
 *
 * **本函数会被 `contextBridge.executeInMainWorld` 序列化后在页面主世界执行**，因此必须自包含：
 * 不得引用模块作用域中的任何标识符（类型除外），只能用参数与内置对象。
 */
import type { BridgeInit, IpcPayload, MainToRenderer, RendererToMain, ResponseBody } from '../shell/bridge-messages.ts';

export interface BridgeTransport {
  send(message: RendererToMain): void;
  subscribe(listener: (message: MainToRenderer) => void): void;
}

export function installTauriBridge(transport: BridgeTransport, init: BridgeInit, target?: object): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w: any = target ?? globalThis;
  const SERIALIZE_TO_IPC_FN = '__TAURI_TO_IPC_KEY__';

  // ---- prepare_pending_webview：isTauri 与 __TAURI_INTERNALS__ 根对象
  Object.defineProperty(w, 'isTauri', { value: true });
  if (!w.__TAURI_INTERNALS__) {
    Object.defineProperty(w, '__TAURI_INTERNALS__', { value: { plugins: {} } });
  }
  const internals = w.__TAURI_INTERNALS__;

  // ---- core.js
  function uid(): number {
    return (w.crypto.getRandomValues(new Uint32Array(1)) as Uint32Array)[0] as number;
  }
  const osName = init.osName;
  const protocolScheme = init.protocolScheme;

  Object.defineProperty(internals, 'convertFileSrc', {
    value: function (filePath: string, protocol = 'asset') {
      const path = encodeURIComponent(filePath);
      return osName === 'windows' || osName === 'android' ? `${protocolScheme}://${protocol}.localhost/${path}` : `${protocol}://localhost/${path}`;
    },
  });

  const callbacks = new Map<number, (data: unknown) => unknown>();
  function registerCallback(callback: ((data: unknown) => unknown) | undefined, once: boolean): number {
    const identifier = uid();
    callbacks.set(identifier, (data: unknown) => {
      if (once) unregisterCallback(identifier);
      return callback && callback(data);
    });
    return identifier;
  }
  function unregisterCallback(id: number): void {
    callbacks.delete(id);
  }
  function runCallback(id: number, data: unknown): void {
    const callback = callbacks.get(id);
    if (callback) {
      callback(data);
    } else {
      // boundary-allow console-log: 沙箱 preload 无 Host logger，保留上游 Tauri 桥的告警文案。
      console.warn(
        `[TAURI] Couldn't find callback id ${id}. This might happen when the app is reloaded while Rust is running an asynchronous operation.`,
      );
    }
  }
  Object.defineProperty(internals, 'transformCallback', { value: registerCallback });
  Object.defineProperty(internals, 'unregisterCallback', { value: unregisterCallback });
  Object.defineProperty(internals, 'runCallback', { value: runCallback });
  Object.defineProperty(internals, 'callbacks', { value: callbacks });

  // ---- process-ipc-message-fn.js
  function processIpcMessage(message: unknown): IpcPayload {
    if (message instanceof ArrayBuffer || ArrayBuffer.isView(message) || Array.isArray(message)) {
      let bytes: Uint8Array;
      if (message instanceof ArrayBuffer) bytes = new Uint8Array(message.slice(0));
      else if (ArrayBuffer.isView(message)) bytes = new Uint8Array(message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength));
      else bytes = Uint8Array.from(message as number[]);
      return { contentType: 'application/octet-stream', data: bytes };
    }
    const data = JSON.stringify(message, (_k, val) => {
      if (val instanceof Map) return Object.fromEntries(val.entries());
      if (val instanceof Uint8Array) return Array.from(val);
      if (val instanceof ArrayBuffer) return Array.from(new Uint8Array(val));
      if (typeof val === 'object' && val !== null && SERIALIZE_TO_IPC_FN in val) return val[SERIALIZE_TO_IPC_FN]();
      return val;
    });
    return { contentType: 'application/json', data: data === undefined ? 'null' : data };
  }

  function headersToObject(options: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    const raw = options && typeof options === 'object' ? (options as { headers?: unknown }).headers : undefined;
    if (!raw) return out;
    const headers = new w.Headers(raw) as { forEach(cb: (value: string, key: string) => void): void };
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }

  // ---- ipc.js（brownfield）+ ipc-protocol.js 的 postMessage
  function sendIpcMessage(message: { cmd: string; callback: number; error: number; payload: unknown; options?: unknown }): void {
    transport.send({
      type: 'invoke',
      cmd: message.cmd,
      callback: message.callback,
      error: message.error,
      payload: processIpcMessage(message.payload),
      headers: headersToObject(message.options),
    });
  }
  Object.defineProperty(internals, 'postMessage', { value: sendIpcMessage });
  Object.defineProperty(internals, 'ipc', { value: Object.freeze((message: Parameters<typeof sendIpcMessage>[0]) => sendIpcMessage(message)) });

  Object.defineProperty(internals, 'invoke', {
    value: function (cmd: string, payload: unknown = {}, options?: unknown) {
      return new Promise(function (resolve, reject) {
        const callback = registerCallback((r) => {
          resolve(r);
          unregisterCallback(error);
        }, true);
        const error = registerCallback((e) => {
          reject(e);
          unregisterCallback(callback);
        }, true);
        internals.ipc({ cmd, callback, error, payload, options });
      });
    },
  });

  // ---- metadata
  Object.defineProperty(internals, 'metadata', {
    value: {
      currentWindow: { label: init.windowLabel },
      currentWebview: { label: init.webviewLabel },
    },
  });

  // ---- path/init.js
  Object.defineProperty(internals.plugins, 'path', { value: { sep: init.sep, delimiter: init.delimiter } });

  // ---- 事件：event_initialization_script / listen_js_script / unlisten_js_script
  const listenersObject: Record<string, Record<string, { target: unknown; handlerId: number }>> = Object.create(null);
  function emitToListeners(eventData: { event: string; payload: unknown; id?: number }, ids: number[]): void {
    const listeners = listenersObject[eventData.event] || {};
    for (const id of ids) {
      const listener = listeners[id];
      if (listener) {
        eventData.id = id;
        runCallback(listener.handlerId, eventData);
      }
    }
  }
  Object.defineProperty(w, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
    value: {
      unregisterListener: (event: string, eventId: number) => {
        const listeners = listenersObject[event];
        if (listeners) {
          const listener = listeners[eventId];
          if (listener) unregisterCallback(listener.handlerId);
        }
      },
    },
  });

  function decodeBody(body: ResponseBody): unknown {
    if (body.kind === 'raw') {
      const bytes = body.data;
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    return JSON.parse(body.data);
  }

  transport.subscribe((message) => {
    switch (message.type) {
      case 'result': {
        const value = decodeBody(message.body);
        runCallback(message.callbackId, value);
        if (message.diagnostic && message.diagnostic.operation !== 'report_frontend_log') {
          const summary = typeof value === 'string' ? value : (value as { message?: unknown } | null)?.message;
          // boundary-allow empty-catch: diagnostic IPC log reporting must never recursively fail
          void internals.invoke('report_frontend_log', { payload: {
            level: 'ERROR', kind: 'IPC_FAILURE', message: typeof summary === 'string' ? summary.slice(0, 4000) : 'IPC failed',
            extra: { diagnosticId: message.diagnostic.id, operation: message.diagnostic.operation },
          } }).catch(() => undefined);
        }
        break;
      }
      case 'callback':
        runCallback(message.id, decodeBody(message.body));
        break;
      case 'channel':
        runCallback(
          message.id,
          message.body === undefined ? { end: true, index: message.index } : { message: decodeBody(message.body), index: message.index },
        );
        break;
      case 'listen-js': {
        let eventListeners = listenersObject[message.event];
        if (eventListeners === undefined) {
          eventListeners = Object.create(null) as Record<string, { target: unknown; handlerId: number }>;
          listenersObject[message.event] = eventListeners;
        }
        Object.defineProperty(eventListeners, String(message.eventId), {
          value: { target: message.target, handlerId: message.handlerId },
          configurable: true,
          enumerable: true,
        });
        break;
      }
      case 'emit-js':
        emitToListeners({ event: message.event, payload: JSON.parse(message.payload) }, message.ids);
        break;
    }
  });
}
