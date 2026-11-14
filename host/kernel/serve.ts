/**
 * Host 会话核心（可移植）：握手、消息路由、启动收尾、有序退出。插件装载由调用方以 `load` 提供：
 * 桌面入口 connection.ts 的 `serveHost` 读 profile 文件；没有文件系统的宿主（移动端 Web Worker）用
 * {@link serveImportedHost} 安装静态导入的条目。
 *
 * 传输层只是 {@link HostTransport} 接口；MessagePort / Electron parentPort / Node IPC 的实现在 transports.ts，
 * 以后的 WebSocket（headless / SDK）实现同一接口即可。
 */
import { PLUGIN_MANAGER_CONFIG_COMMAND, PLUGIN_MANAGER_LIST_COMMAND, type AppInfo, type PluginPlatform } from './core.ts';
import { thrownMessage } from './commands.ts';
import type { ContractSet } from './contract-set.ts';
import { describeError, writeHostStderr } from './kernel.ts';
import { loadImportedProfile } from './profile-install.ts';
import { HOST_PROTOCOL_VERSION, type Handshake, type HostToMain, type InvokeRequest, type InvokeResponse, type MainToHostMessage } from './protocol.ts';
import { HostRuntime, type HostCallCallerMode, type PluginInstall } from './runtime.ts';
import type { CapabilityAcl } from './acl.ts';

export interface HostTransport {
  send(message: HostToMain): void;
  /** 注册消息监听（只注册一次）。 */
  onMessage(listener: (message: unknown) => void): void;
  /** 对端断开（端口关闭 / 父进程断开）。 */
  onClose(listener: () => void): void;
  close(): void;
}

/** 各入口共用的会话选项。 */
export interface ServeSessionOptions {
  acl?: (app: AppInfo) => CapabilityAcl;
  shellTimeoutMs?: number;
  /** `plugin:host|call` 缺 `caller` 时的处理；默认 `DEFAULT_HOST_CALL_CALLER_MODE`。 */
  hostCallCaller?: HostCallCallerMode;
  /** 安全模式（W06 `--safe-mode`）：Host 只装载官方插件，拒绝社区安装/启用/profile 变更。 */
  safeMode?: boolean;
  /** Host 结束时调用（0 = 正常退出，1 = 启动失败）。 */
  exit?: (code: number) => void;
  /** 运行时创建后、加载插件前调用（main.ts 用它挂日志输出）。 */
  onRuntime?: (runtime: HostRuntime) => void;
}

export interface ServeCoreOptions extends ServeSessionOptions {
  contracts: () => ContractSet;
  /** 运行时创建后装载插件（profile 文件或静态导入的条目）；抛错即 HostFatal。之后执行启动 finalizer 并发送 HostReady。 */
  load: (runtime: HostRuntime, handshake: Handshake) => Promise<void>;
}

export interface ServeImportedOptions extends ServeSessionOptions {
  /** 契约（没有文件系统的宿主通常随包内置，或用 `ContractSet.empty()`）。 */
  contracts: () => ContractSet;
  /** 预先静态导入的插件条目（如由 `host/profiles/mobile.json` 生成的模块表）。 */
  installs: () => Promise<readonly PluginInstall[]>;
  /** 当前插件平台；给出时平台不在插件 `meta.platforms` 内的条目不装载（`UNSUPPORTED_ON_PLATFORM`）。移动端应传 `mobile`。 */
  platform?: PluginPlatform;
}

export interface HostSession {
  /** 握手完成、profile 加载成功后 resolve 运行时；启动失败时 resolve `null`（此时已发送 HostFatal 并退出）。 */
  readonly ready: Promise<HostRuntime | null>;
  /** 有序退出；返回时插件已全部停止。 */
  shutdown(): Promise<void>;
}

/**
 * 安装静态导入的插件条目并运行 Host：不解析、不动态导入任何 profile 文件；安装隔离、启动 finalizer 与
 * HostReady 顺序与文件 profile 相同。
 */
export function serveImportedHost(transport: HostTransport, options: ServeImportedOptions): HostSession {
  const { installs, platform, ...session } = options;
  return serveHostCore(transport, {
    ...session,
    load: async (runtime) => {
      const entries = await installs();
      runtime.startup.mark('modules imported');
      await loadImportedProfile(runtime, entries, platform ? { platform } : {});
      runtime.commands._registerKernel(PLUGIN_MANAGER_LIST_COMMAND, () => ({
        revision: 'mobile-static',
        safeMode: runtime.safeMode,
        plugins: entries
          .filter((entry) => entry.plugin.meta.id !== 'dstu.mobile.shell')
          .map((entry) => {
            const meta = entry.plugin.meta;
            const id = meta.id;
            const installed = runtime.get(id);
            return {
              id,
              origin: 'builtin' as const,
              source: 'builtin' as const,
              trust: 'full' as const,
              displayName:
                meta.displayName ??
                id
                  .replace(/^dstu\./, '')
                  .split(/[.-]/)
                  .map((part) => (part[0] ? part[0].toUpperCase() + part.slice(1) : ''))
                  .join(' '),
              icon: meta.icon ?? 'Package',
              author: meta.author ?? 'Deep Student',
              description: meta.description ?? (meta.provides ?? []).join(', '),
              category: meta.category ?? (id.startsWith('dstu.platform.') ? 'platform' : meta.lane ?? 'application'),
              homepage: meta.homepage ?? 'https://github.com/helixnow/deep-student',
              ...(meta.displayNameKey ? { displayNameKey: meta.displayNameKey } : {}),
              ...(meta.descriptionKey ? { descriptionKey: meta.descriptionKey } : {}),
              platforms: [...(meta.platforms ?? ['desktop', 'mobile'])],
              ...(meta.version !== undefined ? { version: meta.version } : {}),
              enabled: true,
              state: installed ? ('running' as const) : ('degraded' as const),
              permissions: [],
              services: [...(meta.provides ?? [])],
              hasConfig: installed?.plugin.Config !== undefined,
            };
          }),
      }));
      runtime.commands._registerKernel(PLUGIN_MANAGER_CONFIG_COMMAND, (args) => {
        const id = typeof (args as { id?: unknown } | null)?.id === 'string' ? (args as { id: string }).id : '';
        return { id, revision: 'mobile-static', values: null, schema: null };
      });
    },
  });
}

function isMessage(value: unknown): value is MainToHostMessage {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string';
}

function validateHandshake(message: Handshake): string | null {
  if (message.protocol !== HOST_PROTOCOL_VERSION) return `protocol mismatch: main speaks ${String(message.protocol)}, Host speaks ${HOST_PROTOCOL_VERSION}`;
  if (typeof message.appDataDir !== 'string' || !message.appDataDir) return 'handshake.appDataDir must be a non-empty string';
  if (typeof message.appVersion !== 'string') return 'handshake.appVersion must be a string';
  if (!['darwin', 'win32', 'linux'].includes(message.platform)) return `handshake.platform ${JSON.stringify(message.platform)} is not supported`;
  if (typeof message.debug !== 'boolean') return 'handshake.debug must be a boolean';
  if (message.profile !== undefined && typeof message.profile !== 'string') return 'handshake.profile must be a string';
  return null;
}

/**
 * D2 启动收尾：profile 安装完成（等价 Rust `lib.rs` setup 中迁移/业务初始化结束）后，
 * 由组合根先执行 F3 的启动 finalizer，再标记 F2 的 startupGate。
 *
 * - 正常启动：`storage.runStartupFinalizers()` 全部成功后才 `startupGate.markStartupReady()`；
 *   任一 finalizer 抛错向上传播，boot 走 HostFatal，不发送 `HostReady`，也不标记就绪。
 * - 恢复模式：Rust `lib.rs:953-959` 在恢复预检后提前返回，不进入业务初始化；这里跳过
 *   finalizer，但仍标记 gate，等价 `StartupReadyGuard` 在 setup 提前返回时 drop，放行
 *   `get_startup_recovery_status` 的 `wait_startup_ready`。
 * - F3 的 finalizer API 目前在 `ds-mig/F3-storage` 分支（`fe46369d8`/`9f8c77387`），
 *   main 尚未合入；缺少该方法时本步骤为空操作，gate 仍按启动成功标记。
 * - 本组合根不重试：`runStartupFinalizers()` 失败即向上抛，boot 发送 `HostFatal` 并退出 1。F3 registry 的
 *   “再次 run 跳过已完成项”只供显式调用方使用；当前生产没有该调用方，也不得由业务插件 catch 后自行启动
 *   或定时等待来替代启动契约（L06 契约请求，C2 2026-11-04 确认）。
 * - 业务插件在 `apply` 中注册 finalizer 失败仍按既有隔离规则处理：该插件 degraded，boot 可继续并标记
 *   gate。若该插件本应提供必需的恢复/清理钩子，这属于“启动不完整”；必需钩子的判定/失败传播政策
 *   待架构师裁定，本文件不擅自把全部 apply 错误改为 fatal。
 *
 * 这里只按服务名做结构化探测，不 import `host/platform/storage` 或 `electron/`，保持平台不 import 业务。
 */
interface StartupFinalizerStorage {
  runStartupFinalizers?(): Promise<unknown>;
}
interface StartupRecoveryProbe {
  status?(): { recovery_required?: unknown };
}
interface StartupGateLike {
  markStartupReady?(): void;
}

/**
 * `HostFatal` 只携带 `message`/`stack`；F3 `StartupFinalizerError` 的失败名称、已完成列表与原始 cause
 * 需要写入 Host 日志，才能事后诊断启动失败原因（log 插件已装载时落盘到主日志，并输出到 stderr）。
 */
function logStartupFailure(runtime: HostRuntime, stage: string, error: unknown): void {
  const extra = error instanceof Error
    ? error as Error & { finalizer?: unknown; completed?: unknown; cause?: unknown }
    : undefined;
  const details: string[] = [];
  if (typeof extra?.finalizer === 'string') details.push(`finalizer: ${extra.finalizer}`);
  if (Array.isArray(extra?.completed)) details.push(`completed: ${extra.completed.length ? extra.completed.join(', ') : '(none)'}`);
  if (extra?.cause !== undefined) details.push(`cause:\n${describeError(extra.cause)}`);
  runtime.ctx.logger('host').error(
    `startup finalization failed at ${stage}; Host will exit without ready:\n${describeError(error)}` +
    (details.length ? `\n${details.join('\n')}` : ''),
  );
}

async function finishStartup(runtime: HostRuntime): Promise<void> {
  let stage = 'recovery probe';
  try {
    const dataSpace = runtime.ctx.get('dataSpace') as StartupRecoveryProbe | undefined;
    const recovery = dataSpace?.status?.()?.recovery_required === true;
    if (!recovery) {
      stage = 'runStartupFinalizers';
      const storage = runtime.ctx.get('storage') as StartupFinalizerStorage | undefined;
      if (typeof storage?.runStartupFinalizers === 'function') await storage.runStartupFinalizers();
    }
    stage = 'startupGate.markStartupReady';
    const gate = runtime.ctx.get('startupGate') as StartupGateLike | undefined;
    gate?.markStartupReady?.();
  } catch (error) {
    logStartupFailure(runtime, stage, error);
    throw error;
  }
}

/** 在一个传输上运行 Host：等待握手 → 创建运行时 → `options.load` 装载插件 → 启动收尾 → HostReady → 路由消息。 */
export function serveHostCore(transport: HostTransport, options: ServeCoreOptions): HostSession {
  let runtime: HostRuntime | null = null;
  let booting = false;
  let closing: Promise<void> | null = null;
  const buffered: MainToHostMessage[] = [];
  const invokes = new Map<string, AbortController>();

  let resolveReady!: (runtime: HostRuntime | null) => void;
  const ready = new Promise<HostRuntime | null>((resolve) => {
    resolveReady = resolve;
  });

  const send = (message: HostToMain) => transport.send(message);

  const fatal = (error: unknown) => {
    // 之后的断开事件不再走正常退出流程（退出码保持 1）。
    closing ??= Promise.resolve();
    const message = error instanceof Error ? error.message : String(error);
    const fatalMessage: HostToMain = error instanceof Error && error.stack ? { kind: 'fatal', message, stack: error.stack } : { kind: 'fatal', message };
    try {
      send(fatalMessage);
    } finally {
      resolveReady(null);
      const current = runtime;
      runtime = null;
      const finish = () => {
        transport.close();
        options.exit?.(1);
      };
      if (current) current.dispose().then(finish, (disposeError) => {
        writeHostStderr(`[dstu-host] cleanup after boot failure failed:\n${describeError(disposeError)}\n`);
        finish();
      });
      else finish();
    }
  };

  const boot = async (handshake: Handshake) => {
    const handshakeAt = performance.now();
    const problem = validateHandshake(handshake);
    if (problem) throw new Error(`invalid handshake: ${problem}`);
    const app: AppInfo = { dataDir: handshake.appDataDir, version: handshake.appVersion, platform: handshake.platform, debug: handshake.debug };
    const contracts = options.contracts();
    const contractsAt = performance.now();
    const created = new HostRuntime({
      app,
      contracts,
      outbound: { send },
      ...(options.acl ? { acl: options.acl(app) } : {}),
      ...(options.shellTimeoutMs ? { shellTimeoutMs: options.shellTimeoutMs } : {}),
      ...(options.hostCallCaller ? { hostCallCaller: options.hostCallCaller } : {}),
      ...(options.safeMode ? { safeMode: true } : {}),
    });
    created.startup.mark('handshake', handshakeAt);
    created.startup.mark('contracts loaded', contractsAt);
    created.startup.mark('runtime created');
    runtime = created;
    options.onRuntime?.(created);
    await options.load(created, handshake);
    if (closing) return created;
    await finishStartup(created);
    created.startup.mark('finalizers done');
    return created;
  };

  /**
   * 每个 invoke 都必须有 InvokeResponse（API.md §2.3）。结果本身无法经传输层发出（如 release 下结果含函数，
   * structured clone 抛 DataCloneError）时，改发该命令的统一内部错误；连这条也发不出（连接已断）才只记日志。
   */
  const sendResult = (rt: HostRuntime, request: InvokeRequest, response: InvokeResponse) => {
    try {
      send(response);
      return;
    } catch (failure) {
      // 先发兜底回复，再记日志：日志出口出错也不能让前端挂起。
      let fallbackFailure: { error: unknown } | null = null;
      try {
        send({ kind: 'result', id: request.id, ok: false, error: rt.commands._fallbackReply(request.cmd,
          `[dstu-host] command "${request.cmd}" produced a response that cannot be sent to the frontend: ${thrownMessage(failure)}`) });
      } catch (error) {
        fallbackFailure = { error };
      }
      const logger = rt.ctx.logger('connection');
      logger.error(`response to invoke ${request.id} ("${request.cmd}") could not be sent; ${fallbackFailure ? 'the fallback internal error could not be sent either' : 'replied with an internal error instead'}:\n${describeError(failure)}`);
      if (fallbackFailure) logger.error(`fallback response to invoke ${request.id} failed:\n${describeError(fallbackFailure.error)}`);
    }
  };

  const handleInvoke = (rt: HostRuntime, message: InvokeRequest) => {
    const controller = new AbortController();
    invokes.set(message.id, controller);
    rt.dispatchInvoke({
      id: message.id,
      cmd: message.cmd,
      args: message.args,
      ...(message.argsJson !== undefined ? { argsJson: message.argsJson } : {}),
      source: message.source,
      ...(message.headers !== undefined ? { headers: message.headers } : {}),
    }, controller.signal).then((outcome) => {
      invokes.delete(message.id);
      sendResult(rt, message,
        outcome.kind === 'ok' ? { kind: 'result', id: message.id, ok: true, value: outcome.value, ...(outcome.json === undefined ? {} : { json: outcome.json }) }
          : outcome.kind === 'err' ? { kind: 'result', id: message.id, ok: false, error: outcome.error, ...(outcome.json === undefined ? {} : { json: outcome.json }) }
            // RUST-FIX(RF-W01-panic-replies-internal-error): Tauri 中命令 panic 后前端 Promise 永不 settle；这里回复统一内部错误（commands.ts 已带栈记日志）。
            : { kind: 'result', id: message.id, ok: false, error: outcome.reply });
    }, (error: unknown) => {
      // `_dispatch` 不会 reject；保留兜底，确保前端仍收到回复。
      invokes.delete(message.id);
      rt.ctx.logger('connection').error(`dispatch of invoke ${message.id} failed:\n${describeError(error)}`);
      sendResult(rt, message, { kind: 'result', id: message.id, ok: false,
        error: rt.commands._fallbackReply(message.cmd, thrownMessage(error)) });
    });
  };

  const route = (rt: HostRuntime, message: MainToHostMessage) => {
    switch (message.kind) {
      case 'invoke':
        handleInvoke(rt, message);
        return;
      case 'abandon':
        invokes.get(message.id)?.abort(message.reason);
        return;
      case 'frontend-event':
        rt.deliverFrontendEvent(message.event, message.payload, message.source, message.target, message.native === true);
        return;
      case 'window':
        rt.deliverWindow(message);
        return;
      case 'protocol':
        rt.serveProtocol(message, send).catch((error) => rt.ctx.logger('connection').error(`protocol request ${message.id} failed:\n${describeError(error)}`));
        return;
      case 'shell-result':
        if (!rt.resolveShell(message)) rt.ctx.logger('connection').warn(`shell result for unknown or expired request ${message.id}`);
        return;
      case 'shutdown':
        void shutdown();
        return;
      case 'handshake':
        rt.ctx.logger('connection').warn('ignoring repeated handshake');
        return;
      default:
        rt.ctx.logger('connection').warn(`ignoring message of unknown kind ${JSON.stringify((message as { kind: unknown }).kind)}`);
    }
  };

  const shutdown = (): Promise<void> => {
    if (closing) return closing;
    // A shell can close before handshake/HostReady; callers must not wait forever for startup.
    resolveReady(null);
    buffered.length = 0;
    closing = (async () => {
      const current = runtime;
      runtime = null;
      current?.markExiting('shutdown');
      for (const controller of invokes.values()) controller.abort('reloaded');
      let code = 0;
      try {
        if (current) await current.dispose();
      } catch (error) {
        code = 1;
        writeHostStderr(`[dstu-host] shutdown cleanup failed:\n${describeError(error)}\n`);
      } finally {
        transport.close();
        options.exit?.(code);
      }
    })();
    return closing;
  };

  transport.onMessage((raw) => {
    if (closing) return;
    if (!isMessage(raw)) {
      writeHostStderr(`[dstu-host] dropping malformed message: ${JSON.stringify(raw)}\n`);
      return;
    }
    // 启动期间插件 apply 可能在等待 shell 回复，shell-result 不能被缓冲。
    if (runtime && (!booting || raw.kind === 'shell-result')) {
      route(runtime, raw);
      return;
    }
    if (raw.kind === 'shutdown') {
      void shutdown();
      return;
    }
    if (raw.kind !== 'handshake') {
      buffered.push(raw);
      return;
    }
    if (booting) {
      writeHostStderr('[dstu-host] ignoring repeated handshake during boot\n');
      return;
    }
    booting = true;
    boot(raw).then((rt) => {
      booting = false;
      if (closing) return;
      rt.startup.mark('ready');
      rt.ctx.logger('host').info(rt.startup.summary());
      send({ kind: 'ready', protocol: HOST_PROTOCOL_VERSION });
      resolveReady(rt);
      for (const message of buffered.splice(0)) route(rt, message);
    }, (error) => {
      booting = false;
      if (closing) return;
      fatal(error);
    });
  });

  transport.onClose(() => {
    void shutdown();
  });

  return { ready, shutdown };
}
