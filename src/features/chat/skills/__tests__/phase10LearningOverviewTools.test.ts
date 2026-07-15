import { describe, expect, it } from 'vitest';

import { learningOverviewToolsSkill } from '../builtin-tools/learning-overview-tools';

function tool(name: string) {
  const matches = learningOverviewToolsSkill.embeddedTools?.filter((entry) => entry.name === name) ?? [];
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe('phase 10 learning overview tool contracts', () => {
  it('keeps progressive disclosure closed over exactly three read-only tools', () => {
    expect(learningOverviewToolsSkill.allowedTools).toEqual(
      learningOverviewToolsSkill.embeddedTools?.map((entry) => entry.name),
    );
    expect(new Set(learningOverviewToolsSkill.allowedTools).size).toBe(3);
    expect(learningOverviewToolsSkill.content).toContain('partial=true');
    expect(learningOverviewToolsSkill.content).toContain('sourceErrors');
    expect(learningOverviewToolsSkill.content).toContain('不可混为同一队列');
    expect(learningOverviewToolsSkill.content).toContain('activityTotals/focusTotals');
    expect(learningOverviewToolsSkill.content).toContain('调用时的当前库存/调度快照');
    expect(learningOverviewToolsSkill.content).not.toContain('汇总字段覆盖完整请求区间');
    expect(tool('builtin-learning_overview').description).toContain('调用时当前快照');
  });

  it('requires either a complete exact date range or the seven-day default', () => {
    const schema = tool('builtin-learning_overview').inputSchema;
    expect(schema.oneOf).toHaveLength(2);
    expect(schema.oneOf?.every((branch) => branch.additionalProperties === false)).toBe(true);
    const defaultRange = schema.oneOf?.[0] as any;
    const explicitRange = schema.oneOf?.[1] as any;
    expect(defaultRange.properties.start_date).toBeUndefined();
    expect(explicitRange.required).toEqual(['start_date', 'end_date']);
    expect(explicitRange.properties.start_date.pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$');
    expect(explicitRange.properties.page_size.maximum).toBe(20);
  });

  it('keeps today empty and daily statistics bounded to 90 days and 20 rows', () => {
    const today = tool('builtin-pomodoro_today_stats').inputSchema;
    expect(today.additionalProperties).toBe(false);
    expect(today.properties).toEqual({});

    const daily = tool('builtin-pomodoro_daily_stats').inputSchema;
    expect(daily.additionalProperties).toBe(false);
    expect(daily.properties.days.minimum).toBe(1);
    expect(daily.properties.days.maximum).toBe(90);
    expect(daily.properties.page_size.maximum).toBe(20);
  });
});
