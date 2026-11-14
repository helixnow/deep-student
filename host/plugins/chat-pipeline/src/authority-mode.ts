import { rustTrim } from '../../../platform/util/index.ts';
import { isRawJsonAtom } from '../../../kernel/agent-api.ts';
import type { AuthorityGateDecision, AuthorityMode, AuthorityState, JsonValue,
  PermissionPreset, PlanGateManager as Manager, PlanGateResponse, ToolSensitivity } from '../api.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';

export const META_TOOL_WHITELIST = ['attempt_completion', 'todo_init', 'todo_update', 'todo_add',
  'todo_get', 'goal_create', 'goal_update', 'goal_get', 'load_skills', 'ask_user'] as const;

export function canonicalToolName(name: string): string {
  for (const prefix of ['builtin-', 'builtin:', 'mcp.tools.', 'mcp_']) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}
export function isMetaReadTool(name: string): boolean {
  const short = canonicalToolName(name);
  return META_TOOL_WHITELIST.some(item => item === short) || short.startsWith('todo_') || short.startsWith('goal_');
}
export function isWriteTool(name: string, sensitivity: ToolSensitivity | null): boolean {
  return !isMetaReadTool(name) && sensitivity !== 'low';
}
export function planBindingSatisfiesToolApproval(state: AuthorityState, bindingKey: string,
  privilegeEscalation: boolean, planGateJustApproved: boolean, now: Date): boolean {
  if (privilegeEscalation || state.authorityMode !== 'plan') return false;
  return planGateJustApproved || (state.plan?.isActiveForBinding(bindingKey, now) ?? false);
}
export function requiresToolApproval(state: AuthorityState, base: ToolSensitivity | null,
  effective: ToolSensitivity | null, immutableCommandGuardAsks: boolean,
  externalMcp: boolean, privilegeEscalation: boolean): boolean {
  if (privilegeEscalation) return true;
  const guardAsks = immutableCommandGuardAsks && !externalMcp;
  if (state.authorityMode !== 'craft') return guardAsks || effective !== 'low';
  switch (state.permissionPreset) {
    case 'cautious': return guardAsks || base !== 'low' || effective !== 'low';
    case 'relaxed': return guardAsks || base === null || effective === null || base === 'high' || effective === 'high';
    case 'full_access': case 'danger_full_access': return false;
  }
}
export function shellGuardAdmitted(asks: boolean, required: boolean, satisfied: boolean): boolean {
  return asks && (!required || satisfied);
}
export function evaluateAuthorityGate(state: AuthorityState, name: string, sensitivity: ToolSensitivity | null,
  bindingKey: string | null, now: Date): AuthorityGateDecision {
  if (!isWriteTool(name, sensitivity)) return { kind: 'allow' };
  switch (state.authorityMode) {
    case 'craft': return { kind: 'allow' };
    case 'ask': return { kind: 'blockAsk', toolName: name, message: askBlockMessage(name) };
    case 'plan': return bindingKey !== null && state.plan?.isActiveForBinding(bindingKey, now)
      ? { kind: 'allow' } : { kind: 'waitPlanGate', summary: `Execute this exact \`${name}\` call once` };
  }
}

// Rust canonical_json sorts object keys by UTF-8 order, including nested objects.
// Encode directly so JS integer-property enumeration cannot rearrange sorted keys.
function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object' && !isRawJsonAtom(value)) {
    return `{${Object.keys(value).sort((a, b) => compareUtf8(a, b))
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function planCallBindingKey(name: string, args: JsonValue, roundId: string | null): string {
  const encoded = `{"tool":${JSON.stringify(canonicalToolName(name))},"arguments":${canonicalJson(args)},"roundId":${JSON.stringify(roundId ?? '')}}`;
  return `planbind:${createHasherSync('SHA-256').update(encoded).digestHex()}`;
}
export function askBlockMessage(name: string): string {
  return `AUTHORITY_BLOCKED: session is in Ask (问一问) mode. Write tool '${name}' was refused because only Low-sensitivity / meta tools may run. Ask the user to switch to Plan (想一想) or Craft (做一做) mode, then retry. suggestedMode=plan`;
}
export function askBlockStructuredOutput(name: string) {
  return { authorityBlocked: true, authorityMode: 'ask', suggestedMode: 'plan', toolName: name, message: askBlockMessage(name) };
}
export function defaultPlanTtlSecs(): number { return 30 * 60; }

/** PermissionPreset::parse — trimmed, ASCII-lowercased. */
export function parsePermissionPreset(raw: string): PermissionPreset | null {
  switch (rustTrim(raw).replace(/[A-Z]/g, char => char.toLowerCase())) {
    case 'cautious': return 'cautious';
    case 'relaxed': return 'relaxed';
    case 'full_access': return 'full_access';
    case 'danger_full_access': return 'danger_full_access';
    default: return null;
  }
}

/** PermissionPreset serde wire names. */
export function permissionPresetWireName(preset: PermissionPreset): string {
  return preset;
}

export interface AuthorityMetadataState {
  authorityMode: AuthorityMode;
  permissionPreset: PermissionPreset;
  plan?: JsonValue | null;
}

export function craftDefaultAuthorityState(): AuthorityMetadataState {
  return { authorityMode: 'craft', permissionPreset: 'relaxed', plan: null };
}

function metadataField(map: Record<string, unknown>, camel: string,
  snake: string): unknown {
  // serde_json `get(camel).or_else(get(snake))`: only an absent key falls back.
  if (Object.prototype.hasOwnProperty.call(map, camel)) return map[camel];
  return map[snake];
}

/** types::SessionAuthorityState::from_metadata — both casings, craft default. */
export function authorityStateFromMetadata(metadata: unknown): AuthorityMetadataState {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return craftDefaultAuthorityState();
  }
  const map = metadata as Record<string, unknown>;

  const rawMode = metadataField(map, 'authorityMode', 'authority_mode');
  const mode = typeof rawMode === 'string' ? rustTrim(rawMode).toLowerCase() : '';
  const authorityMode: AuthorityMode = mode === 'ask' || mode === 'plan' || mode === 'craft'
    ? mode
    : 'craft';

  const rawPreset = metadataField(map, 'permissionPreset', 'permission_preset');
  const permissionPreset = typeof rawPreset === 'string'
    ? parsePermissionPreset(rawPreset) ?? 'relaxed'
    : 'relaxed';

  const plan = map.plan === undefined ? null : map.plan as JsonValue;
  return { authorityMode, permissionPreset, plan };
}

/** types::SessionAuthorityState::apply_to_metadata — writes both casings. */
export function authorityStateToMetadata(state: AuthorityMetadataState,
  metadata?: unknown): Record<string, unknown> {
  const base = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
  base.authorityMode = state.authorityMode;
  base.authority_mode = state.authorityMode;
  base.permissionPreset = state.permissionPreset;
  base.permission_preset = state.permissionPreset;
  if (state.plan !== undefined && state.plan !== null) {
    base.plan = state.plan;
  } else {
    delete base.plan;
  }
  return base;
}

/** authority_mode.rs:280-351. No implicit timeout: the tool loop owns the timeout race. */
export class PlanGateManager implements Manager {
  private readonly pending = new Map<string, { planId: string; resolve(value: PlanGateResponse): void; reject(reason: Error): void }>();
  private timeout = 300;
  withTimeout(seconds: number): this { this.timeout = seconds; return this; }
  defaultTimeout(): number { return this.timeout; }
  register(sessionId: string, toolCallId: string, planId: string): Promise<PlanGateResponse> {
    const key = `${sessionId}\n${toolCallId}`;
    const old = this.pending.get(key);
    const response = new Promise<PlanGateResponse>((resolve, reject) => {
      this.pending.set(key, { planId, resolve, reject });
    });
    old?.resolve({ sessionId, planId: '', toolCallId, approved: false, reason: 'superseded' });
    return response;
  }
  respond(response: PlanGateResponse): boolean {
    const key = `${response.sessionId}\n${response.toolCallId}`;
    const pending = this.pending.get(key);
    if (!pending || pending.planId !== response.planId) return false;
    this.pending.delete(key);
    pending.resolve(response);
    return true;
  }
  cancel(sessionId: string, toolCallId: string): void {
    const key = `${sessionId}\n${toolCallId}`;
    const pending = this.pending.get(key);
    this.pending.delete(key);
    pending?.reject(new Error('channel closed'));
  }
}
const manager = new PlanGateManager();
export function globalPlanGateManager(): PlanGateManager { return manager; }
