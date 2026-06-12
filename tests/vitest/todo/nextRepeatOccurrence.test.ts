/**
 * nextRepeatOccurrence — 重复任务「下次出现」预览
 *
 * 语义必须与后端 step_due_date / compute_next_due_date 一致：
 * - 从当前到期日推进一步
 * - 结果早于 today 时继续推进（跳过已错过周期）
 * - weekly byWeekday 以周一为一周起点，interval 按周差取模
 */
import { describe, it, expect } from 'vitest';
import { nextRepeatOccurrence } from '@/features/todo/types';

describe('nextRepeatOccurrence', () => {
  it('daily 按 interval 推进', () => {
    expect(
      nextRepeatOccurrence({ freq: 'daily', interval: 1 }, '2026-06-10', '2026-06-01'),
    ).toBe('2026-06-11');
    expect(
      nextRepeatOccurrence({ freq: 'daily', interval: 3 }, '2026-06-10', '2026-06-01'),
    ).toBe('2026-06-13');
  });

  it('daily 逾期时跳到 >= today', () => {
    expect(
      nextRepeatOccurrence({ freq: 'daily', interval: 1 }, '2026-06-01', '2026-06-10'),
    ).toBe('2026-06-10');
  });

  it('weekly 普通每周 +7 天', () => {
    expect(
      nextRepeatOccurrence({ freq: 'weekly', interval: 2 }, '2026-06-10', '2026-06-01'),
    ).toBe('2026-06-24');
  });

  it('weekly byWeekday 找同周下一个命中日', () => {
    // 2026-06-10 是周三；每周一三五 → 下一个是周五 06-12
    expect(
      nextRepeatOccurrence(
        { freq: 'weekly', interval: 1, byWeekday: [1, 3, 5] },
        '2026-06-10',
        '2026-06-01',
      ),
    ).toBe('2026-06-12');
  });

  it('weekly byWeekday 跨周回到第一个选中星期', () => {
    // 2026-06-12 是周五；每周一三五 → 下周一 06-15
    expect(
      nextRepeatOccurrence(
        { freq: 'weekly', interval: 1, byWeekday: [1, 3, 5] },
        '2026-06-12',
        '2026-06-01',
      ),
    ).toBe('2026-06-15');
  });

  it('weekly byWeekday interval=2 跳过下一周', () => {
    // 2026-06-12 周五，每两周的周五 → 跳过 06-19，命中 06-26
    expect(
      nextRepeatOccurrence(
        { freq: 'weekly', interval: 2, byWeekday: [5] },
        '2026-06-12',
        '2026-06-01',
      ),
    ).toBe('2026-06-26');
  });

  it('monthly 月末收敛', () => {
    // 1/31 + 1 月 → 2/28（2026 非闰年）
    expect(
      nextRepeatOccurrence({ freq: 'monthly', interval: 1 }, '2026-01-31', '2026-01-01'),
    ).toBe('2026-02-28');
  });

  it('yearly 推进一年', () => {
    expect(
      nextRepeatOccurrence({ freq: 'yearly', interval: 1 }, '2026-06-10', '2026-01-01'),
    ).toBe('2027-06-10');
  });

  it('weekdays 跳过周末', () => {
    // 2026-06-12 是周五 → 下一个工作日是周一 06-15
    expect(
      nextRepeatOccurrence({ freq: 'weekdays', interval: 1 }, '2026-06-12', '2026-06-01'),
    ).toBe('2026-06-15');
  });

  it('非法日期返回 null', () => {
    expect(nextRepeatOccurrence({ freq: 'daily', interval: 1 }, 'bad-date')).toBeNull();
  });
});
