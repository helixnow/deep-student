/**
 * 定时任务（自动化）自然语言排期解析器
 *
 * 供工作区代理快速创建输入框调用：从一句话中解析出 AutomationSchedule、
 * 任务名（name）与去时间表达后的任务内容（prompt）。
 *
 * 支持（中文优先 + 基础英文）：
 *   周期：每天/每日/daily、每周X/每周一到周五/工作日/weekdays/every weekday、每月N号、
 *         每(隔)N分钟/每(隔)N小时（支持中文数字：每两小时）/每小时/every N minutes|hours/hourly、
 *         每周末/every weekend（→ 周六，medium）、每晚/每早（daily + 时段推断）、
 *         every morning|afternoon|evening|night（daily + 时段默认时刻）、
 *         每周一三五/every monday and friday（多个星期直接产出 weekly + weekdays
 *         集合；恰为周一至周五时仍归并为 weekdays 调度）、
 *         每月最后一天/last day of every month（→ monthly 31 号；后端与前端
 *         推算都会把 31 收敛到短月月末，语义等价）
 *   时刻：早上8点/上午9点半/下午3点/晚上10点/凌晨1点/晚八点/早七点半/中午/
 *         8:30/20:00/9am/9:30pm/at 6（裸小时，标记歧义）；
 *         小时支持中文数字（八点/十点半/二十三点）；点半=:30、一刻=:15、三刻=:45；
 *         周期任务缺时刻默认 09:00（confidence 降级）；
 *         「at」「在」连接词随时间 token 一并剔除，不残留进 prompt/name
 *   一次性：今天/明天/后天/大后天/周X/下周X/N月N日/YYYY-MM-DD + 时刻；
 *           「X分钟后/X小时后」（支持中文数字：两小时后）→ once（now+偏移，取整到分）
 *
 * 歧义提示：解析中出现默认值/推断（默认时刻、周末→周六、每周锚定当天、
 * 间隔越界收敛、裸小时歧义等）时输出 hints（i18n key 后缀），供 UI 呈现。
 *
 * 设计原则与 quickAddParser 一致：token 匹配要求词边界，逐个从工作文本中剔除，
 * 剩余文本作为 prompt，进一步去助词、截断后作为 name。
 */

import type { AutomationSchedule } from '../settings/components/automationSettingsApi';

export type { AutomationSchedule };

/**
 * 解析歧义/推断提示（i18n key 后缀，UI 侧映射到 `todo:automation.nl.hints.*`）：
 * - defaultTime：未指定时刻，落到默认 09:00
 * - impliedTime：时段词（每晚/every morning 等）推断出默认时刻
 * - weekendSaturday：「周末」按周六处理
 * - weekAnchored：「每周」未指定星期，锚定解析当天的星期
 * - monthlyFirstDay：「每月」未指定几号，默认 1 号
 * - intervalClamped：间隔越界，收敛到 5–1440 分钟
 * - bareHourAmbiguous：裸小时（at 6）无上下午信息，按原值处理
 * - timeOnlyToday / timeRolledTomorrow：只给了时刻 → 排到今天 / 已过顺延明天
 * - monthLastDay：「每月最后一天」按每月 31 号处理（短月自动收敛到月末）
 *
 * （multiWeekday 提示已随 weekly 多天调度（weekdays 数组）落地而移除：
 * 「每周一三五」不再是歧义降级，而是无损解析。）
 */
export type AutomationNlHint =
  | 'defaultTime'
  | 'impliedTime'
  | 'weekendSaturday'
  | 'weekAnchored'
  | 'monthlyFirstDay'
  | 'intervalClamped'
  | 'bareHourAmbiguous'
  | 'timeOnlyToday'
  | 'timeRolledTomorrow'
  | 'monthLastDay';

export interface AutomationNlParseResult {
  /** 从剩余文本提炼的短任务名（≤20 字） */
  name?: string;
  /** 解析出的调度；解析不出则 undefined */
  schedule?: AutomationSchedule;
  /** 去掉时间表达后的任务内容 */
  prompt?: string;
  confidence: 'high' | 'medium' | 'low';
  /** 命中的时间表达原文（UI 高亮用） */
  matchedText?: string;
  /** 歧义/推断提示（仅在 schedule 存在时输出） */
  hints?: AutomationNlHint[];
}

const INTERVAL_MIN = 5;
const INTERVAL_MAX = 1440;
const DEFAULT_TIME = '09:00';

const ZH_WEEKDAY_MAP: Record<string, number> = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0,
};

const EN_WEEKDAY_MAP: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const ZH_DIGIT: Record<string, number> = {
  '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
};
/** 中文数字序列（间隔/相对偏移量用），支持 一~九、十、X十、十X、X十Y */
const ZH_NUM_SEQ = '[一两二三四五六七八九十]{1,3}';

/** 阿拉伯数字或简单中文数字 → number；无法解析返回 null */
function parseZhOrArabicNumber(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  const compound = /^([一两二三四五六七八九])?十([一二三四五六七八九])?$/.exec(raw);
  if (compound) {
    return (compound[1] ? ZH_DIGIT[compound[1]] : 1) * 10 + (compound[2] ? ZH_DIGIT[compound[2]] : 0);
  }
  return raw in ZH_DIGIT ? ZH_DIGIT[raw] : null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function formatLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatLocalTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * 「周X」= 最近的未来周X（今天恰为周X 则取下周X）；
 * 「下周X」= 下个日历周（下周一开始）中的周X。
 */
function nextWeekday(base: Date, weekday: number, forceNextWeek: boolean): Date {
  const current = base.getDay();
  if (!forceNextWeek) {
    let diff = (weekday - current + 7) % 7;
    if (diff === 0) diff = 7;
    return addDays(base, diff);
  }
  const daysToNextMonday = ((8 - current) % 7) || 7;
  const offsetInWeek = weekday === 0 ? 6 : weekday - 1;
  return addDays(base, daysToNextMonday + offsetInWeek);
}

function clampInterval(minutes: number): number {
  return Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, minutes));
}

function clampDayOfMonth(day: number): number {
  return Math.min(31, Math.max(1, day));
}

// ---------------------------------------------------------------------------
// 周期表达匹配
// ---------------------------------------------------------------------------

interface RecurrenceMatch {
  token: string;
  /** 不含 time 的调度骨架 */
  schedule: Omit<AutomationSchedule, 'time'>;
  /** 口语模糊或使用了默认值（如「每周末」「每周」无具体星期） */
  fuzzy: boolean;
  /** 时段推断（每晚/every evening…）：裸小时按该时段换算成 24 小时制 */
  impliedPeriod?: 'morning' | 'afternoon' | 'evening';
  /** 时段推断出的默认时刻（无显式时刻时使用，优先于全局默认 09:00） */
  impliedTime?: string;
  /** 该周期匹配自带的歧义提示 */
  hint?: AutomationNlHint;
}

/** every morning/afternoon/evening/night → 时段与默认时刻 */
const EN_PERIOD_DEFAULTS: Record<string, { period: 'morning' | 'afternoon' | 'evening'; time: string }> = {
  morning: { period: 'morning', time: '09:00' },
  afternoon: { period: 'afternoon', time: '15:00' },
  evening: { period: 'evening', time: '20:00' },
  night: { period: 'evening', time: '22:00' },
};

/**
 * 一组星期 → 合法调度（无损）：
 * 恰为周一至周五 → weekdays 调度（归并逻辑保持）；
 * 多个星期 → weekly + weekdays 集合（升序去重，单数 weekday 同步为最小值，
 * 供旧消费方降级展示）；单个星期 → weekly（纯 weekday，形状与存量一致）。
 */
function buildWeeklySetMatch(token: string, weekdays: number[]): RecurrenceMatch {
  const sorted = Array.from(new Set(weekdays)).sort((a, b) => a - b);
  if (sorted.join(',') === '1,2,3,4,5') {
    return { token, schedule: { kind: 'weekdays' }, fuzzy: false };
  }
  if (sorted.length > 1) {
    return {
      token,
      schedule: { kind: 'weekly', weekday: sorted[0], weekdays: sorted },
      fuzzy: false,
    };
  }
  return { token, schedule: { kind: 'weekly', weekday: sorted[0] }, fuzzy: false };
}

function matchRecurrence(text: string): RecurrenceMatch | null {
  // interval：每(隔)N分钟 / 每(隔)N小时（含中文数字）/ 每(隔)半小时 / 每小时 / every N minutes|hours / hourly
  const zhMinutes = new RegExp(`每\\s*隔?\\s*(\\d{1,4}|${ZH_NUM_SEQ})\\s*分钟`).exec(text);
  if (zhMinutes) {
    const minutes = parseZhOrArabicNumber(zhMinutes[1]);
    if (minutes !== null) {
      const clamped = clampInterval(minutes);
      return {
        token: zhMinutes[0],
        schedule: { kind: 'interval', intervalMinutes: clamped },
        fuzzy: false,
        ...(clamped !== minutes ? { hint: 'intervalClamped' as const } : {}),
      };
    }
  }
  const zhHours = new RegExp(`每\\s*隔?\\s*(\\d{1,3}|${ZH_NUM_SEQ})\\s*(?:个)?\\s*小时`).exec(text);
  if (zhHours) {
    const hours = parseZhOrArabicNumber(zhHours[1]);
    if (hours !== null) {
      const clamped = clampInterval(hours * 60);
      return {
        token: zhHours[0],
        schedule: { kind: 'interval', intervalMinutes: clamped },
        fuzzy: false,
        ...(clamped !== hours * 60 ? { hint: 'intervalClamped' as const } : {}),
      };
    }
  }
  const zhHalfHour = /每\s*隔?\s*半\s*(?:个)?\s*小时/.exec(text);
  if (zhHalfHour) {
    return {
      token: zhHalfHour[0],
      schedule: { kind: 'interval', intervalMinutes: 30 },
      fuzzy: false,
    };
  }
  const zhHourly = /每\s*小时/.exec(text);
  if (zhHourly) {
    return {
      token: zhHourly[0],
      schedule: { kind: 'interval', intervalMinutes: 60 },
      fuzzy: false,
    };
  }
  const enMinutes = /\bevery\s+(\d{1,4})\s+min(?:ute)?s?\b/i.exec(text);
  if (enMinutes) {
    const minutes = parseInt(enMinutes[1], 10);
    const clamped = clampInterval(minutes);
    return {
      token: enMinutes[0],
      schedule: { kind: 'interval', intervalMinutes: clamped },
      fuzzy: false,
      ...(clamped !== minutes ? { hint: 'intervalClamped' as const } : {}),
    };
  }
  const enHours = /\bevery\s+(\d{1,3})\s+hours?\b/i.exec(text);
  if (enHours) {
    const minutes = parseInt(enHours[1], 10) * 60;
    const clamped = clampInterval(minutes);
    return {
      token: enHours[0],
      schedule: { kind: 'interval', intervalMinutes: clamped },
      fuzzy: false,
      ...(clamped !== minutes ? { hint: 'intervalClamped' as const } : {}),
    };
  }
  const enHourly = /\bhourly\b|\bevery\s+hour\b/i.exec(text);
  if (enHourly) {
    return { token: enHourly[0], schedule: { kind: 'interval', intervalMinutes: 60 }, fuzzy: false };
  }

  // weekdays：每周一到周五 / 每个工作日 / 工作日 / every weekday / weekdays
  const weekdaysRe =
    /每\s*(?:周|星期|礼拜)一\s*(?:到|至)\s*(?:周|星期|礼拜)?五|每\s*个?\s*工作日|工作日|\bevery\s+weekday\b|\bweekdays\b/i;
  const wdm = weekdaysRe.exec(text);
  if (wdm) {
    return { token: wdm[0], schedule: { kind: 'weekdays' }, fuzzy: false };
  }

  // 每周末 / every weekend → weekly 周六（confidence: medium）
  const weekendRe = /每\s*(?:个)?\s*周末|\bevery\s+weekend\b/i;
  const wem = weekendRe.exec(text);
  if (wem) {
    return {
      token: wem[0],
      schedule: { kind: 'weekly', weekday: 6 },
      fuzzy: true,
      hint: 'weekendSaturday',
    };
  }

  // weekly（锚定星期）：每周X / 每周一三五 / every monday / every monday and friday
  // 多个星期直接产出 weekly + weekdays 集合（无损）；
  // 恰为周一至周五仍归并为 weekdays 调度。
  // 「每周一次」不视为周一（次/个 → 落到下方「每周」泛化路径）。
  // 列表项之间要求直接相邻（一三五）或显式分隔（、,，和 / 周X 前缀），
  // 纯空格不算分隔，避免吃掉「每周一 五号楼开会」里的「五」。
  const zhWeekly =
    /每\s*(?:周|星期|礼拜)\s*([一二三四五六日天](?:(?:\s*[、,，和]\s*(?:周|星期|礼拜)?|\s*(?:周|星期|礼拜))\s*[一二三四五六日天]|[一二三四五六日天])*)(?![次个])/.exec(text);
  if (zhWeekly) {
    let token = zhWeekly[0];
    let body = zhWeekly[1];
    // 「每周一三点」的末位星期字若紧跟 点/时，实为时刻小时（每周一 + 3点）：
    // 回吐最后一个星期字，交还给时刻解析。仅在多个星期时处理，
    // 保持「每周三」= 周三 的既有单星期语义。
    const tail = text.slice(zhWeekly.index + token.length);
    const weekdayChars = body.split('').filter((char) => ZH_WEEKDAY_MAP[char] !== undefined);
    if (weekdayChars.length > 1 && /^\s*[点时]/.test(tail)) {
      const lastChar = weekdayChars[weekdayChars.length - 1];
      const cut = token.lastIndexOf(lastChar);
      token = token.slice(0, cut).replace(/[\s、,，和]+$/, '');
      body = body.slice(0, body.lastIndexOf(lastChar));
    }
    const weekdays: number[] = [];
    for (const char of body) {
      const weekday = ZH_WEEKDAY_MAP[char];
      if (weekday !== undefined && !weekdays.includes(weekday)) weekdays.push(weekday);
    }
    if (weekdays.length > 0) {
      return buildWeeklySetMatch(token, weekdays);
    }
  }
  const EN_WEEKDAY_ALT = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
  const enWeekly = new RegExp(
    `\\bevery\\s+((?:${EN_WEEKDAY_ALT})(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+|\\s*&\\s*)(?:${EN_WEEKDAY_ALT}))*)\\b`,
    'i',
  ).exec(text);
  if (enWeekly) {
    const weekdays: number[] = [];
    for (const word of enWeekly[1].toLowerCase().match(/[a-z]+/g) ?? []) {
      const weekday = EN_WEEKDAY_MAP[word];
      if (weekday !== undefined && !weekdays.includes(weekday)) weekdays.push(weekday);
    }
    if (weekdays.length > 0) {
      return buildWeeklySetMatch(enWeekly[0], weekdays);
    }
  }

  // monthly（带日）：每月N号 / 每月N日
  const zhMonthly = /每\s*个?\s*月\s*(\d{1,2})\s*[号日]/.exec(text);
  if (zhMonthly) {
    return {
      token: zhMonthly[0],
      schedule: { kind: 'monthly', dayOfMonth: clampDayOfMonth(parseInt(zhMonthly[1], 10)) },
      fuzzy: false,
    };
  }

  // monthly（最后一天）：每月最后一天 / 每月月底 / last day of every month
  // → dayOfMonth=31：后端 scheduled_slot_on_date 与前端 computeNextRuns 都会把
  // 31 收敛到短月月末，语义与「每月最后一天」完全一致。
  const monthLastRe =
    /每\s*个?\s*月\s*(?:的)?\s*(?:最后一[天日]|月底|月末)|\b(?:on\s+the\s+)?last\s+day\s+of\s+(?:every|each|the)\s+month\b/i;
  const ml = monthLastRe.exec(text);
  if (ml) {
    return {
      token: ml[0],
      schedule: { kind: 'monthly', dayOfMonth: 31 },
      fuzzy: false,
      hint: 'monthLastDay',
    };
  }

  // 每晚 / 每早 → daily + 时段推断（「每天晚上8点」仍走 每天 + 前缀时刻的原路径）
  const zhEvening = /每\s*晚上?/.exec(text);
  if (zhEvening) {
    return {
      token: zhEvening[0],
      schedule: { kind: 'daily' },
      fuzzy: false,
      impliedPeriod: 'evening',
      impliedTime: '20:00',
    };
  }
  const zhMorning = /每\s*早(?:晨|上)?/.exec(text);
  if (zhMorning) {
    return {
      token: zhMorning[0],
      schedule: { kind: 'daily' },
      fuzzy: false,
      impliedPeriod: 'morning',
      impliedTime: '08:00',
    };
  }

  // every morning/afternoon/evening/night → daily + 时段推断
  const enPeriod = /\bevery\s+(morning|afternoon|evening|night)\b/i.exec(text);
  if (enPeriod) {
    const preset = EN_PERIOD_DEFAULTS[enPeriod[1].toLowerCase()];
    return {
      token: enPeriod[0],
      schedule: { kind: 'daily' },
      fuzzy: false,
      impliedPeriod: preset.period,
      impliedTime: preset.time,
    };
  }

  // daily：每天 / 每日 / daily / every day
  const dailyRe = /每\s*[天日]|\bevery\s*day\b|\bdaily\b/i;
  const dm = dailyRe.exec(text);
  if (dm) {
    return { token: dm[0], schedule: { kind: 'daily' }, fuzzy: false };
  }

  // monthly（无日 → 默认 1 号，降级）
  const monthlyPlainRe = /每\s*个?\s*月|\bevery\s+month\b|\bmonthly\b/i;
  const mp = monthlyPlainRe.exec(text);
  if (mp) {
    return {
      token: mp[0],
      schedule: { kind: 'monthly', dayOfMonth: 1 },
      fuzzy: true,
      hint: 'monthlyFirstDay',
    };
  }

  // weekly（无星期 → 锚定解析时的星期，降级），由调用方补 weekday
  const weeklyPlainRe = /每\s*(?:周|星期|礼拜)|\bevery\s+week\b|\bweekly\b/i;
  const wp = weeklyPlainRe.exec(text);
  if (wp) {
    return { token: wp[0], schedule: { kind: 'weekly' }, fuzzy: true, hint: 'weekAnchored' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 相对偏移（X分钟后 / X小时后 → once）
// ---------------------------------------------------------------------------

interface RelativeMatch {
  token: string;
  minutes: number;
}

function matchRelativeOffset(text: string): RelativeMatch | null {
  const zhMin = new RegExp(`(\\d{1,4}|${ZH_NUM_SEQ})\\s*分钟(?:之|以)?后`).exec(text);
  if (zhMin) {
    const minutes = parseZhOrArabicNumber(zhMin[1]);
    if (minutes !== null) return { token: zhMin[0], minutes };
  }
  const zhHour = new RegExp(`(\\d{1,3}|${ZH_NUM_SEQ})\\s*(?:个)?\\s*小时(?:之|以)?后`).exec(text);
  if (zhHour) {
    const hours = parseZhOrArabicNumber(zhHour[1]);
    if (hours !== null) return { token: zhHour[0], minutes: hours * 60 };
  }
  const zhHalf = /半\s*(?:个)?\s*小时(?:之|以)?后/.exec(text);
  if (zhHalf) {
    return { token: zhHalf[0], minutes: 30 };
  }
  const enMin = /\bin\s+(\d{1,4})\s+min(?:ute)?s?\b/i.exec(text);
  if (enMin) {
    return { token: enMin[0], minutes: parseInt(enMin[1], 10) };
  }
  const enHour = /\bin\s+(\d{1,3})\s+hours?\b/i.exec(text);
  if (enHour) {
    return { token: enHour[0], minutes: parseInt(enHour[1], 10) * 60 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 一次性日期匹配
// ---------------------------------------------------------------------------

interface DateMatch {
  token: string;
  date: Date;
}

function matchOnceDate(text: string, now: Date): DateMatch | null {
  // YYYY-MM-DD（最明确，优先）
  const isoRe = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/;
  const iso = isoRe.exec(text);
  if (iso) {
    const y = parseInt(iso[1], 10);
    const mo = parseInt(iso[2], 10);
    const d = parseInt(iso[3], 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return { token: iso[0], date: new Date(y, mo - 1, d) };
    }
  }

  // 相对日（长 token 优先，避免「后天」吃进「大后天」）
  const relative: Array<[string, number]> = [
    ['大后天', 3],
    ['后天', 2],
    ['明天', 1],
    ['今天', 0],
    ['tomorrow', 1],
    ['today', 0],
  ];
  for (const [token, offset] of relative) {
    const isAsciiToken = /^[a-z]+$/.test(token);
    let idx = -1;
    if (isAsciiToken) {
      idx = new RegExp(`\\b${token}\\b`, 'i').exec(text)?.index ?? -1;
    } else {
      idx = text.indexOf(token);
    }
    if (idx !== -1) {
      return { token: text.slice(idx, idx + token.length), date: addDays(now, offset) };
    }
  }

  // 下周X / 周X / 星期X / 礼拜X
  const weekdayRe = /(下\s*)?(?:周|星期|礼拜)([一二三四五六日天])/;
  const wm = weekdayRe.exec(text);
  if (wm) {
    const weekday = ZH_WEEKDAY_MAP[wm[2]];
    if (weekday !== undefined) {
      return { token: wm[0], date: nextWeekday(now, weekday, Boolean(wm[1])) };
    }
  }

  // next monday / friday（英文尽力）
  const enWeekdayRe = /\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
  const em = enWeekdayRe.exec(text);
  if (em) {
    const weekday = EN_WEEKDAY_MAP[em[2].toLowerCase()];
    return { token: em[0], date: nextWeekday(now, weekday, Boolean(em[1])) };
  }

  // N月N日 / N月N号（已过去 → 明年）
  const monthDayRe = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/;
  const mm = monthDayRe.exec(text);
  if (mm) {
    const month = parseInt(mm[1], 10);
    const day = parseInt(mm[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let d = new Date(now.getFullYear(), month - 1, day);
      if (formatLocalDate(d) < formatLocalDate(now)) {
        d = new Date(now.getFullYear() + 1, month - 1, day);
      }
      return { token: mm[0], date: d };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 时刻匹配
// ---------------------------------------------------------------------------

interface TimeMatch {
  token: string;
  /** HH:MM（24 小时制） */
  time: string;
  /** 口语模糊表达（如单独的「中午」） */
  fuzzy: boolean;
  /** 无上下午信息的裸时刻（裸「N点」/ 无 am/pm 的 HH:MM / at N），可被时段推断换算 */
  bare?: boolean;
  /** 裸小时（at 6）：无分钟、无 am/pm，语义歧义 */
  ambiguousHour?: boolean;
}

/** 中文时段前缀 → 24 小时制换算 */
function applyZhPeriod(period: string, hour: number): number {
  if ((period === '下午' || period === '晚上' || period === '傍晚' || period === '晚') && hour < 12) {
    return hour + 12;
  }
  if (period === '中午' && hour < 11) return hour + 12;
  return hour;
}

function zhMinute(part: string | undefined, minuteDigits: string | undefined): number {
  if (part === '半') return 30;
  if (part === '一刻') return 15;
  if (part === '三刻') return 45;
  if (minuteDigits) return Math.min(59, parseInt(minuteDigits, 10));
  return 0;
}

function matchTime(text: string): TimeMatch | null {
  // 带时段前缀：早上/上午/中午/下午/晚上/凌晨/晚/早 H点[半|一刻|三刻|N分]
  // 小时支持中文数字（晚八点/上午十点半）；短前缀 晚/早 放在长词之后避免抢匹配
  const prefixedRe =
    /(上午|早上|早晨|中午|下午|傍晚|晚上|凌晨|晚|早)\s*(\d{1,2}|[一两二三四五六七八九十]{1,3})\s*[点时]\s*(半|一刻|三刻|(\d{1,2})\s*分)?/;
  const pm = prefixedRe.exec(text);
  if (pm) {
    // 「晚一点」「早一点」是程度副词（稍微晚/早一些）而非 13:00 / 01:00：
    // 短前缀 晚/早 + 中文「一」且无分钟部分时放弃（「晚上一点」不受影响）
    const shortPrefixAdverb = (pm[1] === '晚' || pm[1] === '早') && pm[2] === '一' && !pm[3];
    const parsedHour = parseZhOrArabicNumber(pm[2]);
    if (!shortPrefixAdverb && parsedHour !== null && parsedHour >= 0 && parsedHour <= 24) {
      const minute = zhMinute(pm[3], pm[4]);
      let hour = applyZhPeriod(pm[1], parsedHour);
      if (hour === 24) hour = 0;
      if (hour <= 23) {
        return { token: pm[0].trim(), time: `${pad2(hour)}:${pad2(minute)}`, fuzzy: false };
      }
    }
  }

  // 裸「N点[半|一刻|三刻|N分]」：要求前面是行首/空白/分隔符，降低误伤
  const bareZhRe =
    /(?:^|[\s,，、])(\d{1,2}|[一两二三四五六七八九十]{1,3})\s*[点时]\s*(半|一刻|三刻|(\d{1,2})\s*分)?/;
  const bm = bareZhRe.exec(text);
  if (bm) {
    const parsedHour = parseZhOrArabicNumber(bm[1]);
    // 「一点点」「一点儿」是程度副词而非时刻：中文数字小时后紧跟 点/儿 时放弃
    const degreeAdverb =
      !/^\d+$/.test(bm[1]) && !bm[2] && /^[点儿]/.test(text.slice(bm.index + bm[0].length));
    if (parsedHour !== null && parsedHour >= 0 && parsedHour <= 24 && !degreeAdverb) {
      const minute = zhMinute(bm[2], bm[3]);
      const hour = parsedHour === 24 ? 0 : parsedHour;
      if (hour <= 23) {
        const tokenStart = text.indexOf(bm[1], bm.index);
        const token = text.slice(tokenStart, bm.index + bm[0].length).trim();
        return { token, time: `${pad2(hour)}:${pad2(minute)}`, fuzzy: false, bare: true };
      }
    }
  }

  // HH:MM（可带 am/pm 后缀；放行 CJK 紧邻与常见标点）
  const colonRe =
    /(?:^|[\s,，]|(?<=[\u4e00-\u9fff]))(\d{1,2}):(\d{2})\s*(am|pm)?(?=$|[\s,，.;!?。；！？、]|[\u4e00-\u9fff])/i;
  const cm = colonRe.exec(text);
  if (cm) {
    let hour = parseInt(cm[1], 10);
    const minute = parseInt(cm[2], 10);
    const suffix = cm[3]?.toLowerCase();
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59) {
      const tokenStart = text.indexOf(cm[1], cm.index);
      const token = text.slice(tokenStart, cm.index + cm[0].length).trim();
      // 无 am/pm 且小时 <12 的 HH:MM 视为可被时段推断换算的裸时刻（如「每晚8:30」）
      return { token, time: `${pad2(hour)}:${pad2(minute)}`, fuzzy: false, bare: !suffix };
    }
  }

  // 3pm / 11am
  const ampmRe =
    /(?:^|[\s,，]|(?<=[\u4e00-\u9fff]))(\d{1,2})\s*(am|pm)(?=$|[\s,，.;!?。；！？、]|[\u4e00-\u9fff])/i;
  const am = ampmRe.exec(text);
  if (am) {
    let hour = parseInt(am[1], 10);
    const suffix = am[2].toLowerCase();
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    if (hour <= 23) {
      const tokenStart = text.indexOf(am[1], am.index);
      const token = text.slice(tokenStart, am.index + am[0].length).trim();
      return { token, time: `${pad2(hour)}:00`, fuzzy: false };
    }
  }

  // 裸小时 at N（every evening at 6 → 时段推断补全；无时段 → 歧义提示）
  const atBareRe = /(?:^|[\s,，])at\s+(\d{1,2})(?=$|[\s,，.;!?。；！？、])/i;
  const ab = atBareRe.exec(text);
  if (ab) {
    const hour = parseInt(ab[1], 10);
    if (hour <= 23) {
      const token = ab[0].replace(/^[\s,，]+/, '');
      return { token, time: `${pad2(hour)}:00`, fuzzy: false, bare: true, ambiguousHour: true };
    }
  }

  // 单独的「中午/正午」→ 12:00（口语模糊，medium）
  const noonRe = /中午|正午|\bnoon\b/i;
  const nm = noonRe.exec(text);
  if (nm) {
    return { token: nm[0], time: '12:00', fuzzy: true };
  }

  return null;
}

/**
 * 时间 token 向前吸收连接词「at」「在」，避免残留进 prompt/name
 * （如 "daily at 8:30 standup" 剔除 "at 8:30" 而非只剔 "8:30"）。
 */
function expandTimeToken(text: string, token: string): string {
  const index = text.indexOf(token);
  if (index <= 0) return token;
  const before = text.slice(0, index);
  const connective = /(?:\bat\s+|在\s*)$/i.exec(before);
  return connective ? text.slice(index - connective[0].length, index + token.length) : token;
}

// ---------------------------------------------------------------------------
// prompt / name 提炼
// ---------------------------------------------------------------------------

/** 剔除 token 并清理多余空白（只剔除第一次出现） */
function removeToken(text: string, token: string): string {
  return text.replace(token, ' ').replace(/\s{2,}/g, ' ').trim();
}

function cleanEdges(text: string): string {
  return text
    .replace(/^[\s,，、.。;；:：!！?？-]+/, '')
    .replace(/[\s,，、;；:：-]+$/, '')
    .trim();
}

const NAME_MAX_CHARS = 20;

/** 去掉客套/助词前缀，保留语义核心，并截断到 ≤20 字 */
function deriveName(prompt: string): string | undefined {
  let core = prompt;
  // 客套前缀可叠加出现（「麻烦帮我提醒我…」）
  const fillerRe = /^(?:请|麻烦(?:你|您)?|帮我|给我|替我|记得|记住)+/;
  let prev = '';
  while (prev !== core) {
    prev = core;
    core = cleanEdges(core.replace(fillerRe, ''));
    core = cleanEdges(core.replace(/^提醒(?:我|大家)?(?:去|要)?/, ''));
    core = cleanEdges(core.replace(/^(?:please\s+)?remind\s+me\s+(?:to\s+)?/i, ''));
  }
  if (!core) return undefined;
  const chars = Array.from(core);
  return chars.length > NAME_MAX_CHARS ? chars.slice(0, NAME_MAX_CHARS).join('') : core;
}

/** prompt 中是否还有实义内容（字母/数字/汉字） */
function hasContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function parseAutomationNaturalLanguage(
  input: string,
  now: Date = new Date(),
): AutomationNlParseResult | null {
  const original = input?.trim() ?? '';
  if (!original) return null;

  let rest = original;
  const matchedTokens: string[] = [];
  const consume = (token: string) => {
    matchedTokens.push(token);
    rest = removeToken(rest, token);
  };

  let schedule: AutomationSchedule | undefined;
  let fuzzy = false;
  let explicitTime = false;
  let relativeOnce = false;
  const hints: AutomationNlHint[] = [];
  const addHint = (hint: AutomationNlHint) => {
    if (!hints.includes(hint)) hints.push(hint);
  };

  // 1) 周期表达
  const recurrence = matchRecurrence(rest);
  if (recurrence) {
    consume(recurrence.token);
    fuzzy = recurrence.fuzzy;
    if (recurrence.hint) addHint(recurrence.hint);
  }

  // 2) 相对偏移（仅在无周期时视为一次性）
  let onceDate: Date | undefined;
  if (!recurrence) {
    const relative = matchRelativeOffset(rest);
    if (relative) {
      consume(relative.token);
      relativeOnce = true;
      const target = new Date(now.getTime() + relative.minutes * 60_000);
      target.setSeconds(0, 0); // 取整到分
      schedule = { kind: 'once', date: formatLocalDate(target), time: formatLocalTime(target) };
    } else {
      // 3) 一次性日期
      const dateMatch = matchOnceDate(rest, now);
      if (dateMatch) {
        consume(dateMatch.token);
        onceDate = dateMatch.date;
      }
    }
  }

  // 4) 时刻
  let time: string | undefined;
  if (!relativeOnce) {
    const timeMatch = matchTime(rest);
    if (timeMatch) {
      // 向前吸收「at」「在」连接词，避免残留进 prompt/name
      consume(expandTimeToken(rest, timeMatch.token));
      time = timeMatch.time;

      // 时段推断：每晚8点 / every evening at 6 → 裸小时按时段换算到 24 小时制
      if (timeMatch.bare && recurrence?.impliedPeriod && recurrence.impliedPeriod !== 'morning') {
        const [hour, minute] = time.split(':').map((part) => parseInt(part, 10));
        if (hour >= 1 && hour < 12) {
          time = `${pad2(hour + 12)}:${pad2(minute)}`;
        }
      }

      // 裸小时（at 6）且无时段可推断 → 歧义降级
      const ambiguous = Boolean(timeMatch.ambiguousHour) && !recurrence?.impliedPeriod;
      if (ambiguous) addHint('bareHourAmbiguous');
      explicitTime = !timeMatch.fuzzy && !ambiguous;
      if (timeMatch.fuzzy || ambiguous) fuzzy = true;
    }
  }

  // 5) 组装调度
  if (recurrence) {
    const base = recurrence.schedule;
    if (base.kind === 'interval') {
      // 后端 validate_schedule 拒绝 interval + 非空 time/timezone：保持 time 为空串
      // （与 AutomationScheduleEditor 及 serializeSchedule 的约定一致）
      schedule = { kind: 'interval', time: '', intervalMinutes: base.intervalMinutes };
    } else {
      if (!time) {
        if (recurrence.impliedTime) {
          // 时段词自带默认时刻（每晚 → 20:00），比全局默认更贴近语义
          time = recurrence.impliedTime;
          addHint('impliedTime');
        } else {
          time = DEFAULT_TIME;
          addHint('defaultTime');
        }
        fuzzy = true;
      }
      schedule = { ...base, time } as AutomationSchedule;
      if (schedule.kind === 'weekly' && schedule.weekday === undefined) {
        // 「每周」未指定星期 → 锚定解析时刻的星期（matchRecurrence 已标记 fuzzy）
        schedule.weekday = now.getDay();
      }
    }
  } else if (!relativeOnce && onceDate) {
    if (!time) {
      time = DEFAULT_TIME;
      fuzzy = true;
      addHint('defaultTime');
    }
    schedule = { kind: 'once', date: formatLocalDate(onceDate), time };
  } else if (!relativeOnce && time) {
    // 只有时刻，无日期/周期 → 一次性：今天该时刻已过则顺延到明天（口语省略，medium）
    const todayAt = `${formatLocalDate(now)} ${time}`;
    const nowAt = `${formatLocalDate(now)} ${formatLocalTime(now)}`;
    const rolled = todayAt <= nowAt;
    const date = rolled ? addDays(now, 1) : now;
    schedule = { kind: 'once', date: formatLocalDate(date), time };
    fuzzy = true;
    addHint(rolled ? 'timeRolledTomorrow' : 'timeOnlyToday');
  }

  // 6) prompt / name
  const prompt = cleanEdges(rest);
  const promptValue = hasContent(prompt) ? prompt : undefined;
  if (!schedule && !promptValue) return null;
  const name = promptValue ? deriveName(promptValue) : undefined;

  // 7) matchedText：按原文出现顺序拼接命中的时间表达
  const orderedTokens = [...matchedTokens].sort(
    (a, b) => original.indexOf(a) - original.indexOf(b),
  );
  const matchedText = orderedTokens.length > 0 ? orderedTokens.join(' ') : undefined;

  // 8) confidence
  let confidence: AutomationNlParseResult['confidence'];
  if (!schedule) {
    confidence = 'low';
  } else if (schedule.kind === 'interval' || relativeOnce) {
    confidence = 'high';
  } else if (explicitTime && !fuzzy) {
    confidence = 'high';
  } else {
    confidence = 'medium';
  }

  return {
    ...(name ? { name } : {}),
    ...(schedule ? { schedule } : {}),
    ...(promptValue ? { prompt: promptValue } : {}),
    confidence,
    ...(matchedText ? { matchedText } : {}),
    // hints 只在解析出可用调度时才有意义（低置信度已有独立文案）
    ...(schedule && hints.length > 0 ? { hints } : {}),
  };
}
