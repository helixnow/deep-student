/**
 * 真实 `electron/main.ts`：记录 Host 事件经 main 交给 `runtime.emitTo` 的事件名与载荷 JSON，等到 `test://after` 后
 * 把记录写到 EVENT_PAYLOAD_REPORT。Host 替身见 `event-payload-host.ts`。
 */
import { writeFileSync } from 'node:fs';
import { app } from 'electron';
import { start } from '../../main.ts';

const reportPath = process.env.EVENT_PAYLOAD_REPORT!;
const emitted: Array<[string, string]> = [];

async function run(): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  while (!emitted.some(([event]) => event === 'test://after')) {
    if (Date.now() > deadline) throw new Error(`test://after was not emitted; emitted: ${JSON.stringify(emitted)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { emitted: emitted.filter(([event]) => event.startsWith('test://')) };
}

void app.whenReady().then(() => start({
  processHooks: { restart: () => undefined, exit: () => undefined },
  onRuntime: (runtime) => {
    const emitTo = runtime.emitTo.bind(runtime);
    runtime.emitTo = (target, event, payloadJson) => {
      emitted.push([event, payloadJson]);
      emitTo(target, event, payloadJson);
    };
  },
})).then(run).then((report) => {
  writeFileSync(reportPath, JSON.stringify(report));
  app.exit(0);
}, (error: unknown) => {
  writeFileSync(reportPath, JSON.stringify({ fatal: error instanceof Error ? error.stack ?? error.message : String(error) }));
  app.exit(1);
});
