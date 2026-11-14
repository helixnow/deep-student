/**
 * 后台驻留接线集成测试（`background-residency-wiring-host.test.ts`）专用的 Host 替身。
 *
 * - `plugin:host|call` → `agentAutomation.backgroundResidency`：回 RESIDENCY_STATE（JSON）。
 * - `residency_step`：页面回报的步骤（带 `visible`）。
 * 每收到一条就把完整记录写入 RESIDENCY_REPORT；收到 `shutdown` 时记一条再退出。
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

const reportPath = process.env.RESIDENCY_REPORT as string;
const state = JSON.parse(process.env.RESIDENCY_STATE as string) as unknown;
const log: Array<Record<string, unknown>> = [];
const record = (entry: Record<string, unknown>) => {
  log.push({ ...entry, at: Date.now() });
  writeFileSync(reportPath, JSON.stringify({ log }));
};

parentPort.on('message', (event) => {
  if (event.data.kind !== 'connect') return;
  const connected = event.ports[0];
  if (!connected) return;
  connected.on('message', ({ data }) => {
    switch (data.kind) {
      case 'handshake':
        record({ kind: 'handshake', compileCache: process.env.NODE_COMPILE_CACHE ?? null });
        connected.postMessage({ kind: 'ready', protocol: 1 });
        break;
      case 'invoke': {
        const args = (data.args ?? {}) as Record<string, unknown>;
        if (data.cmd === 'plugin:host|call') {
          record({ kind: 'host-call', service: args.service, method: args.method, source: data.source });
          if (args.service === 'agentAutomation' && args.method === 'backgroundResidency') {
            connected.postMessage({ kind: 'result', id: data.id, ok: true, value: state });
          } else {
            connected.postMessage({ kind: 'result', id: data.id, ok: false, error: `unexpected host call ${String(args.service)}.${String(args.method)}` });
          }
          break;
        }
        if (data.cmd === 'residency_step') {
          record({ kind: 'step', step: args.step, visible: args.visible });
          connected.postMessage({ kind: 'result', id: data.id, ok: true, value: null });
          break;
        }
        record({ kind: 'other-invoke', cmd: data.cmd });
        connected.postMessage({ kind: 'result', id: data.id, ok: false, error: `${String(data.cmd)} not allowed. Command not found` });
        break;
      }
      case 'shutdown':
        record({ kind: 'shutdown' });
        process.exit(0);
    }
  });
  connected.start();
});
