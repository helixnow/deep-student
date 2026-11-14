/**
 * V06 §5.2 启动测试的运行器：独立 Node 进程（不在 vitest worker 里删全局），用法 `node worker-boot-runner.ts <bundle-dir>`。
 *
 * 1. Node 版 sqlite-wasm（与移动端同一版本）充当 `@sqlite.org/sqlite-wasm`（打包时替换为 `globalThis.__probe.sqlite3`），
 *    opfs-sahpool 换成 Emscripten 内存文件系统上的同形实现；`navigator.storage.getDirectory()` 指向内存 OPFS。
 * 2. 先触发 Node 惰性初始化的 Web 全局并做一次 MessageChannel 往返：删掉 `Buffer` 后 undici 再惰性加载会崩。
 * 3. 用 EventTarget 伪造 Worker 全局（`self.addEventListener/postMessage/close`），删除 `process`、`Buffer`、
 *    `setImmediate`、`clearImmediate`、`global`，再导入打包好的 Host Worker 与主线程驱动。
 * 4. 经 `MobileShell` 握手 → 调用 → 有序退出 → 退出后调用；结果以 `RESULT_PREFIX` 开头的一行 JSON 写到 stdout。
 *
 * 可选第二个参数：JSON 数组 `[[cmd, args], …]`，在固定调用之后、退出之前依次调用，回复放在结果的 `extra` 里。
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createFakeOpfs } from '../../../host/platform/files/tests/__fixtures__/fake-opfs.ts';
import { MOBILE_DIAGNOSTICS_PLUGIN_ID } from '../../src/diagnostics-id.ts';
import type { WorkerLike } from '../../src/shell/host-supervisor.ts';
import type { BootDriver, InvokeReply } from './boot-driver.ts';

const RESULT_PREFIX = 'W31-BOOT-RESULT ';
const READY_WITHIN_MS = 20_000;
const REMOVED_GLOBALS = ['process', 'Buffer', 'setImmediate', 'clearImmediate', 'global'] as const;

const proc = process;
const uncaught: string[] = [];
proc.on('uncaughtException', error => uncaught.push(`uncaughtException: ${error.stack ?? error.message}`));
proc.on('unhandledRejection', reason => uncaught.push(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`));
const report = (result: Record<string, unknown>) => {
  proc.stdout.write(`${RESULT_PREFIX}${JSON.stringify({ ...result, uncaught })}\n`);
  proc.exit(0);
};

type NodeSqlite = Awaited<ReturnType<typeof sqlite3InitModule>>;

async function prepareSqlite(): Promise<{ sqlite3: NodeSqlite; installs: () => number }> {
  const init = sqlite3InitModule as unknown as (options: { print(): void; printErr(): void }) => Promise<NodeSqlite>;
  const sqlite3 = await init({ print: () => undefined, printErr: () => undefined });
  const files = new Set<string>();
  const flat = (path: string) => `/pool${path.replaceAll('/', '_')}`;
  class OpfsSAHPoolDb extends sqlite3.oo1.DB {
    constructor(path: string) {
      super(flat(path), 'c');
      files.add(path);
    }
  }
  let installs = 0;
  Object.assign(sqlite3, {
    installOpfsSAHPoolVfs: async () => {
      installs++;
      return {
        OpfsSAHPoolDb,
        getFileNames: () => [...files],
        unlink: (path: string) => files.delete(path),
        exportFile: (path: string) => { throw new Error(`exportFile(${path}) is not used during boot`); },
        reserveMinimumCapacity: async () => undefined,
      };
    },
  });
  return { sqlite3, installs: () => installs };
}

async function warmWebGlobals(): Promise<void> {
  void [MessageChannel, MessageEvent, fetch, Blob, ReadableStream, structuredClone, crypto.subtle, TextEncoder, TextDecoder];
  await new Promise<void>((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      port2.close();
      resolve();
    };
    port2.postMessage('warm-up');
  });
}

async function main(bundleDir: string, extraInvokes: readonly [cmd: string, args: unknown][]): Promise<void> {
  const { sqlite3, installs } = await prepareSqlite();
  const opfs = createFakeOpfs();
  Object.defineProperty(globalThis.navigator, 'storage', { configurable: true, value: { getDirectory: async () => opfs } });
  await warmWebGlobals();

  const workerScope = new EventTarget();
  const toShell = new EventTarget();
  const workerExits: number[] = [];
  let closeCalls = 0;
  Object.assign(workerScope, {
    postMessage: (data: unknown) => { setTimeout(() => toShell.dispatchEvent(new MessageEvent('message', { data })), 0); },
    close: () => { closeCalls++; },
  });
  // 退出报告走 Host 端口（mobile/src/worker/exit-report.ts）：在 Worker 拿到的端口上记录。
  const recordExits = (port: MessagePort) => {
    const post = port.postMessage.bind(port) as (message: unknown) => void;
    port.postMessage = ((message: unknown) => {
      const report = message as { kind?: unknown; code?: unknown };
      if (report.kind === 'dstu-worker-exit') workerExits.push(report.code as number);
      post(message);
    }) as MessagePort['postMessage'];
  };
  const worker = {
    postMessage: (data: unknown) => {
      recordExits((data as { port: MessagePort }).port);
      setTimeout(() => workerScope.dispatchEvent(new MessageEvent('message', { data })), 0);
    },
    addEventListener: (type: string, listener: (event: never) => void) => toShell.addEventListener(type, listener as unknown as EventListener),
    terminate: () => undefined,
  } as unknown as WorkerLike;

  // Worker 里 Host 的 logger exporter 写 console（host-worker.ts onRuntime）；收进结果供断言。
  const consoleLines: string[] = [];
  for (const level of ['error', 'warn', 'info'] as const) {
    console[level] = (...args: unknown[]) => { consoleLines.push(`${level}: ${args.map(String).join(' ')}`); };
  }

  const scope = globalThis as unknown as Record<string, unknown>;
  scope.__probe = { sqlite3 };
  scope.self = workerScope;
  for (const name of REMOVED_GLOBALS) delete scope[name];
  const nodeGlobalsAtBoot = Object.fromEntries(REMOVED_GLOBALS.map(name => [name, typeof scope[name]]));

  const started = performance.now();
  await import(pathToFileURL(join(bundleDir, 'host-worker.js')).href);
  const { startShell } = await import(pathToFileURL(join(bundleDir, 'boot-driver.js')).href) as typeof import('./boot-driver.ts');
  const driver: BootDriver = startShell(worker);
  const listened = await driver.listen('data-governance-migration-status');
  const ready = await Promise.race([
    driver.ready.then(() => 'ready', (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`),
    new Promise<string>(resolve => setTimeout(() => resolve('timeout'), READY_WITHIN_MS)),
  ]);
  const readyMs = performance.now() - started;
  if (ready !== 'ready') {
    report({ nodeGlobalsAtBoot, ready, readyMs, logs: driver.logs, console: consoleLines });
    return;
  }
  const status: InvokeReply = await driver.invoke('plugin:host|status');
  const manifest: InvokeReply = await driver.invoke('plugin:ui|manifest', { version: 2 });
  const diagnostics: InvokeReply = await driver.invoke('plugin:host|call', { service: 'mobileDiagnostics', method: 'ping', args: ['boot'], caller: MOBILE_DIAGNOSTICS_PLUGIN_ID });
  const extra: InvokeReply[] = [];
  for (const [cmd, args] of extraInvokes) extra.push(await driver.invoke(cmd, args));
  await driver.shutdown();
  const afterShutdown: InvokeReply = await driver.invoke('plugin:host|status');
  report({
    nodeGlobalsAtBoot,
    ready,
    readyMs,
    poolInstalls: installs(),
    listened,
    events: driver.events,
    status,
    manifest,
    diagnostics,
    extra,
    workerExits,
    closeCalls,
    afterShutdown,
    logs: driver.logs,
    console: consoleLines,
  });
}

main(proc.argv[2]!, JSON.parse(proc.argv[3] ?? '[]') as [string, unknown][]).catch((error: unknown) => report({ error: error instanceof Error ? error.stack ?? error.message : String(error) }));
