/**
 * 启动测试的主线程侧：与 `src/main.ts` 相同的 `MobileShell` + `HostWorkerSupervisor`，经 renderer 桥传输发命令。
 * 与 Host Worker 一起按浏览器目标打包（worker-boot.test.ts），在去掉 Node 全局的进程里运行（worker-boot-runner.ts）。
 */
import type { MainToRenderer, ResponseBody } from '../../../electron/shell/bridge-messages.ts';
import { HostWorkerSupervisor, type WorkerLike } from '../../src/shell/host-supervisor.ts';
import { MobileShell } from '../../src/shell/mobile-shell.ts';

export interface InvokeReply {
  readonly ok: boolean;
  readonly body: unknown;
}

export interface BootDriver {
  readonly ready: Promise<void>;
  readonly logs: string[];
  /** `listen` 过的事件收到的 payload（按到达顺序）。 */
  readonly events: { event: string; payload: unknown }[];
  invoke(cmd: string, args?: unknown): Promise<InvokeReply>;
  listen(event: string): Promise<InvokeReply>;
  shutdown(): Promise<void>;
}

function decode(body: ResponseBody): unknown {
  return body.kind === 'json' ? JSON.parse(body.data) as unknown : body.data;
}

export function startShell(worker: WorkerLike): BootDriver {
  const logs: string[] = [];
  const events: { event: string; payload: unknown }[] = [];
  const shell = new MobileShell({
    handshake: { appDataDir: '/deep-student', appVersion: '0.0.0-boot', platform: 'linux', debug: false },
    log: message => logs.push(message),
  });
  const supervisor = new HostWorkerSupervisor({ shell, createWorker: () => worker, log: message => logs.push(message) });

  const waiting = new Map<number, { ok: boolean; resolve: (reply: InvokeReply) => void }>();
  let listeners = 0;
  const transport = shell.bridgeTransport();
  transport.subscribe((message: MainToRenderer) => {
    if (message.type === 'result') {
      const entry = waiting.get(message.callbackId);
      waiting.delete(message.callbackId);
      waiting.delete(message.otherId);
      entry?.resolve({ ok: entry.ok, body: decode(message.body) });
    } else if (message.type === 'emit-js') {
      events.push({ event: message.event, payload: JSON.parse(message.payload) as unknown });
    }
  });

  let nextId = 1;
  const invoke = (cmd: string, args: unknown = {}): Promise<InvokeReply> => new Promise((resolve) => {
    const callback = nextId++;
    const error = nextId++;
    waiting.set(callback, { ok: true, resolve });
    waiting.set(error, { ok: false, resolve });
    transport.send({ type: 'invoke', cmd, callback, error, payload: { contentType: 'application/json', data: JSON.stringify(args) }, headers: {} });
  });

  supervisor.start();
  return {
    ready: shell.ready,
    logs,
    events,
    invoke,
    listen: event => invoke('plugin:event|listen', { event, target: { kind: 'Any' }, handler: ++listeners }),
    shutdown: () => supervisor.shutdown(),
  };
}
