import { describe, expect, it } from 'vitest';

import { parseAutomationNaturalLanguage } from '../automationNlParser';

/** 固定基准时间：2026-07-19（周日）10:00 本地时间 */
const NOW = new Date(2026, 6, 19, 10, 0, 0);

describe('parseAutomationNaturalLanguage', () => {
  // -------------------------------------------------------------------------
  // 周期：daily
  // -------------------------------------------------------------------------
  it('每天 + 明确时刻 → daily / high', () => {
    const r = parseAutomationNaturalLanguage('每天早上8点提醒我背单词', NOW);
    expect(r).not.toBeNull();
    expect(r!.schedule).toEqual({ kind: 'daily', time: '08:00' });
    expect(r!.confidence).toBe('high');
    expect(r!.prompt).toBe('提醒我背单词');
    expect(r!.name).toBe('背单词');
    expect(r!.matchedText).toContain('每天');
    expect(r!.matchedText).toContain('早上8点');
  });

  it('每日 + 点半 → daily 09:30', () => {
    const r = parseAutomationNaturalLanguage('每日9点半复盘当天学习', NOW);
    expect(r!.schedule).toEqual({ kind: 'daily', time: '09:30' });
    expect(r!.confidence).toBe('high');
  });

  it('每天无时刻 → 默认 09:00 / medium', () => {
    const r = parseAutomationNaturalLanguage('每天提醒我喝水', NOW);
    expect(r!.schedule).toEqual({ kind: 'daily', time: '09:00' });
    expect(r!.confidence).toBe('medium');
    expect(r!.name).toBe('喝水');
  });

  it('每天凌晨1点 → 01:00', () => {
    const r = parseAutomationNaturalLanguage('每天凌晨1点备份数据', NOW);
    expect(r!.schedule).toEqual({ kind: 'daily', time: '01:00' });
    expect(r!.confidence).toBe('high');
  });

  it('英文 daily at 8:30 → daily 08:30', () => {
    const r = parseAutomationNaturalLanguage('daily at 8:30 standup', NOW);
    expect(r!.schedule).toEqual({ kind: 'daily', time: '08:30' });
    expect(r!.confidence).toBe('high');
  });

  // -------------------------------------------------------------------------
  // 周期：weekly / weekdays
  // -------------------------------------------------------------------------
  it('每周一晚上10点 → weekly weekday=1 22:00 / high', () => {
    const r = parseAutomationNaturalLanguage('每周一晚上10点写周报', NOW);
    expect(r!.schedule).toEqual({ kind: 'weekly', weekday: 1, time: '22:00' });
    expect(r!.confidence).toBe('high');
  });

  it('每周日下午3点 → weekly weekday=0 15:00', () => {
    const r = parseAutomationNaturalLanguage('每周日下午3点整理笔记', NOW);
    expect(r!.schedule).toEqual({ kind: 'weekly', weekday: 0, time: '15:00' });
    expect(r!.confidence).toBe('high');
  });

  it('英文 every monday 9am → weekly weekday=1 09:00', () => {
    const r = parseAutomationNaturalLanguage('every monday 9am review goals', NOW);
    expect(r!.schedule).toEqual({ kind: 'weekly', weekday: 1, time: '09:00' });
    expect(r!.confidence).toBe('high');
  });

  it('每周一到周五 → weekdays', () => {
    const r = parseAutomationNaturalLanguage('每周一到周五早上9点打卡', NOW);
    expect(r!.schedule).toEqual({ kind: 'weekdays', time: '09:00' });
    expect(r!.confidence).toBe('high');
  });

  it('每个工作日 → weekdays', () => {
    const r = parseAutomationNaturalLanguage('每个工作日18:00写总结', NOW);
    expect(r!.schedule).toEqual({ kind: 'weekdays', time: '18:00' });
    expect(r!.confidence).toBe('high');
  });

  it('英文 weekdays 9:30am → weekdays 09:30', () => {
    const r = parseAutomationNaturalLanguage('weekdays 9:30am check email', NOW);
    expect(r!.schedule).toEqual({ kind: 'weekdays', time: '09:30' });
  });

  it('每周末 → weekly 周六 / medium', () => {
    const r = parseAutomationNaturalLanguage('每周末下午2点打扫房间', NOW);
    expect(r!.schedule).toEqual({ kind: 'weekly', weekday: 6, time: '14:00' });
    expect(r!.confidence).toBe('medium');
  });

  it('每周（无具体星期）→ 锚定当前星期 / medium', () => {
    // NOW 是周日（0）
    const r = parseAutomationNaturalLanguage('每周20:00回顾', NOW);
    expect(r!.schedule).toEqual({ kind: 'weekly', weekday: 0, time: '20:00' });
    expect(r!.confidence).toBe('medium');
  });

  // -------------------------------------------------------------------------
  // 周期：monthly
  // -------------------------------------------------------------------------
  it('每月1日 → monthly dayOfMonth=1', () => {
    const r = parseAutomationNaturalLanguage('每月1日中午提醒发工资', NOW);
    expect(r!.schedule).toEqual({ kind: 'monthly', dayOfMonth: 1, time: '12:00' });
    // 单独「中午」属于口语模糊 → medium
    expect(r!.confidence).toBe('medium');
  });

  it('每月31号（边界）→ dayOfMonth=31 / high', () => {
    const r = parseAutomationNaturalLanguage('每月31号20:00交房租', NOW);
    expect(r!.schedule).toEqual({ kind: 'monthly', dayOfMonth: 31, time: '20:00' });
    expect(r!.confidence).toBe('high');
  });

  // -------------------------------------------------------------------------
  // 周期：interval
  // -------------------------------------------------------------------------
  it('每5分钟 → interval 5 / high', () => {
    const r = parseAutomationNaturalLanguage('每5分钟检查一次下载进度', NOW);
    expect(r!.schedule?.kind).toBe('interval');
    expect(r!.schedule?.intervalMinutes).toBe(5);
    expect(r!.confidence).toBe('high');
  });

  it('每1分钟 → clamp 到下限 5', () => {
    const r = parseAutomationNaturalLanguage('每1分钟刷新', NOW);
    expect(r!.schedule?.intervalMinutes).toBe(5);
  });

  it('每2小时 → interval 120', () => {
    const r = parseAutomationNaturalLanguage('每2小时同步一次云端', NOW);
    expect(r!.schedule?.intervalMinutes).toBe(120);
  });

  it('每小时 → interval 60', () => {
    const r = parseAutomationNaturalLanguage('每小时提醒我站起来活动', NOW);
    expect(r!.schedule?.intervalMinutes).toBe(60);
    expect(r!.name).toBe('站起来活动');
  });

  it('超过上限 → clamp 到 1440', () => {
    const r = parseAutomationNaturalLanguage('每30小时归档', NOW);
    expect(r!.schedule?.intervalMinutes).toBe(1440);
  });

  it('英文 every 30 minutes → interval 30', () => {
    const r = parseAutomationNaturalLanguage('check inbox every 30 minutes', NOW);
    expect(r!.schedule?.kind).toBe('interval');
    expect(r!.schedule?.intervalMinutes).toBe(30);
  });

  // -------------------------------------------------------------------------
  // 一次性：日期 + 时刻
  // -------------------------------------------------------------------------
  it('明天下午3点 → once 明天 15:00 / high', () => {
    const r = parseAutomationNaturalLanguage('明天下午3点开项目会', NOW);
    expect(r!.schedule).toEqual({ kind: 'once', date: '2026-07-20', time: '15:00' });
    expect(r!.confidence).toBe('high');
  });

  it('后天9点 → once +2天 09:00', () => {
    const r = parseAutomationNaturalLanguage('后天9点交报告', NOW);
    expect(r!.schedule).toEqual({ kind: 'once', date: '2026-07-21', time: '09:00' });
  });

  it('周五晚上8点 → once 最近的周五 20:00', () => {
    // NOW 是周日 2026-07-19 → 周五为 2026-07-24
    const r = parseAutomationNaturalLanguage('周五晚上8点复盘', NOW);
    expect(r!.schedule).toEqual({ kind: 'once', date: '2026-07-24', time: '20:00' });
    expect(r!.confidence).toBe('high');
  });

  it('下周一早上8点 → once 下个日历周的周一', () => {
    // NOW 是周日 → 下周一即 2026-07-20
    const r = parseAutomationNaturalLanguage('下周一早上8点面试', NOW);
    expect(r!.schedule).toEqual({ kind: 'once', date: '2026-07-20', time: '08:00' });
  });

  it('8月3日10点 → once 2026-08-03', () => {
    const r = parseAutomationNaturalLanguage('8月3日10点续订会员', NOW);
    expect(r!.schedule).toEqual({ kind: 'once', date: '2026-08-03', time: '10:00' });
  });

  it('N月N日已过 → 顺延到明年（跨年）', () => {
    const r = parseAutomationNaturalLanguage('1月1日9点新年计划', NOW);
    expect(r!.schedule).toEqual({ kind: 'once', date: '2027-01-01', time: '09:00' });
  });

  it('ISO 日期 2026-08-03 14:30 → once', () => {
    const r = parseAutomationNaturalLanguage('2026-08-03 14:30 发布新版本', NOW);
    expect(r!.schedule).toEqual({ kind: 'once', date: '2026-08-03', time: '14:30' });
    expect(r!.confidence).toBe('high');
  });

  it('明天无时刻 → 默认 09:00 / medium', () => {
    const r = parseAutomationNaturalLanguage('明天提醒我交作业', NOW);
    expect(r!.schedule).toEqual({ kind: 'once', date: '2026-07-20', time: '09:00' });
    expect(r!.confidence).toBe('medium');
  });

  // -------------------------------------------------------------------------
  // 一次性：相对偏移
  // -------------------------------------------------------------------------
  it('30分钟后 → once now+30min（取整到分）', () => {
    const r = parseAutomationNaturalLanguage('30分钟后提醒我关火', NOW);
    expect(r!.schedule).toEqual({ kind: 'once', date: '2026-07-19', time: '10:30' });
    expect(r!.confidence).toBe('high');
    expect(r!.name).toBe('关火');
  });

  it('2小时后 → once now+120min', () => {
    const r = parseAutomationNaturalLanguage('2小时后检查烤箱', NOW);
    expect(r!.schedule).toEqual({ kind: 'once', date: '2026-07-19', time: '12:00' });
  });

  it('相对偏移跨天：20小时后 → 次日', () => {
    const r = parseAutomationNaturalLanguage('20小时后提醒我', NOW);
    expect(r!.schedule).toEqual({ kind: 'once', date: '2026-07-20', time: '06:00' });
  });

  // -------------------------------------------------------------------------
  // 一次性：只有时刻
  // -------------------------------------------------------------------------
  it('裸时刻（未过）→ once 今天 / medium', () => {
    const r = parseAutomationNaturalLanguage('晚上8点提醒我打电话', NOW);
    expect(r!.schedule).toEqual({ kind: 'once', date: '2026-07-19', time: '20:00' });
    expect(r!.confidence).toBe('medium');
  });

  it('裸时刻（已过）→ 顺延到明天', () => {
    // NOW 为 10:00，早上8点已过
    const r = parseAutomationNaturalLanguage('早上8点提醒我晨读', NOW);
    expect(r!.schedule).toEqual({ kind: 'once', date: '2026-07-20', time: '08:00' });
  });

  it('英文 9:30pm → 21:30', () => {
    const r = parseAutomationNaturalLanguage('9:30pm review notes', NOW);
    expect(r!.schedule).toEqual({ kind: 'once', date: '2026-07-19', time: '21:30' });
  });

  // -------------------------------------------------------------------------
  // 口语细节
  // -------------------------------------------------------------------------
  it('一刻 = :15', () => {
    const r = parseAutomationNaturalLanguage('每天8点一刻晨会', NOW);
    expect(r!.schedule).toEqual({ kind: 'daily', time: '08:15' });
  });

  it('上午9点半 = 09:30', () => {
    const r = parseAutomationNaturalLanguage('每天上午9点半站会', NOW);
    expect(r!.schedule).toEqual({ kind: 'daily', time: '09:30' });
  });

  // -------------------------------------------------------------------------
  // name / prompt 提炼
  // -------------------------------------------------------------------------
  it('name 截断到 20 字', () => {
    const long = '整理这一周所有课程的学习笔记并且归纳出重点错题清单发给学习小组';
    const r = parseAutomationNaturalLanguage(`每天晚上9点${long}`, NOW);
    expect(r!.name).toBe(Array.from(long).slice(0, 20).join(''));
    expect(r!.prompt).toBe(long);
  });

  it('去掉客套助词：帮我提醒我 → 语义核心', () => {
    const r = parseAutomationNaturalLanguage('每天中午帮我提醒我吃维生素', NOW);
    expect(r!.name).toBe('吃维生素');
    expect(r!.prompt).toBe('帮我提醒我吃维生素');
  });

  // -------------------------------------------------------------------------
  // 无调度 / 无效输入
  // -------------------------------------------------------------------------
  it('只有内容猜不出周期 → low，schedule undefined，但保留 name/prompt', () => {
    const r = parseAutomationNaturalLanguage('提醒我复习英语语法', NOW);
    expect(r).not.toBeNull();
    expect(r!.schedule).toBeUndefined();
    expect(r!.confidence).toBe('low');
    expect(r!.name).toBe('复习英语语法');
    expect(r!.prompt).toBe('提醒我复习英语语法');
  });

  it('空输入 → null', () => {
    expect(parseAutomationNaturalLanguage('', NOW)).toBeNull();
    expect(parseAutomationNaturalLanguage('   ', NOW)).toBeNull();
  });

  it('纯标点无实义内容 → null', () => {
    expect(parseAutomationNaturalLanguage('！！！。。。', NOW)).toBeNull();
  });

  it('now 缺省不抛异常（默认 new Date()）', () => {
    const r = parseAutomationNaturalLanguage('每天8点喝水');
    expect(r!.schedule?.kind).toBe('daily');
  });
});
