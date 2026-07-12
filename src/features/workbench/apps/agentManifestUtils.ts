import type {
  ActivationContext,
  ActivationHandlerResult,
  AgentActionCall,
  AgentActionResult,
  AgentAppContext,
  AgentJsonSchema,
  AgentJsonValue,
} from '../core/types';

export const NO_ARGS_SCHEMA: AgentJsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

export function objectSchema(
  properties: Record<string, AgentJsonSchema>,
  required: string[] = [],
): AgentJsonSchema {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

export function stableAgentRef(...parts: Array<string | number>): string {
  return parts.map((part) => encodeURIComponent(String(part))).join(':');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

/** Short deterministic revision token; it is an OCC token, not a security hash. */
export function stableRevision(...values: unknown[]): string {
  const input = canonical(values);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `r${(hash >>> 0).toString(36)}`;
}

export function shortLabel(value: string | null | undefined, max = 120): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

export function actionArgs(action: AgentActionCall): Record<string, unknown> {
  return action.args && typeof action.args === 'object' && !Array.isArray(action.args)
    ? (action.args as Record<string, unknown>)
    : {};
}

export function rejectMismatchedTarget(
  action: AgentActionCall,
  expectedRef: string | null | undefined,
): AgentActionResult | null {
  if (!action.targetRef || !expectedRef || action.targetRef === expectedRef) return null;
  return {
    handled: false,
    changed: false,
    code: 'TARGET_REF_MISMATCH',
    hint: `targetRef ${action.targetRef} 与动作参数指向的实体不一致`,
  };
}

export function activationContext(
  ctx: AgentAppContext,
  action: AgentActionCall,
): ActivationContext {
  return {
    windowId: ctx.windowId,
    instanceKey: ctx.instanceKey,
    action: action.name,
    payload: action.args,
  };
}

export function normalizeActivationResult(
  result: ActivationHandlerResult,
  extras: Omit<AgentActionResult, 'handled'> = {},
): AgentActionResult {
  if (result === false) return { handled: false, ...extras };
  if (result && typeof result === 'object') return { ...result, ...extras };
  return { handled: true, ...extras };
}

export async function executeActivation(
  handler: (ctx: ActivationContext) => ActivationHandlerResult | Promise<ActivationHandlerResult>,
  ctx: AgentAppContext,
  action: AgentActionCall,
  extras: Omit<AgentActionResult, 'handled'> = {},
): Promise<AgentActionResult> {
  const result = await handler(activationContext(ctx, action));
  return normalizeActivationResult(result, extras);
}

export function jsonRecord(
  value: Record<string, AgentJsonValue>,
): Record<string, AgentJsonValue> {
  return value;
}
