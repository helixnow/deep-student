import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import zhReview from '../../../locales/zh-CN/review.json';
import enReview from '../../../locales/en-US/review.json';
import { SprintSettlementScreen } from '../SprintSettlementScreen';
import type { SprintSessionSettlement } from '../sprintContracts';

const EMOJI_RE = /[\p{Extended_Pictographic}]/u;

function buildSettlementFixture(
  overrides: Partial<SprintSessionSettlement> = {},
): SprintSessionSettlement {
  return {
    planSessionId: 'sprint_settle_1',
    readinessBefore: {
      spaceId: 'space_math',
      examDate: '2026-11-29',
      daysUntilExam: 18,
      phase: 'reinforce',
      effectiveTargetRetention: 0.92,
      dailyNewCardQuota: 15,
      newIntakeFrozen: false,
      predictedExamRetrievability: 0.864,
      currentRetrievability: 0.88,
      totalActiveItems: 120,
      selectedSprintCount: 28,
      estimatedSprintMinutes: 14,
      estimatedSprintSeconds: 840,
      deferredBacklogCount: 16,
      breakdown: {
        fsrsDueCount: 14,
        fsrsNewCount: 4,
        mistakeDueCount: 6,
        mindmapWeakCount: 4,
      },
      computedAtMs: 1_762_000_000_000,
    },
    readinessAfter: {
      spaceId: 'space_math',
      examDate: '2026-11-29',
      daysUntilExam: 18,
      phase: 'reinforce',
      effectiveTargetRetention: 0.92,
      dailyNewCardQuota: 15,
      newIntakeFrozen: false,
      predictedExamRetrievability: 0.891,
      currentRetrievability: 0.915,
      totalActiveItems: 120,
      selectedSprintCount: 0,
      estimatedSprintMinutes: 0,
      estimatedSprintSeconds: 0,
      deferredBacklogCount: 16,
      breakdown: {
        fsrsDueCount: 0,
        fsrsNewCount: 0,
        mistakeDueCount: 0,
        mindmapWeakCount: 0,
      },
      computedAtMs: 1_762_000_840_000,
    },
    readinessDeltaPctPoints: 2.7,
    totalCompleted: 28,
    passedCount: 24,
    againCount: 4,
    totalElapsedSeconds: 840,
    studyTimeRecordedSeconds: 840,
    masteryEventsWritten: 28,
    byKind: {
      fsrsCards: 18,
      mistakes: 6,
      variantsSolved: 3,
      mindmapNodes: 4,
    },
    conceptDeltas: [
      { concept: '定积分换元法', scoreAfter: 0.78, outcome: 'improved' },
      { concept: '泰勒展开余项', scoreAfter: 0.52, outcome: 'needs_reinforce' },
    ],
    ...overrides,
  };
}

function collectAllStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node);
  } else if (Array.isArray(node)) {
    for (const item of node) collectAllStrings(item, out);
  } else if (node && typeof node === 'object') {
    for (const val of Object.values(node)) collectAllStrings(val, out);
  }
  return out;
}

describe('SprintSettlementScreen', () => {
  it('renders verified before/after Exam Readiness, tabular-nums metrics, modality breakdown, and concept mastery deltas with zero emojis', () => {
    const onFinish = vi.fn();
    const onExtraSprint = vi.fn();
    const settlement = buildSettlementFixture();

    const { container } = render(
      <SprintSettlementScreen
        settlement={settlement}
        deferredBacklogCount={16}
        onFinish={onFinish}
        onExtraSprint={onExtraSprint}
      />,
    );

    const beforeEl = screen.getByTestId('settlement-readiness-before');
    const afterEl = screen.getByTestId('settlement-readiness-after');
    const deltaEl = screen.getByTestId('settlement-readiness-delta');
    const durationEl = screen.getByTestId('settlement-duration-value');
    const totalEl = screen.getByTestId('settlement-completed-total');
    const firstPassEl = screen.getByTestId('settlement-first-pass-rate');

    expect(beforeEl.textContent).toBe('86.4%');
    expect(afterEl.textContent).toBe('89.1%');
    expect(deltaEl.textContent).toBe('+2.7%');
    expect(durationEl.textContent).toBe('14 分钟');
    expect(totalEl.textContent).toBe('28');
    expect(firstPassEl.textContent).toBe('85.7%');

    for (const el of [beforeEl, afterEl, deltaEl, durationEl, totalEl, firstPassEl]) {
      expect(el.className).toContain('font-mono');
      expect(el.className).toContain('tabular-nums');
    }

    expect(container.textContent).toContain('闪卡 18 · 错题 6 · 导图 4');
    expect(container.textContent).toContain('含 3 道 AI 变式');
    expect(container.textContent).toContain('定积分换元法');
    expect(container.textContent).toContain('78%');
    expect(screen.getByTestId('settlement-deferred-note').textContent).toContain('16');

    expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);

    fireEvent.click(screen.getByTestId('settlement-extra-sprint'));
    expect(onExtraSprint).toHaveBeenCalledWith(10);

    fireEvent.click(screen.getByTestId('settlement-finish-button'));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('handles cold-start null retrievability without NaN and enforces zero emojis across both zh-CN and en-US examSprint bundles', () => {
    const base = buildSettlementFixture();
    const coldSettlement = buildSettlementFixture({
      readinessBefore: {
        ...base.readinessBefore,
        examDate: null,
        daysUntilExam: null,
        phase: 'unscheduled',
        predictedExamRetrievability: null,
        totalActiveItems: 0,
      },
      readinessAfter: {
        ...base.readinessAfter,
        examDate: null,
        daysUntilExam: null,
        phase: 'unscheduled',
        predictedExamRetrievability: null,
        totalActiveItems: 0,
      },
      readinessDeltaPctPoints: null,
      totalCompleted: 0,
      passedCount: 0,
      totalElapsedSeconds: 25,
    });

    const { container } = render(
      <SprintSettlementScreen settlement={coldSettlement} onFinish={() => {}} />,
    );

    expect(container.textContent).not.toContain('NaN');
    expect(container.textContent).not.toContain('Infinity');
    expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);

    const zhStrings = collectAllStrings((zhReview as Record<string, unknown>).examSprint);
    const enStrings = collectAllStrings((enReview as Record<string, unknown>).examSprint);
    expect(zhStrings.length).toBeGreaterThan(20);
    expect(enStrings.length).toBe(zhStrings.length);
    for (const s of [...zhStrings, ...enStrings]) {
      expect(EMOJI_RE.test(s)).toBe(false);
    }
  });
});
