/**
 * Todo 快速添加自然语言解析（Todoist 级）
 *
 * 从输入文本中识别日期、时间、优先级、重复规则、提醒、标签、目标清单与预估时长
 * token，返回剔除 token 后的标题。
 * 支持（中文优先 + 常用英文）：
 *   日期：今天 / 明天 / 后天 / 大后天 / N天后 / N周后 / N个月后 / 周一~周日 /
 *         下周一~下周日 / N月N日(号) / N号 / 下(个)月 / 2026-08-01 /
 *         today / tomorrow / monday / next monday / next week /
 *         jul 30 / july 30th / 30 jul / in 3 days / in 2 weeks
 *   时间：HH:MM / N点(半|一刻|三刻|N分) / 上午|下午|晚上N点 / 3pm / 3:30pm
 *   优先级：!紧急 / !高 / !中 / !低（半角或全角叹号）/ p1~p4（Todoist 惯例：p1=urgent p4=low）
 *   重复：每天 / 每周 / 每周X / 每周一三五 / 每N天 / 每月 / 每年 / 每个工作日 /
 *         daily / weekly / every 2 weeks ...
 *   提醒：提醒我 / !remind / remind me（结合解析出的日期时间，输出 YYYY-MM-DDTHH:MM，
 *         无时间 token 时默认 09:00，无日期 token 时默认今天）
 *   标签：#标签名
 *   清单：~清单名 或 @清单名（词首标记；解析器只回传名称，由 UI 按清单标题匹配）
 *   时长：30分钟 / 2小时 / 2个半小时 / 半小时 / 45min / 1h30m / 2h（可带「预计/大约」前缀）
 *
 * 全角容错：全角数字/字母/标点（！＃＠：～０-９ 等）在匹配前归一为半角
 * （逐 UTF-16 码元 1:1 映射，token 位置在原文与归一文本间完全对齐）。
 *
 * 设计原则：token 必须是独立词（避免误伤如「明天气温」中的「明天气」——
 * 「天」后紧跟「气/堂/才…」等强复合字时不视为日期 token），
 * 解析结果在 UI 中以 chip 预览，用户手动设置的字段优先于解析结果。
 *
 * 实现说明：匹配过程不逐段删除文本，而是在等长掩码文本上原位「涂空」已命中
 * 的 token——所有 token 位置（start/end）都是相对原始输入的稳定偏移，
 * 可直接用于输入框内高亮；标题在最后一次性剔除全部命中区间。
 */

import type { TodoPriority, TodoRepeatRule } from './types';

// ============================================================================
// 导出类型
// ============================================================================

export type QuickAddTokenType =
  | 'date'
  | 'time'
  | 'priority'
  | 'repeat'
  | 'reminder'
  | 'tag'
  | 'list'
  | 'duration';

/** 命中的 token 及其在【原始输入】中的位置（[start, end) UTF-16 偏移） */
export interface QuickAddToken {
  type: QuickAddTokenType;
  /** 原文切片（保留用户输入的全角字符） */
  text: string;
  start: number;
  end: number;
}

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
  /** 提醒时间（YYYY-MM-DDTHH:MM，本地时区），由「提醒我 / !remind / remind me」触发 */
  reminder?: string;
  /** 命中的日期 token 原文（用于 UI 回显） */
  dateToken?: string;
  /** 命中的时间 token 原文 */
  timeToken?: string;
  /** 命中的优先级 token 原文 */
  priorityToken?: string;
  /** 命中的重复 token 原文 */
  repeatToken?: string;
  /** 命中的提醒 token 原文 */
  reminderToken?: string;
  /** 目标清单名（~清单 或 @清单，不含前缀；由 UI 按标题匹配到具体清单） */
  listName?: string;
  /** 命中的清单 token 原文（含前缀） */
  listToken?: string;
  /** 预估时长（分钟，由时长语法解析） */
  estimatedMinutes?: number;
  /** 预估番茄数（estimatedMinutes / 25 四舍五入，至少 1；供 estimatedPomodoros 预填） */
  estimatedPomodoros?: number;
  /** 命中的时长 token 原文 */
  durationToken?: string;
  /** 全部命中 token（含位置信息，按 start 升序；供输入框高亮） */
  tokens: QuickAddToken[];
}

// ============================================================================
// 全角 → 半角归一（逐 UTF-16 码元 1:1 映射，位置完全对齐）
// ============================================================================

function normalizeFullWidth(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === 0x3000) {
      out += ' '; // 全角空格
    } else if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0); // ！＃＠：～０-９Ａ-Ｚａ-ｚ 等
    } else {
      out += input[i];
    }
  }
  return out;
}

/**
 * 全角 → 半角归一（2026-07-20 遗留补齐轮导出）：逐 UTF-16 码元 1:1 映射，
 * 输出长度与输入完全一致，token 位置在原文与归一文本间完全对齐。
 * 供 UI（TodoQuickAdd 等）与解析器共用同一口径，避免各自复制实现。
 */
export function normalizeQuickAddInput(text: string): string {
  return normalizeFullWidth(text);
}

// ============================================================================
// 通用工具
// ============================================================================

const WEEKDAY_MAP: Record<string, number> = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0,
};

const EN_WEEKDAY_MAP: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tues: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thurs: 4, thur: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const EN_MONTH_MAP: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const EN_MONTH_RE_PART =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

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

const ZH_NUM_MAP: Record<string, number> = {
  '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
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

/** 加 N 个月，日期超过目标月天数时收敛到月末 */
function addMonthsClamped(d: Date, n: number): Date {
  const targetMonth = d.getMonth() + n;
  const lastDay = new Date(d.getFullYear(), targetMonth + 1, 0).getDate();
  return new Date(d.getFullYear(), targetMonth, Math.min(d.getDate(), lastDay));
}

/** 构造并校验真实日历日（拒绝 2月30日 这类溢出翻滚），非法返回 null */
function makeValidDate(year: number, monthIndex: number, day: number): Date | null {
  const d = new Date(year, monthIndex, day);
  return d.getFullYear() === year && d.getMonth() === monthIndex && d.getDate() === day
    ? d
    : null;
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

// ============================================================================
// 掩码文本：命中的 token 原位涂空，位置保持稳定
// ============================================================================

interface Span {
  start: number;
  end: number;
}

/** 把 [start, end) 区间替换为等长空格（后续匹配不会再命中，位置不漂移） */
function maskSpan(text: string, span: Span): string {
  return text.slice(0, span.start) + ' '.repeat(span.end - span.start) + text.slice(span.end);
}

/** 收缩区间两端的分隔符（正则以 [\s,，、] 起界时，token 文本/位置不含前导分隔符） */
function trimSpan(text: string, start: number, end: number): Span {
  let s = start;
  let e = end;
  while (s < e && /[\s,，、]/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return { start: s, end: e };
}

// ============================================================================
// 日期匹配
// ============================================================================

interface DateMatch extends Span {
  date: Date;
}

/**
 * 「天」后紧跟这些字时大概率是「天气/天堂/天才…」等复合词而非日期结尾，
 * 该处不视为日期 token（如「明天气温」「今天使用」），继续向后找下一处出现。
 * （「涯/津/安」对应天涯、天津、天安门；不收「花/亮」等常作动词起始的字，
 * 避免误伤「明天花时间…」这类正常输入）
 */
const ZH_TIAN_COMPOUND_NEXT = '气堂才使赋空线真鹅桥籁涯津安';

/** 中文相对日 token 的保守查找：跳过被复合词吞掉的出现位置，找不到返回 -1 */
function findZhRelativeToken(text: string, token: string): number {
  let from = 0;
  while (from <= text.length - token.length) {
    const idx = text.indexOf(token, from);
    if (idx === -1) return -1;
    const next = text[idx + token.length];
    if (!token.endsWith('天') || !next || !ZH_TIAN_COMPOUND_NEXT.includes(next)) {
      return idx;
    }
    from = idx + 1;
  }
  return -1;
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
    // ★ 英文 token 要求词边界：避免 "tomorrowland"/"uptoday" 等单词被误吞；
    //   中文 token 用复合词黑名单保守匹配：避免「明天气温」被剥成「气温」
    const isAsciiToken = /^[a-z]+$/.test(token);
    let idx = -1;
    if (isAsciiToken) {
      const wordRe = new RegExp(`\\b${token}\\b`, 'i');
      idx = wordRe.exec(text)?.index ?? -1;
    } else {
      idx = findZhRelativeToken(text, token);
    }
    if (idx !== -1) {
      return { start: idx, end: idx + token.length, date: addDays(now, offset) };
    }
  }

  // ISO 日期：2026-08-01（无歧义强信号；校验为真实日历日，拒绝 2026-13-40）
  const isoRe = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/;
  const iso = isoRe.exec(text);
  if (iso) {
    const d = makeValidDate(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
    if (d) {
      return { start: iso.index, end: iso.index + iso[0].length, date: d };
    }
  }

  // N天后 / N周后 / N个月后（含「之后/以后」，支持阿拉伯数字与一~十/两）
  // 「后」须紧跟单位（或经由「之/以」），避免「5日 后续处理」这类断句被误判
  const relAfterRe = /(\d{1,3}|[一两二三四五六七八九十])\s*(天|日|个?\s*月|周|星期|礼拜)(?:之|以)?[后後]/;
  const ra = relAfterRe.exec(text);
  if (ra) {
    const n = /^\d+$/.test(ra[1]) ? parseInt(ra[1], 10) : ZH_NUM_MAP[ra[1]];
    const unit = ra[2].replace(/\s/g, '');
    if (n !== undefined && n >= 1) {
      let d: Date;
      if (unit === '天' || unit === '日') d = addDays(now, n);
      else if (unit === '周' || unit === '星期' || unit === '礼拜') d = addDays(now, n * 7);
      else d = addMonthsClamped(now, n); // 月 / 个月
      return { start: ra.index, end: ra.index + ra[0].length, date: d };
    }
  }

  // in N days / in 2 weeks / in 3 months（英文相对偏移）
  const inRe = /\bin\s+(\d{1,3})\s+(day|week|month)s?\b/i;
  const im = inRe.exec(text);
  if (im) {
    const n = parseInt(im[1], 10);
    if (n >= 1) {
      const unit = im[2].toLowerCase();
      const d =
        unit === 'day' ? addDays(now, n) : unit === 'week' ? addDays(now, n * 7) : addMonthsClamped(now, n);
      return { start: im.index, end: im.index + im[0].length, date: d };
    }
  }

  // 下周X / 周X / 星期X / 礼拜X
  const weekdayRe = /(下\s*)?(周|星期|礼拜)([一二三四五六日天])/;
  const wm = weekdayRe.exec(text);
  if (wm) {
    const isNextWeek = Boolean(wm[1]);
    const weekday = WEEKDAY_MAP[wm[3]];
    if (weekday !== undefined) {
      return {
        start: wm.index,
        end: wm.index + wm[0].length,
        date: nextWeekday(now, weekday, isNextWeek),
      };
    }
  }

  // 英文星期：monday / mon / next monday（语义与「周X / 下周X」一致）
  const enWeekdayRe =
    /\b(next\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/i;
  const ewm = enWeekdayRe.exec(text);
  if (ewm) {
    const weekday = EN_WEEKDAY_MAP[ewm[2].toLowerCase()];
    if (weekday !== undefined) {
      return {
        start: ewm.index,
        end: ewm.index + ewm[0].length,
        date: nextWeekday(now, weekday, Boolean(ewm[1])),
      };
    }
  }

  // next week（= 下周一，Todoist 语义）/ 下周（无星期后缀）
  const nextWeekRe = /\bnext\s+week\b/i;
  const nw = nextWeekRe.exec(text);
  if (nw) {
    return {
      start: nw.index,
      end: nw.index + nw[0].length,
      date: nextWeekday(now, 1, true),
    };
  }

  // 下(个)月（无具体日 → 下月同日，月末收敛）；「下个月5号」由后面的 N号 分支
  // 无法整体识别，这里优先整体匹配「下个月N号/日」
  const nextMonthDayRe = /下\s*个?\s*月\s*(\d{1,2})\s*[号日]/;
  const nmd = nextMonthDayRe.exec(text);
  if (nmd) {
    const day = parseInt(nmd[1], 10);
    if (day >= 1 && day <= 31) {
      // ★ 短月收敛：「下个月31号」在下月无 31 日时取下月月末
      // （与 addMonthsClamped 口径一致），而不是漏识别导致
      // 只吃掉「下个月」、把「31号」残留在标题里
      const base = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
      const d = new Date(base.getFullYear(), base.getMonth(), Math.min(day, lastDay));
      return { start: nmd.index, end: nmd.index + nmd[0].length, date: d };
    }
  }
  const nextMonthRe = /下\s*个?\s*月/;
  const nm = nextMonthRe.exec(text);
  if (nm) {
    return { start: nm.index, end: nm.index + nm[0].length, date: addMonthsClamped(now, 1) };
  }

  // N月N日 / N月N号（★ 校验真实日历日：2月30日 不再翻滚成 3月2日；
  // 今年已过或今年无此日（2月29）→ 顺延到最近的有效年份，最多看 4 年）
  const monthDayRe = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/;
  const mm = monthDayRe.exec(text);
  if (mm) {
    const month = parseInt(mm[1], 10);
    const day = parseInt(mm[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const today = formatLocalDate(now);
      for (let y = now.getFullYear(); y <= now.getFullYear() + 4; y++) {
        const d = makeValidDate(y, month - 1, day);
        if (d && formatLocalDate(d) >= today) {
          return { start: mm.index, end: mm.index + mm[0].length, date: d };
        }
      }
      // 该月日在未来 4 年内都不存在（理论上只可能是非法组合），不视为日期
    }
  }

  // 英文月日：jul 30 / july 30th / 30 jul / 30th of july
  const enMonthDayRe = new RegExp(`\\b${EN_MONTH_RE_PART}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i');
  const enDayMonthRe = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${EN_MONTH_RE_PART}\\b`,
    'i',
  );
  for (const [re, monthGroup, dayGroup] of [
    [enMonthDayRe, 1, 2],
    [enDayMonthRe, 2, 1],
  ] as const) {
    const em = re.exec(text);
    if (em) {
      const month = EN_MONTH_MAP[em[monthGroup].toLowerCase()];
      const day = parseInt(em[dayGroup], 10);
      if (month && day >= 1 && day <= 31) {
        const today = formatLocalDate(now);
        for (let y = now.getFullYear(); y <= now.getFullYear() + 4; y++) {
          const d = makeValidDate(y, month - 1, day);
          if (d && formatLocalDate(d) >= today) {
            return { start: em.index, end: em.index + em[0].length, date: d };
          }
        }
      }
    }
  }

  // N号 / N日（无月份 → 本月或往后最近的有效月份；
  // ★ 修复：此前「2月10日输入 30号」会翻滚成 3月2日，现在逐月找真实存在的日）
  const dayRe = /(?:^|[\s,，])(\d{1,2})\s*[号日](?=$|[\s,，])/;
  const dm = dayRe.exec(text);
  if (dm) {
    const day = parseInt(dm[1], 10);
    if (day >= 1 && day <= 31) {
      const today = formatLocalDate(now);
      for (let offset = 0; offset <= 12; offset++) {
        const base = new Date(now.getFullYear(), now.getMonth() + offset, 1);
        const d = makeValidDate(base.getFullYear(), base.getMonth(), day);
        if (d && formatLocalDate(d) >= today) {
          const span = trimSpan(text, dm.index, dm.index + dm[0].length);
          return { ...span, date: d };
        }
      }
    }
  }

  return null;
}

// ============================================================================
// 优先级匹配
// ============================================================================

interface PriorityMatch extends Span {
  priority: TodoPriority;
}

/** Todoist 惯例：p1 最高 → p4 最低 */
const P_LEVEL_MAP: Record<string, TodoPriority> = {
  '1': 'urgent',
  '2': 'high',
  '3': 'medium',
  '4': 'low',
};

function matchPriority(text: string): PriorityMatch | null {
  const re = /[!！](紧急|高|中|低|urgent|high|medium|low)/i;
  const m = re.exec(text);
  if (m) {
    return {
      start: m.index,
      end: m.index + m[0].length,
      priority: PRIORITY_MAP[m[1].toLowerCase()],
    };
  }

  // p1~p4（词边界：不吞 "mp3"/"p10" 等；CJK 紧邻天然有边界，「交作业p1」可识别）
  const pRe = /\b[pP]([1-4])\b/;
  const pMatch = pRe.exec(text);
  if (pMatch) {
    return {
      start: pMatch.index,
      end: pMatch.index + pMatch[0].length,
      priority: P_LEVEL_MAP[pMatch[1]],
    };
  }

  return null;
}

// ============================================================================
// 提醒标记匹配
// ============================================================================

/**
 * 提醒标记匹配（保守设计，避免误伤普通标题里的「提醒」二字）：
 *   中文：提醒我（必须带「我」）
 *   英文：!remind / ！remind 前缀，或独立的 "remind me"
 * 具体提醒时刻由解析出的日期/时间组合而成（见 parseQuickAddInput 尾部）。
 */
function matchReminder(text: string): Span | null {
  const zh = /提醒我/.exec(text);
  if (zh) return { start: zh.index, end: zh.index + zh[0].length };
  const en = /[!！]remind\b|\bremind\s+me\b/i.exec(text);
  if (en) return { start: en.index, end: en.index + en[0].length };
  return null;
}

// ============================================================================
// 重复规则匹配
// ============================================================================

interface RepeatMatch extends Span {
  rule: TodoRepeatRule;
  /** 「每周X」携带的锚定星期（0=周日），据此预填到期日 */
  anchorWeekday?: number;
}

/**
 * 重复 token 匹配。「每周X」优先于「每周」，「每个工作日」优先于「每」前缀族，
 * 避免部分匹配吃掉更长的 token。
 */
function matchRepeat(text: string): RepeatMatch | null {
  const weekdaysRe = /每\s*个?\s*工作日/;
  const wm = weekdaysRe.exec(text);
  if (wm) {
    return {
      start: wm.index,
      end: wm.index + wm[0].length,
      rule: { freq: 'weekdays', interval: 1 },
    };
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
      const fullLen = mwm[0].replace(/[、，,\s]+$/, '').length;
      return {
        start: mwm.index,
        end: mwm.index + fullLen,
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
      return {
        start: wam.index,
        end: wam.index + wam[0].length,
        rule: { freq: 'weekly', interval: 1 },
        anchorWeekday: weekday,
      };
    }
  }

  // 间隔重复：每3天 / 每两周 / 每2个月 / 每3年（数字介于「每」与单位之间，
  // 与下方无间隔的「每天/每周…」天然互斥）
  const zhIntervalRe = /每\s*(\d{1,3}|[一两二三四五六七八九十])\s*(天|日|个?\s*月|周|星期|礼拜|年)/;
  const zim = zhIntervalRe.exec(text);
  if (zim) {
    const n = /^\d+$/.test(zim[1]) ? parseInt(zim[1], 10) : ZH_NUM_MAP[zim[1]];
    const unit = zim[2].replace(/\s/g, '');
    if (n !== undefined && n >= 1) {
      let freq: TodoRepeatRule['freq'] | null = null;
      if (unit === '天' || unit === '日') freq = 'daily';
      else if (unit === '周' || unit === '星期' || unit === '礼拜') freq = 'weekly';
      else if (unit === '月' || unit === '个月') freq = 'monthly';
      else if (unit === '年') freq = 'yearly';
      if (freq) {
        return {
          start: zim.index,
          end: zim.index + zim[0].length,
          rule: { freq, interval: Math.min(999, n) },
        };
      }
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
    if (m) {
      return { start: m.index, end: m.index + m[0].length, rule: { freq, interval: 1 } };
    }
  }

  // every 2 weeks / every 3 days（带间隔的英文重复）。
  // ★ 英文规则统一用 i 标志在原文上匹配——不能在 toLowerCase() 副本上取 index：
  // 个别字符（如 İ）小写后 UTF-16 长度变化，偏移会与原文/掩码文本错位
  const enIntervalRe = /\bevery\s+(\d{1,3})\s+(day|week|month|year)s?\b/i;
  const eim = enIntervalRe.exec(text);
  if (eim) {
    const n = parseInt(eim[1], 10);
    const EN_FREQ_MAP = { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' } as const;
    if (n >= 1) {
      return {
        start: eim.index,
        end: eim.index + eim[0].length,
        rule: {
          freq: EN_FREQ_MAP[eim[2].toLowerCase() as keyof typeof EN_FREQ_MAP],
          interval: Math.min(999, n),
        },
      };
    }
  }

  const enRules: Array<[RegExp, TodoRepeatRule['freq']]> = [
    [/\bevery\s*weekday\b|\bweekdays\b/i, 'weekdays'],
    [/\bevery\s*day\b|\bdaily\b/i, 'daily'],
    [/\bevery\s*week\b|\bweekly\b/i, 'weekly'],
    [/\bevery\s*month\b|\bmonthly\b/i, 'monthly'],
    [/\bevery\s*year\b|\byearly\b/i, 'yearly'],
  ];
  for (const [re, freq] of enRules) {
    const m = re.exec(text);
    if (m) {
      return { start: m.index, end: m.index + m[0].length, rule: { freq, interval: 1 } };
    }
  }

  return null;
}

// ============================================================================
// 时间匹配
// ============================================================================

interface TimeMatch extends Span {
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
        const span = trimSpan(text, pm.index, pm.index + pm[0].length);
        return { ...span, time: `${pad2(hour)}:${pad2(minute)}` };
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
        const span = trimSpan(text, bm.index, bm.index + bm[0].length);
        return { ...span, time: `${pad2(hour)}:${pad2(minute)}` };
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
      const span = trimSpan(text, cm.index, cm.index + cm[0].length);
      return { ...span, time: `${pad2(hour)}:${pad2(minute)}` };
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
      const span = trimSpan(text, am.index, am.index + am[0].length);
      return { ...span, time: `${pad2(hour)}:00` };
    }
  }

  return null;
}

// ============================================================================
// 标签匹配
// ============================================================================

interface TagsMatch {
  spans: Span[];
  tags: string[];
}

/** #标签 匹配（#后跟非空白、非#字符；支持中文）。 */
function matchTags(text: string): TagsMatch | null {
  const re = /#([^\s#，,、!！#]+)/g;
  const spans: Span[] = [];
  const tags: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
    if (!tags.includes(m[1])) tags.push(m[1]);
  }
  if (tags.length === 0) return null;
  return { spans, tags };
}

// ============================================================================
// 清单匹配（~清单名 / @清单名）
// ============================================================================

interface ListMatch extends Span {
  /** 清单名（不含 ~/@ 前缀；原文形态，UI 按标题匹配） */
  name: string;
}

/**
 * 目标清单标记：词首的 ~名称 或 @名称（前面必须是行首/空白/分隔符）。
 * 保守排除：名称不允许以 / 开头（路径 ~/dir）、不允许以数字开头
 * （时长速记 ~30min、~2h 留给时长解析）；邮箱 a@b.com 因 @ 前有字符不会命中。
 */
function matchList(text: string): ListMatch | null {
  const re = /(?:^|[\s,，、])([~@])([^\s#@~，,、!！/0-9][^\s#@~，,、!！]*)/;
  const m = re.exec(text);
  if (!m) return null;
  const markerStart = m.index + m[0].indexOf(m[1]);
  return {
    start: markerStart,
    end: m.index + m[0].length,
    name: m[2],
  };
}

// ============================================================================
// 时长匹配（→ 预估分钟数 / 番茄数）
// ============================================================================

interface DurationMatch extends Span {
  minutes: number;
}

/** 每个番茄的名义时长（分钟），用于 estimatedPomodoros 换算 */
const POMODORO_MINUTES = 25;

/**
 * 预估时长语法（在日期/时间剥离之后匹配，「3点30分」不会被误认时长）：
 *   中文：30分钟 / 2小时 / 2小时30分钟 / 2个半小时 / 半小时（可带「预计/大约/大概/需要」前缀）
 *   英文：45min / 45 mins / 1h / 2hrs / 1h30m / 1.5h（h 允许小数一位）
 */
function matchDuration(text: string): DurationMatch | null {
  const boundary = '(?:^|[\\s,，、~～]|(?<=[\\u4e00-\\u9fff]))';
  const prefix = '(?:预计|大约|大概|需要|需时|用时)?\\s*';

  // N个半小时（2个半小时 = 150 分钟）
  const halfRe = new RegExp(`${boundary}${prefix}(\\d{1,2})\\s*个半\\s*小时`);
  const hm = halfRe.exec(text);
  if (hm) {
    const n = parseInt(hm[1], 10);
    if (n >= 1) {
      const span = trimSpan(text, hm.index, hm.index + hm[0].length);
      return { ...span, minutes: n * 60 + 30 };
    }
  }

  // 半小时 / 半个小时
  const halfHourRe = new RegExp(`${boundary}${prefix}半\\s*个?\\s*小时`);
  const hh = halfHourRe.exec(text);
  if (hh) {
    const span = trimSpan(text, hh.index, hh.index + hh[0].length);
    return { ...span, minutes: 30 };
  }

  // N小时[N分钟] / N.5小时
  const zhHourRe = new RegExp(
    `${boundary}${prefix}(\\d{1,2}(?:\\.\\d)?)\\s*个?\\s*小时\\s*(?:(\\d{1,2})\\s*分钟?)?`,
  );
  const zh = zhHourRe.exec(text);
  if (zh) {
    const hours = parseFloat(zh[1]);
    const extra = zh[2] ? parseInt(zh[2], 10) : 0;
    if (hours > 0 || extra > 0) {
      const span = trimSpan(text, zh.index, zh.index + zh[0].length);
      return { ...span, minutes: Math.round(hours * 60) + extra };
    }
  }

  // N分钟
  const zhMinRe = new RegExp(`${boundary}${prefix}(\\d{1,3})\\s*分钟`);
  const zm = zhMinRe.exec(text);
  if (zm) {
    const n = parseInt(zm[1], 10);
    if (n >= 1) {
      const span = trimSpan(text, zm.index, zm.index + zm[0].length);
      return { ...span, minutes: n };
    }
  }

  // 1h30m / 2h / 1.5h / 2hrs / 2 hours（h 后可跟分钟段）
  const enHourRe =
    /(?:^|[\s,，、~～]|(?<=[\u4e00-\u9fff]))(\d{1,2}(?:\.\d)?)\s*h(?:rs?|ours?)?\s*(?:(\d{1,2})\s*m(?:ins?|inutes?)?)?(?=$|[\s,，.;!?。；！？、]|[\u4e00-\u9fff])/i;
  const eh = enHourRe.exec(text);
  if (eh) {
    const hours = parseFloat(eh[1]);
    const extra = eh[2] ? parseInt(eh[2], 10) : 0;
    if (hours > 0 || extra > 0) {
      const span = trimSpan(text, eh.index, eh.index + eh[0].length);
      return { ...span, minutes: Math.round(hours * 60) + extra };
    }
  }

  // 45min / 45 mins / 45 minutes
  const enMinRe =
    /(?:^|[\s,，、~～]|(?<=[\u4e00-\u9fff]))(\d{1,3})\s*m(?:ins?|inutes?)\b/i;
  const em = enMinRe.exec(text);
  if (em) {
    const n = parseInt(em[1], 10);
    if (n >= 1) {
      const span = trimSpan(text, em.index, em.index + em[0].length);
      return { ...span, minutes: n };
    }
  }

  return null;
}

// ============================================================================
// 主入口
// ============================================================================

export function parseQuickAddInput(input: string, now: Date = new Date()): QuickAddParseResult {
  // 归一副本用于匹配；token 文本从原始输入按同一偏移切片（1:1 映射位置对齐）
  let work = normalizeFullWidth(input);

  let dueDate: string | undefined;
  let dueTime: string | undefined;
  let priority: TodoPriority | undefined;
  let repeat: TodoRepeatRule | undefined;
  let tags: string[] | undefined;
  let reminder: string | undefined;
  let listName: string | undefined;
  let estimatedMinutes: number | undefined;

  const tokens: QuickAddToken[] = [];
  const consumed: Span[] = [];

  const consume = (type: QuickAddTokenType, span: Span): string => {
    const text = input.slice(span.start, span.end);
    tokens.push({ type, text, start: span.start, end: span.end });
    consumed.push(span);
    work = maskSpan(work, span);
    return text;
  };

  // 标签最先剔除（#token 与其他语法无交集，先剥离可简化后续匹配）
  const tmatch = matchTags(work);
  if (tmatch) {
    tags = tmatch.tags;
    for (const span of tmatch.spans) {
      consume('tag', span);
    }
  }

  // 清单标记（~/@ 前缀，与日期/时间语法无交集）
  const lmatch = matchList(work);
  let listToken: string | undefined;
  if (lmatch) {
    listName = lmatch.name;
    listToken = consume('list', lmatch);
  }

  // 提醒标记先于日期/时间剥离（「明天3点提醒我交作业」——标记本身不携带时刻，
  // 提醒时刻在日期/时间解析完成后组合）
  const remMatch = matchReminder(work);
  let reminderToken: string | undefined;
  if (remMatch) {
    reminderToken = consume('reminder', remMatch);
  }

  const pm = matchPriority(work);
  let priorityToken: string | undefined;
  if (pm) {
    priority = pm.priority;
    priorityToken = consume('priority', pm);
  }

  // 重复 token 先于日期匹配：「每周一」必须整体识别为重复规则，
  // 否则会被日期解析吃掉「周一」只剩下「每」
  const rmatch = matchRepeat(work);
  let repeatToken: string | undefined;
  if (rmatch) {
    repeat = rmatch.rule;
    repeatToken = consume('repeat', rmatch);
    if (rmatch.rule.byWeekday && rmatch.rule.byWeekday.length > 0) {
      // 多选星期：锚定到最近的选中星期（今天命中则今天）
      dueDate = formatLocalDate(nearestOfWeekdays(now, rmatch.rule.byWeekday));
    } else if (rmatch.anchorWeekday !== undefined) {
      dueDate = formatLocalDate(nearestWeekday(now, rmatch.anchorWeekday));
    }
  }

  const dmatch = matchDate(work, now);
  let dateToken: string | undefined;
  if (dmatch) {
    dueDate = formatLocalDate(dmatch.date);
    dateToken = consume('date', dmatch);
  }

  // 时间在日期之后匹配（「明天3点」先剥日期再剥时间）
  const timeMatch = matchTime(work);
  let timeToken: string | undefined;
  if (timeMatch) {
    dueTime = timeMatch.time;
    timeToken = consume('time', timeMatch);
  }

  // 时长在时间之后匹配（「3点30分」已被时间吃掉，不会误认为 30 分钟时长）
  const durMatch = matchDuration(work);
  let durationToken: string | undefined;
  if (durMatch) {
    estimatedMinutes = durMatch.minutes;
    durationToken = consume('duration', durMatch);
  }

  // 重复任务需要到期日才能滚动生成下一次；无日期时默认从今天开始。
  // 单独出现时间 token（如「3点开会」）时同样默认今天。
  if ((repeat || dueTime) && !dueDate) {
    dueDate = formatLocalDate(now);
  }

  // 提醒时刻 = 解析出的日期 + 时间；无日期默认今天，无时间默认 09:00。
  // 只组合提醒字段，不反向影响 dueDate/dueTime（用户可能只想要提醒不设到期日）
  if (reminderToken) {
    reminder = `${dueDate ?? formatLocalDate(now)}T${dueTime ?? '09:00'}`;
  }

  // 标题 = 原始输入剔除全部命中区间后清理空白。
  // ★ 先合并重叠区间再裁剪：后匹配的 token 可经 \s* 跨过先前涂空的区域
  // （如「3点 #tag 半」的时间区间包住已消费的标签区间）；重叠区间若按
  // 原始偏移独立裁剪，后一次裁剪会错位吃掉标题字符
  consumed.sort((a, b) => a.start - b.start);
  const mergedSpans: Span[] = [];
  for (const span of consumed) {
    const last = mergedSpans[mergedSpans.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      mergedSpans.push({ ...span });
    }
  }
  let title = input;
  for (let i = mergedSpans.length - 1; i >= 0; i--) {
    const span = mergedSpans[i];
    title = title.slice(0, span.start) + ' ' + title.slice(span.end);
  }
  title = title.replace(/\s{2,}/g, ' ').trim();

  tokens.sort((a, b) => a.start - b.start);

  return {
    title,
    dueDate,
    dueTime,
    priority,
    repeat,
    tags,
    reminder,
    dateToken,
    timeToken,
    priorityToken,
    repeatToken,
    reminderToken,
    listName,
    listToken,
    estimatedMinutes,
    estimatedPomodoros:
      estimatedMinutes !== undefined
        ? Math.max(1, Math.round(estimatedMinutes / POMODORO_MINUTES))
        : undefined,
    durationToken,
    tokens,
  };
}
