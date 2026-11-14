/**
 * 页面加载生命周期集成测试专用的 Host 替身（仅测试使用）。
 *
 * 握手后延迟 PAGE_LOAD_READY_DELAY_MS 才回 ready（验证 Host 未 ready 时 main 的缓冲）；按到达顺序记录
 * `window` 生命周期、`abandon` 与 `page_load_step` invoke。`hang` 步骤故意不回复。主页面 `reloaded` 步骤后
 * 经 shell op 创建、重载、销毁 browser-content，再把记录写入 PAGE_LOAD_REPORT。
 */
import { writeFileSync } from 'node:fs';

interface PortLike {
  on(event: 'message', listener: (e: { data: Record<string, unknown> }) => void): void;
  postMessage(message: unknown): void;
  start(): void;
}

const parentPort = (process as unknown as {
  parentPort: { on(event: 'message', listener: (e: { data: { kind?: string }; ports: PortLike[] }) => void): void };
}).parentPort;

const reportPath = process.env.PAGE_LOAD_REPORT as string;
const contentUrl = process.env.PAGE_LOAD_CONTENT_URL as string;
const profileDir = process.env.PAGE_LOAD_PROFILE_DIR as string;
const readyDelay = Number(process.env.PAGE_LOAD_READY_DELAY_MS ?? '0');

const log: Array<Record<string, unknown>> = [];
let readyAt = 0;
let port: PortLike | null = null;
let sequence = 0;
const pending = new Map<string, (result: unknown) => void>();

function callShell(op: string, args: unknown = {}): Promise<unknown> {
  const id = `page-load-op-${++sequence}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    port!.postMessage({ kind: 'shell-request', id, op, args });
  });
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const contentLoads = () =>
  log.filter((entry) => entry.state === 'page-load-started' && (entry.ref as { webview?: string }).webview === 'browser-content').length;

async function browserScenario(): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  results.create = await callShell('browser.createContentWindow', {
    url: contentUrl, title: 'page load probe', width: 400, height: 300, focused: false, profileDir, initializationScript: '',
  });
  await waitFor(() => contentLoads() === 1, 'browser-content initial page load');
  results.reload = await callShell('browser.reload');
  await waitFor(() => contentLoads() === 2, 'browser-content reload page load');
  results.destroy = await callShell('browser.destroyContentWindow');
  // 销毁后不应再收到 browser-content 的页面加载。
  await new Promise((resolve) => setTimeout(resolve, 500));
  return results;
}

parentPort.on('message', (event) => {
  if (event.data.kind !== 'connect') return;
  const connected = event.ports[0];
  if (!connected) return;
  port = connected;
  connected.on('message', ({ data }) => {
    switch (data.kind) {
      case 'handshake':
        setTimeout(() => {
          readyAt = Date.now();
          connected.postMessage({ kind: 'ready', protocol: 1 });
        }, readyDelay);
        break;
      case 'window':
        log.push({ kind: 'window', ref: data.ref, state: data.state });
        break;
      case 'abandon':
        log.push({ kind: 'abandon', id: data.id, reason: data.reason });
        break;
      case 'shell-result': {
        const resolve = pending.get(String(data.id));
        pending.delete(String(data.id));
        resolve?.(data.ok === true ? { ok: true, value: data.value } : { ok: false, error: data.error });
        break;
      }
      case 'invoke': {
        if (data.cmd !== 'page_load_step') {
          connected.postMessage({ kind: 'result', id: data.id, ok: false, error: `${String(data.cmd)} not allowed. Command not found` });
          break;
        }
        const args = data.args as { step: string; at: number };
        log.push({ kind: 'invoke', id: data.id, step: args.step, at: args.at, source: data.source });
        if (args.step === 'hang') break;
        connected.postMessage({ kind: 'result', id: data.id, ok: true, value: null });
        if (args.step === 'reloaded') {
          void browserScenario().then(
            (results) => writeFileSync(reportPath, JSON.stringify({ readyAt, log, results })),
            (error: unknown) => writeFileSync(reportPath, JSON.stringify({ readyAt, log, fatal: String(error) })),
          );
        }
        break;
      }
      case 'shutdown':
        process.exit(0);
    }
  });
  connected.start();
});
