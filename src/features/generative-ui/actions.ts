import type { GenerativeActionDefinition, GenerativeUIIntent, RiskLevel } from './types';
import {
  defaultGenerativeActionTelemetrySink,
  wrapActionWithTelemetry,
  type GenerativeActionTelemetrySink,
} from './handlers/actionTelemetry';
import { pushDefaultGenerativeActionTelemetry } from './handlers/actionTelemetryRing';
import {
  wrapActionWithTimeout,
  GENERATIVE_ACTION_TIMEOUT_MS,
} from './handlers/actionTimeout';
import {
  wrapActionWithRateLimit,
  GENERATIVE_ACTION_COOLDOWN_MS,
} from './handlers/actionRateLimit';
import { fingerprintGenerativeUIIntent } from './utils/fingerprintGenerativeUIIntent';

const RISK_RANK: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export interface GenerativeActionInstrumentationOptions {
  sink?: GenerativeActionTelemetrySink;
  /** 显式 fingerprint；与 intent 同时存在时优先 */
  fingerprint?: string;
  /** 传入则自动计算 fingerprint 写入 telemetry 事件 */
  intent?: GenerativeUIIntent;
  ignoreBlockOrder?: boolean;
  /** handler 超时，默认 15s；0 表示跳过 timeout 包装 */
  timeoutMs?: number;
  /** 同 action 冷却，默认 400ms；0 表示跳过 rate-limit 包装 */
  cooldownMs?: number;
}

function resolveInstrumentationFingerprint(
  options?: GenerativeActionInstrumentationOptions,
): string | undefined {
  if (typeof options?.fingerprint === 'string' && options.fingerprint.length > 0) {
    return options.fingerprint;
  }
  if (options?.intent) {
    return fingerprintGenerativeUIIntent(options.intent, {
      ignoreBlockOrder: options.ignoreBlockOrder,
    });
  }
  return undefined;
}

function composeInstrumentationSink(
  sink?: GenerativeActionTelemetrySink,
): GenerativeActionTelemetrySink {
  return (event) => {
    pushDefaultGenerativeActionTelemetry(event);
    (sink ?? defaultGenerativeActionTelemetrySink)(event);
  };
}

function applyActionGuards(
  def: GenerativeActionDefinition,
  options?: GenerativeActionInstrumentationOptions,
): GenerativeActionDefinition {
  const timeoutMs = options?.timeoutMs ?? GENERATIVE_ACTION_TIMEOUT_MS;
  const cooldownMs = options?.cooldownMs ?? GENERATIVE_ACTION_COOLDOWN_MS;
  let next = def;
  if (cooldownMs > 0) {
    next = wrapActionWithRateLimit(next, { cooldownMs });
  }
  if (timeoutMs > 0) {
    next = wrapActionWithTimeout(next, { timeoutMs });
  }
  return next;
}

/** Own-property lookup so prototype keys cannot impersonate a registered action. */
export function lookupGenerativeActionHandler(
  actionHandlers: Record<string, GenerativeActionDefinition> | undefined,
  actionId: string,
): GenerativeActionDefinition | undefined {
  if (!actionHandlers || !Object.hasOwn(actionHandlers, actionId)) return undefined;
  return actionHandlers[actionId];
}

/** 最小侵入：为 handler 表统一套上 rate-limit / timeout / telemetry，不改各 createXxxHandlers 签名 */
export function withGenerativeActionInstrumentation(
  handlers: Record<string, GenerativeActionDefinition>,
  options?: GenerativeActionInstrumentationOptions,
): Record<string, GenerativeActionDefinition> {
  const fingerprint = resolveInstrumentationFingerprint(options);
  const extras = fingerprint ? { fingerprint } : undefined;
  const sink = composeInstrumentationSink(options?.sink);
  const instrumented: Record<string, GenerativeActionDefinition> = Object.create(null);
  for (const [id, def] of Object.entries(handlers)) {
    if (!Object.hasOwn(handlers, id)) continue;
    instrumented[id] = wrapActionWithTelemetry(applyActionGuards(def, options), sink, extras);
  }
  return instrumented;
}

/** 有效风险级 = max(模型声明, handler 注册声明)，不信任模型单独声明 */
export function resolveEffectiveRiskLevel(
  modelDeclared?: RiskLevel,
  handlerDeclared?: RiskLevel,
): RiskLevel {
  const model = modelDeclared ?? 'low';
  const handler = handlerDeclared ?? 'low';
  return RISK_RANK[model] >= RISK_RANK[handler] ? model : handler;
}
