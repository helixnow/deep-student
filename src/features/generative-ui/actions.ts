import type { GenerativeActionDefinition, RiskLevel } from './types';
import {
  wrapActionWithTelemetry,
  type GenerativeActionTelemetrySink,
} from './handlers/actionTelemetry';

const RISK_RANK: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export interface GenerativeActionInstrumentationOptions {
  sink?: GenerativeActionTelemetrySink;
}

/** 最小侵入：为 handler 表统一套上 telemetry，不改各 createXxxHandlers 签名 */
export function withGenerativeActionInstrumentation(
  handlers: Record<string, GenerativeActionDefinition>,
  options?: GenerativeActionInstrumentationOptions,
): Record<string, GenerativeActionDefinition> {
  const instrumented: Record<string, GenerativeActionDefinition> = {};
  for (const [id, def] of Object.entries(handlers)) {
    instrumented[id] = wrapActionWithTelemetry(def, options?.sink);
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
