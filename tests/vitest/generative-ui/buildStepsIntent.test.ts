import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  buildStepsIntent,
  normalizeStepsStatus,
  normalizeStepsItems,
} from '@/features/generative-ui/utils/buildStepsIntent';
import { buildLearningPlanStepsIntent } from '@/features/generative-ui/utils/buildLearningPlanStepsIntent';
import {
  registerStepsBlock,
  STEPS_BLOCK_TYPE,
  stepsBlockPropsSchema,
} from '@/features/generative-ui/components/StepsBlock';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import { validateBlockProps } from '@/features/generative-ui/schema';

describe('buildStepsIntent', () => {
  beforeAll(() => {
    registerStepsBlock();
  });

  it('defaults missing or invalid status to pending', () => {
    expect(normalizeStepsStatus(undefined)).toBe('pending');
    expect(normalizeStepsStatus('running')).toBe('pending');
    expect(normalizeStepsStatus('done')).toBe('done');

    const intent = buildStepsIntent({
      steps: [
        { label: '未标状态' },
        { label: '非法状态', status: 'running' },
        { label: '已完成', status: 'done' },
      ],
      labels: { title: '学习步骤', metaTitle: 'Steps' },
    });

    expect(intent.blocks[0]?.type).toBe('steps');
    const steps = (intent.blocks[0]?.props as { steps: Array<{ status: string; label: string }> }).steps;
    expect(steps.map((s) => s.status)).toEqual(['pending', 'pending', 'done']);

    const validation = validateBlockProps(stepsBlockPropsSchema, intent.blocks[0]?.props ?? {});
    expect(validation.ok).toBe(true);
  });

  it('clamps schema limits for title, label, description, duration and count', () => {
    const intent = buildStepsIntent({
      title: 'T'.repeat(200),
      steps: [
        {
          label: 'L'.repeat(200),
          description: 'D'.repeat(400),
          durationLabel: 'U'.repeat(80),
          status: 'active',
        },
        ...Array.from({ length: 24 }, (_, i) => ({ label: `额外 ${i}` })),
      ],
      labels: { metaTitle: 'clamp' },
    });

    const props = intent.blocks[0]?.props as {
      title: string;
      steps: Array<{ label: string; description?: string; durationLabel?: string }>;
    };
    expect(props.title).toHaveLength(120);
    expect(props.steps).toHaveLength(20);
    expect(props.steps[0]?.label).toHaveLength(160);
    expect(props.steps[0]?.description).toHaveLength(300);
    expect(props.steps[0]?.durationLabel).toHaveLength(40);
    expect(stepsBlockPropsSchema.safeParse(props).success).toBe(true);
  });

  it('normalizes items and drops empty labels', () => {
    const items = normalizeStepsItems([
      { label: '  有效  ', status: 'error' },
      { label: '   ' },
      { label: '可选', durationLabel: ' 5 分 ' },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ label: '有效', status: 'error' });
    expect(items[1]).toMatchObject({ label: '可选', durationLabel: '5 分', status: 'pending' });
  });

  it('returns no steps block when all labels are empty', () => {
    const intent = buildStepsIntent({ steps: [{ label: '  ' }], labels: { title: '空' } });
    expect(intent.blocks).toEqual([]);
  });

  it('buildLearningPlanStepsIntent appends start-review action-bar', () => {
    const intent = buildLearningPlanStepsIntent({
      steps: [
        { label: '复习到期闪卡', status: 'active', durationLabel: '15 分钟' },
        { label: '完成待办' },
      ],
      labels: { title: '今日学习计划', startReview: '开始复习' },
    });

    expect(intent.meta?.title).toBe('今日学习计划');
    expect(intent.blocks.map((b) => b.type)).toEqual(['steps', 'action-bar']);
    const stepsProps = intent.blocks[0]?.props as { title: string; steps: Array<{ status: string }> };
    expect(stepsProps.title).toBe('今日学习计划');
    expect(stepsProps.steps.map((s) => s.status)).toEqual(['active', 'pending']);

    const actions = (intent.blocks[1]?.props as { actions: Array<{ id: string; label: string }> }).actions;
    expect(actions).toEqual([
      expect.objectContaining({ id: 'start-review', label: '开始复习', variant: 'primary' }),
    ]);

    const config = generativeUIRegistry.get('steps');
    expect(config?.allowPartialRender).toBe(true);
    expect(validateBlockProps(config!.propsSchema, intent.blocks[0]?.props ?? {}).ok).toBe(true);
  });
});
