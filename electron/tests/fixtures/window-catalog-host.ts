/** Real F2 Host service + HostSupervisor/main protocol, without unrelated profile/storage plugins. */
import { writeFileSync } from 'node:fs';
import { createTestHost } from '../../../host/kernel/testing.ts';
import shell from '../../index.ts';

interface PortLike {
  on(event: 'message', listener: (event: { data: Record<string, unknown> }) => void): void;
  postMessage(message: unknown): void;
  start(): void;
}
const parentPort = (process as unknown as {
  parentPort: { on(event: 'message', listener: (event: { data: { kind?: string }; ports: PortLike[] }) => void): void };
}).parentPort;
let port: PortLike;
let sequence = 0;
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

function callShell(op: string, args: unknown = {}): Promise<unknown> {
  const id = `catalog-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`shell request timed out: ${op}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    port.postMessage({ kind: 'shell-request', id, op, args });
  });
}

async function run(): Promise<void> {
  // Intentionally no host/window event replay: this service starts after main is already open.
  const host = await createTestHost({ plugins: [shell], shell: callShell });
  const report: Record<string, unknown> = {};
  try {
    await callShell('plugin:window|hide', { label: 'main' });
    report.initial = await host.ctx.shellWindows.listWindows();
    report.main = await host.ctx.shellWindows.getMainWindow();
    report.mainFocused = await callShell('plugin:window|is_focused', { label: 'main' });
    await callShell('plugin:window|create', { options: { label: 'fallback', visible: false, focus: false } });
    report.withFallback = await host.ctx.shellWindows.listWindows();
    await callShell('plugin:window|destroy', { label: 'main' });
    report.afterMainDestroyed = await host.ctx.shellWindows.listWindows();
    report.mainAfterDestroyed = await host.ctx.shellWindows.getMainWindow();
    // The goal resolver's main ?? arbitrary-live-window policy, not a change to getMainWindow semantics.
    report.selectedFallback = (await host.ctx.shellWindows.getMainWindow()) ?? (await host.ctx.shellWindows.listWindows())[0] ?? null;
  } finally { await host.dispose(); }
  writeFileSync(process.env.WINDOW_CATALOG_REPORT!, JSON.stringify(report));
}

parentPort.on('message', (event) => {
  if (event.data.kind !== 'connect' || !event.ports[0]) return;
  port = event.ports[0];
  port.on('message', ({ data }) => {
    if (data.kind === 'handshake') {
      port.postMessage({ kind: 'ready', protocol: 1 });
      void run().catch((error: unknown) => writeFileSync(process.env.WINDOW_CATALOG_REPORT!, JSON.stringify({ error: String(error) })));
    } else if (data.kind === 'shell-result') {
      const entry = pending.get(String(data.id));
      if (!entry) return;
      pending.delete(String(data.id));
      clearTimeout(entry.timer);
      if (data.ok === true) entry.resolve(data.value);
      else entry.reject(new Error(String(data.error)));
    }
  });
  port.start();
});
