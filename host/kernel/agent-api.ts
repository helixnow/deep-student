/** dstu-agent-api: provider registry, policy descriptors, typed service keys and result budget. */
import { rustTrim } from '../platform/util/portable.ts';
import { isJsonNumberAtom } from './serde.ts';
export type ToolSensitivity = 'low' | 'medium' | 'high';
export type ToolConcurrency = 'read_only' | 'safe_parallel' | 'serial';
export type ToolTimeout = number | null;
export type HeadlessPolicy = 'blocked' | 'read_only' | 'allowed';
export type PtcPolicy = 'denied' | 'read_only' | 'write';
export type ApprovalPolicy = { kind: 'never' } | { kind: 'scoped'; scopeKind: string; precise: boolean; neverRemember: boolean };

export class ToolDescriptor {
  readonly name: string;
  aliases: readonly string[] = [];
  blockType = 'mcp_tool';
  timeout: ToolTimeout = null;
  headless: HeadlessPolicy = 'blocked';
  ptc: PtcPolicy = 'denied';
  approval: ApprovalPolicy = { kind: 'scoped', scopeKind: 'tool', precise: false, neverRemember: false };
  sensitivity: ToolSensitivity = 'low';
  constructor(name: string) { this.name = name; }
  private copy(patch: Partial<ToolDescriptor>): ToolDescriptor { return Object.assign(new ToolDescriptor(this.name), this, patch); }
  withAliases(aliases: readonly string[]): ToolDescriptor { return this.copy({ aliases }); }
  withBlockType(blockType: string): ToolDescriptor { return this.copy({ blockType }); }
  withTimeout(timeout: ToolTimeout): ToolDescriptor { return this.copy({ timeout }); }
  withHeadless(headless: HeadlessPolicy): ToolDescriptor { return this.copy({ headless }); }
  withPtc(ptc: PtcPolicy): ToolDescriptor { return this.copy({ ptc }); }
  withApproval(approval: ApprovalPolicy): ToolDescriptor { return this.copy({ approval }); }
  withSensitivity(sensitivity: ToolSensitivity): ToolDescriptor { return this.copy({ sensitivity }); }
  names(): string[] { return [this.name, ...this.aliases]; }
}

/**
 * Provider 标识（`dstu-agent-api/src/provider.rs:17-41`）。
 * Rust 的 `&'static str` newtype 在 TS 中就是字符串；注册表按值比较。
 */
export type ProviderId = string;

/** Object identity replaces Rust Arc::ptr_eq; providers must return their roster instances. */
export interface ToolProvider<E extends object> {
  readonly id: ProviderId;
  descriptors(): readonly ToolDescriptor[];
  executor(name: string): E | undefined;
  executors(): readonly E[];
  /** headless 精简 schema（`provider.rs:63-66`）；缺省为空。 */
  headlessSchemas?(): readonly unknown[];
  /** 仅 General/MCP 这类兜底 provider 返回 true（`provider.rs:68-70`）；缺省 false。 */
  isCatchAll?(): boolean;
}
/** Rust `is_catch_all` 的 trait 默认值 false。 */
export function isCatchAllProvider<E extends object>(provider: ToolProvider<E>): boolean { return provider.isCatchAll?.() ?? false; }
export type ToolRegistryErrorCode = 'EmptyRegistry' | 'DuplicateProviderId' | 'EmptyToolName' | 'DuplicateToolName' | 'MissingExecutor' | 'ExecutorNotInRoster' | 'UndeclaredExecutor' | 'MultipleCatchAllProviders' | 'CatchAllNotLast';
export class ToolRegistryError extends Error {
  readonly code: ToolRegistryErrorCode;
  readonly fields: Record<string, string>;
  constructor(code: ToolRegistryErrorCode, fields: Record<string, string> = {}) {
    const { provider, name, first, second, after } = fields;
    const messages: Record<ToolRegistryErrorCode, string> = {
      EmptyRegistry: 'tool registry requires at least one provider',
      DuplicateProviderId: `provider id \`${provider}\` is registered twice`,
      EmptyToolName: `provider \`${provider}\` declares an empty tool name`,
      DuplicateToolName: `tool name \`${name}\` is declared by both \`${first}\` and \`${second}\``,
      MissingExecutor: `provider \`${provider}\` declares \`${name}\` but returns no executor for it`,
      ExecutorNotInRoster: `provider \`${provider}\` returns an executor for \`${name}\` that is missing from executors()`,
      UndeclaredExecutor: `provider \`${provider}\` returns an executor that none of its descriptors declare`,
      MultipleCatchAllProviders: `only one catch-all provider is allowed; \`${first}\` and \`${second}\` both claim it`,
      CatchAllNotLast: `catch-all provider \`${provider}\` must be registered last (found \`${after}\` after it)`,
    };
    super(messages[code]); this.name = 'ToolRegistryError'; this.code = code; this.fields = fields;
  }
}
/** descriptor 索引（name/alias → descriptor），`registry.rs:102-133`。 */
export class DescriptorTable {
  private readonly entries: ReadonlyMap<string, ToolDescriptor>;
  constructor(entries: Iterable<readonly [string, ToolDescriptor]> = []) { this.entries = new Map(entries); }
  get(name: string): ToolDescriptor | undefined { return this.entries.get(name); }
  contains(name: string): boolean { return this.entries.has(name); }
  len(): number { return this.entries.size; }
  isEmpty(): boolean { return this.len() === 0; }
  iter(): ReadonlyMap<string, ToolDescriptor> { return this.entries; }
}
export class ToolRegistry<E extends object> {
  private readonly roster: E[];
  private readonly orderedProviders: ToolProvider<E>[];
  private readonly byName: Map<string, E>;
  private readonly owners: Map<string, ProviderId>;
  private readonly descriptors: DescriptorTable;
  private readonly catchAll: ToolProvider<E> | undefined;
  constructor(providers: ToolProvider<E>[], roster: E[], byName: Map<string, E>, owners: Map<string, ProviderId>, descriptors: DescriptorTable, catchAll?: ToolProvider<E>) {
    this.orderedProviders = providers; this.roster = roster; this.byName = byName; this.owners = owners; this.descriptors = descriptors; this.catchAll = catchAll;
  }
  executorFor(name: string): E | undefined { return this.byName.get(name) ?? this.catchAll?.executor(name); }
  descriptor(name: string): ToolDescriptor | undefined { return this.descriptors.get(name); }
  descriptorTable(): DescriptorTable { return this.descriptors; }
  ownerOf(name: string): ProviderId | undefined { return this.owners.get(name); }
  executors(): readonly E[] { return this.roster; }
  providers(): readonly ToolProvider<E>[] { return this.orderedProviders; }
  catchAllProvider(): ToolProvider<E> | undefined { return this.catchAll; }
  len(): number { return this.descriptors.len(); }
  isEmpty(): boolean { return this.len() === 0; }
}
export class ToolRegistryBuilder<E extends object> {
  private providers: ToolProvider<E>[] = [];
  register(provider: ToolProvider<E>): this { this.providers.push(provider); return this; }
  withProvider(provider: ToolProvider<E>): this { return this.register(provider); }
  build(): ToolRegistry<E> {
    const providers = [...this.providers];
    if (!providers.length) throw new ToolRegistryError('EmptyRegistry');
    const catchAll = providers.filter(isCatchAllProvider);
    if (catchAll.length > 1) throw new ToolRegistryError('MultipleCatchAllProviders', { first: catchAll[0]!.id, second: catchAll[1]!.id });
    if (catchAll[0] && providers.indexOf(catchAll[0]) !== providers.length - 1) throw new ToolRegistryError('CatchAllNotLast', { provider: catchAll[0].id, after: providers[providers.indexOf(catchAll[0]) + 1]!.id });
    const ids = new Set<string>(), owners = new Map<string, ProviderId>(), byName = new Map<string, E>(), descriptors = new Map<string, ToolDescriptor>(), roster: E[] = [];
    for (const p of providers) {
      const provider = p.id;
      if (ids.has(provider)) throw new ToolRegistryError('DuplicateProviderId', { provider });
      ids.add(provider);
      const claimed: [string, E][] = [];
      for (const descriptor of p.descriptors()) for (const name of descriptor.names()) {
        if (!rustTrim(name)) throw new ToolRegistryError('EmptyToolName', { provider });
        if (owners.has(name)) throw new ToolRegistryError('DuplicateToolName', { name, first: owners.get(name)!, second: provider });
        const e = p.executor(name);
        if (!e) throw new ToolRegistryError('MissingExecutor', { provider, name });
        owners.set(name, provider); descriptors.set(name, descriptor); byName.set(name, e); claimed.push([name, e]);
      }
      const ownRoster = p.executors();
      for (const [name, e] of claimed) if (!ownRoster.includes(e)) throw new ToolRegistryError('ExecutorNotInRoster', { provider, name });
      if (!isCatchAllProvider(p)) for (const e of ownRoster) if (!claimed.some(([, c]) => c === e)) throw new ToolRegistryError('UndeclaredExecutor', { provider });
      for (const e of ownRoster) if (!roster.includes(e)) roster.push(e);
    }
    return new ToolRegistry(providers, roster, byName, owners, new DescriptorTable(descriptors), catchAll[0]);
  }
}

/** Stable domain-owned key object replaces TypeId; typeName retains Rust error context. */
export class ServiceKey<T> {
  declare readonly type: T;
  readonly typeName: string;
  constructor(typeName: string) { this.typeName = typeName; }
}
export class ServiceNotFound extends Error {
  readonly typeName: string;
  constructor(typeName: string) { super(`service \`${typeName}\` is not registered in Services`); this.typeName = typeName; this.name = 'ServiceNotFound'; }
}
export class AgentServices {
  private map = new Map<object, unknown>();
  insert<T>(key: ServiceKey<T>, value: T): T | undefined { const old = this.get(key); this.map.set(key, value); return old; }
  get<T>(key: ServiceKey<T>): T | undefined { return this.map.get(key) as T | undefined; }
  require<T>(key: ServiceKey<T>): T { if (!this.map.has(key)) throw new ServiceNotFound(key.typeName); return this.map.get(key) as T; }
  contains<T>(key: ServiceKey<T>): boolean { return this.map.has(key); }
  len(): number { return this.map.size; }
  isEmpty(): boolean { return this.len() === 0; }
}

export const DEFAULT_TOOL_RESULT_CHAR_BUDGET = 30_000;
export const TRUNCATION_MARKER = '…[truncated]';
export type AgentJson = null | boolean | number | string | AgentJson[] | { [key: string]: AgentJson };
export function serializedCharLen(value: AgentJson): number { return [...JSON.stringify(value)].length; }
export function applyToolResultBudget(output: AgentJson, requestedBudget: number): AgentJson {
  const budget = Math.max(requestedBudget, 1024), originalChars = serializedCharLen(output);
  if (originalChars <= budget) return output;
  const leafCap = Math.max(Math.floor(budget / 8), 256); let changed = false;
  const truncate = (value: AgentJson): AgentJson => {
    if (typeof value === 'string' && [...value].length > leafCap) { changed = true; return [...value].slice(0, leafCap).join('') + TRUNCATION_MARKER; }
    // Native raw atoms are Value::Number (budget.rs `_ => false`), not maps to walk.
    if (isJsonNumberAtom(value)) return value;
    if (Array.isArray(value)) return value.map(truncate);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncate(v)]));
    return value;
  };
  const working = truncate(output);
  if (changed && serializedCharLen(working) <= budget) {
    const object = working !== null && typeof working === 'object' && !Array.isArray(working);
    const metadata = { truncated: true, original_chars: originalChars, truncation_note: `Tool output exceeded the ${budget}-char result budget; long string ${object ? 'fields were' : 'content was'} shortened. The full output was persisted before truncation.` };
    return object ? { ...working, ...metadata } : { ...metadata, result: working };
  }
  return { truncated: true, original_chars: originalChars, budget_chars: budget, truncation_note: 'Tool output exceeded the result budget; showing a JSON preview. The full output was persisted before truncation.', preview: [...JSON.stringify(working)].slice(0, budget).join('') };
}

/**
 * The unbudgeted output, kept for the loop's own structured reads (see RF-W02-loaded-skill-ids-truncation).
 * Symbol-keyed so it survives object spread but never reaches JSON (wire, DB, model).
 */
// RUST-FIX(RF-W02-loaded-skill-ids-truncation): keep the pre-budget output; tool_loop.rs:2016 read the truncated one.
export const PRE_BUDGET_OUTPUT: unique symbol = Symbol.for('dstu.agent.preBudgetOutput');
export type BudgetedToolResult<T extends { output: unknown }> = T & { [PRE_BUDGET_OUTPUT]?: unknown };
export function withToolResultBudget<T extends { output: unknown }>(result: T, budget: number): BudgetedToolResult<T> {
  const output = applyToolResultBudget(result.output as AgentJson, budget);
  return output === result.output ? result : { ...result, output, [PRE_BUDGET_OUTPUT]: result.output };
}
export function preBudgetOutput(result: { output: unknown }): unknown {
  const original = (result as { [PRE_BUDGET_OUTPUT]?: unknown })[PRE_BUDGET_OUTPUT];
  return original === undefined ? result.output : original;
}

/**
 * Tool output as `serde_json::Value`: bigint leaves become numbers (the same projection as `toWireJson`), so
 * budgeting, history text and persistence can serialize it. Raw atoms stay atoms (structuredClone throws on
 * them); output without bigint is returned as is.
 */
// RUST-FIX(RF-W02-agent-json-bigint): Rust writes every i64/u64 digit; past 2^53 this rounds like the frontend's JSON.parse.
export function toAgentJson(value: unknown): unknown {
  return containsBigint(value, new Set()) ? bigintsToNumbers(value, new Map()) : value;
}
function plainContainer(value: object): boolean {
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function containsBigint(value: unknown, seen: Set<object>): boolean {
  if (typeof value === 'bigint') return true;
  if (value === null || typeof value !== 'object' || isRawJsonAtom(value) || seen.has(value) || !plainContainer(value)) return false;
  seen.add(value);
  return Object.values(value).some(item => containsBigint(item, seen));
}
function bigintsToNumbers(value: unknown, seen: Map<object, unknown>): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value === null || typeof value !== 'object' || isRawJsonAtom(value) || !plainContainer(value)) return value;
  const done = seen.get(value);
  if (done !== undefined) return done;
  if (Array.isArray(value)) {
    const copy: unknown[] = new Array(value.length);
    seen.set(value, copy);
    value.forEach((item, index) => { copy[index] = bigintsToNumbers(item, seen); });
    return copy;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, { value: bigintsToNumbers(item, seen), writable: true, enumerable: true, configurable: true });
  }
  return copy;
}

const nativeJson = JSON as typeof JSON & { isRawJSON?(value: unknown): boolean };
/** A native `JSON.rawJSON` atom: already-serialized JSON text, a leaf for every walker (never a `{rawJSON}` map). */
export function isRawJsonAtom(value: unknown): value is Readonly<{ rawJSON: string }> {
  return nativeJson.isRawJSON?.(value) === true;
}
/**
 * `Value::clone` for tool calls, results and blocks: a drop-in for structuredClone that shares native
 * `JSON.rawJSON` atoms (frozen leaves, e.g. a number spelled `1.0`). structuredClone throws on them and
 * spreading drops the raw brand. Non-plain objects (Date, typed arrays, class instances) still go
 * through structuredClone.
 */
export function cloneAgentJson<T>(value: T): T {
  return cloneJsonTree(value, new Map()) as T;
}
function cloneJsonTree(value: unknown, seen: Map<object, unknown>): unknown {
  if (typeof value === 'function' || typeof value === 'symbol') return structuredClone(value);
  if (value === null || typeof value !== 'object' || isRawJsonAtom(value)) return value;
  const done = seen.get(value);
  if (done !== undefined) return done;
  if (Array.isArray(value)) {
    const copy: unknown[] = new Array(value.length);
    seen.set(value, copy);
    value.forEach((item, index) => { copy[index] = cloneJsonTree(item, seen); });
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return structuredClone(value);
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, { value: cloneJsonTree(item, seen), writable: true, enumerable: true, configurable: true });
  }
  return copy;
}

// ---------------------------------------------------------------- executor.rs

/**
 * `dstu_core::agent::ToolCall`（`crates/dstu-core/src/agent.rs:109-131`，camelCase wire）。
 * dstu-agent-api 只引用该类型，不拥有它。
 */
export interface AgentToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/**
 * `dstu_core::agent::ToolResultInfo`（`crates/dstu-core/src/agent.rs:134-172`，camelCase wire）。
 * `None` 字段在 serde 中 `skip_serializing_if`，TS 中缺省即可。
 */
export interface AgentToolResultInfo {
  toolCallId?: string;
  blockId?: string;
  toolName: string;
  input: unknown;
  output: unknown;
  success: boolean;
  error?: string;
  durationMs?: number;
  reasoningContent?: string;
  thoughtSignature?: string;
}

/**
 * 工具执行器契约（`executor.rs:56-108`）。
 *
 * 约定（与 Rust 相同）：
 * - 执行器应发射 start/end/error 事件；
 * - 即使工具执行失败，也应返回 `success=false` 的结果；
 * - 只有执行器自身异常才 reject（Rust `Err(String)`）。
 */
export interface ToolExecutor {
  /** 判断该执行器是否处理指定工具。 */
  canHandle(toolName: string): boolean;
  /** 执行工具调用。 */
  execute(call: AgentToolCall, ctx: ExecutionContext): Promise<AgentToolResultInfo>;
  /** 工具敏感等级；默认 low（`executor.rs:74-76`）。 */
  sensitivityLevel?(toolName: string): ToolSensitivity;
  /** 解析一次具体调用的敏感度；默认委托 `sensitivityLevel`（`executor.rs:79-86`）。 */
  sensitivityLevelForCall?(toolName: string, args: unknown): ToolSensitivity;
  /** 敏感度是否随参数变化；默认 false（`executor.rs:89-91`）。 */
  hasDynamicSensitivity?(toolName: string): boolean;
  /** 工具并发等级；默认 serial（`executor.rs:94-96`）。 */
  concurrencyClass?(toolName: string): ToolConcurrency;
  /** 执行器是否自行处理取消终态；默认 false（`executor.rs:99-103`）。 */
  managesCancellation?(toolName: string): boolean;
  /** 结果字符预算；默认 {@link DEFAULT_TOOL_RESULT_CHAR_BUDGET}，`null` 关闭外层预算（`executor.rs:105-108`）。 */
  resultCharBudget?(toolName: string): number | null;
  /** 执行器名称（日志/花名册快照）；默认取类型名（`executor.rs:112-116`）。 */
  name(): string;
}

/** `ToolExecutor` 的 trait 默认方法；领域执行器继承它即可只实现 canHandle/execute。 */
export abstract class ToolExecutorBase implements ToolExecutor {
  abstract canHandle(toolName: string): boolean;
  abstract execute(call: AgentToolCall, ctx: ExecutionContext): Promise<AgentToolResultInfo>;
  sensitivityLevel(_toolName: string): ToolSensitivity { return 'low'; }
  sensitivityLevelForCall(toolName: string, _arguments: unknown): ToolSensitivity { return this.sensitivityLevel(toolName); }
  hasDynamicSensitivity(_toolName: string): boolean { return false; }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'serial'; }
  managesCancellation(_toolName: string): boolean { return false; }
  resultCharBudget(_toolName: string): number | null { return DEFAULT_TOOL_RESULT_CHAR_BUDGET; }
  name(): string { return this.constructor.name; }
}

/** 对任意 `ToolExecutor` 应用 Rust trait 默认值（供只实现接口的对象使用）。 */
export function executorSensitivity(executor: ToolExecutor, toolName: string): ToolSensitivity {
  return executor.sensitivityLevel?.(toolName) ?? 'low';
}
export function executorSensitivityForCall(executor: ToolExecutor, toolName: string, args: unknown): ToolSensitivity {
  return executor.sensitivityLevelForCall?.(toolName, args) ?? executorSensitivity(executor, toolName);
}
export function executorHasDynamicSensitivity(executor: ToolExecutor, toolName: string): boolean {
  return executor.hasDynamicSensitivity?.(toolName) ?? false;
}
export function executorConcurrencyClass(executor: ToolExecutor, toolName: string): ToolConcurrency {
  return executor.concurrencyClass?.(toolName) ?? 'serial';
}
export function executorManagesCancellation(executor: ToolExecutor, toolName: string): boolean {
  return executor.managesCancellation?.(toolName) ?? false;
}
export function executorResultCharBudget(executor: ToolExecutor, toolName: string): number | null {
  // Rust 的 Option<usize>：None（null）表示关闭外层预算，不能与“未覆写”混为一谈。
  return executor.resultCharBudget === undefined ? DEFAULT_TOOL_RESULT_CHAR_BUDGET : executor.resultCharBudget(toolName);
}

// ---------------------------------------------------------------- context.rs

/** 本次调用的标识集合（`context.rs:18-30`）。 */
export interface CallIds {
  sessionId: string;
  messageId: string;
  blockId?: string;
  toolCallId: string;
  round: number;
}

/** 本次调用的功能开关（`context.rs:33-41`）。 */
export interface ExecutionFlags {
  memoryEnabled: boolean;
  ragEnabled: boolean;
  webSearchEnabled: boolean;
  supportsTools: boolean;
}

/** 单域请求参数（`context.rs:44-52`）。 */
export interface RequestExt {
  ragTopK?: number;
  canvasNoteId?: string;
  questionAuthoring?: unknown;
}

export interface ExecutionContextInit {
  call: AgentToolCall;
  ids?: CallIds;
  emitter: AppEventEmitter;
  services: AgentServices;
  host: HostBridge;
  runtimeRoots: RuntimeRootResolver;
  blockStore: ToolBlockStore;
  dispatcher: AdmittedToolDispatcher;
  /** Rust `CancellationToken`；对应 AbortSignal。 */
  cancel: AbortSignal;
  flags?: ExecutionFlags;
  request?: RequestExt;
}

/** 工具执行上下文（`context.rs:55-104`）。 */
export class ExecutionContext {
  readonly call: AgentToolCall;
  readonly ids: CallIds;
  readonly emitter: AppEventEmitter;
  readonly services: AgentServices;
  readonly host: HostBridge;
  readonly runtimeRoots: RuntimeRootResolver;
  readonly blockStore: ToolBlockStore;
  readonly dispatcher: AdmittedToolDispatcher;
  readonly cancel: AbortSignal;
  readonly flags: ExecutionFlags;
  readonly request: RequestExt;

  constructor(init: ExecutionContextInit) {
    this.call = init.call;
    this.ids = init.ids ?? { sessionId: '', messageId: '', toolCallId: '', round: 0 };
    this.emitter = init.emitter;
    this.services = init.services;
    this.host = init.host;
    this.runtimeRoots = init.runtimeRoots;
    this.blockStore = init.blockStore;
    this.dispatcher = init.dispatcher;
    this.cancel = init.cancel;
    this.flags = init.flags ?? { memoryEnabled: false, ragEnabled: false, webSearchEnabled: false, supportsTools: false };
    this.request = init.request ?? {};
  }

  /** 本次调用是否已请求取消（`context.rs:89-92`）。 */
  isCancelled(): boolean { return this.cancel.aborted; }

  /** 是否有可交互的前端窗口（`context.rs:94-96`）。 */
  hasFrontend(): boolean { return this.host.hasFrontend(); }
}

// ---------------------------------------------------------------- host.rs

/** 一次往返请求（`host.rs:22-52`，serde camelCase；`timeoutMs` 缺省省略）。 */
export class HostRequest {
  readonly channel: string;
  readonly payload: unknown;
  readonly timeoutMs: number | undefined;

  constructor(channel: string, payload: unknown, timeoutMs?: number) {
    this.channel = channel;
    this.payload = payload;
    this.timeoutMs = timeoutMs;
  }

  /** 设置超时（毫秒）。 */
  withTimeoutMs(timeoutMs: number): HostRequest { return new HostRequest(this.channel, this.payload, timeoutMs); }
}

/**
 * 宿主桥：前端是否在线、单向事件、往返请求（`host.rs:55-73`）。
 * Rust 的 `Result<_, String>` 在 TS 中以抛出异常表示。
 */
export interface HostBridge {
  hasFrontend(): boolean;
  /** 发一条单向事件；失败时抛出（Rust `Err(String)`）。 */
  emit(event: string, payload: unknown): void;
  /** 发起一次往返请求（前端桥/桌面桥）。 */
  roundTrip(request: HostRequest): Promise<unknown>;
  /** 仅 app 内部降级用（取回具体宿主对象）。 */
  asAny(): unknown;
}

/** 块级/会话级事件发射器（`host.rs:76-88`）。 */
export interface AppEventEmitter {
  hasFrontend(): boolean;
  /** 发射块级事件（`chat_v2_event_{session_id}`）。 */
  emitBlockEvent(event: string, payload: unknown): void;
  /** 发射会话级事件（`chat_v2_session_{session_id}`）。 */
  emitSessionEvent(event: string, payload: unknown): void;
}

/**
 * 运行时根目录解析与授权（`host.rs:91-108`）。
 * 路径在 TS 中是字符串；`resolve` / `authorize` 失败时抛出（Rust `Err(String)`）。
 */
export interface RuntimeRootResolver {
  artifactRoot(): string;
  tempRoot(): string;
  workspaceRoot(): string;
  resolve(relative: string): string;
  authorize(path: string): void;
}

/** 工具块持久化出口（`host.rs:111-119`）；失败时抛出（Rust `Err(String)`）。 */
export interface ToolBlockStore {
  upsertToolBlock(call: AgentToolCall, blockType: string, payload: unknown): void;
}

/** 重入 pipeline 的准入调度器（`host.rs:122-132`）。 */
export interface AdmittedToolDispatcher {
  dispatchAdmitted(call: AgentToolCall, ctx: ExecutionContext): Promise<AgentToolResultInfo>;
}

/** Optional chat-runtime lifecycle hooks present when an AgentToolExecutor runs under ChatExecutionContext. */
export interface AgentToolLifecycleHooks {
  emitToolCallStart?(toolName: string, input: unknown, toolCallId: string | null): void;
  emitToolCallEnd?(result: unknown | null): void;
  emitToolCallError?(error: string): void;
  saveToolBlock?(result: AgentToolResultInfo): void;
}

export interface AgentToolLifecycleOptions {
  /** Overrides input passed to tool_call start event and AgentToolResultInfo. */
  displayInput?: unknown;
  /** Omits empty string blockId (`''`) for executors that treat blank ids as absent. */
  omitEmptyBlockId?: boolean;
  /** Formats thrown values into tool error strings. */
  formatError?: (error: unknown) => string;
  /** Rounds elapsed duration in milliseconds (defaults to Math.floor). */
  roundDuration?: (elapsedMs: number) => number;
  /** Warns instead of discarding when lifecycle emission or block save throws. */
  warn?: (message: string) => void;
}

const defaultLifecycleError = (error: unknown): string =>
  typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);

/**
 * Runs an `AgentToolExecutor` action while emitting standard `tool_call` start/end/error events
 * and persisting the tool block when the runtime context carries chat lifecycle hooks.
 */
export async function executeAgentToolWithLifecycle(
  call: AgentToolCall,
  ctx: ExecutionContext,
  run: () => Promise<unknown> | unknown,
  options?: AgentToolLifecycleOptions,
): Promise<AgentToolResultInfo> {
  const started = performance.now();
  const rawBlockId = ctx.ids?.blockId;
  const includeBlockId = rawBlockId !== undefined && (!options?.omitEmptyBlockId || rawBlockId !== '');
  const input = options !== undefined && Object.hasOwn(options, 'displayInput') ? options.displayInput : call.arguments;
  const base = {
    toolCallId: call.id,
    ...(includeBlockId ? { blockId: rawBlockId } : {}),
    toolName: call.name,
    input,
  };
  const hooks = ctx as unknown as AgentToolLifecycleHooks;
  const round = options?.roundDuration ?? Math.floor;
  const warn = options?.warn;
  const safeCall = (label: string, fn: () => void): void => {
    try { fn(); }
    catch (error) { warn?.(`${label}: ${defaultLifecycleError(error)}`); }
  };

  safeCall('tool_call start emit failed', () => {
    hooks.emitToolCallStart?.(call.name, input, call.id ?? null);
  });

  let result: AgentToolResultInfo;
  try {
    const output = await run();
    const durationMs = round(performance.now() - started);
    safeCall('tool_call end emit failed', () => {
      hooks.emitToolCallEnd?.({ result: output, durationMs });
    });
    result = { ...base, output, success: true, durationMs };
  } catch (error) {
    const durationMs = round(performance.now() - started);
    const formatted = (options?.formatError ?? defaultLifecycleError)(error);
    safeCall('tool_call error emit failed', () => {
      hooks.emitToolCallError?.(formatted);
    });
    result = { ...base, output: null, success: false, error: formatted, durationMs };
  }

  safeCall('saveToolBlock failed', () => {
    hooks.saveToolBlock?.(result);
  });
  return result;
}
