import { describe, expect, it } from 'vitest';
import { runDialecticReflection } from '../src/dialectic-reflection.ts';

describe('Memory v2 Dialectic Reflection Engine', () => {
  it('flags recurring weak points, stale retirement candidates, rule promotions, and budget pressure', () => {
    const nowMs = Date.parse('2026-11-23T12:00:00Z');
    const report = runDialecticReflection({
      nowMs,
      rulesChars: 1320,
      rulesMaxChars: 1500,
      profileChars: 800,
      profileMaxChars: 2500,
      hardRules: {
        version: 3,
        updated_at: '2026-11-23T00:00:00Z',
        rules: [
          {
            id: 'r1',
            instruction: '每次结尾留一道思考题',
            scope: 'global',
            origin: 'user_explicit',
            pinned: true,
            createdAt: '2026-11-01T00:00:00Z',
            updatedAt: '2026-11-01T00:00:00Z',
          },
        ],
      },
      learnerProfile: {
        version: 4,
        updated_at: '2026-11-23T00:00:00Z',
        weak_points: [
          {
            subject: '线性代数',
            knowledge_point: '特征值几何意义',
            error_pattern: '变换矩阵列空间理解错误',
            evidence_count: 4,
            last_seen: '2026-11-22T00:00:00Z',
          },
          {
            subject: '高等数学',
            knowledge_point: '洛必达法则条件',
            error_pattern: '未验证0/0型',
            evidence_count: 1,
            last_seen: '2026-09-01T00:00:00Z',
          },
        ],
        preferences: {
          others: ['每次结尾留一道思考题', '请优先用生活中的工程类比解释抽象概念'],
        },
        goals: [],
      },
    });

    expect(report.activeWeakPointCount).toBe(2);
    expect(report.proposals.some(p => p.kind === 'relapse_focus' && p.title.includes('特征值几何意义'))).toBe(true);
    expect(report.proposals.some(p => p.kind === 'retire_stale_weak_point' && p.title.includes('洛必达法则条件'))).toBe(true);
    expect(report.proposals.some(p => p.kind === 'compress_hard_rules')).toBe(true);
    // Budget >= 85% suppresses automatic promotion suggestions
    expect(report.proposals.some(p => p.kind === 'promote_preference_to_rule')).toBe(false);
  });

  it('suggests promoting uncovered soft preferences when L1 budget has headroom', () => {
    const report = runDialecticReflection({
      rulesChars: 200,
      rulesMaxChars: 1500,
      profileChars: 400,
      profileMaxChars: 2500,
      hardRules: { version: 1, updated_at: '2026-11-23T00:00:00Z', rules: [] },
      learnerProfile: {
        version: 1,
        updated_at: '2026-11-23T00:00:00Z',
        weak_points: [],
        preferences: { others: ['回答中所有数学符号都用中文标注含义'] },
        goals: [],
      },
    });

    expect(report.proposals.some(p => p.kind === 'promote_preference_to_rule')).toBe(true);
    expect(report.proposals.some(p => p.kind === 'compress_hard_rules')).toBe(false);
  });
});
