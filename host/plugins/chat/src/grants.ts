/**
 * G02 DelegatedGrant: data model, process-wide worker grant registry and
 * revocation epochs. Rust source: `chat_v2/grants.rs` (L04-owned).
 *
 * Like the Rust statics, the registry and epoch axis are process-wide: worker
 * grants live and die with the process, epochs are persisted in the chat_v2
 * `revocation_epochs` table (V20260910) and restored at startup with max semantics.
 * Bump paths write the database first and only then the in-memory axis
 * (fail-closed). JS is single-threaded, so the Rust bump mutex is the
 * synchronous body of each function.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { prepareRevocationEpochs, revocationEpochsTableExists, selectRevocationEpochRows,
  upsertRevocationEpoch } from '../repository/grants.ts';
import { parseRfc3339, toRfc3339 } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import type { DelegatedBudgetSpec } from '../../chat-pipeline/api.ts';
import type { ChatV2Database } from '../api.ts';
import { toolAllowEntryMatches } from './tool-policy.ts';
import { grantsScopeHint } from './tool-descriptors.ts';
import { errorText, type ChatLogger } from './logger.ts';
import { ulid } from './ulid.ts';

/** `DELEGATED_GRANT_SCHEMA_VERSION` (u16). */
export const DELEGATED_GRANT_SCHEMA_VERSION = 1;

/** `dstu_core::agent::ToolScope`: `#[serde(rename_all = "snake_case", tag = "kind")]`. */
export type ToolScope =
  | { kind: 'builtin'; name: string }
  | { kind: 'mcp'; server: string; tool: string }
  | { kind: 'shell'; prefixes: string[] };

/** `ObjectScope` (P1: always empty). */
export type ObjectScope =
  | { kind: 'resource_read'; resource_ids: string[] }
  | { kind: 'resource_write'; resource_ids: string[] }
  | { kind: 'runtime_root'; root_id: string; writable: boolean };

/** `DelegatedGrant` (`rename_all = "camelCase"`). u64 epoch kept exact as bigint (D3). */
export interface DelegatedGrant {
  grantId: string;
  schemaVersion: number;
  parentTaskId: string;
  childTaskId: string;
  toolScopes: ToolScope[];
  objectScopes: ObjectScope[];
  networkDestinations: string[];
  /** `Option<BudgetSpec>`; the shape is owned by L03 `budget.rs` (G08). */
  budget: DelegatedBudgetSpec | null;
  /** RFC3339 UTC (`Option<DateTime<Utc>>`). P1 issuance is always null. */
  expiry: string | null;
  revocationEpoch: bigint;
  profileHash: string;
}

export type GrantDenial = 'revoked' | 'expired';

// ============================================================================
// ToolScopeExt
// ============================================================================

/** `ToolScopeExt::allows`: the execution-allowlist entry semantics. */
export function toolScopeAllows(scope: ToolScope, toolName: string, args: unknown): boolean {
  switch (scope.kind) {
    case 'builtin':
      return toolAllowEntryMatches(scope.name, toolName, args);
    case 'mcp':
      return scope.server === ''
        ? toolAllowEntryMatches(scope.tool, toolName, args)
        : toolAllowEntryMatches(`${scope.server}::${scope.tool}`, toolName, args);
    case 'shell':
      // P1 fail-closed: shell prefix grants are not wired yet.
      return false;
  }
}

/** `ToolScopeExt::from_allow_entry`. */
export function toolScopeFromAllowEntry(raw: string): ToolScope {
  const entry = rustTrim(raw);
  const separator = entry.indexOf('::');
  if (separator >= 0) {
    return { kind: 'mcp', server: entry.slice(0, separator), tool: entry.slice(separator + 2) };
  }
  if (entry.startsWith('mcp.tools.') || entry.startsWith('mcp_')) {
    return { kind: 'mcp', server: '', tool: entry };
  }
  return grantsScopeHint(entry) === 'shell'
    ? { kind: 'shell', prefixes: [] }
    : { kind: 'builtin', name: entry };
}

/** `ToolScopeExt::scopes_from_allowed_tools`: order-preserving, no dedup. */
export function scopesFromAllowedTools(allowedTools: readonly string[]): ToolScope[] {
  return allowedTools.map(toolScopeFromAllowEntry);
}

// ============================================================================
// DelegatedGrant / GrantDenial
// ============================================================================

/** `GrantDenial::message`. */
export function grantDenialMessage(denial: GrantDenial, grantId: string, toolName: string): string {
  return denial === 'revoked'
    ? `授权已撤销：委派授权（grant ${grantId}）已被撤回，工具调用 '${toolName}' 已被后端拦截`
    : `授权已过期：委派授权（grant ${grantId}）已过有效期，工具调用 '${toolName}' 已被后端拦截`;
}

/** `DelegatedGrant::effective_tools`: profile.allowed_tools ∩ tool_scopes, in profile order. */
export function grantEffectiveTools(grant: DelegatedGrant, profileAllowedTools: readonly string[]): string[] {
  const effective: string[] = [];
  for (const raw of profileAllowedTools) {
    const entry = rustTrim(raw);
    if (entry === '') continue;
    if (grant.toolScopes.some(scope => toolScopeAllows(scope, entry, null)) && !effective.includes(entry)) {
      effective.push(entry);
    }
  }
  return effective;
}

function epochNanosOf(rfc3339: string): bigint {
  const parsed = parseRfc3339(rfc3339);
  if (parsed === null) throw new Error(`invalid grant timestamp: ${rfc3339}`);
  return parsed.epochNanos;
}

/** `DelegatedGrant::check_liveness`; `now` is an RFC3339 instant. Returns null when live. */
export function checkGrantLiveness(grant: DelegatedGrant, currentEpoch: bigint, now: string): GrantDenial | null {
  if (grant.revocationEpoch < currentEpoch) return 'revoked';
  if (grant.expiry !== null && epochNanosOf(now) >= epochNanosOf(grant.expiry)) return 'expired';
  return null;
}

/** `DelegatedGrant::ensure_live`: process-wide epoch and the current wall clock. */
export function ensureGrantLive(grant: DelegatedGrant): GrantDenial | null {
  return checkGrantLiveness(grant, currentEpochFor(grant.childTaskId), toRfc3339());
}

// ============================================================================
// Revocation epochs (process axis + V20260910 persistence)
// ============================================================================

const EPOCH_KIND_GLOBAL = 'global';
const EPOCH_KIND_TASK = 'task';
const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;

let globalRevocationEpoch = 0n;
const taskRevocationEpochs = new Map<string, bigint>();
const grantRegistry = new Map<string, DelegatedGrant>();

/** `u64::saturating_add(1)`. */
function saturatingIncrement(value: bigint): bigint { return value >= U64_MAX ? U64_MAX : value + 1n; }
function maxBigint(a: bigint, b: bigint): bigint { return a > b ? a : b; }

/** `current_global_epoch`. */
export function currentGlobalEpoch(): bigint { return globalRevocationEpoch; }

/** `current_epoch_for` = max(global, per-task). */
export function currentEpochFor(childTaskId: string): bigint {
  return maxBigint(globalRevocationEpoch, taskRevocationEpochs.get(childTaskId) ?? 0n);
}

/** `revoke_all_grants`: persist first, then bump the in-memory global epoch. */
export function revokeAllGrants(db: ChatV2Database, log: ChatLogger): bigint {
  const next = saturatingIncrement(currentGlobalEpoch());
  persistRevocationEpoch(db, EPOCH_KIND_GLOBAL, '', next);
  globalRevocationEpoch = next;
  log.warn(`[Grants] revoke_all_grants: global revocation epoch bumped to ${next} (persisted)`);
  return next;
}

/** `revoke_grants_for`: next = max(task, global) + 1, persisted before memory. */
export function revokeGrantsFor(db: ChatV2Database, childTaskId: string, log: ChatLogger): bigint {
  const current = taskRevocationEpochs.get(childTaskId) ?? 0n;
  const next = saturatingIncrement(maxBigint(current, currentGlobalEpoch()));
  persistRevocationEpoch(db, EPOCH_KIND_TASK, childTaskId, next);
  taskRevocationEpochs.set(childTaskId, next);
  log.warn(`[Grants] revoke_grants_for: child_task_id=${childTaskId} revoked at epoch ${next} (persisted)`);
  return next;
}

function connectionOf(db: ChatV2Database): SqlExecutor {
  try { return db.getConn(); }
  catch (error) { throw new Error(`revocation_epochs: get conn failed: ${errorText(error)}`); }
}

/** `persist_revocation_epoch`: upsert one epoch row. */
export function persistRevocationEpoch(db: ChatV2Database, kind: string, taskId: string, epoch: bigint): void {
  if (epoch > I64_MAX) throw new Error(`epoch ${epoch} exceeds SQLite INTEGER range`);
  const conn = connectionOf(db);
  try {
    upsertRevocationEpoch(conn, kind, taskId, epoch, toRfc3339());
  } catch (error) {
    throw new Error(`revocation_epochs upsert failed (kind=${kind}, task=${taskId}): ${errorText(error)}`);
  }
}

/** `LoadedRevocationEpochs`. */
export interface LoadedRevocationEpochs {
  global: bigint;
  tasks: [string, bigint][];
}

/** `LoadedRevocationEpochs::current_epoch_for`. */
export function loadedEpochFor(loaded: LoadedRevocationEpochs, childTaskId: string): bigint {
  const task = loaded.tasks.find(([id]) => id === childTaskId)?.[1] ?? 0n;
  return maxBigint(loaded.global, task);
}


/** `load_revocation_epochs`: missing table → empty snapshot; corrupt rows skipped with warn. */
export function loadRevocationEpochs(db: ChatV2Database, log: ChatLogger): LoadedRevocationEpochs {
  const conn = connectionOf(db);
  if (!revocationEpochsTableExists(conn)) {
    log.debug('[Grants] revocation_epochs table absent; starting from epoch 0');
    return { global: 0n, tasks: [] };
  }
  try { prepareRevocationEpochs(conn); }
  catch (error) { throw new Error(`revocation_epochs prepare failed: ${errorText(error)}`); }
  let rows: { kind: unknown; task_id: unknown; epoch: unknown }[];
  try { rows = selectRevocationEpochRows(conn); }
  catch (error) { throw new Error(`revocation_epochs query failed: ${errorText(error)}`); }
  const loaded: LoadedRevocationEpochs = { global: 0n, tasks: [] };
  for (const row of rows) {
    if (typeof row.kind !== 'string' || typeof row.task_id !== 'string' || typeof row.epoch !== 'bigint') {
      throw new Error(`revocation_epochs row decode failed: Invalid column type at row ${JSON.stringify(
        { kind: typeof row.kind, task_id: typeof row.task_id, epoch: typeof row.epoch })}`);
    }
    const { kind, task_id: taskId, epoch } = row;
    if (epoch < 0n) {
      log.warn(`[Grants] skipping corrupt revocation_epochs row (negative epoch): kind=${kind}, task=${taskId}`);
      continue;
    }
    if (kind === EPOCH_KIND_GLOBAL) {
      loaded.global = maxBigint(loaded.global, epoch);
    } else if (kind === EPOCH_KIND_TASK) {
      const existing = loaded.tasks.find(([id]) => id === taskId);
      if (existing !== undefined) existing[1] = maxBigint(existing[1], epoch);
      else loaded.tasks.push([taskId, epoch]);
    } else {
      log.warn(`[Grants] skipping revocation_epochs row with unknown kind: ${kind}`);
    }
  }
  return loaded;
}

/** `restore_revocation_epochs_from_db`: max-install, never lowers; errors only log. */
export function restoreRevocationEpochsFromDb(db: ChatV2Database, log: ChatLogger): void {
  let loaded: LoadedRevocationEpochs;
  try { loaded = loadRevocationEpochs(db, log); }
  catch (error) {
    log.error(`[Grants] Failed to restore revocation epochs (starting from in-memory 0): ${errorText(error)}`);
    return;
  }
  if (loaded.global === 0n && loaded.tasks.length === 0) return;
  globalRevocationEpoch = maxBigint(globalRevocationEpoch, loaded.global);
  for (const [taskId, epoch] of loaded.tasks) {
    taskRevocationEpochs.set(taskId, maxBigint(taskRevocationEpochs.get(taskId) ?? 0n, epoch));
  }
  log.info(`[Grants] Restored revocation epochs from db: global=${loaded.global}, tasks=${loaded.tasks.length}`);
}

// ============================================================================
// Process-wide grant registry (worker session → grant)
// ============================================================================

/**
 * `GrantRegistrationGuard`: Drop → `dispose()`. Only removes the registry
 * entry while it is still this guard's generation (same-session reruns
 * overwrite the registration first).
 */
export class GrantRegistrationGuard {
  private disposed = false;
  private readonly sessionId: string;
  readonly grantId: string;
  private readonly log: ChatLogger;
  constructor(sessionId: string, grantId: string, log: ChatLogger) {
    this.sessionId = sessionId; this.grantId = grantId; this.log = log;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (grantRegistry.get(this.sessionId)?.grantId === this.grantId) {
      grantRegistry.delete(this.sessionId);
      this.log.debug(`[Grants] Unregistered grant ${this.grantId} for session ${this.sessionId}`);
    }
  }

  [Symbol.dispose](): void { this.dispose(); }
}

/** `issue_worker_grant`: snapshot = current max(global, per-task) epoch; expiry None in P1. */
export function issueWorkerGrant(sessionId: string, parentTaskId: string, childTaskId: string,
  allowedTools: readonly string[], profileHash: string, budget: DelegatedBudgetSpec | null,
  log: ChatLogger): GrantRegistrationGuard {
  const grant: DelegatedGrant = {
    grantId: `grant_${ulid()}`,
    schemaVersion: DELEGATED_GRANT_SCHEMA_VERSION,
    parentTaskId,
    childTaskId,
    toolScopes: scopesFromAllowedTools(allowedTools),
    objectScopes: [],
    networkDestinations: [],
    budget,
    expiry: null,
    revocationEpoch: currentEpochFor(childTaskId),
    profileHash,
  };
  return registerGrant(sessionId, grant, log);
}

/** `register_grant`: a same-session rerun overwrites the previous registration. */
export function registerGrant(sessionId: string, grant: DelegatedGrant, log: ChatLogger): GrantRegistrationGuard {
  const guard = new GrantRegistrationGuard(sessionId, grant.grantId, log);
  log.debug(`[Grants] Registered grant ${grant.grantId} for session ${sessionId} (child_task=${grant.childTaskId}, scopes=${grant.toolScopes.length}, epoch=${grant.revocationEpoch})`);
  grantRegistry.set(sessionId, grant);
  return guard;
}

/** `lookup_grant_for_session`: returns a clone, like the Rust read-lock clone. */
export function lookupGrantForSession(sessionId: string): DelegatedGrant | null {
  const grant = grantRegistry.get(sessionId);
  return grant === undefined ? null : structuredClone(grant);
}
