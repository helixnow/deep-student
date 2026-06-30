/**
 * 待办提醒调度器（应用级单例）
 *
 * 轮询后端「设置了提醒的待处理任务」，到点弹系统通知。
 * - reminder 为本地 datetime 字符串（YYYY-MM-DDTHH:MM），`new Date()` 按本地时区解析
 * - 已触发记录持久化到 localStorage，应用重启不重复提醒
 * - 超过宽限期（30 分钟）仍未触发的过期提醒不再补发（避免轰炸）
 * - 非 Tauri 环境 / 通知权限缺失时静默退化
 */

import i18n from '@/i18n';
import { listReminderItems, listTodayItems } from './api';
import type { TodoItem } from './types';

const CHECK_INTERVAL_MS = 30_000;
/** 错过提醒的补发宽限期：应用恢复/启动时，此窗口内的过期提醒仍会补发一次 */
const GRACE_MS = 30 * 60 * 1000;
const FIRED_STORAGE_KEY = 'todo-reminders-fired-v1';
const FIRED_CAP = 300;
/** ★ 3.1 每日到期汇总：记录最近一次汇总的本地日期（YYYY-MM-DD） */
const DAILY_DIGEST_STORAGE_KEY = 'todo-daily-digest-date-v1';
/** 早间汇总从该小时起触发（避免凌晨打扰） */
const DAILY_DIGEST_FROM_HOUR = 7;

let timer: ReturnType<typeof setInterval> | null = null;
let checking = false;

/** 已触发集合：`${itemId}@${reminder}`（同一任务改提醒时间后可再次触发） */
function loadFired(): string[] {
  try {
    const raw = localStorage.getItem(FIRED_STORAGE_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveFired(fired: string[]): void {
  try {
    localStorage.setItem(FIRED_STORAGE_KEY, JSON.stringify(fired.slice(-FIRED_CAP)));
  } catch {
    // localStorage 不可用时降级为内存去重（当次会话仍有效）
  }
}

// ★ 8.1 统一通知策略：到点提醒是用户主动设置的，force 绕过 background 前台拦截
async function sendSystemNotification(title: string, body: string): Promise<void> {
  const { sendSystemNotification: send } = await import('@/utils/systemNotification');
  await send(title, body, { force: true });
}

function reminderBody(item: TodoItem): string {
  if (item.dueDate) {
    const due = item.dueTime ? `${item.dueDate} ${item.dueTime}` : item.dueDate;
    return i18n.t('todo:reminder.notificationBodyWithDue', { due });
  }
  return i18n.t('todo:reminder.notificationBody');
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
    const dueToday = await listTodayItems(false);
    if (dueToday.length === 0) {
      // 无到期项也记录日期，当天不再查询
      localStorage.setItem(DAILY_DIGEST_STORAGE_KEY, today);
      return;
    }

    const titles = dueToday.slice(0, 3).map((item) => item.title).join('、');
    const body = dueToday.length > 3
      ? i18n.t('todo:dailyDigest.bodyMore', { titles, rest: dueToday.length - 3 })
      : titles;
    const { sendSystemNotification: send } = await import('@/utils/systemNotification');
    await send(
      i18n.t('todo:dailyDigest.title', { count: dueToday.length }),
      body,
      { force: true },
    );
    // 发送尝试完成后才记录日期：查询/发送过程抛错时当天可在下个周期补发
    // （send 自身对权限缺失/策略禁止返回 false 不抛错，不会造成轰炸）
    localStorage.setItem(DAILY_DIGEST_STORAGE_KEY, today);
  } catch (e) {
    console.warn('[TodoReminder] Daily digest failed:', e);
  }
}

async function checkReminders(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    // ★ 3.1 每日到期早间汇总（独立于到点提醒，有自己的每日去重）
    await checkDailyDueDigest(new Date());

    const items = await listReminderItems();
    if (items.length === 0) return;

    const now = Date.now();
    const fired = loadFired();
    const firedSet = new Set(fired);
    let changed = false;

    for (const item of items) {
      if (!item.reminder) continue;
      const key = `${item.id}@${item.reminder}`;
      if (firedSet.has(key)) continue;

      const at = new Date(item.reminder).getTime();
      if (Number.isNaN(at)) continue;
      // 未到点：跳过；过期超出宽限期：标记吞掉（不补发也不再反复检查）
      if (at > now) continue;

      firedSet.add(key);
      fired.push(key);
      changed = true;

      if (now - at <= GRACE_MS) {
        void sendSystemNotification(
          i18n.t('todo:reminder.notificationTitle', { title: item.title }),
          reminderBody(item),
        );
      }
    }

    if (changed) saveFired(fired);
  } catch (e) {
    console.warn('[TodoReminder] Check failed:', e);
  } finally {
    checking = false;
  }
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
  timer = setInterval(() => void checkReminders(), CHECK_INTERVAL_MS);
  document.addEventListener('visibilitychange', onVisibilityChange);
  // 启动即检查一次（补发宽限期内错过的提醒）
  void checkReminders();
  return stopReminderScheduler;
}

export function stopReminderScheduler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  document.removeEventListener('visibilitychange', onVisibilityChange);
}
