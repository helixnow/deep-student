/**
 * 待办提醒调度器（应用级单例）
 *
 * 轮询后端「设置了提醒的待处理任务」，到点弹系统通知。
 * - reminder 为本地 datetime 字符串（YYYY-MM-DDTHH:MM），`new Date()` 按本地时区解析
 * - 已触发记录持久化到 localStorage，应用重启不重复提醒
 * - 宽限期（30 分钟）内的过期提醒逐条补发；超出宽限期的错过提醒聚合成一条
 *   「你错过了 N 条提醒」的汇总通知一次性补发（不再静默吞掉，也不轰炸）
 * - 30s 轮询之外，对最近的下一条提醒设置精确 setTimeout（clamp 30 分钟），提醒准点触发
 * - 通过 tick 时间跳变检测睡眠恢复 / 系统节流恢复，恢复后立即检查并重算精确定时器
 * - 每日 7 点后第一次检查时发送今日到期任务汇总
 * - 非 Tauri 环境 / 通知权限缺失时静默退化
 */

import i18n from '@/i18n';
import { listReminderItems, listTodayItems } from './api';
import type { TodoItem } from './types';

const CHECK_INTERVAL_MS = 30_000;
/** 到点提醒的即时窗口：此窗口内的过期提醒按普通到点提醒逐条发送 */
const GRACE_MS = 30 * 60 * 1000;
const FIRED_STORAGE_KEY = 'todo-reminders-fired-v1';
/** fired 记录按触发时间保留 30 天，过期清理；容量上限仅作兜底 */
const FIRED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const FIRED_CAP = 1000;
/** ★ 3.1 每日到期汇总：记录最近一次汇总的本地日期（YYYY-MM-DD） */
const DAILY_DIGEST_STORAGE_KEY = 'todo-daily-digest-date-v1';
/** 早间汇总从该小时起触发（避免凌晨打扰） */
const DAILY_DIGEST_FROM_HOUR = 7;
/** 精确定时器 clamp 上限：更远的提醒到点后重算（也天然覆盖睡眠期间的漂移） */
const EXACT_TIMER_MAX_MS = 30 * 60 * 1000;
/** 精确定时器附加缓冲：确保触发时提醒时间确实已过 */
const EXACT_TIMER_SLACK_MS = 500;
/** tick 间隔超过该阈值视为睡眠恢复 / 系统节流恢复 */
const WAKE_GAP_MS = CHECK_INTERVAL_MS * 2;
/** 汇总类通知正文最多列出的任务标题数 */
const DIGEST_TITLES_MAX = 3;

/** 单条通知发送失败的重试上限：达到后视为已处理（防风暴） */
const SEND_MAX_ATTEMPTS = 3;
/** 数据变更触发的即时校准合并窗口 */
const DATA_CHANGED_DEBOUNCE_MS = 300;

let timer: ReturnType<typeof setInterval> | null = null;
let exactTimer: ReturnType<typeof setTimeout> | null = null;
let dataChangedTimer: ReturnType<typeof setTimeout> | null = null;
let checking = false;
/** 检查进行中又有触发请求（精确定时器到点/数据变更）：结束后立即补跑一次 */
let recheckRequested = false;
let lastTickAt = 0;
/** 非法 reminder 值只 warn 一次，避免每 30s 刷日志 */
const warnedInvalidReminders = new Set<string>();
/** 发送失败重试计数（内存级；成功或达上限后写入 fired 并清除） */
const sendAttempts = new Map<string, number>();

// ============================================================================
// 已触发记录（localStorage，键结构向后兼容）
// ============================================================================

/**
 * 已触发映射：`${itemId}@${reminder}` → 触发时间戳（ms）。
 * 同一任务改提醒时间后 key 变化，可再次触发。
 *
 * 存储格式 v2：`{ "v": 2, "entries": { key: firedAt } }`。
 * 兼容旧格式 v1（string[]）：读到数组时迁移，firedAt 记为迁移时刻。
 */
function loadFired(): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const raw = localStorage.getItem(FIRED_STORAGE_KEY);
    if (!raw) return map;
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      // v1 迁移：旧记录已处理过，firedAt 记为当前时间，避免迁移后立即被过期清理再补发
      const migratedAt = Date.now();
      for (const entry of parsed) {
        if (typeof entry === 'string') map.set(entry, migratedAt);
      }
    } else if (parsed && typeof parsed === 'object') {
      const entries = (parsed as { entries?: unknown }).entries;
      if (entries && typeof entries === 'object') {
        for (const [key, at] of Object.entries(entries as Record<string, unknown>)) {
          if (typeof at === 'number' && Number.isFinite(at)) map.set(key, at);
        }
      }
    }
  } catch {
    // 解析失败时视为无记录（当次会话内存去重仍有效）
  }
  return map;
}

function saveFired(fired: Map<string, number>): void {
  const now = Date.now();
  let entries = [...fired].filter(([, at]) => now - at <= FIRED_RETENTION_MS);
  if (entries.length > FIRED_CAP) {
    entries.sort((a, b) => a[1] - b[1]);
    entries = entries.slice(-FIRED_CAP);
  }
  try {
    localStorage.setItem(
      FIRED_STORAGE_KEY,
      JSON.stringify({ v: 2, entries: Object.fromEntries(entries) }),
    );
  } catch {
    // localStorage 不可用时降级为内存去重（当次会话仍有效）
  }
}

// ============================================================================
// 通知发送
// ============================================================================

// ★ 8.1 统一通知策略：到点提醒是用户主动设置的，force 绕过 background 前台拦截。
// 返回是否实际发出（策略拦截/权限缺失/非 Tauri 环境返回 false）
async function sendSystemNotification(title: string, body: string): Promise<boolean> {
  const { sendSystemNotification: send } = await import('@/utils/systemNotification');
  return await send(title, body, { force: true });
}

function reminderBody(item: TodoItem): string {
  if (item.dueDate) {
    const due = item.dueTime ? `${item.dueDate} ${item.dueTime}` : item.dueDate;
    return i18n.t('todo:reminder.notificationBodyWithDue', { due });
  }
  return i18n.t('todo:reminder.notificationBody');
}

/** 汇总通知正文：最多列 3 个标题，超出部分折叠为「另有 N 条」 */
function digestBody(items: TodoItem[], moreKey: string): string {
  const titles = items
    .slice(0, DIGEST_TITLES_MAX)
    .map((item) => item.title)
    .join(i18n.t('todo:reminder.titleJoin'));
  return items.length > DIGEST_TITLES_MAX
    ? i18n.t(moreKey, { titles, rest: items.length - DIGEST_TITLES_MAX })
    : titles;
}

/** 错过提醒聚合补发：启动/唤醒后一次性通知，避免逐条轰炸 */
async function sendMissedDigest(missed: TodoItem[]): Promise<boolean> {
  return await sendSystemNotification(
    i18n.t('todo:reminder.missedTitle', { count: missed.length }),
    digestBody(missed, 'todo:reminder.missedBodyMore'),
  );
}

/**
 * reminder（YYYY-MM-DDTHH:MM[:SS]）→ 本地时间戳。
 * 不用 `new Date(string)`——无时区后缀的 ISO 字符串在不同引擎/格式下
 * 可能按 UTC 解析，手动拆字段构造本地 Date；溢出值（13 月、40 日等）判为非法。
 */
function parseLocalReminder(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) return NaN;
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  const d = new Date(
    parseInt(m[1], 10),
    month - 1,
    day,
    hour,
    minute,
    m[6] ? parseInt(m[6], 10) : 0,
  );
  if (
    d.getMonth() !== month - 1 ||
    d.getDate() !== day ||
    d.getHours() !== hour ||
    d.getMinutes() !== minute
  ) {
    return NaN;
  }
  return d.getTime();
}

/**
 * 发送结果结算：成功→写入 fired；失败→累计重试，达上限后也写入 fired 防风暴。
 * 返回 fired 是否发生变化。
 */
function settleSendResult(fired: Map<string, number>, key: string, sentOk: boolean, now: number): boolean {
  if (sentOk) {
    sendAttempts.delete(key);
    fired.set(key, now);
    return true;
  }
  const attempts = (sendAttempts.get(key) ?? 0) + 1;
  if (attempts >= SEND_MAX_ATTEMPTS) {
    sendAttempts.delete(key);
    fired.set(key, now);
    return true;
  }
  sendAttempts.set(key, attempts);
  return false;
}

function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * ★ 3.1 每日到期早间汇总：每天 7 点后第一次检查时，如有今日到期任务发一条汇总通知。
 * 与到点提醒互补：没设提醒时间但有截止日期的任务也能被感知。
 */
async function checkDailyDueDigest(now: Date): Promise<void> {
  if (now.getHours() < DAILY_DIGEST_FROM_HOUR) return;

  const today = localDateString(now);
  try {
    if (localStorage.getItem(DAILY_DIGEST_STORAGE_KEY) === today) return;
  } catch {
    // localStorage 不可用时跳过（避免每 30s 轰炸）
    return;
  }

  try {
    // ★ 口径修复：todo_list_today 的 pending 含逾期（due_date <= today）。
    // 「今日到期汇总」只统计真正今天到期的任务——逾期任务有独立的
    // 启动时逾期汇总通知（useTodoStore.initialize），混入会重复且数目虚高
    const dueToday = (await listTodayItems(false)).filter((item) => item.dueDate === today);
    if (dueToday.length === 0) {
      // 无到期项也记录日期，当天不再查询
      localStorage.setItem(DAILY_DIGEST_STORAGE_KEY, today);
      return;
    }

    await sendSystemNotification(
      i18n.t('todo:dailyDigest.title', { count: dueToday.length }),
      digestBody(dueToday, 'todo:dailyDigest.bodyMore'),
    );
    // 发送尝试完成后才记录日期：查询/发送过程抛错时当天可在下个周期补发
    // （send 自身对权限缺失/策略禁止返回 false 不抛错，不会造成轰炸）
    localStorage.setItem(DAILY_DIGEST_STORAGE_KEY, today);
  } catch (e) {
    console.warn('[TodoReminder] Daily digest failed:', e);
  }
}

// ============================================================================
// 核心检查与调度
// ============================================================================

/**
 * 精确定时器：对下一条最近的提醒设置 setTimeout，让提醒准点触发而不是最多晚 30s。
 * delay clamp 到 30 分钟上限——到点后 checkReminders 会重算下一次。
 */
function scheduleExactTimer(nextAt: number | null): void {
  if (exactTimer !== null) {
    clearTimeout(exactTimer);
    exactTimer = null;
  }
  // 调度器已停止或没有未来提醒时不设定时器
  if (timer === null || nextAt === null) return;
  const delay = Math.min(
    Math.max(nextAt - Date.now(), 0) + EXACT_TIMER_SLACK_MS,
    EXACT_TIMER_MAX_MS,
  );
  exactTimer = setTimeout(() => {
    exactTimer = null;
    void checkReminders();
  }, delay);
}

async function checkReminders(): Promise<void> {
  if (checking) {
    // 检查进行中到点的触发不能丢——本轮可能基于旧数据（如刚改完提醒时间），
    // 记录请求，当前轮结束后立即补跑，避免精确定时器的到点提醒被吞到下个 30s 周期
    recheckRequested = true;
    return;
  }
  checking = true;
  try {
    // ★ 3.1 每日到期早间汇总（独立于到点提醒，有自己的每日去重）
    await checkDailyDueDigest(new Date());

    const items = await listReminderItems();
    const now = Date.now();
    const fired = loadFired();
    const dueNow: Array<{ item: TodoItem; key: string }> = [];
    const missed: Array<{ item: TodoItem; key: string }> = [];
    let nextAt: number | null = null;
    let changed = false;

    for (const item of items) {
      if (!item.reminder) continue;
      const key = `${item.id}@${item.reminder}`;

      const at = parseLocalReminder(item.reminder);
      if (Number.isNaN(at)) {
        // 非法 reminder 值：跳过并 warn 一次（不写入 fired，修复后可正常触发）
        if (!warnedInvalidReminders.has(key)) {
          warnedInvalidReminders.add(key);
          console.warn('[TodoReminder] Invalid reminder value, skipped:', item.id, item.reminder);
        }
        continue;
      }

      if (fired.has(key)) continue;

      if (at > now) {
        // 未到点：参与「下一条最近提醒」的精确定时
        if (nextAt === null || at < nextAt) nextAt = at;
        continue;
      }

      if (now - at <= GRACE_MS) {
        dueNow.push({ item, key });
      } else {
        // 超出宽限期的错过提醒：聚合补发，不再静默吞掉
        missed.push({ item, key });
      }
    }

    // 发送成功才写入 fired（失败下轮重试，同 key 最多 SEND_MAX_ATTEMPTS 次防风暴）
    for (const { item, key } of dueNow) {
      let sentOk = false;
      try {
        sentOk = await sendSystemNotification(
          i18n.t('todo:reminder.notificationTitle', { title: item.title }),
          reminderBody(item),
        );
      } catch {
        sentOk = false;
      }
      if (settleSendResult(fired, key, sentOk, now)) changed = true;
    }

    if (missed.length > 0) {
      let sentOk = false;
      try {
        sentOk = await sendMissedDigest(missed.map((m) => m.item));
      } catch {
        sentOk = false;
      }
      for (const { key } of missed) {
        if (settleSendResult(fired, key, sentOk, now)) changed = true;
      }
    }

    if (changed) saveFired(fired);
    scheduleExactTimer(nextAt);
  } catch (e) {
    console.warn('[TodoReminder] Check failed:', e);
  } finally {
    checking = false;
    if (recheckRequested) {
      recheckRequested = false;
      // 调度器已停止则不补跑
      if (timer !== null) void checkReminders();
    }
  }
}

function onIntervalTick(): void {
  const now = Date.now();
  // 睡眠唤醒感知：tick 间隔明显超过周期视为睡眠/节流恢复，
  // 丢弃可能被冻结的精确定时器（本次 check 结束后按当前时间重算）
  if (lastTickAt > 0 && now - lastTickAt > WAKE_GAP_MS && exactTimer !== null) {
    clearTimeout(exactTimer);
    exactTimer = null;
  }
  lastTickAt = now;
  void checkReminders();
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') {
    void checkReminders();
  }
}

/**
 * 启动提醒调度器（幂等）。返回停止函数。
 * 在应用根组件挂载一次即可，覆盖全应用生命周期。
 */
export function initReminderScheduler(): () => void {
  if (timer !== null) {
    return stopReminderScheduler;
  }
  lastTickAt = Date.now();
  timer = setInterval(onIntervalTick, CHECK_INTERVAL_MS);
  document.addEventListener('visibilitychange', onVisibilityChange);
  // 启动即检查一次（错过的提醒在此聚合补发）
  void checkReminders();
  return stopReminderScheduler;
}

export function stopReminderScheduler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (exactTimer !== null) {
    clearTimeout(exactTimer);
    exactTimer = null;
  }
  if (dataChangedTimer !== null) {
    clearTimeout(dataChangedTimer);
    dataChangedTimer = null;
  }
  document.removeEventListener('visibilitychange', onVisibilityChange);
}

/**
 * 待办数据变更通知：立即触发一次提醒校准（短窗口合并连续变更）。
 * 供 store 在 create/update/toggle/delete 成功后调用；调度器未启动时为 no-op。
 */
export function notifyReminderDataChanged(): void {
  if (timer === null) return;
  if (dataChangedTimer !== null) clearTimeout(dataChangedTimer);
  dataChangedTimer = setTimeout(() => {
    dataChangedTimer = null;
    void checkReminders();
  }, DATA_CHANGED_DEBOUNCE_MS);
}
