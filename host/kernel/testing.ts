/**
 * 测试宿主：在单个 Node 进程内运行真实的 kernel（同一套命令注册表、契约校验、Tauri 错误、事件、协议、
 * 插件生命周期），不需要 Electron，也不需要其他 lane 的实现。
 *
 * 这是**唯一**允许为其他 lane 的服务提供测试替身的地方（`provide` 选项）。用法见 API.md「测试」。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Service, type Context } from '@deepseek-ai/cordis';
import type { AppInfo, HostPlugin, WindowRef } from './api.ts';
import type { CapabilityAcl } from './acl.ts';
import type { JsonSchema, LaneContract } from './contract.ts';
import { thrownMessage } from './commands.ts';
import { ContractSet, type ContractSource } from './contracts.ts';
import { ContractSet as PortableContractSet } from './contract-set.ts';
import type { CoverageReport } from './coverage.ts';
import { HostRuntime, type HostCallCallerMode, type InstalledPlugin } from './runtime.ts';
import type { BackendEvent, EventTarget, HostToMain, ProtocolChunk, ProtocolResponse, ShellRequest, WindowLifecycle } from './protocol.ts';

export { CommandError, definePlugin } from './api.ts';
export type { HostRuntime, InstalledPlugin } from './runtime.ts';

/**
 * 测试中 invoke 的处理函数 panic：抛出了 `CommandError` / 裸 `AppError` 以外的值（Rust 中对应 panic）。
 * 生产中前端 Promise 以 {@link HandlerPanic.reply}（统一内部错误）reject；测试宿主改抛本类，
 * 让漏掉的 Rust `Err` 映射在断言中可见。
 */
export class HandlerPanic extends Error {
  override name = 'HandlerPanic';
  /** 生产连接层发给前端的 reject 值（按命令契约 `error` 形状构造，见 API.md §2.3）。 */
  readonly reply: unknown;
  constructor(cmd: string, cause: unknown, reply?: unknown) {
    super(`command "${cmd}" panicked (in production the frontend promise rejects with the unified internal error): ${thrownMessage(cause)}`, { cause });
    this.reply = reply;
  }
}

export type TestPluginEntry = HostPlugin<any> | readonly [plugin: HostPlugin<any>, config: unknown];

export interface TestHostOptions {
  acl?: CapabilityAcl;
  /** 按顺序安装的插件；`[plugin, config]` 传配置。任一失败则整体回滚并让 createTestHost reject。 */
  plugins?: readonly TestPluginEntry[];
  /**
   * 其他 lane 服务的测试替身：`{ 服务名: 实现 }`。实现可以是普通对象（直接 `ctx.provide`），
   * 也可以是 Cordis `Service` 子类（作为插件启动，构造函数中 `super(ctx, 服务名)`）。
   * 在插件安装之前提供。
   */
  provide?: Record<string, unknown>;
  /**
   * 契约：
   * - 省略：读取仓库 `contracts/ipc`；
   * - `LaneContract[]` / `ContractSource[]`：叠加在仓库契约之上（同名命令以这里为准）；
   * - `{ only: [...] }`：只用给出的契约，不读仓库；
   * - `ContractSet`：原样使用。
   */
  contracts?: readonly (LaneContract | ContractSource)[] | { only: readonly (LaneContract | ContractSource)[] } | ContractSet;
  /** 覆盖应用信息。默认 `debug: true`、`dataDir` 为本次新建的临时目录（dispose 时删除）。 */
  app?: Partial<AppInfo>;
  /** 默认调用来源窗口，默认 `{ window: 'main', webview: 'main' }`。 */
  source?: WindowRef;
  /** 回答 `ctx.shell.request`；省略时 shell 请求以错误回复（走真实的 ShellResponse 路径）。 */
  shell?: (op: string, args: unknown) => unknown | Promise<unknown>;
  /** shell 请求超时，默认 30 秒。 */
  shellTimeoutMs?: number;
  /** `plugin:host|call` 缺 `caller` 时的处理；默认与生产相同（`DEFAULT_HOST_CALL_CALLER_MODE`）。 */
  hostCallCaller?: HostCallCallerMode;
  /** 卸载/关停时等待在途命令响应 abort 的上限；默认与生产相同（`COMMAND_CLOSE_TIMEOUT_MS`）。 */
  commandCloseTimeoutMs?: number;
}

export interface InvokeOptions {
  /**
   * 是否像 Electron main 一样带 `argsJson: JSON.stringify(args)`（生产路径，V08-02）。
   * 省略：参数能无损写成 JSON（只含 plain 对象、数组、字符串、有限数字、布尔、null、`JSON.rawJSON` 原子）时带，
   * 否则（字节、bigint、`undefined` 值、Date、Map、类实例、NaN…）走对象路径；`false`：总走对象路径（同 `invokeRaw`）。
   */
  exactJson?: boolean;
}

export interface PendingInvoke<T = unknown> {
  readonly id: string;
  /** 与前端 `invoke()` 的 Promise 相同：resolve 成功值，reject 前端看到的错误值；panic 时 reject {@link HandlerPanic}。 */
  readonly result: Promise<T>;
  /** 模拟 InvokeAbandon（窗口关闭 / 页面重载）：中止 `CallContext.signal`。 */
  abandon(reason?: 'window-closed' | 'reloaded'): void;
}

export interface ProtocolResult {
  status: number;
  headers: Record<string, string>;
  /** 拼接后的完整响应体。 */
  body: Uint8Array;
  /** 原始消息序列（头 + 分块），用于断言分块行为。 */
  messages: (ProtocolResponse | ProtocolChunk)[];
  /** 流式响应体中途失败时的错误文本。 */
  error?: string;
  /** 响应体按 UTF-8 解码。 */
  text(): string;
}

export interface TestHost {
  /** 根 Context（kernel 服务所在）。 */
  readonly ctx: Context;
  readonly runtime: HostRuntime;
  readonly app: AppInfo;
  /** 已安装插件。 */
  readonly plugins: readonly InstalledPlugin[];
  /**
   * 与前端 `invoke(cmd, args)` 等价，走真实的注册表、契约校验与错误路径。JSON 安全的参数默认带 `argsJson`，
   * 与生产相同（见 {@link InvokeOptions}）。
   */
  invoke<T = unknown>(cmd: string, args?: unknown, source?: WindowRef, options?: InvokeOptions): Promise<T>;
  /** 同 invoke，但总走对象路径（不带 `argsJson`）：只给专门测试旧路径或需要传非 JSON 参数的用例。 */
  invokeRaw<T = unknown>(cmd: string, args?: unknown, source?: WindowRef): Promise<T>;
  /** 同 invoke，但返回可 abandon 的句柄。 */
  startInvoke<T = unknown>(cmd: string, args?: unknown, source?: WindowRef, options?: InvokeOptions): PendingInvoke<T>;
  /** 模拟前端 `emit(event, payload)`（或 `emitTo`，给出 target）。 */
  emitFrontend(event: string, payload?: unknown, source?: WindowRef, target?: EventTarget): void;
  /** 模拟 main 自己产生的原生回调（`FrontendEvent.native: true`，target App）：监听者收到的 `source.native` 为 true。 */
  emitNative(event: string, payload?: unknown, source?: WindowRef): void;
  /** 模拟窗口生命周期消息（派发 Cordis 事件 `host/window`）。 */
  window(ref: WindowRef, state: WindowLifecycle['state']): void;
  /** 后端发往前端的全部事件，按发送顺序。可以直接清空（`events.length = 0`）。 */
  readonly events: BackendEvent[];
  /** 按事件名取出已发送事件的载荷。 */
  eventsNamed(event: string): unknown[];
  /** Host 发出的全部 shell 请求。 */
  readonly shellRequests: ShellRequest[];
  /** 发起一次自定义协议请求并收集完整响应。 */
  protocol(scheme: string, url: string, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array }): Promise<ProtocolResult>;
  /** 安装更多插件（`installAll`：任一失败整批回滚；profile 装载请用 `profile.ts::loadProfile`）。 */
  install(...plugins: TestPluginEntry[]): Promise<InstalledPlugin[]>;
  /** 卸载插件（仍被依赖时抛错）。 */
  unload(id: string): Promise<void>;
  /** 覆盖检查（已安装插件 vs 契约 vs 实际注册）。 */
  coverage(): CoverageReport;
  /** 停止全部插件并删除临时数据目录。 */
  dispose(): Promise<void>;
}

const DEFAULT_SOURCE: WindowRef = Object.freeze({ window: 'main', webview: 'main' });

function toSource(value: LaneContract | ContractSource, index: number): ContractSource {
  if ('contract' in value && 'file' in value) return value;
  const lane = value as LaneContract;
  return { file: `${lane.lane || `fixture-${index}`}.json`, contract: lane };
}

function resolveContracts(option: TestHostOptions['contracts']): ContractSet {
  if (option instanceof PortableContractSet) return option;
  if (option === undefined) return ContractSet.fromDirectory();
  if ('only' in option) return new ContractSet(option.only.map(toSource));
  return ContractSet.fromDirectory().with((option as readonly (LaneContract | ContractSource)[]).map(toSource));
}

function isServiceClass(value: unknown): value is new (ctx: Context) => Service {
  return typeof value === 'function' && value.prototype instanceof Service;
}

function platformOf(): AppInfo['platform'] {
  return process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
}

let invokeCounter = 0;

const nativeJson = JSON as typeof JSON & { isRawJSON(value: unknown): boolean };

/** `JSON.stringify(value)` 能否得到前端会发出的、与对象等价的参数文本。 */
function isJsonSafe(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (nativeJson.isRawJSON(value)) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) if (!(i in value) || !isJsonSafe(value[i], seen)) return false;
      return true;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value).every((item) => isJsonSafe(item, seen));
  } finally {
    seen.delete(value);
  }
}

/** 创建测试宿主。 */
export async function createTestHost(options: TestHostOptions = {}): Promise<TestHost> {
  const ownDataDir = options.app?.dataDir === undefined ? mkdtempSync(join(tmpdir(), 'dstu-test-host-')) : undefined;
  const app: AppInfo = {
    dataDir: options.app?.dataDir ?? ownDataDir!,
    version: options.app?.version ?? '0.0.0-test',
    platform: options.app?.platform ?? platformOf(),
    debug: options.app?.debug ?? true,
  };
  const events: BackendEvent[] = [];
  const shellRequests: ShellRequest[] = [];
  const protocolSinks = new Map<string, (message: ProtocolResponse | ProtocolChunk) => void>();
  let runtime!: HostRuntime;

  const answerShell = (request: ShellRequest) => {
    const respond = async () => {
      if (!options.shell) throw new Error(`test host has no shell handler for "${request.op}" (pass options.shell)`);
      return options.shell(request.op, request.args);
    };
    respond().then(
      (value) => runtime.resolveShell({ kind: 'shell-result', id: request.id, ok: true, value: value === undefined ? null : value }),
      (error: unknown) => runtime.resolveShell({ kind: 'shell-result', id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  };

  const outbound = {
    send(message: HostToMain) {
      switch (message.kind) {
        case 'event':
          events.push(message);
          return;
        case 'shell-request':
          shellRequests.push(message);
          queueMicrotask(() => answerShell(message));
          return;
        case 'protocol-result':
        case 'protocol-chunk':
          protocolSinks.get(message.id)?.(message);
          return;
        default:
          throw new Error(`test host: unexpected outbound message ${message.kind}`);
      }
    },
  };

  runtime = new HostRuntime({
    ...(options.acl ? { acl: options.acl } : {}),
    app,
    contracts: resolveContracts(options.contracts),
    outbound,
    ...(options.shellTimeoutMs ? { shellTimeoutMs: options.shellTimeoutMs } : {}),
    ...(options.hostCallCaller ? { hostCallCaller: options.hostCallCaller } : {}),
    ...(options.commandCloseTimeoutMs !== undefined ? { commandCloseTimeoutMs: options.commandCloseTimeoutMs } : {}),
  });
  const defaultSource = options.source ?? DEFAULT_SOURCE;

  const cleanup = () => {
    if (ownDataDir) rmSync(ownDataDir, { recursive: true, force: true });
  };

  const toInstalls = (entries: readonly TestPluginEntry[]) =>
    entries.map((entry) => (Array.isArray(entry) ? { plugin: entry[0] as HostPlugin<any>, config: entry[1] } : { plugin: entry as HostPlugin<any> }));

  try {
    for (const [name, impl] of Object.entries(options.provide ?? {})) {
      if (isServiceClass(impl)) {
        await runtime.ctx.plugin(impl);
        if (runtime.ctx.get(name) === undefined) throw new Error(`createTestHost: provide.${name} is a Service class that did not register "${name}" (call super(ctx, '${name}'))`);
      } else {
        runtime.ctx.provide(name, impl);
      }
    }
    await runtime.installAll(toInstalls(options.plugins ?? []));
  } catch (error) {
    try {
      await runtime.dispose();
    } catch (disposeError) {
      throw new AggregateError([error, disposeError], `createTestHost failed and cleanup reported errors: ${String(error)}`);
    } finally {
      cleanup();
    }
    throw error;
  }

  const startInvoke = <T>(cmd: string, args: unknown = {}, source: WindowRef = defaultSource, options: InvokeOptions = {}): PendingInvoke<T> => {
    const id = `test-invoke-${++invokeCounter}`;
    const controller = new AbortController();
    const exactJson = options.exactJson ?? isJsonSafe(args);
    const request = exactJson ? { id, cmd, args, argsJson: JSON.stringify(args), source } : { id, cmd, args, source };
    const result = runtime.dispatchInvoke(request, controller.signal).then((outcome) => {
      if (outcome.kind === 'ok') return outcome.value as T;
      if (outcome.kind === 'err') throw outcome.error;
      throw new HandlerPanic(cmd, outcome.error, outcome.reply);
    });
    return { id, result, abandon: (reason = 'window-closed') => controller.abort(reason) };
  };

  let protocolCounter = 0;
  const host: TestHost = {
    ctx: runtime.ctx,
    runtime,
    app: runtime.app,
    get plugins() {
      return runtime.plugins();
    },
    invoke: <T,>(cmd: string, args?: unknown, source?: WindowRef, options?: InvokeOptions) => startInvoke<T>(cmd, args, source, options).result,
    invokeRaw: <T,>(cmd: string, args?: unknown, source?: WindowRef) => startInvoke<T>(cmd, args, source, { exactJson: false }).result,
    startInvoke,
    emitFrontend(event, payload = null, source = defaultSource, target = { kind: 'Any' }) {
      runtime.deliverFrontendEvent(event, payload, source, target);
    },
    emitNative(event, payload = null, source = defaultSource) {
      runtime.deliverFrontendEvent(event, payload, source, { kind: 'App' }, true);
    },
    window(ref, state) {
      runtime.deliverWindow({ ref, state });
    },
    events,
    eventsNamed: (event) => events.filter((e) => e.event === event).map((e) => e.payload),
    shellRequests,
    protocol(scheme, url, init = {}) {
      const id = `test-protocol-${++protocolCounter}`;
      const messages: (ProtocolResponse | ProtocolChunk)[] = [];
      return new Promise<ProtocolResult>((resolve, reject) => {
        protocolSinks.set(id, (message) => {
          messages.push(message);
          if (!message.final) return;
          protocolSinks.delete(id);
          const head = messages[0] as ProtocolResponse;
          const parts = messages.map((m) => m.body);
          const total = parts.reduce((n, p) => n + p.byteLength, 0);
          const body = new Uint8Array(total);
          let offset = 0;
          for (const part of parts) {
            body.set(part, offset);
            offset += part.byteLength;
          }
          const error = message.kind === 'protocol-chunk' ? message.error : undefined;
          resolve({ status: head.status, headers: head.headers, body, messages, ...(error !== undefined ? { error } : {}), text: () => new TextDecoder().decode(body) });
        });
        runtime
          .serveProtocol({ kind: 'protocol', id, scheme, url, method: init.method ?? 'GET', headers: init.headers ?? {}, ...(init.body ? { body: init.body } : {}) }, outbound.send)
          .catch((error: unknown) => {
            protocolSinks.delete(id);
            reject(error);
          });
      });
    },
    install: (...plugins) => runtime.installAll(toInstalls(plugins)),
    unload: (id) => runtime.unload(id),
    coverage: () => runtime.coverage(),
    async dispose() {
      try {
        await runtime.dispose();
      } finally {
        cleanup();
      }
    },
  };
  return host;
}

/**
 * 命令 `name` 的最小契约参数：每个必填参数取 schema 接受的最小值（字符串 `'x'`、数字 `max(1, minimum)`、
 * 布尔 `false`、数组 `[]`、对象只填 required 键、`const` / `enum` 取首个、联合取首个非 null 分支），可选参数省略。
 * 多数命令会把这些值当作无效 id 或不存在的记录拒绝，正好走到 Err 路径。
 */
export function minimalCommandArgs(contracts: PortableContractSet, name: string): Record<string, unknown> {
  const contract = contracts.get(name);
  if (!contract) throw new Error(`minimalCommandArgs: command "${name}" is not in the contracts`);
  const minimal = (schema: JsonSchema | boolean | undefined, base: string, depth: number): unknown => {
    if (schema === undefined || typeof schema === 'boolean' || depth > 6) return null;
    if (typeof schema.$ref === 'string') {
      const target = contracts.resolveRef(schema.$ref, base);
      return target ? minimal(target.schema, target.base, depth + 1) : null;
    }
    if (schema.const !== undefined) return schema.const;
    if (Array.isArray(schema.enum)) return schema.enum[0];
    const alternatives = (schema.oneOf ?? schema.anyOf) as (JsonSchema | boolean)[] | undefined;
    if (alternatives) {
      const pick = alternatives.find((item) => typeof item === 'object' && item.type !== 'null') ?? alternatives[0];
      return minimal(pick, base, depth + 1);
    }
    const type = Array.isArray(schema.type) ? (schema.type as string[]).find((item) => item !== 'null') : schema.type;
    if (type === 'string') return 'x';
    if (type === 'integer' || type === 'number') return Math.max(1, typeof schema.minimum === 'number' ? schema.minimum : 1);
    if (type === 'boolean') return false;
    if (type === 'array') return [];
    if (type === 'object' || schema.properties) {
      const properties = (schema.properties ?? {}) as Record<string, JsonSchema | boolean>;
      const value: Record<string, unknown> = {};
      for (const key of (schema.required ?? []) as string[]) value[key] = minimal(properties[key], base, depth + 1);
      return value;
    }
    return null;
  };
  const base = contracts.schemaBase(contract);
  const args: Record<string, unknown> = {};
  for (const arg of contract.args) if (!arg.optional) args[arg.key] = minimal(arg.schema, base, 0);
  return args;
}

/**
 * 一次 invoke 的结局：`ok`；`classified`（reject 的值通过了契约 `error` 校验）；`unclassified`（处理函数抛出
 * `CommandError` / `AppError` 以外的值，生产中前端只拿到统一内部错误）；`contract`（debug 下的契约违规诊断）；
 * `did not settle`（`timeoutMs` 内没有 settle）。
 */
export type CommandErrorOutcome = 'ok' | 'classified' | 'did not settle' | `unclassified: ${string}` | `contract: ${string}`;

export async function commandErrorOutcome(invoke: Promise<unknown>, timeoutMs = 5_000): Promise<CommandErrorOutcome> {
  const settled = invoke.then((): CommandErrorOutcome => 'ok', (error: unknown): CommandErrorOutcome => {
    if (error instanceof HandlerPanic) return `unclassified: ${thrownMessage(error.cause)}`;
    if (typeof error === 'string' && error.startsWith('[dstu-host] command')) return `contract: ${error}`;
    return 'classified';
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<CommandErrorOutcome>((resolve) => { timer = setTimeout(() => resolve('did not settle'), timeoutMs); });
  try {
    return await Promise.race([settled, hung]);
  } finally {
    clearTimeout(timer);
  }
}

export interface CommandErrorSettleOptions {
  /** 不调用的命令（触达网络、模型、音频或长时间后台任务的），每条都应能说明原因。 */
  exclude?: Iterable<string>;
  /** 某些命令的参数；返回 `undefined` 时用 {@link minimalCommandArgs}。 */
  args?: (command: string) => Record<string, unknown> | undefined;
  /** 每次 invoke 的 settle 上限，默认 5000 ms。 */
  timeoutMs?: number;
}

/**
 * 命令错误动态守卫（API.md §2.3.1）：依次 invoke `plugins` 声明的每个命令（`exclude` 除外），返回结局不是
 * `ok` / `classified` 的条目 `"<插件> <命令>: <结局>"`；不在契约里的命令记为 `not in contracts`。
 * 守卫测试断言它为空，通常各跑一次正常依赖和一次失败依赖（关闭数据库等）。
 */
export async function unsettledCommandErrors(host: TestHost, plugins: readonly HostPlugin<any>[], options: CommandErrorSettleOptions = {}): Promise<string[]> {
  const exclude = new Set(options.exclude ?? []);
  const contracts = host.runtime.kernel.contracts;
  const bad: string[] = [];
  for (const plugin of plugins) {
    for (const command of plugin.meta.commands ?? []) {
      if (exclude.has(command)) continue;
      if (!contracts.get(command)) {
        bad.push(`${plugin.meta.id} ${command}: not in contracts`);
        continue;
      }
      const args = options.args?.(command) ?? minimalCommandArgs(contracts, command);
      const outcome = await commandErrorOutcome(host.invoke(command, args), options.timeoutMs);
      if (outcome !== 'ok' && outcome !== 'classified') bad.push(`${plugin.meta.id} ${command}: ${outcome}`);
    }
  }
  return bad;
}
