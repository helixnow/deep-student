/**
 * 定时任务（自动化）自然语言排期解析器
 *
 * 供工作区代理快速创建输入框调用：从一句话中解析出 AutomationSchedule、
 * 任务名（name）与去时间表达后的任务内容（prompt）。
 *
 * 支持（中文优先 + 基础英文）：
 *   周期：每天/每日/daily、每周X/每周一到周五/工作日/weekdays、每月N号、
 *         每N分钟/每N小时/每小时/every N minutes|hours/hourly、每周末（→ 周六，medium）
 *   时刻：早上8点/上午9点半/下午3点/晚上10点/凌晨1点/中午/8:30/20:00/9am/9:30pm/
 *         点半=:30、一刻=:15、三刻=:45；周期任务缺时刻默认 09:00（confidence 降级）
 *   一次性：今天/明天/后天/大后天/周X/下周X/N月N日/YYYY-MM-DD + 时刻；
 *           「X分钟后/X小时后」→ once（now+偏移，取整到分）
 *
 * 设计原则与 quickAddParser 一致：token 匹配要求词边界，逐个从工作文本中剔除，
 * 剩余文本作为 prompt，进一步去助词、截断后作为 name。
 */

import type { AutomationSchedule } from '../settings/components/automationSettingsApi';

export type { AutomationSchedule };

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
}

function matchRecurrence(text: string): RecurrenceMatch | null {
  // interval：每N分钟 / 每N小时 / 每半小时 / 每小时 / every N minutes|hours / hourly
  const zhMinutes = /每\s*(\d{1,4})\s*分钟/.exec(text);
  if (zhMinutes) {
    return {
      token: zhMinutes[0],
      schedule: { kind: 'interval', intervalMinutes: clampInterval(parseInt(zhMinutes[1], 10)) },
      fuzzy: false,
    };
  }
  const zhHours = /每\s*(\d{1,3})\s*(?:个)?\s*小时/.exec(text);
  if (zhHours) {
    return {
      token: zhHours[0],
      schedule: { kind: 'interval', intervalMinutes: clampInterval(parseInt(zhHours[1], 10) * 60) },
      fuzzy: false,
    };
  }
  const zhHalfHour = /每\s*半\s*(?:个)?\s*小时/.exec(text);
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
    return {
      token: enMinutes[0],
      schedule: { kind: 'interval', intervalMinutes: clampInterval(parseInt(enMinutes[1], 10)) },
      fuzzy: false,
    };
  }
  const enHours = /\bevery\s+(\d{1,3})\s+hours?\b/i.exec(text);
  if (enHours) {
    return {
      token: enHours[0],
      schedule: { kind: 'interval', intervalMinutes: clampInterval(parseInt(enHours[1], 10) * 60) },
      fuzzy: false,
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

  // 每周末 → weekly 周六（confidence: medium）
  const weekendRe = /每\s*(?:个)?\s*周末/;
  const wem = weekendRe.exec(text);
  if (wem) {
    return { token: wem[0], schedule: { kind: 'weekly', weekday: 6 }, fuzzy: true };
  }

  // weekly（锚定星期）：每周X / every monday
  const zhWeekly = /每\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(text);
  if (zhWeekly) {
    const weekday = ZH_WEEKDAY_MAP[zhWeekly[1]];
    if (weekday !== undefined) {
      return { token: zhWeekly[0], schedule: { kind: 'weekly', weekday }, fuzzy: false };
    }
  }
  const enWeekly = /\bevery\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(text);
  if (enWeekly) {
    return {
      token: enWeekly[0],
      schedule: { kind: 'weekly', weekday: EN_WEEKDAY_MAP[enWeekly[1].toLowerCase()] },
      fuzzy: false,
    };
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
    return { token: mp[0], schedule: { kind: 'monthly', dayOfMonth: 1 }, fuzzy: true };
  }

  // weekly（无星期 → 锚定解析时的星期，降级），由调用方补 weekday
  const weeklyPlainRe = /每\s*(?:周|星期|礼拜)|\bevery\s+week\b|\bweekly\b/i;
  const wp = weeklyPlainRe.exec(text);
  if (wp) {
    return { token: wp[0], schedule: { kind: 'weekly' }, fuzzy: true };
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
  const zhMin = /(\d{1,4})\s*分钟(?:之|以)?后/.exec(text);
  if (zhMin) {
    return { token: zhMin[0], minutes: parseInt(zhMin[1], 10) };
  }
  const zhHour = /(\d{1,3})\s*(?:个)?\s*小时(?:之|以)?后/.exec(text);
  if (zhHour) {
    return { token: zhHour[0], minutes: parseInt(zhHour[1], 10) * 60 };
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
}

/** 中文时段前缀 → 24 小时制换算 */
function applyZhPeriod(period: string, hour: number): number {
  if ((period === '下午' || period === '晚上' || period === '傍晚') && hour < 12) return hour + 12;
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
  // 带时段前缀：早上/上午/中午/下午/晚上/凌晨 H点[半|一刻|三刻|N分]
  const prefixedRe =
    /(上午|早上|早晨|中午|下午|傍晚|晚上|凌晨)\s*(\d{1,2})\s*[点时]\s*(半|一刻|三刻|(\d{1,2})\s*分)?/;
  const pm = prefixedRe.exec(text);
  if (pm) {
    let hour = parseInt(pm[2], 10);
    if (hour >= 0 && hour <= 24) {
      const minute = zhMinute(pm[3], pm[4]);
      hour = applyZhPeriod(pm[1], hour);
      if (hour === 24) hour = 0;
      if (hour <= 23) {
        return { token: pm[0].trim(), time: `${pad2(hour)}:${pad2(minute)}`, fuzzy: false };
      }
    }
  }

  // 裸「N点[半|一刻|三刻|N分]」：要求前面是行首/空白/分隔符，降低误伤
  const bareZhRe = /(?:^|[\s,，、])(\d{1,2})\s*[点时]\s*(半|一刻|三刻|(\d{1,2})\s*分)?/;
  const bm = bareZhRe.exec(text);
  if (bm) {
    let hour = parseInt(bm[1], 10);
    if (hour >= 0 && hour <= 24) {
      const minute = zhMinute(bm[2], bm[3]);
      if (hour === 24) hour = 0;
      if (hour <= 23) {
        const tokenStart = text.indexOf(bm[1], bm.index);
        const token = text.slice(tokenStart, bm.index + bm[0].length).trim();
        return { token, time: `${pad2(hour)}:${pad2(minute)}`, fuzzy: false };
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
      return { token, time: `${pad2(hour)}:${pad2(minute)}`, fuzzy: false };
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

  // 单独的「中午/正午」→ 12:00（口语模糊，medium）
  const noonRe = /中午|正午|\bnoon\b/i;
  const nm = noonRe.exec(text);
  if (nm) {
    return { token: nm[0], time: '12:00', fuzzy: true };
  }

  return null;
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

  // 1) 周期表达
  const recurrence = matchRecurrence(rest);
  if (recurrence) {
    consume(recurrence.token);
    fuzzy = recurrence.fuzzy;
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
      consume(timeMatch.token);
      time = timeMatch.time;
      explicitTime = !timeMatch.fuzzy;
      if (timeMatch.fuzzy) fuzzy = true;
    }
  }

  // 5) 组装调度
  if (recurrence) {
    const base = recurrence.schedule;
    if (base.kind === 'interval') {
      schedule = { kind: 'interval', time: '00:00', intervalMinutes: base.intervalMinutes };
    } else {
      if (!time) {
        time = DEFAULT_TIME;
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
    }
    schedule = { kind: 'once', date: formatLocalDate(onceDate), time };
  } else if (!relativeOnce && time) {
    // 只有时刻，无日期/周期 → 一次性：今天该时刻已过则顺延到明天（口语省略，medium）
    const todayAt = `${formatLocalDate(now)} ${time}`;
    const nowAt = `${formatLocalDate(now)} ${formatLocalTime(now)}`;
    const date = todayAt > nowAt ? now : addDays(now, 1);
    schedule = { kind: 'once', date: formatLocalDate(date), time };
    fuzzy = true;
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
  };
}
