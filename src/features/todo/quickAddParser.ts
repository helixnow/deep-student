/**
 * Todo 快速添加自然语言解析（轻量版）
 *
 * 从输入文本中识别日期、时间、优先级、重复规则与标签 token，返回剔除 token 后的标题。
 * 支持（中文优先 + 基础英文）：
 *   日期：今天 / 明天 / 后天 / 大后天 / 周一~周日 / 下周一~下周日 /
 *         N月N日(号) / N号 / today / tomorrow
 *   时间：HH:MM / N点(半|N分) / 上午|下午|晚上N点 / 3pm / 3:30pm
 *   优先级：!紧急 / !高 / !中 / !低（半角或全角叹号）
 *   重复：每天 / 每周 / 每周X / 每周一三五 / 每月 / 每年 / 每个工作日 / daily / weekly ...
 *   标签：#标签名
 *
 * 设计原则：token 必须是独立词（避免误伤如「明天气温」中的「明天气」），
 * 解析结果在 UI 中以 chip 预览，用户手动设置的字段优先于解析结果。
 */

import type { TodoPriority, TodoRepeatRule } from './types';

export interface QuickAddParseResult {
  /** 剔除已识别 token 后的标题 */
  title: string;
  /** YYYY-MM-DD（本地时区） */
  dueDate?: string;
  /** HH:MM（24 小时制） */
  dueTime?: string;
  priority?: TodoPriority;
  /** 重复规则（如「每天」→ daily）；命中时若无日期 token，dueDate 默认今天 */
  repeat?: TodoRepeatRule;
  /** 解析出的标签（#token，不含 # 前缀） */
  tags?: string[];
  /** 命中的日期 token 原文（用于 UI 回显） */
  dateToken?: string;
  /** 命中的时间 token 原文 */
  timeToken?: string;
  /** 命中的优先级 token 原文 */
  priorityToken?: string;
  /** 命中的重复 token 原文 */
  repeatToken?: string;
}

const WEEKDAY_MAP: Record<string, number> = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0,
};

const PRIORITY_MAP: Record<string, TodoPriority> = {
  '紧急': 'urgent',
  '高': 'high',
  '中': 'medium',
  '低': 'low',
  'urgent': 'urgent',
  'high': 'high',
  'medium': 'medium',
  'low': 'low',
};

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * 目标星期对应的日期。
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
  const offsetInWeek = weekday === 0 ? 6 : weekday - 1; // 周一为下周第 0 天，周日为第 6 天
  return addDays(base, daysToNextMonday + offsetInWeek);
}

interface DateMatch {
  token: string;
  index: number;
  date: Date;
}

function matchDate(text: string, now: Date): DateMatch | null {
  // 相对日（按 token 长度降序尝试，避免「后天」匹配进「大后天」）
  const relative: Array<[string, number]> = [
    ['大后天', 3],
    ['后天', 2],
    ['明天', 1],
    ['今天', 0],
    ['tomorrow', 1],
    ['today', 0],
  ];
  for (const [token, offset] of relative) {
    // ★ 英文 token 要求词边界：避免 "tomorrowland"/"uptoday" 等单词被误吞
    const isAsciiToken = /^[a-z]+$/.test(token);
    let idx = -1;
    if (isAsciiToken) {
      const wordRe = new RegExp(`\\b${token}\\b`, 'i');
      idx = wordRe.exec(text)?.index ?? -1;
    } else {
      idx = text.indexOf(token);
    }
    if (idx !== -1) {
      return { token: text.slice(idx, idx + token.length), index: idx, date: addDays(now, offset) };
    }
  }

  // 下周X / 周X / 星期X / 礼拜X
  const weekdayRe = /(下\s*)?(周|星期|礼拜)([一二三四五六日天])/;
  const wm = weekdayRe.exec(text);
  if (wm) {
    const isNextWeek = Boolean(wm[1]);
    const weekday = WEEKDAY_MAP[wm[3]];
    if (weekday !== undefined) {
      return { token: wm[0], index: wm.index, date: nextWeekday(now, weekday, isNextWeek) };
    }
  }

  // N月N日 / N月N号
  const monthDayRe = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/;
  const mm = monthDayRe.exec(text);
  if (mm) {
    const month = parseInt(mm[1], 10);
    const day = parseInt(mm[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let d = new Date(now.getFullYear(), month - 1, day);
      // 已过去的日期视为明年
      if (formatLocalDate(d) < formatLocalDate(now)) {
        d = new Date(now.getFullYear() + 1, month - 1, day);
      }
      return { token: mm[0], index: mm.index, date: d };
    }
  }

  // N号 / N日（无月份 → 本月或下月最近的）
  const dayRe = /(?:^|[\s,，])(\d{1,2})\s*[号日](?=$|[\s,，])/;
  const dm = dayRe.exec(text);
  if (dm) {
    const day = parseInt(dm[1], 10);
    if (day >= 1 && day <= 31) {
      let d = new Date(now.getFullYear(), now.getMonth(), day);
      if (formatLocalDate(d) < formatLocalDate(now)) {
        d = new Date(now.getFullYear(), now.getMonth() + 1, day);
      }
      // token 不含前导分隔符
      const tokenStart = text.indexOf(dm[1], dm.index);
      const fullToken = text.slice(tokenStart).match(/^\d{1,2}\s*[号日]/)?.[0] ?? dm[0].trim();
      return { token: fullToken, index: tokenStart, date: d };
    }
  }

  return null;
}

interface PriorityMatch {
  token: string;
  priority: TodoPriority;
}

function matchPriority(text: string): PriorityMatch | null {
  const re = /[!！](紧急|高|中|低|urgent|high|medium|low)/i;
  const m = re.exec(text);
  if (!m) return null;
  return { token: m[0], priority: PRIORITY_MAP[m[1].toLowerCase()] };
}

interface RepeatMatch {
  token: string;
  rule: TodoRepeatRule;
  /** 「每周X」携带的锚定星期（0=周日），据此预填到期日 */
  anchorWeekday?: number;
}

/**
 * 重复 token 匹配。「每周X」优先于「每周」，「每个工作日」优先于「每」前缀族，
 * 避免部分匹配吃掉更长的 token。
 */
function matchRepeat(text: string): RepeatMatch | null {
  const lower = text.toLowerCase();

  const weekdaysRe = /每\s*个?\s*工作日/;
  const wm = weekdaysRe.exec(text);
  if (wm) {
    return { token: wm[0], rule: { freq: 'weekdays', interval: 1 } };
  }

  // 每周一三五 / 每周一、三、五（多选星期，2 个及以上）
  const multiWeekdayRe = /每\s*(?:周|星期|礼拜)((?:[一二三四五六日天][、，,\s]*){2,})/;
  const mwm = multiWeekdayRe.exec(text);
  if (mwm) {
    const dayChars = mwm[1].match(/[一二三四五六日天]/g) ?? [];
    const byWeekday = [...new Set(
      dayChars
        .map((c) => WEEKDAY_MAP[c])
        .filter((d): d is number => d !== undefined),
    )].sort((a, b) => a - b);
    if (byWeekday.length >= 2) {
      // token 去掉尾部多余分隔符
      const token = mwm[0].replace(/[、，,\s]+$/, '');
      return {
        token,
        rule: { freq: 'weekly', interval: 1, byWeekday },
        anchorWeekday: byWeekday[0],
      };
    }
  }

  // 每周X / 每星期X / 每礼拜X（锚定到具体星期）
  const weeklyAnchorRe = /每\s*(?:周|星期|礼拜)([一二三四五六日天])/;
  const wam = weeklyAnchorRe.exec(text);
  if (wam) {
    const weekday = WEEKDAY_MAP[wam[1]];
    if (weekday !== undefined) {
      return { token: wam[0], rule: { freq: 'weekly', interval: 1 }, anchorWeekday: weekday };
    }
  }

  const zhSimple: Array<[RegExp, TodoRepeatRule['freq']]> = [
    [/每\s*(?:天|日)/, 'daily'],
    [/每\s*(?:周|星期|礼拜)/, 'weekly'],
    [/每\s*个?\s*月/, 'monthly'],
    [/每\s*年/, 'yearly'],
  ];
  for (const [re, freq] of zhSimple) {
    const m = re.exec(text);
    if (m) return { token: m[0], rule: { freq, interval: 1 } };
  }

  const enRules: Array<[RegExp, TodoRepeatRule['freq']]> = [
    [/\bevery\s*weekday\b|\bweekdays\b/, 'weekdays'],
    [/\bevery\s*day\b|\bdaily\b/, 'daily'],
    [/\bevery\s*week\b|\bweekly\b/, 'weekly'],
    [/\bevery\s*month\b|\bmonthly\b/, 'monthly'],
    [/\bevery\s*year\b|\byearly\b/, 'yearly'],
  ];
  for (const [re, freq] of enRules) {
    const m = re.exec(lower);
    if (m) {
      return { token: text.slice(m.index, m.index + m[0].length), rule: { freq, interval: 1 } };
    }
  }

  return null;
}

/** 锚定星期对应的最近日期（今天恰为该星期则取今天） */
function nearestWeekday(base: Date, weekday: number): Date {
  const diff = (weekday - base.getDay() + 7) % 7;
  return addDays(base, diff);
}

/** 多个锚定星期中最近的一个（今天命中则取今天） */
function nearestOfWeekdays(base: Date, weekdays: number[]): Date {
  let best: Date | null = null;
  for (const w of weekdays) {
    const candidate = nearestWeekday(base, w);
    if (!best || candidate < best) best = candidate;
  }
  return best ?? base;
}

interface TimeMatch {
  token: string;
  /** HH:MM（24 小时制） */
  time: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 中文时段前缀 → 小时偏移处理 */
function applyZhPeriod(period: string | undefined, hour: number): number {
  if ((period === '下午' || period === '晚上') && hour < 12) return hour + 12;
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

/**
 * 时间 token 匹配（中文优先 + 基础英文）：
 *   HH:MM / H点 / H点半 / H点N分 / 上午|早上|中午|下午|晚上 H点 / 3pm / 3:30am
 * 「下午/晚上」+12 小时；裸「N点」要求词边界（避免「买3点心」误判）且按 24 小时制。
 */
function matchTime(text: string): TimeMatch | null {
  // 带时段前缀：上午/下午/晚上 H点[半|N分]（前缀本身就是强信号，允许任意位置）
  const prefixedRe = /(上午|早上|中午|下午|晚上|凌晨)\s*(\d{1,2})\s*[点时]\s*(半|一刻|三刻|(\d{1,2})\s*分)?/;
  const pm = prefixedRe.exec(text);
  if (pm) {
    let hour = parseInt(pm[2], 10);
    if (hour >= 0 && hour <= 24) {
      const minute = zhMinute(pm[3], pm[4]);
      hour = applyZhPeriod(pm[1], hour);
      if (hour === 24) hour = 0;
      if (hour <= 23) {
        return { token: pm[0].trim(), time: `${pad2(hour)}:${pad2(minute)}` };
      }
    }
  }

  // 裸「N点[半|N分]」：要求前面是行首/空白/分隔符，降低误伤
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
        return { token, time: `${pad2(hour)}:${pad2(minute)}` };
      }
    }
  }

  // HH:MM（可带 am/pm 后缀）。数字:数字本身是强时间信号，
  // 边界额外放行 CJK 紧邻与常见标点（「开会14:30」「14:30提交」）
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
      return { token, time: `${pad2(hour)}:${pad2(minute)}` };
    }
  }

  // 3pm / 11am（同样放行 CJK 紧邻：「3pm开会」）
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
      return { token, time: `${pad2(hour)}:00` };
    }
  }

  return null;
}

interface TagsMatch {
  tokens: string[];
  tags: string[];
}

/** #标签 匹配（#后跟非空白、非#字符；支持中文）。 */
function matchTags(text: string): TagsMatch | null {
  const re = /#([^\s#，,、!！#]+)/g;
  const tokens: string[] = [];
  const tags: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push(m[0]);
    if (!tags.includes(m[1])) tags.push(m[1]);
  }
  if (tags.length === 0) return null;
  return { tokens, tags };
}

/** 剔除 token 并清理多余空白 */
function removeToken(text: string, token: string): string {
  return text.replace(token, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function parseQuickAddInput(input: string, now: Date = new Date()): QuickAddParseResult {
  let title = input;
  let dueDate: string | undefined;
  let dueTime: string | undefined;
  let priority: TodoPriority | undefined;
  let repeat: TodoRepeatRule | undefined;
  let tags: string[] | undefined;
  let dateToken: string | undefined;
  let timeToken: string | undefined;
  let priorityToken: string | undefined;
  let repeatToken: string | undefined;

  // 标签最先剔除（#token 与其他语法无交集，先剥离可简化后续匹配）
  const tmatch = matchTags(title);
  if (tmatch) {
    tags = tmatch.tags;
    for (const token of tmatch.tokens) {
      title = removeToken(title, token);
    }
  }

  const pm = matchPriority(title);
  if (pm) {
    priority = pm.priority;
    priorityToken = pm.token;
    title = removeToken(title, pm.token);
  }

  // 重复 token 先于日期匹配：「每周一」必须整体识别为重复规则，
  // 否则会被日期解析吃掉「周一」只剩下「每」
  const rmatch = matchRepeat(title);
  if (rmatch) {
    repeat = rmatch.rule;
    repeatToken = rmatch.token;
    title = removeToken(title, rmatch.token);
    if (rmatch.rule.byWeekday && rmatch.rule.byWeekday.length > 0) {
      // 多选星期：锚定到最近的选中星期（今天命中则今天）
      dueDate = formatLocalDate(nearestOfWeekdays(now, rmatch.rule.byWeekday));
    } else if (rmatch.anchorWeekday !== undefined) {
      dueDate = formatLocalDate(nearestWeekday(now, rmatch.anchorWeekday));
    }
  }

  const dmatch = matchDate(title, now);
  if (dmatch) {
    dueDate = formatLocalDate(dmatch.date);
    dateToken = dmatch.token;
    title = removeToken(title, dmatch.token);
  }

  // 时间在日期之后匹配（「明天3点」先剥日期再剥时间）
  const timeMatch = matchTime(title);
  if (timeMatch) {
    dueTime = timeMatch.time;
    timeToken = timeMatch.token;
    title = removeToken(title, timeMatch.token);
  }

  // 重复任务需要到期日才能滚动生成下一次；无日期时默认从今天开始。
  // 单独出现时间 token（如「3点开会」）时同样默认今天。
  if ((repeat || dueTime) && !dueDate) {
    dueDate = formatLocalDate(now);
  }

  return {
    title: title.trim(),
    dueDate,
    dueTime,
    priority,
    repeat,
    tags,
    dateToken,
    timeToken,
    priorityToken,
    repeatToken,
  };
}
