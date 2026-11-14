/**
 * 测试专用 Host：通过真实 HostSupervisor 协议向 main 发送 shell-request，记录 op 结果。
 * 仅用于验证 Host → main 的 shell 路由；不启动真实 Host 插件/profile。
 */
import { writeFileSync } from 'node:fs';

interface PortLike {
  on(event: 'message', listener: (e: { data: Record<string, unknown> }) => void): void;
  postMessage(message: unknown): void;
  start(): void;
}

const parentPort = (process as unknown as {
  parentPort: {
    on(event: 'message', listener: (e: { data: { kind?: string }; ports: PortLike[] }) => void): void;
  };
}).parentPort;

const reportPath = process.env.SHELL_REPORT;
let port: PortLike | null = null;
let started = false;
let sequence = 0;
const pending = new Map<string, { resolve: (result: unknown) => void; timer: ReturnType<typeof setTimeout> }>();

function callShell(op: string, args?: unknown): Promise<unknown> {
  if (port === null) return Promise.resolve({ ok: false, error: 'host port was not connected' });
  const id = `shell-request-${++sequence}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: `shell request timed out: ${op}` });
    }, 30_000);
    pending.set(id, { resolve, timer });
    port!.postMessage({ kind: 'shell-request', id, op, args: args ?? {} });
  });
}

async function run(): Promise<void> {
  if (reportPath === undefined) throw new Error('SHELL_REPORT is required');
  const report: Record<string, unknown> = {};
  report.fullVersion = await callShell('app.fullVersion');
  report['plugin:process|restart'] = await callShell('plugin:process|restart');
  report['process:restart'] = await callShell('process:restart');
  report.pdfStreamDirs = await callShell('app.pdfStreamAllowedDirs');
  report.dataDirs = await callShell('app.dataDirs');
  report.shellOsDirsEnv = process.env.DS_SHELL_OS_DIRS ?? null;
  report.unknownProcessOp = await callShell('plugin:process|nope');
  const pathDirs: Record<string, unknown> = {};
  for (const [name, directory] of [['home', 21], ['appData', 14], ['appLocalData', 15], ['appConfig', 13], ['appCache', 16], ['appLog', 17], ['data', 4], ['config', 3], ['cache', 2]] as const) {
    pathDirs[name] = await callShell('plugin:path|resolve_directory', { directory });
  }
  report.pathDirs = pathDirs;
  writeFileSync(reportPath, JSON.stringify(report));
}

parentPort.on('message', (event) => {
  if (event.data.kind !== 'connect') return;
  const connected = event.ports[0];
  if (!connected) return;
  port = connected;
  connected.on('message', ({ data }) => {
    switch (data.kind) {
      case 'handshake':
        connected.postMessage({ kind: 'ready', protocol: 1 });
        if (!started) {
          started = true;
          void run().catch((error: unknown) => {
            writeFileSync(reportPath ?? '/dev/null', JSON.stringify({ fatal: error instanceof Error ? error.message : String(error) }));
          });
        }
        break;
      case 'shell-result': {
        const id = String(data.id);
        const entry = pending.get(id);
        if (entry === undefined) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        entry.resolve(data.ok === true ? { ok: true, value: data.value } : { ok: false, error: String(data.error) });
        break;
      }
    }
  });
  connected.start();
});
