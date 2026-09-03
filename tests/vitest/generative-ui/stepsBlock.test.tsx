import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import {
  StepsBlock,
  stepsBlockPropsSchema,
  registerStepsBlock,
  STEPS_BLOCK_TYPE,
  STEPS_STATUSES,
  STEPS_STATUS_TONE,
} from '@/features/generative-ui/components/StepsBlock';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import { validateBlockProps } from '@/features/generative-ui/schema';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { buildStepsIntent } from '@/features/generative-ui/utils/buildStepsIntent';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'blocks.steps.status_pending': '待开始',
        'blocks.steps.status_active': '进行中',
        'blocks.steps.status_done': '已完成',
        'blocks.steps.status_error': '失败',
        'blocks.steps.status_skipped': '已跳过',
        'a11y.steps_label': '步骤',
        'a11y.step_pending': '未开始',
        'a11y.step_active': '进行中',
        'a11y.step_done': '已完成',
        'a11y.step_error': '失败',
        'a11y.step_skipped': '已跳过',
        parse_error_title: '解析失败',
        unknown_block_title: '未知',
        unknown_block_desc: '跳过',
        validation_failed_title: '校验失败',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

const ALL_STATUS_STEPS = [
  { id: 's1', label: '预习讲义', status: 'pending' as const, durationLabel: '10 分钟' },
  { id: 's2', label: '复习到期闪卡', status: 'active' as const, description: 'FSRS 今日到期' },
  { id: 's3', label: '完成练习', status: 'done' as const },
  { id: 's4', label: '错题回顾', status: 'error' as const },
  { id: 's5', label: '选读拓展', status: 'skipped' as const },
];

describe('StepsBlock', () => {
  beforeAll(() => {
    registerStepsBlock();
  });

  it('registers steps with allowPartialRender', () => {
    const config = generativeUIRegistry.get(STEPS_BLOCK_TYPE);
    expect(config).toBeDefined();
    expect(config?.allowPartialRender).toBe(true);
    expect(config?.propsSchema).toBe(stepsBlockPropsSchema);
  });

  it('covers all five statuses with semantic tones', () => {
    render(<StepsBlock title="今日学习计划" steps={ALL_STATUS_STEPS} />);

    expect(screen.getByText('今日学习计划')).toBeInTheDocument();
    expect(screen.getByText('预习讲义')).toBeInTheDocument();
    expect(screen.getByText('10 分钟')).toBeInTheDocument();
    expect(screen.getByText('FSRS 今日到期')).toBeInTheDocument();
    expect(screen.getByText('待开始')).toBeInTheDocument();
    expect(screen.getByText('未开始')).toBeInTheDocument();
    expect(screen.getAllByText('进行中').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('已完成').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('失败').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('已跳过').length).toBeGreaterThanOrEqual(1);

    for (const status of STEPS_STATUSES) {
      const item = document.querySelector(`[data-step-status="${status}"]`);
      expect(item, `missing status ${status}`).toBeTruthy();
      expect(item?.getAttribute('data-tone')).toBe(STEPS_STATUS_TONE[status]);
    }
  });

  it('marks the current active step with aria-current="step"', () => {
    render(<StepsBlock steps={ALL_STATUS_STEPS} />);
    const current = document.querySelector('[aria-current="step"]');
    expect(current).toBeTruthy();
    expect(current?.getAttribute('data-step-status')).toBe('active');
    expect(document.querySelectorAll('[aria-current="step"]').length).toBe(1);
  });

  it('uses ol/li semantics', () => {
    const { container } = render(<StepsBlock steps={ALL_STATUS_STEPS} />);
    expect(container.querySelector('[data-generative-steps] ol')).toBeTruthy();
    expect(container.querySelectorAll('[data-generative-steps] li')).toHaveLength(5);
    expect(container.querySelectorAll('[data-generative-steps] .sr-only')).toHaveLength(5);
  });

  it('enforces schema limits', () => {
    expect(stepsBlockPropsSchema.safeParse({ steps: [] }).success).toBe(false);
    expect(
      stepsBlockPropsSchema.safeParse({
        steps: Array.from({ length: 21 }, (_, i) => ({ label: `步骤 ${i + 1}` })),
      }).success,
    ).toBe(false);
    expect(
      stepsBlockPropsSchema.safeParse({
        steps: Array.from({ length: 20 }, (_, i) => ({ label: `步骤 ${i + 1}` })),
      }).success,
    ).toBe(true);
    expect(stepsBlockPropsSchema.safeParse({ title: 'a'.repeat(121), steps: [{ label: 'A' }] }).success).toBe(
      false,
    );
    expect(stepsBlockPropsSchema.safeParse({ steps: [{ label: 'b'.repeat(161) }] }).success).toBe(false);
    expect(
      stepsBlockPropsSchema.safeParse({ steps: [{ label: 'ok', description: 'c'.repeat(301) }] }).success,
    ).toBe(false);
    expect(
      stepsBlockPropsSchema.safeParse({ steps: [{ label: 'ok', durationLabel: 'd'.repeat(41) }] }).success,
    ).toBe(false);
    expect(stepsBlockPropsSchema.safeParse({ steps: [{ label: 'ok', status: 'running' }] }).success).toBe(
      false,
    );
    expect(stepsBlockPropsSchema.safeParse({ steps: [{ label: 'ok' }] }).success).toBe(true);
  });

  it('renders through GenerativeUIRenderer after test-side register', () => {
    const intent = buildStepsIntent({
      title: '学习步骤',
      steps: ALL_STATUS_STEPS,
      labels: { metaTitle: '计划' },
    });

    const config = generativeUIRegistry.get('steps');
    expect(config).toBeDefined();
    const validation = validateBlockProps(config!.propsSchema, intent.blocks[0]?.props ?? {});
    expect(validation.ok).toBe(true);

    render(<GenerativeUIRenderer intent={intent} showChrome={false} />);
    expect(document.querySelector('[data-generative-steps]')).toBeTruthy();
    expect(screen.getByText('复习到期闪卡')).toBeInTheDocument();
    expect(document.querySelector('[aria-current="step"]')).toHaveAttribute('data-step-status', 'active');
  });
});
