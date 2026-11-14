import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import zhReview from '../../../locales/zh-CN/review.json';
import enReview from '../../../locales/en-US/review.json';
import { ExamReadinessHud } from '../ExamReadinessHud';
import {
  getSprintLauncherSnapshot,
  resetSprintLauncherStoreForTest,
  setSprintReadinessForTest,
} from '../sprintLauncherStore';
import type { ExamReadinessSnapshot } from '../sprintContracts';

const EMOJI_RE = /[\p{Extended_Pictographic}]/u;

function buildHudReadiness(
  overrides: Partial<ExamReadinessSnapshot> = {},
): ExamReadinessSnapshot {
  return {
    spaceId: 'space_physics',
    examDate: '2026-11-29',
    daysUntilExam: 18,
    phase: 'reinforce',
    effectiveTargetRetention: 0.91,
    dailyNewCardQuota: 14,
    newIntakeFrozen: false,
    predictedExamRetrievability: 0.864,
    currentRetrievability: 0.89,
    totalActiveItems: 64,
    selectedSprintCount: 22,
    estimatedSprintMinutes: 12,
    estimatedSprintSeconds: 720,
    deferredBacklogCount: 18,
    breakdown: {
      fsrsDueCount: 12,
      fsrsNewCount: 4,
      mistakeDueCount: 4,
      mindmapWeakCount: 2,
    },
    computedAtMs: 1_762_000_000_000,
    ...overrides,
  };
}

function collectKeyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...collectKeyPaths(v as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

describe('ExamReadinessHud', () => {
  beforeEach(() => {
    resetSprintLauncherStoreForTest();
  });

  it('renders study-space-header, agenda-strip, and mobile-banner variants with D-18, 86.4%, and 12-minute CTA, triggering openDailySprint on click', () => {
    setSprintReadinessForTest(buildHudReadiness());

    const headerView = render(<ExamReadinessHud variant="study-space-header" />);
    const headerEl = screen.getByTestId('exam-readiness-hud-header');
    expect(headerEl.textContent).toContain('D-18');
    expect(headerEl.textContent).toContain('预测提取率 86.4%');
    expect(headerEl.textContent).toContain('开始今日冲刺 · 预计 12 分钟');
    expect(EMOJI_RE.test(headerEl.textContent ?? '')).toBe(false);

    fireEvent.click(screen.getByTestId('hud-header-sprint-cta'));
    expect(getSprintLauncherSnapshot().isOpen).toBe(true);
    expect(getSprintLauncherSnapshot().launchOptions?.source).toBe('study-space-header');
    headerView.unmount();

    resetSprintLauncherStoreForTest();
    setSprintReadinessForTest(buildHudReadiness());

    const agendaView = render(<ExamReadinessHud variant="agenda-strip" />);
    const agendaEl = screen.getByTestId('exam-readiness-hud-agenda');
    expect(agendaEl.textContent).toContain('D-18');
    expect(agendaEl.textContent).toContain('86.4%');
    expect(agendaEl.textContent).toContain('开始今日冲刺 · 预计 12 分钟');
    expect(EMOJI_RE.test(agendaEl.textContent ?? '')).toBe(false);

    fireEvent.click(screen.getByTestId('wb-agenda-sprint-cta'));
    expect(getSprintLauncherSnapshot().isOpen).toBe(true);
    expect(getSprintLauncherSnapshot().launchOptions?.source).toBe('desktop-agenda');
    agendaView.unmount();

    resetSprintLauncherStoreForTest();
    setSprintReadinessForTest(buildHudReadiness());

    render(<ExamReadinessHud variant="mobile-banner" />);
    const mobileEl = screen.getByTestId('exam-readiness-hud-mobile');
    expect(mobileEl.textContent).toContain('D-18');
    expect(mobileEl.textContent).toContain('预测提取率 86.4%');
    const mobileCta = screen.getByTestId('hud-mobile-sprint-cta');
    expect(mobileCta.textContent).toContain('开始今日冲刺 · 预计 12 分钟');
    expect(mobileCta.className).toContain('min-h-[48px]');
    expect(EMOJI_RE.test(mobileEl.textContent ?? '')).toBe(false);

    fireEvent.click(mobileCta);
    expect(getSprintLauncherSnapshot().isOpen).toBe(true);
    expect(getSprintLauncherSnapshot().launchOptions?.source).toBe('mobile-banner');
  });

  it('handles D-Day (D=0), post-exam maintenance (D=-3), and unscheduled [设置考期] action cleanly', () => {
    setSprintReadinessForTest(
      buildHudReadiness({
        daysUntilExam: 0,
        phase: 'sprint',
        effectiveTargetRetention: 0.94,
      }),
    );
    const ddayView = render(<ExamReadinessHud variant="study-space-header" />);
    expect(screen.getByTestId('exam-readiness-hud-header').textContent).toContain('D-Day');
    ddayView.unmount();

    setSprintReadinessForTest(
      buildHudReadiness({
        daysUntilExam: -3,
        phase: 'maintenance',
        effectiveTargetRetention: 0.88,
      }),
    );
    const postView = render(<ExamReadinessHud variant="study-space-header" />);
    expect(screen.getByTestId('exam-readiness-hud-header').textContent).toContain('D+3 · 考后维持');
    postView.unmount();

    setSprintReadinessForTest(
      buildHudReadiness({
        examDate: null,
        daysUntilExam: null,
        phase: 'unscheduled',
      }),
    );
    render(<ExamReadinessHud variant="mobile-banner" />);
    expect(screen.getByTestId('hud-mobile-set-exam').textContent).toContain('设置考期');
    expect(screen.getByTestId('exam-readiness-hud-mobile').textContent).toContain('7 日预测提取率 86.4%');
  });

  it('maintains 100% examSprint key tree parity between zh-CN/review.json and en-US/review.json', () => {
    const zhExamSprint = (zhReview as Record<string, unknown>).examSprint as Record<string, unknown>;
    const enExamSprint = (enReview as Record<string, unknown>).examSprint as Record<string, unknown>;
    expect(zhExamSprint).toBeDefined();
    expect(enExamSprint).toBeDefined();
    expect(collectKeyPaths(zhExamSprint)).toEqual(collectKeyPaths(enExamSprint));
  });
});
