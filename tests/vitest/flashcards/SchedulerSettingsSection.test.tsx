import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'settings.scheduler.title': '调度设置',
      'settings.scheduler.subtitle': '每日限额、保持率、学习步与日切（默认牌组）',
      'settings.scheduler.basicGroup': '日常复习节奏',
      'settings.scheduler.newPerDay': '每日新卡上限',
      'settings.scheduler.reviewsPerDay': '每日复习上限',
      'settings.scheduler.desiredRetention': '目标记忆保持率',
      'settings.scheduler.reviewOrder': '复习卡顺序',
      'settings.scheduler.newReviewOrder': '新卡位置',
      'settings.scheduler.expandAdvanced': '展开进阶调度与算法优化',
      'settings.scheduler.collapseAdvanced': '收起进阶调度与算法优化',
      'settings.scheduler.learningSteps': '学习步',
      'settings.scheduler.relearningSteps': '重学步',
      'settings.scheduler.save': '保存',
      'settings.optimizer.title': '个性化记忆节奏（FSRS 参数优化）',
    }[key] ?? key),
    i18n: { language: 'zh-CN' },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { SchedulerSettingsSection } from '@/features/flashcards/components/SchedulerSettingsSection';

const sampleConfig = {
  newPerDay: 20,
  reviewsPerDay: 200,
  desiredRetention: 0.9,
  learnAheadMinutes: 20,
  learningSteps: [60, 600],
  relearningSteps: [600],
  dayRolloverHour: 4,
  maximumInterval: 36500,
  enableFuzz: true,
  buryNewSiblings: false,
  buryReviewSiblings: false,
  reviewOrder: 'due',
  newReviewOrder: 'after',
  maxAnswerSeconds: 60,
  fsrsParams: [],
};

describe('SchedulerSettingsSection', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(sampleConfig);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows daily pacing by default and expands advanced scheduling & FSRS optimizer on demand', async () => {
    render(<SchedulerSettingsSection flushTop />);

    expect(await screen.findByLabelText('每日新卡上限')).toHaveValue('20');
    expect(screen.getByLabelText('每日复习上限')).toHaveValue('200');
    expect(screen.getByLabelText('目标记忆保持率')).toHaveValue('0.9');
    expect(screen.queryByTestId('fsrs-scheduler-advanced')).toBeNull();
    expect(screen.queryByTestId('fsrs-optimizer')).toBeNull();

    fireEvent.click(screen.getByTestId('fsrs-scheduler-advanced-toggle'));

    expect(screen.getByTestId('fsrs-scheduler-advanced')).toBeInTheDocument();
    expect(screen.getByTestId('fsrs-scheduler-steps')).toBeInTheDocument();
    expect(screen.getByTestId('fsrs-optimizer')).toBeInTheDocument();
  });
});
