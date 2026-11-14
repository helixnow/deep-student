/** chat_v2/types.rs:443-740: backend authority values, shared by commands and the repository. */
import { rustTrim } from '../../../platform/util/index.ts';
import { nowEpochNanos, parseRfc3339, toRfc3339, type ParsedDateTime } from '../../../platform/time/index.ts';
import type { AuthorityMode, PermissionPreset } from '../api.ts';

export type PlanStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export interface PlanAuthorityState {
  planId: string;
  status: PlanStatus;
  summary: string;
  approvedAt?: string | null;
  approvedUntil?: string | null;
  bindingKey?: string | null;
}
export interface SessionAuthorityState {
  authorityMode: AuthorityMode;
  permissionPreset: PermissionPreset;
  plan?: PlanAuthorityState;
}

function asciiLower(raw: string): string {
  return rustTrim(raw).replace(/[A-Z]/g, char => char.toLowerCase());
}
export function parseAuthorityMode(raw: string): AuthorityMode | null {
  const value = asciiLower(raw);
  return value === 'ask' || value === 'plan' || value === 'craft' ? value : null;
}
export function parsePermissionPreset(raw: string): PermissionPreset | null {
  const value = asciiLower(raw);
  return value === 'cautious' || value === 'relaxed' || value === 'full_access' || value === 'danger_full_access' ? value : null;
}
function object(value: unknown): Record<string, unknown> {
  const json = JSON as typeof JSON & { isRawJSON?(value: unknown): boolean };
  return value !== null && typeof value === 'object' && !Array.isArray(value) && json.isRawJSON?.(value) !== true ? { ...value } : {};
}
function planStatus(value: unknown): PlanStatus | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value);
    value = entries.length === 1 && entries[0]![1] === null ? entries[0]![0] : null;
  }
  return value === 'pending' || value === 'approved' || value === 'rejected' || value === 'expired' ? value : null;
}

/** serde_json::from_value<PlanAuthorityState>. Invalid typed fields discard the whole plan. */
function decodePlan(value: unknown): PlanAuthorityState | undefined {
  const fields = ['planId', 'status', 'summary', 'approvedAt', 'approvedUntil', 'bindingKey'] as const;
  if (Array.isArray(value) && (value.length < 3 || value.length > fields.length)) return undefined;
  const data = Array.isArray(value) ? Object.fromEntries(fields.map((key, index) => [key, value[index]])) : object(value);
  const status = planStatus(data.status);
  if (typeof data.planId !== 'string' || status === null || typeof data.summary !== 'string') return undefined;
  const plan: PlanAuthorityState = { planId: data.planId, status, summary: data.summary };
  for (const key of ['approvedAt', 'approvedUntil', 'bindingKey'] as const) {
    const field = data[key];
    if (field == null) continue;
    if (typeof field !== 'string') return undefined;
    plan[key] = field;
  }
  return plan;
}

export function sessionAuthorityFromMetadata(metadata: unknown): SessionAuthorityState {
  const meta = object(metadata);
  // Value::get(...).or_else(...) uses presence, so explicit null masks the alias.
  const mode = Object.hasOwn(meta, 'authorityMode') ? meta.authorityMode : meta.authority_mode;
  const preset = Object.hasOwn(meta, 'permissionPreset') ? meta.permissionPreset : meta.permission_preset;
  const plan = decodePlan(meta.plan);
  return {
    authorityMode: typeof mode === 'string' ? parseAuthorityMode(mode) ?? 'craft' : 'craft',
    permissionPreset: typeof preset === 'string' ? parsePermissionPreset(preset) ?? 'relaxed' : 'relaxed',
    ...(plan === undefined ? {} : { plan }),
  };
}

export function applySessionAuthorityMetadata(metadata: unknown, authority: SessionAuthorityState): Record<string, unknown> {
  const next = object(metadata);
  next.authorityMode = authority.authorityMode;
  next.authority_mode = authority.authorityMode;
  next.permissionPreset = authority.permissionPreset;
  next.permission_preset = authority.permissionPreset;
  if (authority.plan === undefined) delete next.plan;
  else {
    const plan = authority.plan;
    next.plan = { planId: plan.planId, status: plan.status, summary: plan.summary,
      ...(plan.approvedAt == null ? {} : { approvedAt: plan.approvedAt }),
      ...(plan.approvedUntil == null ? {} : { approvedUntil: plan.approvedUntil }),
      ...(plan.bindingKey == null ? {} : { bindingKey: plan.bindingKey }) };
  }
  return next;
}

export function newPendingPlan(summary: string): PlanAuthorityState {
  return { planId: `plan_${globalThis.crypto.randomUUID()}`, status: 'pending', summary };
}
export function bindPlanToCall(plan: PlanAuthorityState, bindingKey: string): void { plan.bindingKey = bindingKey; }

export function isPlanBatchActive(plan: PlanAuthorityState, now: ParsedDateTime): boolean {
  if (plan.status !== 'approved') return false;
  if (plan.approvedUntil == null) return true;
  const until = parseRfc3339(plan.approvedUntil);
  if (until === null) return false;
  // chrono DateTime Ord compares UTC base seconds then nanos (including leap nanos >= 1e9).
  const untilBase = until.epochNanos - BigInt(until.nanos);
  const nowBase = now.epochNanos - BigInt(now.nanos);
  return untilBase > nowBase || (untilBase === nowBase && until.nanos > now.nanos);
}
export function isPlanActiveForBinding(plan: PlanAuthorityState, bindingKey: string, now: ParsedDateTime): boolean {
  return plan.bindingKey === bindingKey && isPlanBatchActive(plan, now);
}
export function markPlanApproved(plan: PlanAuthorityState, ttlSecs: bigint): void {
  const now = nowEpochNanos();
  plan.status = 'approved';
  plan.approvedAt = toRfc3339(now);
  // chrono Duration::seconds and DateTime::add panic on overflow, not saturate.
  if (ttlSecs < -9223372036854775n || ttlSecs > 9223372036854775n) throw new RangeError('TimeDelta::seconds out of bounds');
  const until = now + ttlSecs * 1_000_000_000n;
  if (until < -8334601228800000000000n || until >= 8210266876800000000000n) throw new RangeError('`DateTime + TimeDelta` overflowed');
  plan.approvedUntil = toRfc3339(until);
}
export function markPlanExpired(plan: PlanAuthorityState): void { plan.status = 'expired'; }
