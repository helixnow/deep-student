/**
 * Desktop Host 进程入口。
 *
 * 设计运行在 Electron `utilityProcess.fork('host/kernel/main.ts', ['--profile=<path>'])` 中（Node 24.22，ESM，
 * 原生剥离 `.ts` 类型）；同一入口也可以由 `child_process.fork(..., { serialization: 'advanced' })` 或
 * `worker_threads` 启动（测试 / headless）。
 *
 * 参数：
 * - `--profile=<path>`：显式 profile（握手中的 `profile` 字段优先）；省略时加载
 *   `<appDataDir>/plugins/user.profile.json`（存在时），失败则记录日志、发出
 *   `host://plugin-profile-failed` 并回退到官方 profile `host/profiles/desktop.json`；
 * - `--contracts=<dir>`：契约目录，默认仓库 `contracts/ipc`；
 * - `--shell-timeout=<ms>`：`ctx.shell.request` 超时；
 * - `--safe-mode`：安全模式（W06）：Host 只装载官方插件；`DS_SAFE_MODE=1` 是外壳内部的传播值，效果相同。
 *
 * 环境变量：`env-config.ts` 中登记的开关（`DEEP_STUDENT_HPIAS_BACKEND`、`DEEP_STUDENT_WEBDAV_RATE_LIMIT`）映射为对应插件的配置；
 * `DS_HOST_CALL_CALLER=require` 让 `plugin:host|call` 必须带 `caller`（现已是默认值，变量只能收紧）。
 */
// 必须是第一个 import：在任何 profile 模块加载之前开启编译缓存。
import { flushCompileCache } from './compile-cache.ts';
import { CapabilityAcl } from './acl.ts';
import { parentPort as workerParentPort } from 'node:worker_threads';
import { serveHost, type HostTransport } from './connection.ts';
import { ContractSet } from './contracts.ts';
import { envConfigOverrides, hostCallCallerMode } from './env-config.ts';
import { describeError } from './kernel.ts';
import { createStderrExporter } from './log-export.ts';
import type { HostToMain } from './protocol.ts';
import { electronParentPortTransport, messagePortTransport, nodeIpcTransport, type ParentPortLike, type PortLike } from './transports.ts';

function argValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === `--${name}`) return args[i + 1];
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

async function selectTransport(): Promise<HostTransport> {
  const electronParentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
  if (electronParentPort) return electronParentPortTransport(electronParentPort);
  if (typeof process.send === 'function') return nodeIpcTransport(process);
  if (workerParentPort) return messagePortTransport(workerParentPort as unknown as PortLike);
  throw new Error('no transport: start the Host with Electron utilityProcess.fork, child_process.fork or worker_threads');
}

/** 让已排队的 IPC 消息有机会写出，再结束进程。 */
const SIGTERM_EXIT_DEADLINE_MS = 6_000;

function exitSoon(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500).unref();
}

async function main(): Promise<void> {
  const transport = await selectTransport();
  const contractsDir = argValue('contracts');
  const profile = argValue('profile');
  const shellTimeout = argValue('shell-timeout');
  const ocrHelper = argValue('system-ocr-helper');
  if (process.platform === 'darwin' && ocrHelper) {
    const [{ setSystemOcrBinding }, { recognizeWithVision }] = await Promise.all([
      import('../plugins/llm-providers/api.ts'),
      import('../platform/native/image/vision-ocr.ts'),
    ]);
    setSystemOcrBinding({ performSystemOcr: (bytes) => recognizeWithVision(ocrHelper, bytes) });
  }

  const reportFatal = (error: unknown) => {
    const message: HostToMain = { kind: 'fatal', message: error instanceof Error ? error.message : String(error), ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) };
    try {
      transport.send(message);
    } finally {
      process.stderr.write(`[dstu-host] fatal: ${describeError(error)}\n`);
      exitSoon(1);
    }
  };
  process.on('uncaughtException', reportFatal);
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[dstu-host] unhandled rejection: ${describeError(reason)}\n`);
  });

  const session = serveHost(transport, {
    acl: app => CapabilityAcl.fromDirectory(app.platform, argValue('tauri-dir')),
    ...(profile ? { profile } : {}),
    contracts: () => (contractsDir ? ContractSet.fromDirectory(contractsDir) : ContractSet.fromDirectory()),
    configOverrides: envConfigOverrides(process.env),
    hostCallCaller: hostCallCallerMode(process.env),
    ...(hasFlag('safe-mode') || process.env.DS_SAFE_MODE === '1' ? { safeMode: true } : {}),
    ...(shellTimeout ? { shellTimeoutMs: Number(shellTimeout) } : {}),
    exit: exitSoon,
    onRuntime(runtime) {
      // Cordis logger 默认只写内存缓冲。这里另写一份到 stderr：Electron 以 stdio: 'inherit' 启动 Host，
      // main 并不收集，只在开发终端可见。落盘由 dstu.platform.log 的桥接写入主日志 deep-student.log。
      runtime.ctx.logger.exporter(createStderrExporter());
    },
  });
  void session.ready.then((runtime) => {
    // 等首批 invoke 处理完再写盘，避免与就绪后的第一波请求争主线程。
    if (runtime) setTimeout(flushCompileCache, 5_000).unref();
  });
  process.on('SIGTERM', () => {
    process.stderr.write('[dstu-host] SIGTERM received, shutting down\n');
    // runtime.dispose 各阶段都有上限（合计 5500 ms，见 runtime.ts）；这里兜住意料之外的挂起。
    setTimeout(() => {
      process.stderr.write(`[dstu-host] shutdown did not finish within ${SIGTERM_EXIT_DEADLINE_MS}ms after SIGTERM, exiting\n`);
      process.exit(1);
    }, SIGTERM_EXIT_DEADLINE_MS).unref();
    void session.shutdown();
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`[dstu-host] failed to start: ${describeError(error)}\n`);
  process.exit(1);
});
