/**
 * chat_v2/budget.rs — G08 whole-tree budget accounting.
 *
 * A tree root ledger aggregates tool calls, tokens (in + out) and wall clock
 * for every worker at any depth. `tryConsume` is all-or-nothing, while
 * `recordUsage` books tokens that already were spent (the next gate blocks).
 *
 * Snapshot persistence is configured by the plugin from L04's database port.
 * Hot-path writes are best effort, at the same lifecycle points as Rust.
 */
import { rustTrim } from '../../../platform/util/index.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import {
  budgetSnapshotsTableExists, readSettingWithConn, selectBudgetSnapshotsWithConn,
  type BudgetSnapshotRow,
  SETTING_BUDGET_MAX_TOOL_CALLS, SETTING_BUDGET_MAX_TOKENS,
  SETTING_BUDGET_MAX_WALL_CLOCK_SECS, upsertBudgetSnapshotWithConn,
} from '../repository/budget.ts';

export { SETTING_BUDGET_MAX_TOOL_CALLS, SETTING_BUDGET_MAX_TOKENS,
  SETTING_BUDGET_MAX_WALL_CLOCK_SECS };

export const DEFAULT_MAX_TOOL_CALLS = 200;
export const DEFAULT_MAX_TOKENS = 2_000_000;
export const DEFAULT_MAX_WALL_CLOCK_SECS = 30 * 60;

const U32_MAX = 0xffff_ffff;
const U64_MAX = 18_446_744_073_709_551_615n;
/** Keep ordinary callers numeric; retain all bits beyond the JS safe range. */
export type BudgetInteger = number | bigint;

function compactInteger(value: bigint): BudgetInteger {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value) : value;
}

/** Log surface matching the Rust `log` macros used by budget.rs. */
export interface BudgetLog {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

let budgetLogger: BudgetLog = { error() {}, warn() {}, info() {}, debug() {} };

/** Plugin wiring supplies the Cordis logger; unit tests may keep the quiet default. */
export function configureBudgetLogger(logger: BudgetLog): void {
  budgetLogger = logger;
}

export interface BudgetLimits {
  maxToolCalls: BudgetInteger;
  maxTokens: BudgetInteger;
  maxWallClockSecs: BudgetInteger;
}

export function defaultBudgetLimits(): BudgetLimits {
  return {
    maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
    maxTokens: DEFAULT_MAX_TOKENS,
    maxWallClockSecs: DEFAULT_MAX_WALL_CLOCK_SECS,
  };
}

let settingsReader: ((key: string) => string | null | undefined) | null = null;
let snapshotConnection: (() => SqlExecutor) | null = null;

/** Rust configure_persistence: later bindings replace the process-wide channel. */
export function configureBudgetPersistence(getConnection: () => SqlExecutor): () => void {
  snapshotConnection = getConnection;
  return () => { if (snapshotConnection === getConnection) snapshotConnection = null; };
}

function persistSnapshotBestEffort(ledger: BudgetLedger): void {
  if (snapshotConnection === null || ledger.snapshotAlreadyPersisted()) return;
  try {
    let conn: SqlExecutor;
    try { conn = snapshotConnection(); }
    catch (error) { throw new Error(`budget_snapshots: pool get failed: ${errorMessage(error)}`); }
    persistSnapshot(conn, ledger);
    ledger.markSnapshotPersisted();
  } catch (error) {
    budgetLogger.warn(`[Budget] snapshot persist failed (root=${ledger.rootId}): ${errorMessage(error)}`);
  }
}

export function restoreBudgetLedgersFromDatabase(getConnection: () => SqlExecutor): void {
  let conn: SqlExecutor;
  try { conn = getConnection(); }
  catch (error) {
    budgetLogger.error(`[Budget] 恢复预算快照失败（get conn）: ${errorMessage(error)}`);
    return;
  }
  restoreBudgetLedgersFromDb(conn);
}

/** Binds the main-DB `settings` reader used by `effectiveBudgetLimits`. */
export function configureBudgetSettingsReader(
  read: ((key: string) => string | null | undefined) | null,
): void {
  settingsReader = read;
}

export function configureBudgetSettings(store: Pick<SettingsStore, 'get'>): void {
  configureBudgetSettingsReader(key => {
    try {
      return store.get(key);
    } catch (error) {
      budgetLogger.warn(`[Budget] 读取 settings key '${key}' 失败，回退默认: ${errorMessage(error)}`);
      return null;
    }
  });
}

/** budget.rs `effective_limits`: settings override the built-in defaults. */
export function effectiveBudgetLimits(): BudgetLimits {
  return settingsReader === null ? defaultBudgetLimits() : resolveLimits(settingsReader);
}


/**
 * `u64::from_str`: optional ASCII `+`, digits only, range 0..=u64::MAX.
 * Returns null for any parse failure, like the Rust `Err`.
 */
export function parseU64(raw: string): bigint | null {
  const trimmed = rustTrim(raw);
  const digits = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
  if (!/^[0-9]+$/.test(digits)) return null;
  const value = BigInt(digits);
  return value <= U64_MAX ? value : null;
}

/** Unsigned decimal settings parse without loss of u64 precision. */
export function parseLimitValue(raw: string | null | undefined): BudgetInteger | null {
  if (raw === null || raw === undefined) return null;
  const parsed = parseU64(raw);
  if (parsed === null || parsed <= 0n) return null;
  return compactInteger(parsed);
}

function parseLimit(raw: string | null | undefined, fallback: number, key: string): BudgetInteger {
  if (raw === null || raw === undefined) return fallback;
  const value = parseLimitValue(raw);
  if (value !== null) return value;
  budgetLogger.warn(`[Budget] settings key '${key}' 的值 ${JSON.stringify(rustTrim(raw))}`
    + ` 非法（需为正整数），回退默认 ${fallback}`);
  return fallback;
}

/** Parses the three settings keys; missing values use defaults, invalid ones too. */
export function resolveLimits(read: (key: string) => string | null | undefined): BudgetLimits {
  return {
    maxToolCalls: parseLimit(read(SETTING_BUDGET_MAX_TOOL_CALLS), DEFAULT_MAX_TOOL_CALLS,
      SETTING_BUDGET_MAX_TOOL_CALLS),
    maxTokens: parseLimit(read(SETTING_BUDGET_MAX_TOKENS), DEFAULT_MAX_TOKENS,
      SETTING_BUDGET_MAX_TOKENS),
    maxWallClockSecs: parseLimit(read(SETTING_BUDGET_MAX_WALL_CLOCK_SECS),
      DEFAULT_MAX_WALL_CLOCK_SECS, SETTING_BUDGET_MAX_WALL_CLOCK_SECS),
  };
}

export interface BudgetDelta {
  toolCalls: BudgetInteger;
  tokensIn: BudgetInteger;
  tokensOut: BudgetInteger;
}

export const ONE_TOOL_CALL: BudgetDelta = { toolCalls: 1, tokensIn: 0, tokensOut: 0 };

export function tokenDelta(tokensIn: BudgetInteger, tokensOut: BudgetInteger): BudgetDelta {
  return { toolCalls: 0, tokensIn, tokensOut };
}

export interface BudgetRemaining {
  toolCalls: BudgetInteger;
  /** in + out combined. */
  tokens: BudgetInteger;
  wallClockSecs: BudgetInteger;
}

export interface BudgetUsage {
  toolCalls: BudgetInteger;
  tokensIn: BudgetInteger;
  tokensOut: BudgetInteger;
  /** Seconds since ledger creation. */
  wallClockSecs: BudgetInteger;
}

export type BudgetDimension = 'tool_calls' | 'tokens' | 'wall_clock';

function dimensionLabel(dimension: BudgetDimension): string {
  switch (dimension) {
    case 'tool_calls': return '工具调用次数';
    case 'tokens': return 'token 用量';
    case 'wall_clock': return '运行时长';
  }
}

export interface BudgetExceeded {
  dimension: BudgetDimension;
  used: BudgetInteger;
  limit: BudgetInteger;
}

/** Explicit gate message fed back to the model so it can close out gracefully. */
export function budgetExceededMessage(exceeded: BudgetExceeded, toolName: string): string {
  const unit = exceeded.dimension === 'wall_clock' ? ' 秒' : '';
  return `任务树预算已耗尽：${dimensionLabel(exceeded.dimension)}已达上限（已用 ${exceeded.used} / 上限 ${exceeded.limit}${unit}）。`
    + `工具调用 '${toolName}' 已被后端拦截。请停止发起新的工具调用，基于已获得的信息整理结论并给出最终回答。`;
}

function saturatingAdd(a: BudgetInteger, b: BudgetInteger): BudgetInteger {
  const sum = BigInt(a) + BigInt(b);
  return compactInteger(sum > U64_MAX ? U64_MAX : sum);
}

function saturatingSub(a: BudgetInteger, b: BudgetInteger): BudgetInteger {
  const difference = BigInt(a) - BigInt(b);
  return compactInteger(difference < 0n ? 0n : difference);
}

/** Tree-root ledger. All members at any depth account into one instance. */
export class BudgetLedger {
  readonly rootId: string;
  readonly limits: BudgetLimits;
  readonly createdAtUnix: BudgetInteger;
  private toolCalls: BudgetInteger = 0;
  private tokensIn: BudgetInteger = 0;
  private tokensOut: BudgetInteger = 0;
  private restoredElapsedSecs = 0n;
  private readonly createdAtMs: number;
  private readonly now: () => number;
  private activeBindingCount = 0;
  private lastSnapshotFingerprint: string | null = null;

  constructor(rootId: string, limits: BudgetLimits, now: () => number = () => performance.now(),
    createdAtMs?: number, createdAtUnix?: BudgetInteger) {
    this.rootId = rootId;
    this.limits = limits;
    this.now = now;
    this.createdAtMs = createdAtMs ?? now();
    this.createdAtUnix = createdAtUnix ?? Math.floor(Date.now() / 1000);
  }

  /** Rebuilds a ledger from a persisted snapshot; downtime keeps counting. */
  static restored(rootId: string, limits: BudgetLimits, usage: BudgetUsage,
    createdAtUnix: BudgetInteger, now: () => number = Date.now,
    monotonic: () => number = () => performance.now()): BudgetLedger {
    const nowMs = now();
    const elapsedSecs = BigInt(Math.floor(nowMs / 1000)) - BigInt(createdAtUnix);
    const ledger = new BudgetLedger(rootId, limits, monotonic, monotonic(), createdAtUnix);
    ledger.restoredElapsedSecs = elapsedSecs < 0n ? 0n : elapsedSecs;
    ledger.toolCalls = usage.toolCalls;
    ledger.tokensIn = usage.tokensIn;
    ledger.tokensOut = usage.tokensOut;
    return ledger;
  }

  activeBindings(): number {
    return this.activeBindingCount;
  }

  addActiveBinding(): void {
    this.activeBindingCount += 1;
  }

  removeActiveBinding(): void {
    this.activeBindingCount = Math.max(0, this.activeBindingCount - 1);
  }

  private tokensTotal(): BudgetInteger {
    return saturatingAdd(this.tokensIn, this.tokensOut);
  }

  private wallClockElapsedMs(): bigint {
    return this.restoredElapsedSecs * 1000n
      + BigInt(Math.max(0, Math.floor(this.now() - this.createdAtMs)));
  }

  private wallClockExceeded(): BudgetExceeded | null {
    const elapsedMs = this.wallClockElapsedMs();
    if (elapsedMs <= BigInt(this.limits.maxWallClockSecs) * 1000n) return null;
    return {
      dimension: 'wall_clock',
      used: compactInteger(elapsedMs / 1000n),
      limit: this.limits.maxWallClockSecs,
    };
  }

  remaining(): BudgetRemaining {
    return {
      toolCalls: saturatingSub(this.limits.maxToolCalls, this.toolCalls),
      tokens: saturatingSub(this.limits.maxTokens, this.tokensTotal()),
      wallClockSecs: saturatingSub(this.limits.maxWallClockSecs,
        this.wallClockElapsedMs() / 1000n),
    };
  }

  usage(): BudgetUsage {
    return {
      toolCalls: this.toolCalls,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      wallClockSecs: compactInteger(this.wallClockElapsedMs() / 1000n),
    };
  }

  isExhausted(): boolean {
    if (this.wallClockExceeded() !== null) return true;
    return this.toolCalls >= this.limits.maxToolCalls
      || this.tokensTotal() >= this.limits.maxTokens;
  }

  /** All-or-nothing consumption: any exceeded dimension consumes nothing. */
  tryConsume(delta: BudgetDelta): { ok: true; remaining: BudgetRemaining }
    | { ok: false; exceeded: BudgetExceeded } {
    const wallClock = this.wallClockExceeded();
    if (wallClock !== null) return { ok: false, exceeded: wallClock };

    const projectedCalls = saturatingAdd(this.toolCalls, delta.toolCalls);
    const projectedTokens = saturatingAdd(saturatingAdd(this.tokensTotal(), delta.tokensIn),
      delta.tokensOut);
    if (projectedCalls > this.limits.maxToolCalls) {
      return { ok: false, exceeded: {
        dimension: 'tool_calls', used: this.toolCalls, limit: this.limits.maxToolCalls,
      } };
    }
    if (projectedTokens > this.limits.maxTokens) {
      return { ok: false, exceeded: {
        dimension: 'tokens', used: this.tokensTotal(), limit: this.limits.maxTokens,
      } };
    }
    this.toolCalls = projectedCalls;
    this.tokensIn = saturatingAdd(this.tokensIn, delta.tokensIn);
    this.tokensOut = saturatingAdd(this.tokensOut, delta.tokensOut);
    return { ok: true, remaining: this.remaining() };
  }

  /** Books already-spent usage unconditionally; a later gate blocks the rest. */
  recordUsage(delta: BudgetDelta): BudgetRemaining {
    this.toolCalls = saturatingAdd(this.toolCalls, delta.toolCalls);
    this.tokensIn = saturatingAdd(this.tokensIn, delta.tokensIn);
    this.tokensOut = saturatingAdd(this.tokensOut, delta.tokensOut);
    return this.remaining();
  }

  limitsSnapshot(): BudgetLimitsSnapshot {
    return {
      maxToolCalls: this.limits.maxToolCalls,
      maxTokens: this.limits.maxTokens,
      maxWallClockSecs: this.limits.maxWallClockSecs,
    };
  }

  usageSnapshot(): BudgetUsageSnapshot {
    const usage = this.usage();
    return {
      toolCalls: usage.toolCalls,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      wallClockSecs: usage.wallClockSecs,
      createdAtUnix: this.createdAtUnix,
    };
  }

  snapshotFingerprint(): string {
    return `${this.toolCalls}:${this.tokensIn}:${this.tokensOut}`;
  }

  snapshotAlreadyPersisted(): boolean {
    return this.lastSnapshotFingerprint === this.snapshotFingerprint();
  }

  markSnapshotPersisted(): void {
    this.lastSnapshotFingerprint = this.snapshotFingerprint();
  }
}

// ============================================================================
// reserve: child cap = min(declared, parent remaining)
// ============================================================================

export interface DelegatedBudgetSpec {
  maxToolCalls?: BudgetInteger | null;
  maxTokens?: BudgetInteger | null;
  maxWallClockSeconds?: BudgetInteger | null;
}

function shrink(declared: BudgetInteger | null | undefined, remaining: BudgetInteger,
  cap: BudgetInteger): BudgetInteger {
  const remainingClamped = BigInt(remaining) < BigInt(cap) ? BigInt(remaining) : BigInt(cap);
  return compactInteger(declared === null || declared === undefined
    ? remainingClamped
    : BigInt(declared) < remainingClamped ? BigInt(declared) : remainingClamped);
}

export function reserveChildSpec(declared: DelegatedBudgetSpec | null | undefined,
  remaining: BudgetRemaining): Required<DelegatedBudgetSpec> {
  const spec = declared ?? {};
  return {
    maxToolCalls: shrink(spec.maxToolCalls, remaining.toolCalls, U32_MAX),
    maxTokens: shrink(spec.maxTokens, remaining.tokens, U64_MAX),
    maxWallClockSeconds: shrink(spec.maxWallClockSeconds, remaining.wallClockSecs, U64_MAX),
  };
}

// ============================================================================
// Snapshot (de)serialization
// ============================================================================

export interface BudgetLimitsSnapshot {
  maxToolCalls: BudgetInteger;
  maxTokens: BudgetInteger;
  maxWallClockSecs: BudgetInteger;
}

export interface BudgetUsageSnapshot {
  toolCalls: BudgetInteger;
  tokensIn: BudgetInteger;
  tokensOut: BudgetInteger;
  wallClockSecs: BudgetInteger;
  createdAtUnix: BudgetInteger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unsignedField(record: Record<string, unknown>, key: string): BudgetInteger | null {
  const value = record[key];
  if (typeof value !== 'bigint' && !(typeof value === 'number' && Number.isSafeInteger(value))) return null;
  return value >= 0 && value <= U64_MAX ? value as BudgetInteger : null;
}

/** V8 source text reviver preserves integers before its rounded number is used. */
function parseSnapshotJson(raw: string): unknown {
  return JSON.parse(raw, (_key, value: unknown, context?: { source: string }) => {
    if (typeof value !== 'number') return value;
    const source = context!.source;
    // serde u64/i64 fields reject floating-point JSON literals, including 1.0.
    return /^-?(?:0|[1-9][0-9]*)$/.test(source) ? compactInteger(BigInt(source)) : NaN;
  });
}

function snapshotJson(value: BudgetLimitsSnapshot | BudgetUsageSnapshot): string {
  const rawJson = (JSON as typeof JSON & { rawJSON(value: string): unknown }).rawJSON;
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? rawJson(item.toString()) : item);
}

export function parseLimitsSnapshot(raw: string): BudgetLimitsSnapshot | null {
  let value: unknown;
  try {
    value = parseSnapshotJson(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const maxToolCalls = unsignedField(value, 'maxToolCalls');
  const maxTokens = unsignedField(value, 'maxTokens');
  const maxWallClockSecs = unsignedField(value, 'maxWallClockSecs');
  if (maxToolCalls === null || maxTokens === null || maxWallClockSecs === null) return null;
  return { maxToolCalls, maxTokens, maxWallClockSecs };
}

export function parseUsageSnapshot(raw: string): BudgetUsageSnapshot | null {
  let value: unknown;
  try {
    value = parseSnapshotJson(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const toolCalls = unsignedField(value, 'toolCalls');
  const tokensIn = unsignedField(value, 'tokensIn');
  const tokensOut = unsignedField(value, 'tokensOut');
  const wallClockSecs = unsignedField(value, 'wallClockSecs');
  const createdAtUnix = value.createdAtUnix;
  if (toolCalls === null || tokensIn === null || tokensOut === null || wallClockSecs === null) {
    return null;
  }
  if (typeof createdAtUnix !== 'bigint'
    && !(typeof createdAtUnix === 'number' && Number.isSafeInteger(createdAtUnix))) return null;
  if (createdAtUnix < -(1n << 63n) || createdAtUnix > (1n << 63n) - 1n) return null;
  return { toolCalls, tokensIn, tokensOut, wallClockSecs, createdAtUnix };
}

/** Explicit snapshot write used by startup/audit paths and tests. */
export function persistSnapshot(db: SqlExecutor, ledger: BudgetLedger): void {
  const updatedAt = toRfc3339();
  const limitsJson = snapshotJson(ledger.limitsSnapshot());
  const usageJson = snapshotJson(ledger.usageSnapshot());
  try {
    upsertBudgetSnapshotWithConn(db, ledger.rootId, limitsJson, usageJson, updatedAt);
  } catch (error) {
    throw new Error(`budget_snapshots upsert failed (root=${ledger.rootId}): ${errorMessage(error)}`);
  }
}

/**
 * Startup restore: live registries win, malformed rows are skipped, and a
 * missing table (unmigrated DB) is a no-op.
 */
export function restoreBudgetLedgersFromDb(db: SqlExecutor): void {
  if (!budgetSnapshotsTableExists(db)) {
    budgetLogger.debug('[Budget] budget_snapshots table absent; nothing to restore');
    return;
  }
  let rows: BudgetSnapshotRow[];
  try {
    rows = selectBudgetSnapshotsWithConn(db);
  } catch (error) {
    budgetLogger.error(`[Budget] 读取 budget_snapshots 失败: ${errorMessage(error)}`);
    return;
  }
  let restoredCount = 0;
  for (const row of rows) {
    const limits = parseLimitsSnapshot(row.limits_json);
    if (limits === null) {
      budgetLogger.warn(`[Budget] 跳过损坏的预算快照行（root=${row.root_id}）:`
        + ` limits_json parse failed`);
      continue;
    }
    const usage = parseUsageSnapshot(row.usage_json);
    if (usage === null) {
      budgetLogger.warn(`[Budget] 跳过损坏的预算快照行（root=${row.root_id}）:`
        + ` usage_json parse failed`);
      continue;
    }
    if (ledgerForTree(row.root_id) !== null) continue;
    const ledger = BudgetLedger.restored(row.root_id, {
      maxToolCalls: limits.maxToolCalls,
      maxTokens: limits.maxTokens,
      maxWallClockSecs: limits.maxWallClockSecs,
    }, {
      toolCalls: usage.toolCalls,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      wallClockSecs: usage.wallClockSecs,
    }, usage.createdAtUnix);
    ledgerRegistry().set(row.root_id, ledger);
    budgetLogger.info(`[Budget] Restored tree ledger from snapshot: root=${row.root_id}`
      + ` (exhausted=${ledger.isExhausted()})`);
    restoredCount += 1;
  }
  if (restoredCount > 0) {
    budgetLogger.info(`[Budget] 启动恢复完成：共恢复 ${restoredCount} 个任务树根账本`);
  }
}

// ============================================================================
// Process-wide registry: tree ledgers + session bindings
// ============================================================================

let ledgers: Map<string, BudgetLedger> | null = null;
let sessionTreeKeys: Map<string, { treeKey: string; bindingId: number }> | null = null;
let nextBindingId = 1;

function ledgerRegistry(): Map<string, BudgetLedger> {
  ledgers ??= new Map();
  return ledgers;
}

function bindingRegistry(): Map<string, { treeKey: string; bindingId: number }> {
  sessionTreeKeys ??= new Map();
  return sessionTreeKeys;
}

/** Gate lookup: root key for a bound session; unbound sessions skip accounting. */
export function treeKeyForSession(sessionId: string): string | null {
  return bindingRegistry().get(sessionId)?.treeKey ?? null;
}

export function ledgerForTree(key: string): BudgetLedger | null {
  return ledgerRegistry().get(key) ?? null;
}

export function getOrEnsureLedger(key: string, limits?: BudgetLimits): BudgetLedger {
  const existing = ledgerRegistry().get(key);
  if (existing !== undefined) return existing;
  const effective = limits ?? effectiveBudgetLimits();
  const ledger = new BudgetLedger(key, effective);
  ledgerRegistry().set(key, ledger);
  budgetLogger.debug(`[Budget] Created tree ledger: root=${key} (limits: `
    + `${effective.maxToolCalls} calls / ${effective.maxTokens} tokens / `
    + `${effective.maxWallClockSecs}s)`);
  persistSnapshotBestEffort(ledger);
  return ledger;
}

/** Free-function gate form used by hooks: `tryConsume(treeKey, delta)`. */
export function tryConsume(key: string, delta: BudgetDelta, limits?: BudgetLimits):
  { ok: true; remaining: BudgetRemaining } | { ok: false; exceeded: BudgetExceeded } {
  const ledger = getOrEnsureLedger(key, limits);
  const result = ledger.tryConsume(delta);
  if (!result.ok) persistSnapshotBestEffort(ledger);
  return result;
}

export function recordUsage(key: string, delta: BudgetDelta, limits?: BudgetLimits): BudgetRemaining {
  const ledger = getOrEnsureLedger(key, limits);
  const remaining = ledger.recordUsage(delta);
  if (ledger.isExhausted()) persistSnapshotBestEffort(ledger);
  return remaining;
}

// ============================================================================
// worker spawn wiring: attachChildToTree
// ============================================================================

/** Session → tree binding. `release()` mirrors the Rust Drop guard. */
export class SessionBudgetBindingGuard {
  private released = false;
  private readonly sessionId: string;
  readonly treeKey: string;
  private readonly bindingId: number;
  private readonly ledger: BudgetLedger;

  constructor(sessionId: string, treeKey: string,
    bindingId: number, ledger: BudgetLedger) {
    this.sessionId = sessionId;
    this.treeKey = treeKey;
    this.bindingId = bindingId;
    this.ledger = ledger;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    const bindings = bindingRegistry();
    const current = bindings.get(this.sessionId);
    if (current !== undefined && current.bindingId === this.bindingId) {
      bindings.delete(this.sessionId);
    }
    this.ledger.removeActiveBinding();
    persistSnapshotBestEffort(this.ledger);
    budgetLogger.debug(`[Budget] Detached child session ${this.sessionId} from tree `
      + `${this.treeKey}`);
  }

  /** `using`/try-finally compatibility with Rust's Drop guard. */
  [Symbol.dispose](): void {
    this.release();
  }
}

export interface ChildBudgetAttachment {
  treeKey: string;
  effectiveBudget: Required<DelegatedBudgetSpec>;
  binding: SessionBudgetBindingGuard;
  /** Releases the binding (idempotent). */
  release(): void;
}

/**
 * Attaches a child session to the parent's tree root (or makes the parent the
 * root). An exhausted ledger with no live bindings is rotated: exhaustion ends
 * one task generation, it must not blacklist the session forever.
 */
export function attachChildToTree(parentSessionId: string, childSessionId: string,
  declared?: DelegatedBudgetSpec | null, limits?: BudgetLimits): ChildBudgetAttachment {
  const treeKey = treeKeyForSession(parentSessionId) ?? parentSessionId;
  const effective = limits ?? effectiveBudgetLimits();

  let ledger = ledgerRegistry().get(treeKey);
  if (ledger === undefined || (ledger.isExhausted() && ledger.activeBindings() === 0)) {
    const rotated = ledger !== undefined;
    ledger = new BudgetLedger(treeKey, effective);
    ledgerRegistry().set(treeKey, ledger);
    if (rotated) {
      budgetLogger.info(`[Budget] Rotated exhausted tree ledger: root=${treeKey}`);
    } else {
      budgetLogger.debug(`[Budget] Created tree ledger: root=${treeKey} (limits: `
        + `${effective.maxToolCalls} calls / ${effective.maxTokens} tokens / `
        + `${effective.maxWallClockSecs}s)`);
    }
    persistSnapshotBestEffort(ledger);
  }

  const bindingId = nextBindingId++;
  bindingRegistry().set(childSessionId, { treeKey, bindingId });
  ledger.addActiveBinding();
  const effectiveBudget = reserveChildSpec(declared, ledger.remaining());
  budgetLogger.debug(`[Budget] Attached child session ${childSessionId} to tree ${treeKey} `
    + `(effective budget: ${effectiveBudget.maxToolCalls} calls / `
    + `${effectiveBudget.maxTokens} tokens / ${effectiveBudget.maxWallClockSeconds}s)`);
  const binding = new SessionBudgetBindingGuard(childSessionId, treeKey, bindingId, ledger);
  return {
    treeKey,
    effectiveBudget,
    binding,
    release: () => binding.release(),
  };
}
