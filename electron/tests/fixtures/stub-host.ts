/**
 * 冒烟测试专用的最小 Host 替身（仅测试使用）：按 host/kernel/protocol.ts 应答握手、
 * 对未知命令返回 Tauri 调试版 ACL 文案、把 `smoke_report` 的参数写入 SMOKE_REPORT 文件、
 * 收到前端事件 `smoke://ping` 时回发后端事件 `smoke://pong`。
 *
 * `ds-plugin` 集成测试额外使用：`plugin:ui|manifest` 返回 `SMOKE_UI_MANIFEST`；
 * `smoke_ui_manifest_update` 回发 `host://ui-manifest` 事件。
 */
import { writeFileSync } from 'node:fs';

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
      case 'handshake':
        if (process.env.SMOKE_HANDSHAKE_REPORT !== undefined) {
          writeFileSync(process.env.SMOKE_HANDSHAKE_REPORT, JSON.stringify({
            ...data,
            safeModeEnv: process.env.DS_SAFE_MODE ?? null,
            argv: process.argv,
          }));
        }
        port.postMessage({ kind: 'ready', protocol: 1 });
        if (process.env.SMOKE_STARTUP_READY === '1') {
          // dstu.shell startupGate 的等价信号：只在 Host 私有端口上，main 不得从渲染进程接受它。
          port.postMessage({ kind: 'shell-request', id: 'startup-ready-1', op: 'app.startupReady', args: {} });
        }
        break;
      case 'invoke':
        if (data.cmd === 'smoke_report') {
          writeFileSync(process.env.SMOKE_REPORT as string, JSON.stringify(data.args));
          if (process.env.SMOKE_META_REPORT !== undefined) {
            writeFileSync(process.env.SMOKE_META_REPORT, JSON.stringify({
              source: data.source,
              headers: data.headers,
              argv: process.argv,
            }));
          }
          port.postMessage({ kind: 'result', id: data.id, ok: true, value: null });
        } else if (data.cmd === 'plugin:ui|manifest') {
          const manifest = JSON.parse(process.env.SMOKE_UI_MANIFEST ?? '[]') as unknown;
          port.postMessage({ kind: 'result', id: data.id, ok: true, value: manifest });
        } else if (data.cmd === 'smoke_ui_manifest_update') {
          const args = (data.args ?? {}) as { manifest?: unknown };
          // ds-plugin 集成测试：与清单事件同步切换 plugins.lock.json 的活动版本（锁是唯一指针）。
          if (process.env.SMOKE_UI_LOCK_PATH !== undefined && process.env.SMOKE_UI_LOCK_NEXT !== undefined) {
            writeFileSync(process.env.SMOKE_UI_LOCK_PATH, process.env.SMOKE_UI_LOCK_NEXT);
          }
          port.postMessage({ kind: 'result', id: data.id, ok: true, value: null });
          port.postMessage({ kind: 'event', event: 'host://ui-manifest', payload: args.manifest ?? [], target: { kind: 'Any' } });
        } else {
          port.postMessage({ kind: 'result', id: data.id, ok: false, error: `${String(data.cmd)} not allowed. Command not found` });
        }
        break;
      case 'frontend-event':
        if (data.event === 'smoke://ping') {
          port.postMessage({ kind: 'event', event: 'smoke://pong', payload: { echo: data.payload, source: data.source }, target: { kind: 'Any' } });
        }
        break;
      case 'shutdown':
        process.exit(0);
    }
  });
  port.start();
});
