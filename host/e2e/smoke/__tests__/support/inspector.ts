/** Minimal V8 inspector (CDP) client for the Host's `--inspect` port, used by the memory diagnostics. */
import { createServer } from 'node:net';

export interface Inspector {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(listener: (method: string, params: Record<string, unknown>) => void): void;
  close(): void;
}

export async function inspector(port: number): Promise<Inspector> {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ webSocketDebuggerUrl: string }>;
  const ws = new WebSocket(targets[0]!.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('inspector socket failed')); });
  let id = 0;
  const pending = new Map<number, (result: unknown) => void>();
  const listeners: Array<(method: string, params: Record<string, unknown>) => void> = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; method?: string; params?: Record<string, unknown> };
    if (msg.id !== undefined) pending.get(msg.id)?.(msg.result);
    else if (msg.method) for (const l of listeners) l(msg.method, msg.params ?? {});
  };
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((resolve) => {
    const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, on: (l) => listeners.push(l), close: () => ws.close() };
}

/** A loopback TCP port that was free a moment ago (other lanes may run diagnostics concurrently). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

/** `process.memoryUsage()` of the inspected process, in MB. */
export async function memoryUsageMB(cdp: Inspector): Promise<Record<string, number>> {
  const usage = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(process.memoryUsage())', returnByValue: true }) as { result: { value: string } };
  return Object.fromEntries(Object.entries(JSON.parse(usage.result.value) as Record<string, number>).map(([k, v]) => [k, Math.round(v / 1024 / 1024)]));
}
