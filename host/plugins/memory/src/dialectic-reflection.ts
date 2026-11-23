/**
 * Dialectic Reflection & Consolidation Engine (RFC-001 M2/M4).
 *
 * Inspired by Honcho's dialectic learner representation & Hermes' bounded-memory
 * distillation pressure: periodically analyzes the learner's HardRules + LearnerProfile
 * + Mastery relapse signals to produce transparent, auditable consolidation proposals:
 *   1. Relapse Alerts: weak points with repeated relapses or high evidence count
 *   2. Hard-Rule Deduplication / Compression Hints: when budget utilization > 80%
 *   3. Candidate Promotions: repeated preferences in `learnerProfile.preferences.others`
 *      that can be promoted to L1 HardRules
 *   4. Stale Weak-Point Retirement Candidates: weak points untouched beyond threshold days
 *
 * Pure deterministic analysis (no LLM required; never mutates silently).
 */
import type { HardRulesDocument } from './hard-rules.ts';
import type { LearnerProfile } from './learner-profile.ts';

type LearnerWeakPoint = LearnerProfile['weak_points'][number];

export type DialecticProposalKind =
  | 'relapse_focus'
  | 'promote_preference_to_rule'
  | 'compress_hard_rules'
  | 'retire_stale_weak_point';

export interface DialecticProposal {
  id: string;
  kind: DialecticProposalKind;
  title: string;
  rationale: string;
  severity: 'info' | 'attention';
  suggestedPayload?: Record<string, unknown>;
}

export interface DialecticReflectionReport {
  generatedAt: string;
  rulesBudgetRatio: number;
  profileBudgetRatio: number;
  activeWeakPointCount: number;
  proposals: DialecticProposal[];
  summary: string;
}

export interface DialecticReflectionInput {
  hardRules: HardRulesDocument;
  learnerProfile: LearnerProfile;
  rulesChars: number;
  rulesMaxChars: number;
  profileChars: number;
  profileMaxChars: number;
  nowMs?: number;
  staleDays?: number;
}

const DEFAULT_STALE_DAYS = 45;

function parseTimeMs(iso?: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}]+/gu, '');
}

export function runDialecticReflection(input: DialecticReflectionInput): DialecticReflectionReport {
  const nowMs = input.nowMs ?? Date.now();
  const staleDays = Math.max(7, input.staleDays ?? DEFAULT_STALE_DAYS);
  const staleThresholdMs = staleDays * 24 * 60 * 60 * 1000;
  const rulesBudgetRatio = input.rulesMaxChars > 0 ? input.rulesChars / input.rulesMaxChars : 0;
  const profileBudgetRatio = input.profileMaxChars > 0 ? input.profileChars / input.profileMaxChars : 0;

  const proposals: DialecticProposal[] = [];

  // 1. High-evidence or recurring weak points deserve priority focus
  const recurringWeakPoints = input.learnerProfile.weak_points
    .filter((wp: LearnerWeakPoint) => wp.evidence_count >= 3)
    .sort((a, b) => b.evidence_count - a.evidence_count);
  for (const wp of recurringWeakPoints.slice(0, 3)) {
    proposals.push({
      id: `relapse:${wp.subject}:${wp.knowledge_point}`,
      kind: 'relapse_focus',
      title: `高频薄弱点：${wp.subject} · ${wp.knowledge_point}`,
      rationale: `已累计触发 ${wp.evidence_count} 次错因证据（${wp.error_pattern}），建议安排专项变式训练或设为阶段目标。`,
      severity: 'attention',
      suggestedPayload: {
        subject: wp.subject,
        knowledge_point: wp.knowledge_point,
        evidence_count: wp.evidence_count,
      },
    });
  }

  // 2. Stale weak points untouched for >= staleDays can be audited for retirement
  for (const wp of input.learnerProfile.weak_points) {
    const lastSeen = parseTimeMs(wp.last_seen);
    if (lastSeen !== null && nowMs - lastSeen >= staleThresholdMs) {
      const daysAgo = Math.floor((nowMs - lastSeen) / (24 * 60 * 60 * 1000));
      proposals.push({
        id: `retire:${wp.subject}:${wp.knowledge_point}`,
        kind: 'retire_stale_weak_point',
        title: `候选退场：${wp.subject} · ${wp.knowledge_point}`,
        rationale: `该薄弱点已超过 ${daysAgo} 天未再复发，若已掌握可从长期画像中移除以释放预算。`,
        severity: 'info',
        suggestedPayload: {
          subject: wp.subject,
          knowledge_point: wp.knowledge_point,
          daysAgo,
        },
      });
    }
  }

  // 3. Explicit preferences in profile that aren't yet promoted to L1 HardRules
  const existingRuleNorms = new Set(input.hardRules.rules.map(r => normalizeForMatch(r.instruction)));
  for (const pref of input.learnerProfile.preferences.others) {
    const trimmed = pref.trim();
    if (!trimmed || trimmed.length < 6) continue;
    const norm = normalizeForMatch(trimmed);
    const alreadyCovered = [...existingRuleNorms].some(rn => rn.includes(norm) || norm.includes(rn));
    if (!alreadyCovered && rulesBudgetRatio < 0.85) {
      proposals.push({
        id: `promote:${norm.slice(0, 24)}`,
        kind: 'promote_preference_to_rule',
        title: `可升级为 L1 硬规则：「${trimmed.slice(0, 32)}${trimmed.length > 32 ? '…' : ''}」`,
        rationale: '该偏好目前仅在画像软提示中，若希望每次新会话第 1 轮 100% 严格遵循，可一键升格为 L1 硬规则。',
        severity: 'info',
        suggestedPayload: { instruction: trimmed, scope: 'global' },
      });
    }
  }

  // 4. Hard-rules distillation pressure alert (> 80% budget)
  if (rulesBudgetRatio >= 0.8) {
    proposals.push({
      id: 'compress:hard_rules',
      kind: 'compress_hard_rules',
      title: `L1 硬规则预算已用 ${Math.round(rulesBudgetRatio * 100)}%（${input.rulesChars}/${input.rulesMaxChars}）`,
      rationale: '接近上限阈值，建议合并语义重复规则或将临时规则下沉到普通记忆笔记，以保持首轮提示高信噪比。',
      severity: 'attention',
      suggestedPayload: {
        rulesChars: input.rulesChars,
        rulesMaxChars: input.rulesMaxChars,
        ruleCount: input.hardRules.rules.length,
      },
    });
  }

  const summary = proposals.length === 0
    ? '当前长期记忆内核结构健康，暂无待处理的合并或退场建议。'
    : `共生成 ${proposals.length} 条记忆整理建议（含 ${proposals.filter(p => p.severity === 'attention').length} 条重点关注）。`;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    rulesBudgetRatio: Number(rulesBudgetRatio.toFixed(3)),
    profileBudgetRatio: Number(profileBudgetRatio.toFixed(3)),
    activeWeakPointCount: input.learnerProfile.weak_points.length,
    proposals,
    summary,
  };
}
