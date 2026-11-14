/**
 * {@link HostTransport} 的 Node / Electron 实现。全部按结构类型描述 Electron 对象，kernel 不依赖 electron 包。
 */
import type { HostTransport } from './connection.ts';
import type { HostToMain } from './protocol.ts';

/** Electron `MessagePortMain` 与 Node `worker_threads.MessagePort` 的公共形状。 */
export interface PortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: unknown) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  start?(): void;
  close(): void;
}

/**
 * MessagePort 传输。`unwrap` 从 'message' 事件中取出数据：Electron `MessagePortMain` 的事件是
 * `{ data, ports }`，Node `MessagePort` 的事件就是数据本身。
 */
export function messagePortTransport(port: PortLike, unwrap: (event: unknown) => unknown = (event) => event): HostTransport {
  let closed = false;
  return {
    send(message: HostToMain) {
      if (!closed) port.postMessage(message);
    },
    onMessage(listener) {
      port.on('message', (event: unknown) => listener(unwrap(event)));
      port.start?.();
    },
    onClose(listener) {
      port.on('close', () => {
        closed = true;
        listener();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      port.close();
    },
  };
}

/** 浏览器 / Web Worker / WebView 的 `MessagePort`（EventTarget 形状）。 */
export interface WebPortLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message' | 'close', listener: (event: unknown) => void): void;
  start(): void;
  close(): void;
}

/**
 * 浏览器 `MessagePort` 传输（移动端 Host 跑在 Web Worker 中）。消息在 `event.data`；
 * `close` 事件只有较新的引擎才会触发，旧引擎上对端断开只能由外壳显式发送 `shutdown`。
 */
export function webMessagePortTransport(port: WebPortLike): HostTransport {
  return messagePortTransport({
    postMessage: message => port.postMessage(message),
    on: (event: 'message' | 'close', listener: (event: unknown) => void) => port.addEventListener(event, listener),
    start: () => port.start(),
    close: () => port.close(),
  }, event => (event as { data?: unknown }).data);
}

/** Electron `utilityProcess` 中的 `process.parentPort`（`Electron.ParentPort`）。 */
export interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown; ports: PortLike[] }) => void): unknown;
  off?(event: 'message', listener: (event: { data: unknown; ports: PortLike[] }) => void): unknown;
}

/**
 * Electron utilityProcess：main 可以
 * - 直接用 `child.postMessage(msg)` 与 Host 通信（parentPort 即传输），或
 * - 先 `child.postMessage({ kind: 'connect' }, [port])` 转移一个 `MessagePortMain`，之后全部消息走该端口。
 *
 * 由 main 发出的第一条消息决定：带端口则采用端口，否则采用 parentPort；第一条消息若本身是协议消息
 * （带 `kind` 且不是 `connect`）则照常投递。parentPort 没有关闭事件，父进程退出时 utilityProcess 随之结束。
 */
export function electronParentPortTransport(parentPort: ParentPortLike): Promise<HostTransport> {
  return new Promise((resolve) => {
    const first = (event: { data: unknown; ports: PortLike[] }) => {
      parentPort.off?.('message', first);
      const port = event.ports?.[0];
      const data = event.data as { kind?: unknown } | null;
      const initial = data && typeof data === 'object' && typeof data.kind === 'string' && data.kind !== 'connect' ? event.data : undefined;
      if (port) {
        const transport = messagePortTransport(port, (e) => (e as { data: unknown }).data);
        resolve(withInitial(transport, initial));
        return;
      }
      let listener: ((message: unknown) => void) | null = null;
      const pending: unknown[] = initial === undefined ? [] : [initial];
      parentPort.on('message', (e) => {
        if (listener) listener(e.data);
        else pending.push(e.data);
      });
      resolve({
        send: (message) => parentPort.postMessage(message),
        onMessage(l) {
          listener = l;
          for (const message of pending.splice(0)) l(message);
        },
        onClose() {
          // parentPort 不会单独关闭；父进程退出时本进程被终止。
        },
        close() {
          // 同上：没有可关闭的对象，退出由 exit 回调完成。
        },
      });
    };
    parentPort.on('message', first);
  });
}

function withInitial(transport: HostTransport, initial: unknown): HostTransport {
  if (initial === undefined) return transport;
  return {
    ...transport,
    onMessage(listener) {
      listener(initial);
      transport.onMessage(listener);
    },
  };
}

/** `child_process.fork(..., { serialization: 'advanced' })` 的 IPC 通道（测试与 headless 运行）。 */
export interface NodeProcessLike {
  send?(message: unknown): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'disconnect', listener: () => void): unknown;
  disconnect?(): void;
  connected?: boolean;
}

export function nodeIpcTransport(proc: NodeProcessLike): HostTransport {
  if (typeof proc.send !== 'function') throw new Error('nodeIpcTransport: process has no IPC channel (not started with child_process.fork)');
  const sendFn = proc.send.bind(proc);
  return {
    send(message: HostToMain) {
      if (proc.connected !== false) sendFn(message);
    },
    onMessage(listener) {
      proc.on('message', listener);
    },
    onClose(listener) {
      proc.on('disconnect', listener);
    },
    close() {
      if (proc.connected) proc.disconnect?.();
    },
  };
}
