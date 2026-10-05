/**
 * 到点提醒点通知直达那条待办：通知带 `todo:<id>`，路由处理器据此打开并选中它。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(async (..._args: unknown[]) => true),
  listReminderItems: vi.fn(),
  openTodoItem: vi.fn(async (_itemId: string) => undefined),
  routeHandler: null as null | ((target: string) => void),
}));

vi.mock('@/utils/systemNotification', () => ({ sendSystemNotification: mocks.send }));
vi.mock('@/utils/notificationRouting', () => ({
  initNotificationRouting: (handler: (target: string) => void) => {
    mocks.routeHandler = handler;
    return () => {
      mocks.routeHandler = null;
    };
  },
}));
vi.mock('@/features/learning-today/todayLearning', () => ({
  loadTodayLearning: vi.fn(async () => ({ cards: 0, mistakes: 0, notes: 0, dueNotes: [] })),
}));
vi.mock('@/i18n', () => ({
  default: { t: (key: string, options?: Record<string, unknown>) => (options?.title ? `${key}:${options.title}` : key) },
}));
vi.mock('../api', () => ({
  listReminderItems: (...args: unknown[]) => mocks.listReminderItems(...args),
  listTodayItems: vi.fn(async () => []),
}));
vi.mock('../openTodoItem', () => ({ openTodoItem: mocks.openTodoItem }));

import { initReminderScheduler, stopReminderScheduler } from '../reminderScheduler';

/** 本地时间 YYYY-MM-DDTHH:MM，与后端 reminder 字段同格式 */
function reminderAgo(ms: number): string {
  const d = new Date(Date.now() - ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const HOUR = 3_600_000;

describe('todo reminder notifications', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.send.mockClear();
    mocks.openTodoItem.mockClear();
  });

  afterEach(() => {
    stopReminderScheduler();
  });

  it('tags a due reminder with its todo and opens that todo when the notification is tapped', async () => {
    mocks.listReminderItems.mockResolvedValue([
      { id: 'ti_1', title: '交线代作业', reminder: reminderAgo(60_000), status: 'pending' },
    ]);
    initReminderScheduler();

    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith(
      'todo:reminder.notificationTitle:交线代作业',
      'todo:reminder.notificationBody',
      { force: true, target: 'todo:ti_1' },
    ));

    mocks.routeHandler?.('todo:ti_1');
    await vi.waitFor(() => expect(mocks.openTodoItem).toHaveBeenCalledWith('ti_1'));
  });

  it('points a single missed reminder at its todo but leaves a multi-item digest untargeted', async () => {
    mocks.listReminderItems.mockResolvedValue([
      { id: 'ti_old', title: '旧任务', reminder: reminderAgo(2 * HOUR), status: 'pending' },
    ]);
    initReminderScheduler();
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith(
      'todo:reminder.missedTitle',
      expect.any(String),
      { force: true, target: 'todo:ti_old' },
    ));
    stopReminderScheduler();

    localStorage.clear();
    mocks.send.mockClear();
    mocks.listReminderItems.mockResolvedValue([
      { id: 'ti_a', title: 'A', reminder: reminderAgo(2 * HOUR), status: 'pending' },
      { id: 'ti_b', title: 'B', reminder: reminderAgo(3 * HOUR), status: 'pending' },
    ]);
    initReminderScheduler();
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith(
      'todo:reminder.missedTitle',
      expect.any(String),
      { force: true },
    ));
  });

  it('ignores targets it does not understand', async () => {
    mocks.listReminderItems.mockResolvedValue([]);
    initReminderScheduler();
    mocks.routeHandler?.('todo:');
    mocks.routeHandler?.('something:else');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.openTodoItem).not.toHaveBeenCalled();
  });
});
