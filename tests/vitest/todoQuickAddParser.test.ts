import { describe, expect, it } from 'vitest';
import { parseQuickAddInput } from '../../src/features/todo/quickAddParser';

// 固定基准：2026-06-12 是周五
const FRI = new Date(2026, 5, 12, 10, 0, 0);

describe('todo quickAdd natural language parser', () => {
  it('parses 今天/明天/后天/大后天', () => {
    expect(parseQuickAddInput('交作业 今天', FRI).dueDate).toBe('2026-06-12');
    expect(parseQuickAddInput('明天交作业', FRI).dueDate).toBe('2026-06-13');
    expect(parseQuickAddInput('后天考试', FRI).dueDate).toBe('2026-06-14');
    expect(parseQuickAddInput('大后天复盘', FRI).dueDate).toBe('2026-06-15');
  });

  it('strips date token from title', () => {
    const r = parseQuickAddInput('明天交作业', FRI);
    expect(r.title).toBe('交作业');
    expect(r.dateToken).toBe('明天');
  });

  it('parses 周X as the nearest future weekday', () => {
    // 基准周五：周一 → 下周一 6/15
    expect(parseQuickAddInput('周一 复习', FRI).dueDate).toBe('2026-06-15');
    // 周五当天说「周五」→ 下周五 6/19
    expect(parseQuickAddInput('周五 复习', FRI).dueDate).toBe('2026-06-19');
    // 周日 → 6/14
    expect(parseQuickAddInput('周日 休息', FRI).dueDate).toBe('2026-06-14');
  });

  it('parses 下周X as next calendar week', () => {
    // 基准周五：下周一 = 6/15，下周五 = 6/19，下周日 = 6/21
    expect(parseQuickAddInput('下周一 开会', FRI).dueDate).toBe('2026-06-15');
    expect(parseQuickAddInput('下周五 交报告', FRI).dueDate).toBe('2026-06-19');
    expect(parseQuickAddInput('下周日 出游', FRI).dueDate).toBe('2026-06-21');
  });

  it('parses N月N日 with year rollover', () => {
    expect(parseQuickAddInput('7月1日 假期', FRI).dueDate).toBe('2026-07-01');
    // 已过去的月日 → 明年
    expect(parseQuickAddInput('1月1日 新年', FRI).dueDate).toBe('2027-01-01');
  });

  it('parses bare N号 within this or next month', () => {
    expect(parseQuickAddInput('15号 还书', FRI).dueDate).toBe('2026-06-15');
    // 已过去的号数 → 下月
    expect(parseQuickAddInput('5号 交房租', FRI).dueDate).toBe('2026-07-05');
  });

  it('parses priority tokens (zh + en)', () => {
    expect(parseQuickAddInput('交作业 !高', FRI).priority).toBe('high');
    expect(parseQuickAddInput('交作业 ！紧急', FRI).priority).toBe('urgent');
    expect(parseQuickAddInput('essay !high', FRI).priority).toBe('high');
    expect(parseQuickAddInput('essay !LOW', FRI).priority).toBe('low');
  });

  it('combines date + priority and cleans title', () => {
    const r = parseQuickAddInput('明天交作业 !高', FRI);
    expect(r.title).toBe('交作业');
    expect(r.dueDate).toBe('2026-06-13');
    expect(r.priority).toBe('high');
  });

  it('returns plain title when nothing matches', () => {
    const r = parseQuickAddInput('普通待办事项', FRI);
    expect(r.title).toBe('普通待办事项');
    expect(r.dueDate).toBeUndefined();
    expect(r.priority).toBeUndefined();
  });

  it('parses english relative dates', () => {
    expect(parseQuickAddInput('essay tomorrow', FRI).dueDate).toBe('2026-06-13');
    expect(parseQuickAddInput('review today', FRI).dueDate).toBe('2026-06-12');
  });
});
