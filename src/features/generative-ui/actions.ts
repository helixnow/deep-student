import type { RiskLevel } from './types';

const RISK_RANK: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** 有效风险级 = max(模型声明, handler 注册声明)，不信任模型单独声明 */
export function resolveEffectiveRiskLevel(
  modelDeclared?: RiskLevel,
  handlerDeclared?: RiskLevel,
): RiskLevel {
  const model = modelDeclared ?? 'low';
  const handler = handlerDeclared ?? 'low';
  return RISK_RANK[model] >= RISK_RANK[handler] ? model : handler;
}
