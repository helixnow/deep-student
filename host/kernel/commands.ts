/**
 * `ctx.commands`：Tauri 命令注册表与 invoke 派发。
 */
import { Service, type Context, type Fiber } from '@deepseek-ai/cordis';
import type { CallContext, CommandHandler, CommandRegistry, WindowRef } from './api.ts';
import { AppError, CommandError, errorDisplay, isAppErrorValue } from './error-model.ts';
import type { CommandContract } from './contract.ts';
import { ContractError, type ContractSet } from './contract-set.ts';
import { commandNotFound } from './errors.ts';
import { findNonJson, hasRawJson, plainWireOutput, toWireJson, type PlainWireOutput } from './json.ts';
import { assertKernelSurface, describeError, isWithin, writeHostStderr, type KernelState } from './kernel.ts';
import { JsonSyntaxError } from '../platform/util/portable.ts';
import { internalJsonValue, parseInvokeJson, plainJsonValue } from './inbound-json.ts';

/**
 * 一次派发的结果。
 * - `ok`：resolve `value`；
 * - `err`：reject `error`（Tauri 框架错误字符串，或 `CommandError.value` / 裸抛的 `AppError` 对象）；
 * - `panic`：处理函数（或派发过程本身）抛出了 `CommandError` / `AppError` 以外的异常，对应 Rust 命令 panic。
 *   Tauri 中这种调用永不 settle（tauri-2.11.5/src/ipc/mod.rs:371-389 只在 `task.await` 正常返回后才
 *   `return_result`）；Host **有意偏离**：kernel 已带栈记录 error 日志，连接层把 `reply`（按命令契约 `error`
 *   形状构造的统一内部错误，见 {@link CommandService._fallbackReply}）作为 InvokeResponse 发出，
 *   前端 Promise 照常 reject。测试宿主把它作为 {@link HandlerPanic} reject，以暴露漏掉的错误映射。
 */
export type InvokeOutcome =
  | { kind: 'ok'; value: unknown; json?: string }
  | { kind: 'err'; error: unknown; json?: string }
  | { kind: 'panic'; error: unknown; reply: unknown };

/**
 * 统一内部错误的候选形状，按顺序取第一个满足命令契约 `error` schema 的：
 * Rust `AppError::unknown`（`From<anyhow::Error>` 同形）、`CommandError::internal`、
 * `DstuError::Internal`，最后是 `Err(String)`。
 */
const FALLBACK_SHAPES: readonly ((message: string) => unknown)[] = [
  (message) => AppError.unknown(message),
  (message) => ({ code: 'INTERNAL_ERROR', message }),
  (message) => ({ type: 'Internal', message }),
  (message) => message,
];

/** 被抛出值的可读文本，作为统一内部错误的 `message`；即插件 API 的 {@link errorDisplay}。 */
export const thrownMessage = errorDisplay;

/** 日志用：`Error` 带栈与 cause 链，其他值带类型与 {@link thrownMessage}。对任何值都不抛错。 */
function describeThrown(error: unknown): string {
  const plain = `thrown ${typeof error}: ${thrownMessage(error)}`;
  try {
    if (!(error instanceof Error)) return plain;
    let text = describeError(error);
    let cause: unknown = error.cause;
    for (let depth = 0; cause !== undefined && depth < 3; depth++) {
      text += `\ncaused by: ${cause instanceof Error ? describeError(cause) : thrownMessage(cause)}`;
      cause = cause instanceof Error ? cause.cause : undefined;
    }
    return text;
  } catch {
    return plain;
  }
}

/**
 * 可以调用 kernel 命令（`plugin:ui|manifest`、`plugin:host|call`、`plugin:host|status`）的 window / webview label：
 * 社区 UI 半与 Host 插件状态同步只在主窗口启动，quick-assistant、pomodoro-mini 用不到这些命令。
 */
export const KERNEL_COMMAND_WINDOWS: readonly string[] = ['main'];

export interface DispatchRequest {
  id: string;
  cmd: string;
  args: unknown;
  /** JSON-only source; same semantics as InvokeRequest.argsJson. */
  argsJson?: string;
  source: WindowRef;
  /** 原始 IPC 请求头；仅 raw-body invoke 提供。 */
  headers?: Record<string, string>;
}

interface InFlight {
  controller: AbortController;
  done: Promise<void>;
  settled: boolean;
}

interface Registration {
  readonly name: string;
  readonly handler: CommandHandler<any, any>;
  readonly fiber: Fiber;
  /** 内核自有命令（`plugin:*`）没有 IPC 契约，参数与结果由处理函数自行校验。 */
  readonly contract?: CommandContract & { file: string };
  readonly kernel?: boolean;
  readonly inflight: Set<InFlight>;
  closed: boolean;
  closing?: Promise<void>;
}

/** 插件停止时中止进行中调用所用的 reason。 */
export class CommandStoppedError extends Error {
  override name = 'CommandStoppedError';
}

/** 运行契约检查；schema 无法编译时把编译错误作为问题描述返回。 */
function contractProblem(check: () => string | null): string | null {
  try {
    return check();
  } catch (error) {
    if (error instanceof ContractError) return error.message;
    throw error;
  }
}

function isCommandError(error: unknown): error is CommandError {
  if (error instanceof CommandError) return true;
  // 同一 api.ts 以不同 URL 被加载两次时 instanceof 失效，按形状识别。
  return typeof error === 'object' && error !== null && (error as Error).name === 'CommandError' && 'value' in error;
}

/**
 * 处理函数抛出的值若对应 Rust `Err(E)`，返回 E 的值：`CommandError.value`，或裸抛的 `AppError`
 * 普通对象（`throw AppError.not_found(...)`，等价 `throw new CommandError(AppError.not_found(...))`）。
 * 其他值返回 `null`；探测本身抛错（如 Proxy 陷阱）同样按“其他值”处理。
 */
function rustErrValue(error: unknown): { value: unknown } | null {
  try {
    if (isCommandError(error)) return { value: error.value === undefined ? null : error.value };
    return isAppErrorValue(error) ? { value: error } : null;
  } catch {
    return null;
  }
}

/** 契约结果标注 `x-binary: true`（Rust 返回 `tauri::ipc::Response`，前端收到 ArrayBuffer）。 */
function isBinaryResultContract(contract: CommandContract | undefined): boolean {
  const result = contract?.result;
  return typeof result === 'object' && result !== null && (result as Record<string, unknown>)['x-binary'] === true;
}

/**
 * F2 `electron/raw-bytes.ts` 使用的 JSON 信封字段。binary 结果在纯 JSON 传输（以及尚未切换的
 * `read_file_bytes`）上仍以 `{ "__dstuRawBytes": "<base64>" }` 表示，main 解码后照常回写 ArrayBuffer。
 */
const RAW_BYTES_FIELD = '__dstuRawBytes';

/** 原始字节：`tauri::ipc::Response` 在 Host 中的等价形态，直接交给传输层（structured clone）。 */
function isRawBytes(value: unknown): value is Uint8Array | ArrayBuffer {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

/** x-binary 成功值的合法形状：原始字节，或兼容 F2 的 `__dstuRawBytes` base64 信封。 */
function binaryResultProblem(value: unknown): string | null {
  if (isRawBytes(value)) return null;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const proto = Object.getPrototypeOf(value);
    if ((proto === Object.prototype || proto === null)
      && typeof (value as Record<string, unknown>)[RAW_BYTES_FIELD] === 'string') return null;
  }
  return `expected Uint8Array/ArrayBuffer or a { "${RAW_BYTES_FIELD}": "<base64>" } envelope`;
}

/**
 * 启动维护态探针：`storage.startupMaintenance()`（platform/storage）。kernel 不依赖平台模块，按形状读取；
 * 返回 `null` 或服务缺失表示不在启动维护态。
 */
interface StartupMaintenanceProbe {
  startupMaintenance?(): { reason: string } | null;
}

/** 降级插件声明的命令：本身没有处理函数，只在启动维护态下给出 MAINTENANCE 错误。 */
interface Placeholder {
  readonly component: string;
  readonly contract: CommandContract & { file: string };
}

/**
 * 按命令错误契约选择 MAINTENANCE 错误的形状。文本沿用 Rust `VfsError::Maintenance`
 * （`MAINTENANCE_MODE: {component} is temporarily unavailable`）；契约都不匹配时退回纯字符串。
 */
function maintenanceError(contracts: ContractSet, contract: Placeholder['contract'], component: string, reason: string): unknown {
  const message = `MAINTENANCE_MODE: ${component} is temporarily unavailable`;
  const data = { code: 'MAINTENANCE', component, reason };
  const shapes: unknown[] = [
    message,
    { error_type: 'Database', message, details: data },
    { code: 'MAINTENANCE', message, data },
    { type: 'VfsError', message },
  ];
  if (contract.error === undefined) return message;
  return shapes.find((shape) => contractProblem(() => contracts.checkError(contract, shape)) === null) ?? message;
}

export class CommandService extends Service implements CommandRegistry {
  _kernel: KernelState;
  _registrations = new Map<string, Registration>();
  _placeholders = new Map<string, Placeholder>();

  constructor(ctx: Context, kernel: KernelState) {
    super(ctx, 'commands');
    this._kernel = kernel;
  }

  register<A = Record<string, unknown>, R = unknown>(name: string, handler: CommandHandler<A, R>): void {
    if (typeof name !== 'string' || !name) throw new TypeError('ctx.commands.register: command name must be a non-empty string');
    if (typeof handler !== 'function') throw new TypeError(`ctx.commands.register("${name}"): handler must be a function`);
    const ctx = this.ctx;
    assertKernelSurface(this._kernel, ctx.fiber, `ctx.commands.register("${name}")`);
    const contract = this._kernel.contracts.get(name);
    if (!contract) {
      throw new Error(`ctx.commands.register("${name}"): no contract for this command in contracts/ipc (commands must exist in Rust and be extracted by F5)`);
    }
    const owner = this._kernel.ownerOf(ctx.fiber);
    if (owner && !(owner.plugin.meta.commands ?? []).includes(name)) {
      throw new Error(`ctx.commands.register("${name}"): plugin "${owner.id}" does not declare this command in meta.commands`);
    }
    ctx.effect(() => {
      const existing = this._registrations.get(name);
      if (existing) {
        const by = this._kernel.ownerOf(existing.fiber)?.id ?? existing.fiber.name;
        throw new Error(`ctx.commands.register("${name}"): command is already registered by "${by}"`);
      }
      const registration: Registration = { name, handler, fiber: ctx.fiber, contract, inflight: new Set(), closed: false };
      this._registrations.set(name, registration);
      return async () => {
        await this._close(registration);
        if (this._registrations.get(name) === registration) this._registrations.delete(name);
      };
    }, `ctx.commands.register(${JSON.stringify(name)})`);
  }

  has(name: string): boolean {
    const registration = this._registrations.get(name);
    return !!registration && !registration.closed;
  }

  /**
   * 注册 kernel 自有命令（`plugin:ui|manifest`、`plugin:host|call`）。
   * 这些命令不是 Rust 命令、不在 `contracts/ipc` 的 `commands` 段（只登记在 `hostNative` 段）：参数校验由处理函数完成，
   * 只对本地应用窗口开放（ACL 不包含它们）。
   */
  _registerKernel<A = Record<string, unknown>, R = unknown>(name: string, handler: CommandHandler<A, R>): void {
    if (typeof name !== 'string' || !name) throw new TypeError('ctx.commands._registerKernel: command name must be a non-empty string');
    if (typeof handler !== 'function') throw new TypeError(`ctx.commands._registerKernel("${name}"): handler must be a function`);
    const ctx = this.ctx;
    ctx.effect(() => {
      if (this._registrations.has(name)) throw new Error(`ctx.commands._registerKernel("${name}"): command is already registered`);
      const registration: Registration = { name, handler, fiber: ctx.fiber, inflight: new Set(), closed: false, kernel: true };
      this._registrations.set(name, registration);
      return async () => {
        await this._close(registration);
        if (this._registrations.get(name) === registration) this._registrations.delete(name);
      };
    }, `ctx.commands._registerKernel(${JSON.stringify(name)})`);
  }

  /**
   * 用本次 profile 装配的降级插件替换维护占位命令（见 `installProfile`）。
   * 占位不进入 `_registrations`：同名真实命令随时可注册且优先派发，占位自动让位。
   */
  _setPlaceholders(plugins: readonly { id: string; commands: readonly string[] }[]): void {
    this._placeholders.clear();
    for (const { id, commands } of plugins) {
      const component = id.startsWith('dstu.') ? id.slice('dstu.'.length) : id;
      for (const name of commands) {
        const contract = this._kernel.contracts.get(name);
        if (contract) this._placeholders.set(name, { component, contract });
      }
    }
  }

  /** 未注册命令的维护占位结果；不在启动维护态或没有占位时返回 `null`（照常 command not found）。 */
  _placeholderOutcome(request: DispatchRequest, debug: boolean): InvokeOutcome | null {
    const placeholder = this._placeholders.get(request.cmd);
    if (!placeholder) return null;
    const storage = this._kernel.root.get('storage') as unknown as StartupMaintenanceProbe | undefined;
    const maintenance = typeof storage?.startupMaintenance === 'function' ? storage.startupMaintenance() : null;
    if (!maintenance) return null;
    const denial = this._kernel.acl?.denial(request.cmd, request.source, debug);
    if (denial) return { kind: 'err', error: denial };
    return { kind: 'err', error: maintenanceError(this._kernel.contracts, placeholder.contract, placeholder.component, maintenance.reason) };
  }

  /** 当前已注册（未关闭）的命令名及其所属 fiber。 */
  _entries(): { name: string; fiber: Fiber; kernel: boolean }[] {
    return [...this._registrations.values()].filter((r) => !r.closed).map((r) => ({ name: r.name, fiber: r.fiber, kernel: r.kernel === true }));
  }

  /**
   * 停止语义第 1–3 步：拒绝新调用 → 中止进行中调用 → 等待它们结束，最多 `commandCloseTimeoutMs`。
   * 不理 abort 的处理器超时后被 detached（记 warn，结果照常回给调用方），插件照常停止。重复调用返回同一个 Promise。
   */
  _close(registration: Registration): Promise<void> {
    return (registration.closing ??= this._drain(registration));
  }

  private async _drain(registration: Registration): Promise<void> {
    registration.closed = true;
    const pending = [...registration.inflight];
    if (pending.length === 0) return;
    for (const call of pending) {
      call.controller.abort(new CommandStoppedError(`command "${registration.name}" is being unregistered`));
    }
    const timeoutMs = this._kernel.commandCloseTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      Promise.allSettled(pending.map((call) => call.done)).then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    if (!timedOut) return;
    const stuck = pending.filter((call) => !call.settled).length;
    this._kernel.root.logger('commands').warn(
      `command "${registration.name}": ${stuck} in-flight call(s) ignored the abort for ${timeoutMs}ms; detached, stopping without waiting for them`);
  }

  /** 关闭 `root` fiber 子树拥有的全部命令（插件停止的前半段）。 */
  async _closeOwnedBy(root: Fiber): Promise<void> {
    const owned = [...this._registrations.values()].filter((r) => isWithin(r.fiber, root));
    await Promise.all(owned.map((r) => this._close(r)));
  }

  /**
   * 命令 `cmd` 的统一内部错误：kernel 命令（`plugin:*`，自身错误均为 AppError）→ `AppError` Unknown；
   * 契约有 `error` schema → {@link FALLBACK_SHAPES} 中第一个通过校验的形状；命令在 Rust 中不返回
   * `Result`、契约缺失或 schema 无法编译 → 字符串 `message`。返回值总是 plain JSON。
   */
  _fallbackReply(cmd: string, message: string): unknown {
    const registration = this._registrations.get(cmd);
    if (registration?.kernel) return AppError.unknown(message);
    const contract = registration?.contract ?? this._kernel.contracts.get(cmd);
    if (contract?.error === undefined) return message;
    for (const shape of FALLBACK_SHAPES) {
      const candidate = shape(message);
      try {
        if (this._kernel.contracts.checkError(contract, candidate) === null) return candidate;
      } catch {
        return message;
      }
    }
    return message;
  }

  /**
   * 派发一次 invoke。所有入口（MessagePort 连接、测试宿主）都走这里。
   * `signal` 为调用方放弃等待（InvokeAbandon）的信号。
   *
   * 永不 reject：处理函数或派发过程抛出的任何意外值都变成 `panic` 结果（带统一错误 `reply`），
   * 保证连接层总能回复 InvokeResponse、前端 Promise 总会 settle。
   */
  async _dispatch(request: DispatchRequest, signal?: AbortSignal): Promise<InvokeOutcome> {
    let outcome: InvokeOutcome;
    try {
      outcome = await this._dispatchOnce(request, signal);
    } catch (error) {
      outcome = this._unhandled(request, error, 'failed inside the kernel dispatch');
    }
    if (outcome.kind !== 'ok' && !signal?.aborted) {
      try {
        const log = this._kernel.root.reflect.get('log', false) as undefined | {
          recordError(event: { source: 'host'; operation: string; id: string; pluginId?: string; window: string; error: unknown }): Promise<void>;
        };
        const registration = this._registrations.get(request.cmd);
        const owner = registration && this._kernel.ownerOf(registration.fiber);
        await log?.recordError({ source: 'host', id: request.id, operation: request.cmd, pluginId: owner?.id,
          window: request.source.window, error: outcome.kind === 'panic' ? outcome.reply : outcome.error });
      } catch (error) {
        writeHostStderr('[dstu-host] could not record command failure: ' + thrownMessage(error) + '\n');
      }
    }
    return outcome;
  }

  /** 意外异常：带栈记 error 日志，回复统一内部错误。 */
  // RUST-FIX(RF-W01-panic-replies-internal-error): Tauri 中 panic 的命令永不回复；这里构造统一内部错误交给连接层。
  _unhandled(request: DispatchRequest, error: unknown, what: string): InvokeOutcome {
    const reply = this._fallbackReply(request.cmd, thrownMessage(error));
    const text = `command "${request.cmd}" (invoke ${request.id}) ${what}; replying with an internal error instead of leaving the frontend promise pending (Rust would panic):\n${describeThrown(error)}`;
    try {
      this._kernel.root.logger('commands').error(text);
    } catch (logError) {
      // 日志 exporter 自身失败不能阻止回复。
      writeHostStderr(`[dstu-host] error [commands] ${text}\n[dstu-host] (logger failed: ${thrownMessage(logError)})\n`);
    }
    return { kind: 'panic', error, reply };
  }

  private async _dispatchOnce(request: DispatchRequest, signal?: AbortSignal): Promise<InvokeOutcome> {
    const debug = this._kernel.app.debug;
    const registration = this._registrations.get(request.cmd);
    if (!registration || registration.closed) {
      return this._placeholderOutcome(request, debug) ?? { kind: 'err', error: commandNotFound(request.cmd, debug) };
    }
    if (registration.kernel) {
      // kernel 命令不在 ACL 权限表中，只对白名单窗口里的本地应用页面开放（remote 页面一律拒绝，SEC-E11）。
      const { origin, window, webview } = request.source;
      if ((origin ?? 'local') !== 'local' || !KERNEL_COMMAND_WINDOWS.includes(window) || !KERNEL_COMMAND_WINDOWS.includes(webview)) {
        return { kind: 'err', error: `Command ${request.cmd} not allowed by ACL` };
      }
    } else {
      const denial = this._kernel.acl?.denial(request.cmd, request.source, debug);
      if (denial) return { kind: 'err', error: denial };
    }

    const { contract } = registration;
    const logger = this._kernel.root.logger('commands');
    let payload = request.args;
    const exactJson = request.argsJson !== undefined && !(payload instanceof ArrayBuffer) && !ArrayBuffer.isView(payload);
    if (exactJson) {
      if (typeof request.argsJson !== 'string') return { kind: 'err', error: '[dstu-host] invalid argsJson: expected a string' };
      try { payload = parseInvokeJson(request.argsJson); }
      catch (error) {
        if (!(error instanceof JsonSyntaxError)) throw error;
        return { kind: 'err', error: `[dstu-host] invalid argsJson: ${error.message}` };
      }
    }
    let checked: ReturnType<ContractSet['checkArgs']>;
    if (registration.kernel) {
      // 内核命令没有 IPC 契约：形状与 JSON 可序列化由处理函数自己校验。
      checked = { ok: true, args: (exactJson ? plainJsonValue(payload) : payload) as Record<string, unknown> };
    } else {
      try {
        checked = this._kernel.contracts.checkArgs(contract!, payload, exactJson);
      } catch (error) {
        // 契约 schema 无法编译：属于契约缺陷，明确拒绝而不是让前端挂起。
        if (!(error instanceof ContractError)) throw error;
        logger.error(error.message);
        return { kind: 'err', error: `[dstu-host] ${error.message}` };
      }
    }
    if (!checked.ok) return { kind: 'err', error: checked.error };

    const controller = new AbortController();
    const onAbandon = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbandon();
    else signal?.addEventListener('abort', onAbandon, { once: true });

    let settle!: () => void;
    const call: InFlight = { controller, done: new Promise<void>((resolve) => (settle = resolve)), settled: false };
    registration.inflight.add(call);
    const parsed = payload;
    let exact: { value: unknown } | undefined;
    const context: CallContext = Object.freeze({
      source: Object.freeze({ ...request.source }),
      signal: controller.signal,
      invokeId: request.id,
      payload: exactJson ? plainJsonValue(parsed) : parsed,
      exactPayload: () => (exact ??= { value: exactJson ? internalJsonValue(parsed) : parsed }).value,
      ...(request.headers !== undefined ? { headers: Object.freeze({ ...request.headers }) } : {}),
    });
    try {
      const invoke = () => registration.handler(checked.args, context);
      // RUST-FIX(RF-P1-managed-plugin-install): Enter the registered plugin owner, not the object reader's context.
      let value: unknown = await (this._kernel.execution ? this._kernel.execution.run(registration.fiber, invoke) : invoke());
      if (value === undefined) value = null;
      const binary = !registration.kernel && isBinaryResultContract(contract);
      if (binary) {
        // X2-R05：`tauri::ipc::Response` 的字节不经 JSON 复制，原样交给传输层（MessagePort / IPC 的
        // structured clone），main 的 encodeBody 会把它作为 raw body 回写，前端收到 ArrayBuffer。
        if (debug) {
          const problem = binaryResultProblem(value);
          if (problem) {
            const message = `[dstu-host] command "${request.cmd}" returned a binary result that violates its contract (${contract!.file}): ${problem}`;
            logger.error(message);
            return { kind: 'err', error: message };
          }
        }
        return { kind: 'ok', value: isRawBytes(value) ? value : toWireJson(value) };
      }
      // D3：内部值保持原样（BigInt 不提前 Number 化），只在返回前复制成线上 JSON。
      const raw = hasRawJson(value);
      const nonJson = debug && !registration.kernel ? findNonJson(value, '$', new Set(), raw) : null;
      const wire: PlainWireOutput = nonJson === null ? plainWireOutput(value, raw) : { value: undefined };
      if (wire.projection) logger.warn(`[dstu-host] command "${request.cmd}" returned a value that is not plain JSON: ${wire.projection}`);
      const wireValue = wire.value;
      if (debug && !registration.kernel) {
        const problem = nonJson ?? contractProblem(() => this._kernel.contracts.checkResult(contract!, wireValue));
        if (problem) {
          const message = `[dstu-host] command "${request.cmd}" returned a value that violates its contract (${contract!.file}): ${problem}`;
          logger.error(message);
          return { kind: 'err', error: message };
        }
      }
      return { kind: 'ok', value: wireValue, ...(wire.json === undefined ? {} : { json: wire.json }) };
    } catch (error) {
      const rustErr = rustErrValue(error);
      if (rustErr) {
        const { value } = rustErr;
        const raw = hasRawJson(value);
        const nonJson = debug && !registration.kernel ? findNonJson(value, '$', new Set(), raw) : null;
        const wire: PlainWireOutput = nonJson === null ? plainWireOutput(value, raw) : { value: undefined };
        if (wire.projection) logger.warn(`[dstu-host] command "${request.cmd}" rejected with a value that is not plain JSON: ${wire.projection}`);
        const wireValue = wire.value;
        if (debug && !registration.kernel) {
          const problem = nonJson ?? contractProblem(() => this._kernel.contracts.checkError(contract!, wireValue));
          if (problem) {
            const message = `[dstu-host] command "${request.cmd}" rejected with a value that violates its contract (${contract!.file}): ${problem}`;
            logger.error(message);
            return { kind: 'err', error: message };
          }
        }
        return { kind: 'err', error: wireValue, ...(wire.json === undefined ? {} : { json: wire.json }) };
      }
      return this._unhandled(request, error, 'threw a value that is neither CommandError nor AppError');
    } finally {
      signal?.removeEventListener('abort', onAbandon);
      registration.inflight.delete(call);
      call.settled = true;
      settle();
    }
  }
}
