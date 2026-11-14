/**
 * 测试专用 Host：在日志插件装载之前失败（HOST_FAILURE_MODE）。
 * - `fatal`：握手后发送 HostFatal 并以 1 退出（与 host/kernel/main.ts 的 reportFatal 相同）；
 * - `crash`：模块求值期抛出未捕获异常，来不及建立端口；
 * - `signal`：写完 stderr 后被 SIGKILL。
 */
const mode = process.env.HOST_FAILURE_MODE ?? 'fatal';
process.stderr.write(`[failing-host] early diagnostic (${mode}) before any logger\n`);

if (mode === 'crash') throw new Error('failing-host crashed while loading modules');
if (mode === 'signal') process.kill(process.pid, 'SIGKILL');

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
    if (data.kind !== 'handshake') return;
    const error = new Error('profile failed to load: storage service unavailable');
    port.postMessage({ kind: 'fatal', message: error.message, stack: error.stack });
    process.stderr.write('[failing-host] fatal sent\n');
    setTimeout(() => process.exit(1), 100);
  });
  port.start();
});
