import { describe, expect, it } from 'vitest';

import {
  formatRequestCount,
  getOpenCodeGoModelQuota,
  OPENCODE_GO_PLAN_MODELS,
  OPENCODE_GO_PLANS,
  OPENCODE_GO_PLANS_VERIFIED_AT,
} from '../opencodeGoPlans';

describe('opencodeGoPlans', () => {
  it('keeps a complete record for every model and plan', () => {
    expect(OPENCODE_GO_PLANS.map((plan) => plan.id)).toEqual(['go', 'go_plus', 'go_teams']);
    expect(OPENCODE_GO_PLANS_VERIFIED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(OPENCODE_GO_PLAN_MODELS.length).toBeGreaterThan(10);
    for (const model of OPENCODE_GO_PLAN_MODELS) {
      for (const plan of OPENCODE_GO_PLANS) {
        expect(model.monthly_limit_usd).toHaveProperty(plan.id);
        expect(model.estimated_requests).toHaveProperty(plan.id);
      }
    }
  });

  it('looks up quotas per plan with official numbers', () => {
    const go = getOpenCodeGoModelQuota('deepseek-v4.1-flash', 'go');
    expect(go?.monthlyLimitUsd).toBe(100);
    expect(go?.estimatedRequests?.five_hour).toBe(43330);
    expect(getOpenCodeGoModelQuota('DeepSeek-V4.1-Flash', 'go_plus')?.monthlyLimitUsd).toBe(200);
    expect(getOpenCodeGoModelQuota('claude-haiku-5-5', 'go')?.monthlyLimitUsd).toBe(15);
  });

  it('marks free and training-permitted models and ignores unknown ids', () => {
    const free = getOpenCodeGoModelQuota('beam-free', 'go');
    expect(free?.free).toBe(true);
    expect(free?.estimatedRequests).toBeNull();
    expect(getOpenCodeGoModelQuota('muse-spark-1.3-contributor', 'go')?.model.training_permitted).toBe(true);
    expect(getOpenCodeGoModelQuota('not-a-model', 'go')).toBeNull();
    expect(getOpenCodeGoModelQuota('', 'go')).toBeNull();
  });

  it('formats request counts compactly', () => {
    expect(formatRequestCount(43330, 'en-US')).toBe('43.3K');
    expect(formatRequestCount(43330, 'zh-CN')).toBe('4.3万');
    expect(formatRequestCount(169, 'en-US')).toBe('169');
  });
});
