/**
 * Todo 快速添加自然语言解析（轻量版）
 *
 * 从输入文本中识别日期与优先级 token，返回剔除 token 后的标题。
 * 支持（中文优先 + 基础英文）：
 *   日期：今天 / 明天 / 后天 / 大后天 / 周一~周日 / 下周一~下周日 /
 *         N月N日(号) / N号 / today / tomorrow
 *   优先级：!紧急 / !高 / !中 / !低（半角或全角叹号）
 *
 * 设计原则：token 必须是独立词（避免误伤如「明天气温」中的「明天气」），
 * 解析结果在 UI 中以 chip 预览，用户手动设置的字段优先于解析结果。
 */

import type { TodoPriority } from './types';

export interface QuickAddParseResult {
  /** 剔除已识别 token 后的标题 */
  title: string;
  /** YYYY-MM-DD（本地时区） */
  dueDate?: string;
  priority?: TodoPriority;
  /** 命中的日期 token 原文（用于 UI 回显） */
  dateToken?: string;
  /** 命中的优先级 token 原文 */
  priorityToken?: string;
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
    const idx = text.toLowerCase().indexOf(token);
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

/** 剔除 token 并清理多余空白 */
function removeToken(text: string, token: string): string {
  return text.replace(token, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function parseQuickAddInput(input: string, now: Date = new Date()): QuickAddParseResult {
  let title = input;
  let dueDate: string | undefined;
  let priority: TodoPriority | undefined;
  let dateToken: string | undefined;
  let priorityToken: string | undefined;

  const pm = matchPriority(title);
  if (pm) {
    priority = pm.priority;
    priorityToken = pm.token;
    title = removeToken(title, pm.token);
  }

  const dmatch = matchDate(title, now);
  if (dmatch) {
    dueDate = formatLocalDate(dmatch.date);
    dateToken = dmatch.token;
    title = removeToken(title, dmatch.token);
  }

  return { title: title.trim(), dueDate, priority, dateToken, priorityToken };
}
