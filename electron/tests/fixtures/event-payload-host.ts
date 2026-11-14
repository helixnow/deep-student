/**
 * Host 替身（仅测试使用）：ready 之后依次发出两个 `JSON.stringify` 会抛错的后端事件（循环引用；
 * 类实例经结构化克隆后剩下的含 BigInt 的普通对象），再发一个正常事件 `test://after`。
 */
interface PortLike {
  on(event: 'message', listener: (e: { data: Record<string, unknown> }) => void): void;
  postMessage(message: unknown): void;
  start(): void;
}
const parentPort = (process as unknown as { parentPort: { on(event: 'message', l: (e: { data: { kind?: string }; ports: PortLike[] }) => void): void } }).parentPort;

parentPort.on('message', (e) => {
  if (e.data.kind !== 'connect') return;
  const port = e.ports[0];
  if (!port) return;
  port.on('message', ({ data }) => {
    switch (data.kind) {
      case 'handshake': {
        port.postMessage({ kind: 'ready', protocol: 1 });
        const cyclic: Record<string, unknown> = { a: 1 };
        cyclic.self = cyclic;
        port.postMessage({ kind: 'event', event: 'test://cyclic', payload: cyclic, target: { kind: 'Any' } });
        port.postMessage({ kind: 'event', event: 'test://bigint', payload: { count: 1n }, target: { kind: 'Any' } });
        port.postMessage({ kind: 'event', event: 'test://after', payload: { ok: true }, target: { kind: 'Any' } });
        break;
      }
      case 'invoke':
        port.postMessage({ kind: 'result', id: data.id, ok: false, error: `${String(data.cmd)} not allowed. Command not found` });
        break;
      case 'shutdown':
        process.exit(0);
    }
  });
  port.start();
});
