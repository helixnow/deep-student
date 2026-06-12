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

  it('requires word boundaries for english relative tokens', () => {
    // "tomorrowland"/"todays" 中的子串不得被识别为日期
    const r1 = parseQuickAddInput('visit tomorrowland', FRI);
    expect(r1.dueDate).toBeUndefined();
    expect(r1.title).toBe('visit tomorrowland');

    const r2 = parseQuickAddInput('read todays news', FRI);
    expect(r2.dueDate).toBeUndefined();
    expect(r2.title).toBe('read todays news');

    // 大小写不敏感的独立词仍然识别
    expect(parseQuickAddInput('essay Tomorrow', FRI).dueDate).toBe('2026-06-13');
  });

  it('parses 每天/每月/每年 repeat with today as default due date', () => {
    const daily = parseQuickAddInput('每天背单词', FRI);
    expect(daily.repeat).toEqual({ freq: 'daily', interval: 1 });
    expect(daily.title).toBe('背单词');
    expect(daily.dueDate).toBe('2026-06-12');

    expect(parseQuickAddInput('每月交房租', FRI).repeat?.freq).toBe('monthly');
    expect(parseQuickAddInput('每年体检', FRI).repeat?.freq).toBe('yearly');
  });

  it('parses 每周X as weekly anchored to that weekday', () => {
    const r = parseQuickAddInput('每周一交周报', FRI);
    expect(r.repeat).toEqual({ freq: 'weekly', interval: 1 });
    // 基准周五 → 最近的周一是 6/15
    expect(r.dueDate).toBe('2026-06-15');
    expect(r.title).toBe('交周报');

    // 今天恰为周五，「每周五」锚定今天
    expect(parseQuickAddInput('每周五打扫 ', FRI).dueDate).toBe('2026-06-12');
  });

  it('parses 每个工作日 as weekdays rule', () => {
    const r = parseQuickAddInput('每个工作日早读', FRI);
    expect(r.repeat).toEqual({ freq: 'weekdays', interval: 1 });
    expect(r.title).toBe('早读');
  });

  it('parses english repeat tokens', () => {
    expect(parseQuickAddInput('standup daily', FRI).repeat?.freq).toBe('daily');
    expect(parseQuickAddInput('report every week', FRI).repeat?.freq).toBe('weekly');
    expect(parseQuickAddInput('reading weekdays', FRI).repeat?.freq).toBe('weekdays');
  });

  it('combines repeat with explicit date token', () => {
    // 显式日期 token 覆盖重复锚定的默认日期
    const r = parseQuickAddInput('每周 复盘 明天', FRI);
    expect(r.repeat?.freq).toBe('weekly');
    expect(r.dueDate).toBe('2026-06-13');
    expect(r.title).toBe('复盘');
  });

  it('does not misparse 每天气温 style words', () => {
    // 「每天」是独立识别——确认普通含「天」词不会误触发重复
    const r = parseQuickAddInput('记录天气', FRI);
    expect(r.repeat).toBeUndefined();
    expect(r.title).toBe('记录天气');
  });

  it('parses 每周一三五 as weekly with byWeekday', () => {
    const r = parseQuickAddInput('每周一三五健身', FRI);
    expect(r.repeat).toEqual({ freq: 'weekly', interval: 1, byWeekday: [1, 3, 5] });
    expect(r.title).toBe('健身');
    // 基准周五：最近的选中星期是当天周五 6/12
    expect(r.dueDate).toBe('2026-06-12');
  });

  it('parses 每周二、四 with separators', () => {
    const r = parseQuickAddInput('每周二、四 复习英语', FRI);
    expect(r.repeat).toEqual({ freq: 'weekly', interval: 1, byWeekday: [2, 4] });
    expect(r.title).toBe('复习英语');
    // 基准周五：最近的周二 6/16 vs 周四 6/18 → 6/16
    expect(r.dueDate).toBe('2026-06-16');
  });

  it('parses 每周六日 weekend combo', () => {
    const r = parseQuickAddInput('每周六日打球', FRI);
    expect(r.repeat).toEqual({ freq: 'weekly', interval: 1, byWeekday: [0, 6] });
    // 基准周五：最近是周六 6/13
    expect(r.dueDate).toBe('2026-06-13');
  });

  it('parses chinese time tokens', () => {
    const r1 = parseQuickAddInput('明天下午3点 开会', FRI);
    expect(r1.dueDate).toBe('2026-06-13');
    expect(r1.dueTime).toBe('15:00');
    expect(r1.title).toBe('开会');

    const r2 = parseQuickAddInput('晚上8点半 复盘', FRI);
    expect(r2.dueTime).toBe('20:30');
    // 无日期 token 时默认今天
    expect(r2.dueDate).toBe('2026-06-12');

    const r3 = parseQuickAddInput('9点 晨会', FRI);
    expect(r3.dueTime).toBe('09:00');
    expect(r3.title).toBe('晨会');
  });

  it('parses HH:MM and am/pm time tokens', () => {
    expect(parseQuickAddInput('meeting 14:30', FRI).dueTime).toBe('14:30');
    expect(parseQuickAddInput('meeting 3pm', FRI).dueTime).toBe('15:00');
    expect(parseQuickAddInput('standup 9:15am', FRI).dueTime).toBe('09:15');
  });

  it('does not misparse 买3点心 as a time', () => {
    const r = parseQuickAddInput('买3点心', FRI);
    expect(r.dueTime).toBeUndefined();
    expect(r.title).toBe('买3点心');
  });

  it('parses #tags and strips them from title', () => {
    const r = parseQuickAddInput('复习线代 #数学 #期末', FRI);
    expect(r.tags).toEqual(['数学', '期末']);
    expect(r.title).toBe('复习线代');
  });

  it('combines tags + date + time + priority + repeat', () => {
    const r = parseQuickAddInput('每周一三五早读 #英语 7点 !高', FRI);
    expect(r.repeat).toEqual({ freq: 'weekly', interval: 1, byWeekday: [1, 3, 5] });
    expect(r.tags).toEqual(['英语']);
    expect(r.dueTime).toBe('07:00');
    expect(r.priority).toBe('high');
    expect(r.title).toBe('早读');
  });
});
