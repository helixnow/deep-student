import type { GenerativeActionDefinition, GenerativeUIIntent, RiskLevel } from './types';
import {
  wrapActionWithTelemetry,
  type GenerativeActionTelemetrySink,
} from './handlers/actionTelemetry';
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

/** 最小侵入：为 handler 表统一套上 telemetry，不改各 createXxxHandlers 签名 */
export function withGenerativeActionInstrumentation(
  handlers: Record<string, GenerativeActionDefinition>,
  options?: GenerativeActionInstrumentationOptions,
): Record<string, GenerativeActionDefinition> {
  const fingerprint = resolveInstrumentationFingerprint(options);
  const extras = fingerprint ? { fingerprint } : undefined;
  const instrumented: Record<string, GenerativeActionDefinition> = {};
  for (const [id, def] of Object.entries(handlers)) {
    instrumented[id] = wrapActionWithTelemetry(def, options?.sink, extras);
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
