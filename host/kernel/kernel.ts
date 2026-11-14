/** kernel 内部共享的状态与工具（不属于插件 API）。 */
import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { AppInfo, HostPlugin } from './api.ts';
import type { ContractSet } from './contract-set.ts';
import type { HostToMain } from './protocol.ts';
import type { CapabilityAcl } from './acl.ts';
import { PluginLoadError } from './plugin-load-error.ts';
import type { PluginManifest } from './manifest.ts';

/**
 * Cordis `FiberState` 是 `const enum`，运行时不导出（verbatimModuleSyntax 下也不能引用环境 const enum），
 * 数值取自 @deepseek-ai/cordis/src/fiber.ts 的声明顺序。
 */
export const FIBER_PENDING = 0;
export const FIBER_ACTIVE = 2;
export const FIBER_FAILED = 3;
export const FIBER_DISPOSED = 4;

/** Host 发往 main 的出口。生产为 MessagePort 连接，测试宿主为内存记录。 */
export interface HostOutbound {
  send(message: HostToMain): void;
}

export interface InstalledPlugin {
  readonly id: string;
  readonly plugin: HostPlugin<any>;
  readonly config: unknown;
  /** 插件的根 fiber（`ctx.plugin()` 创建）。 */
  readonly fiber: Fiber;
  /** 来源模块（profile 加载时为模块 URL）。 */
  readonly source?: string;
  /** 社区插件的包根目录（profile 筛查时找到的 `package.json` 所在目录）。 */
  readonly packageRoot?: string;
  /** 社区插件经安装前校验的 manifest（官方插件没有）。 */
  readonly manifest?: PluginManifest;
}

export interface PluginExecution {
  current(): Fiber | undefined;
  run<T>(fiber: Fiber, callback: () => T): T;
}

export interface KernelState {
  execution?: PluginExecution;
  readonly root: Context;
  readonly contracts: ContractSet;
  readonly app: AppInfo;
  readonly acl?: CapabilityAcl;
  outbound: HostOutbound | null;
  readonly shellTimeoutMs: number;
  /** 注销命令时等待在途调用响应 abort 的上限；超时的调用标记 detached，不再等。 */
  readonly commandCloseTimeoutMs: number;
  /** fiber 所属的已安装插件（沿父链向上找第一个插件根 fiber）。 */
  ownerOf(fiber: Fiber): InstalledPlugin | undefined;
}

/** 插件 API v1 不开放给社区插件的 kernel 服务（API.md §16.7 第 2 项）。 */
// RUST-FIX(RF-P1-managed-plugin-install): Community code cannot inject the builtin installer capability.
export const KERNEL_ONLY_SERVICES: readonly string[] = Object.freeze(['commands', 'protocols', 'backendEvents', 'shell', 'dstuPluginInstaller']);

/**
 * kernel 服务方法的入口检查：调用方 fiber 属于社区插件（profile 筛查过清单、带 `packageRoot`）时抛
 * `KERNEL_API_FORBIDDEN`。归属不明（`ctx.root`、kernel 自身）与官方插件按原行为放行：这是防误用，不是隔离边界。
 */
export function assertKernelSurface(kernel: KernelState, fiber: Fiber, method: string): void {
  const owner = kernel.ownerOf(fiber);
  if (owner?.packageRoot === undefined) return;
  throw new PluginLoadError('KERNEL_API_FORBIDDEN', owner.id, `${method} is not available to community plugins in plugin API v1`);
}

/** `fiber` 是否是 `ancestor` 本身或其后代。 */
export function isWithin(fiber: Fiber, ancestor: Fiber): boolean {
  let current: Fiber | undefined = fiber;
  while (current) {
    if (current === ancestor) return true;
    const parent: Fiber = current.parent.fiber;
    if (parent === current || !current.runtime) return false;
    current = parent;
  }
  return false;
}

/**
 * 日志系统之外的最后出口：Node 写 `process.stderr`（每次调用时查找，测试可以 spy）；
 * 没有 `process` 的宿主（浏览器 / Web Worker）写 `console.error`。
 */
export function writeHostStderr(text: string): void {
  const stderr = (globalThis as { process?: { stderr?: { write?: (chunk: string) => unknown } } }).process?.stderr;
  if (typeof stderr?.write === 'function') stderr.write(text);
  else console.error(text.endsWith('\n') ? text.slice(0, -1) : text);
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}
