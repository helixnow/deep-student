/**
 * OpenCode Go 各模型额度（静态数据，见 scripts/opencode-go-plans.json）。
 *
 * 官方规则：所有模型共用 5 小时 / 周 / 月三档额度；每个模型的「月额度」是换算系数——
 * 按标价在该模型上花掉月额度对应的金额，即用完 100% 月额度。月额度越高，同样的额度能用得越多。
 * 官方没有公开接口提供这张表，数据由 scripts/generate-opencode-go-plans.mjs 从文档页生成，
 * 随版本发布；实时剩余额度走公开的用量接口（见 ./opencodeGo.ts）。
 */

import { useEffect, useState } from 'react';
import plansData from '../../scripts/opencode-go-plans.json';
import { getSetting, saveSetting } from './settingsApi';

export type OpenCodeGoPlanId = 'go' | 'go_plus' | 'go_teams';

export interface OpenCodeGoEstimatedRequests {
  five_hour: number;
  week: number;
  month: number;
}

export interface OpenCodeGoPlanModel {
  id: string;
  name: string;
  protocol: string;
  training_permitted: boolean;
  monthly_limit_usd: Record<OpenCodeGoPlanId, number | null>;
  estimated_requests: Record<OpenCodeGoPlanId, OpenCodeGoEstimatedRequests | null>;
}

interface OpenCodeGoPlansDocument {
  verified_at: string;
  source: string;
  plans: Array<{ id: OpenCodeGoPlanId; name: string; price_usd_per_month: number; per_member?: boolean }>;
  models: OpenCodeGoPlanModel[];
}

const plans = plansData as OpenCodeGoPlansDocument;

export const OPENCODE_GO_PLANS = plans.plans;
export const OPENCODE_GO_PLAN_MODELS = plans.models;
export const OPENCODE_GO_PLANS_VERIFIED_AT = plans.verified_at;
export const OPENCODE_GO_PLANS_SOURCE = plans.source;

export const OPENCODE_GO_PLAN_SETTING_KEY = 'opencode_go.plan';
export const DEFAULT_OPENCODE_GO_PLAN: OpenCodeGoPlanId = 'go';
const PLAN_CHANGED_EVENT = 'opencode-go-plan-changed';

const isPlanId = (value: unknown): value is OpenCodeGoPlanId =>
  value === 'go' || value === 'go_plus' || value === 'go_teams';

export interface OpenCodeGoModelQuota {
  model: OpenCodeGoPlanModel;
  /** 免费型号（官方标注 Unlimited，限时） */
  free: boolean;
  monthlyLimitUsd: number | null;
  estimatedRequests: OpenCodeGoEstimatedRequests | null;
}

/** 按模型 ID（如 `deepseek-v4.1-flash`）查询某套餐下的额度。 */
export function getOpenCodeGoModelQuota(
  modelId: string | null | undefined,
  plan: OpenCodeGoPlanId,
): OpenCodeGoModelQuota | null {
  const id = (modelId ?? '').trim().toLowerCase();
  if (!id) return null;
  const model = OPENCODE_GO_PLAN_MODELS.find((candidate) => candidate.id.toLowerCase() === id);
  if (!model) return null;
  const monthlyLimitUsd = model.monthly_limit_usd[plan];
  return {
    model,
    free: monthlyLimitUsd === null,
    monthlyLimitUsd,
    estimatedRequests: model.estimated_requests[plan],
  };
}

/** 请求数的紧凑写法：中文「4.3万」、英文「43K」。 */
export function formatRequestCount(count: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(count);
}

export async function loadOpenCodeGoPlan(): Promise<OpenCodeGoPlanId> {
  try {
    const value = await getSetting(OPENCODE_GO_PLAN_SETTING_KEY);
    return isPlanId(value) ? value : DEFAULT_OPENCODE_GO_PLAN;
  } catch {
    return DEFAULT_OPENCODE_GO_PLAN;
  }
}

export async function saveOpenCodeGoPlan(plan: OpenCodeGoPlanId): Promise<void> {
  await saveSetting(OPENCODE_GO_PLAN_SETTING_KEY, plan);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<OpenCodeGoPlanId>(PLAN_CHANGED_EVENT, { detail: plan }));
  }
}

/** 当前选择的套餐档位（用户在 OpenCode Go 供应商页选择，默认 Go）。 */
export function useOpenCodeGoPlan(): [OpenCodeGoPlanId, (plan: OpenCodeGoPlanId) => Promise<void>] {
  const [plan, setPlan] = useState<OpenCodeGoPlanId>(DEFAULT_OPENCODE_GO_PLAN);

  useEffect(() => {
    let active = true;
    void loadOpenCodeGoPlan().then((value) => {
      if (active) setPlan(value);
    });
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<OpenCodeGoPlanId>).detail;
      if (isPlanId(next)) setPlan(next);
    };
    window.addEventListener(PLAN_CHANGED_EVENT, onChange);
    return () => {
      active = false;
      window.removeEventListener(PLAN_CHANGED_EVENT, onChange);
    };
  }, []);

  const update = async (next: OpenCodeGoPlanId) => {
    setPlan(next);
    await saveOpenCodeGoPlan(next);
  };

  return [plan, update];
}
