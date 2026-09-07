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

/** 导出供 N09 回归测试直接验证 guard 组合顺序语义 */
export function applyActionGuards(
  def: GenerativeActionDefinition,
  options?: GenerativeActionInstrumentationOptions,
): GenerativeActionDefinition {
  const timeoutMs = options?.timeoutMs ?? GENERATIVE_ACTION_TIMEOUT_MS;
  const cooldownMs = options?.cooldownMs ?? GENERATIVE_ACTION_COOLDOWN_MS;
  let next = def;
  // N09（2026-09-07 审阅）：timeout 必须包在 rate-limit 内层。
  // 旧顺序（rate-limit 在内、timeout 在外）下，外层 race 超时后底层 handler
  // 并未取消，内层 finally 永不执行 → inFlight 永久占用，该 action 在实例
  // 存活期内再无重试路径。换序后超时拒绝会穿过限流器的 finally，占用随
  // 超时释放，重试在 cooldown 后恢复。
  // 注意：超时只停止等待，不 abort 底层 handler——迟到完成仍可能产生一次
  // 副作用，因此 action handler 必须幂等；用户显式重试产生的第二次调用
  // 属于知情重试，与崩溃重启后的重试同级。
  if (timeoutMs > 0) {
    next = wrapActionWithTimeout(next, { timeoutMs });
  }
  if (cooldownMs > 0) {
    next = wrapActionWithRateLimit(next, { cooldownMs });
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
