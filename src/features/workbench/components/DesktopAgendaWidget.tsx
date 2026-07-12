import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  CaretLeft,
  CaretRight,
  Check,
  Plus,
  WarningCircle,
} from '@phosphor-icons/react';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { TodoItem, TodoList } from '@/features/todo/types';
import { workbenchBus } from '../core/workbenchBus';
import { useWorkbenchGestures } from '../hooks/useWorkbenchGestures';
import {
  completeTodoAgendaItem,
  getTodoAgendaSnapshot,
  subscribeTodoAgenda,
} from '../apps/system/todoAgendaSource';
import './DesktopAgendaWidget.css';

const CALENDAR_DAY_COUNT = 42;
const MAX_AGENDA_ITEMS = 4;
const FALLBACK_COLORS = ['#ef4444', '#0ea5e9', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899'];

export function formatLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addLocalDays(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

function addLocalMonths(date: Date, amount: number): Date {
  const lastDay = new Date(date.getFullYear(), date.getMonth() + amount + 1, 0).getDate();
  return new Date(
    date.getFullYear(),
    date.getMonth() + amount,
    Math.min(date.getDate(), lastDay),
  );
}

export function buildCalendarDays(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = addLocalDays(first, -mondayOffset);
  return Array.from({ length: CALENDAR_DAY_COUNT }, (_, index) => addLocalDays(start, index));
}

function fallbackListColor(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

function listColor(list: TodoList | undefined, listId: string): string {
  return list?.color?.trim() || fallbackListColor(listId);
}

function priorityRank(item: TodoItem): number {
  return { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }[item.priority];
}

function agendaSort(a: TodoItem, b: TodoItem): number {
  if (a.dueTime !== b.dueTime) {
    if (!a.dueTime) return 1;
    if (!b.dueTime) return -1;
    return a.dueTime.localeCompare(b.dueTime);
  }
  return priorityRank(a) - priorityRank(b);
}

export const DesktopAgendaWidget: React.FC = React.memo(() => {
  const { t, i18n } = useTranslation('workbench');
  const snapshot = useSyncExternalStore(
    subscribeTodoAgenda,
    getTodoAgendaSnapshot,
    getTodoAgendaSnapshot,
  );
  const today = useMemo(
    () => new Date(snapshot.updatedAt || Date.now()),
    [snapshot.updatedAt],
  );
  const todayKey = formatLocalDateKey(today);
  const [visibleMonth, setVisibleMonth] = useState(
    () => new Date(today.getFullYear(), today.getMonth(), 1),
  );
  const [selectedKey, setSelectedKey] = useState(todayKey);
  const [completingId, setCompletingId] = useState<string | null>(null);
  const previousTodayKey = useRef(todayKey);
  const widgetRef = useRef<HTMLElement | null>(null);
  const pendingDayFocusRef = useRef<string | null>(null);
  const swipeCommittedRef = useRef(false);

  useEffect(() => {
    const previous = previousTodayKey.current;
    if (previous === todayKey) return;
    setSelectedKey((current) => current === previous ? todayKey : current);
    const previousDate = new Date(`${previous}T00:00:00`);
    setVisibleMonth((current) => (
      current.getFullYear() === previousDate.getFullYear() &&
      current.getMonth() === previousDate.getMonth()
        ? new Date(today.getFullYear(), today.getMonth(), 1)
        : current
    ));
    previousTodayKey.current = todayKey;
  }, [today, todayKey]);

  const locale = i18n.language?.startsWith('zh') ? 'zh-CN' : 'en-US';
  const calendarDays = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);
  const listsById = useMemo(
    () => new Map(snapshot.lists.map((list) => [list.id, list])),
    [snapshot.lists],
  );
  const itemsByDate = useMemo(() => {
    const result = new Map<string, TodoItem[]>();
    for (const item of snapshot.items) {
      if (!item.dueDate) continue;
      const bucket = result.get(item.dueDate) ?? [];
      bucket.push(item);
      result.set(item.dueDate, bucket);
    }
    for (const bucket of result.values()) bucket.sort(agendaSort);
    return result;
  }, [snapshot.items]);

  const selectedItems = itemsByDate.get(selectedKey) ?? [];
  const overdueItems = selectedKey === todayKey
    ? snapshot.items.filter((item) => Boolean(item.dueDate && item.dueDate < todayKey))
    : [];
  const agendaItems = selectedKey === todayKey
    ? [...overdueItems.sort(agendaSort), ...selectedItems].slice(0, MAX_AGENDA_ITEMS)
    : selectedItems.slice(0, MAX_AGENDA_ITEMS);
  const hiddenCount = (selectedKey === todayKey ? overdueItems.length + selectedItems.length : selectedItems.length)
    - agendaItems.length;

  const monthLabel = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
  }).format(visibleMonth);
  const selectedDate = new Date(`${selectedKey}T00:00:00`);
  const selectedLabel = new Intl.DateTimeFormat(locale, {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(selectedDate);
  const weekdayLabels = useMemo(() => {
    const monday = new Date(2024, 0, 1);
    return Array.from({ length: 7 }, (_, index) =>
      new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(addLocalDays(monday, index)),
    );
  }, [locale]);

  const selectDate = useCallback((date: Date, moveFocus = false) => {
    const key = formatLocalDateKey(date);
    setSelectedKey(key);
    setVisibleMonth((current) => (
      current.getFullYear() === date.getFullYear() && current.getMonth() === date.getMonth()
        ? current
        : new Date(date.getFullYear(), date.getMonth(), 1)
    ));
    if (moveFocus) pendingDayFocusRef.current = key;
  }, []);

  useEffect(() => {
    const key = pendingDayFocusRef.current;
    if (!key) return undefined;
    pendingDayFocusRef.current = null;
    const frame = requestAnimationFrame(() => {
      widgetRef.current
        ?.querySelector<HTMLButtonElement>(`.wb-agenda-day[data-date="${key}"]`)
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedKey, visibleMonth]);

  const changeMonth = useCallback((amount: number) => {
    setVisibleMonth((current) => {
      const next = new Date(current.getFullYear(), current.getMonth() + amount, 1);
      const nextKey = next.getFullYear() === today.getFullYear() && next.getMonth() === today.getMonth()
        ? todayKey
        : formatLocalDateKey(next);
      setSelectedKey(nextKey);
      return next;
    });
  }, [today, todayKey]);

  const handleDayKeyDown = useCallback((
    event: React.KeyboardEvent<HTMLButtonElement>,
    day: Date,
  ) => {
    let next: Date | null = null;
    switch (event.key) {
      case 'ArrowLeft': next = addLocalDays(day, -1); break;
      case 'ArrowRight': next = addLocalDays(day, 1); break;
      case 'ArrowUp': next = addLocalDays(day, -7); break;
      case 'ArrowDown': next = addLocalDays(day, 7); break;
      case 'PageUp': next = addLocalMonths(day, -1); break;
      case 'PageDown': next = addLocalMonths(day, 1); break;
      case 'Home': next = today; break;
      default: return;
    }
    event.preventDefault();
    selectDate(next, true);
  }, [selectDate, today]);

  const openTodoView = useCallback(async () => {
    const view = selectedKey < todayKey ? 'overdue' : selectedKey === todayKey ? 'today' : 'upcoming';
    await workbenchBus.activateDetailed({
      typeId: 'todo',
      instanceKey: null,
      action: 'showView',
      payload: { view },
      fallbackLaunch: { typeId: 'todo', reason: 'api' },
    });
  }, [selectedKey, todayKey]);

  const openTodoItem = useCallback(async (item: TodoItem) => {
    await workbenchBus.activateDetailed({
      typeId: 'todo',
      instanceKey: null,
      action: 'showList',
      payload: { listId: item.todoListId },
      fallbackLaunch: {
        typeId: 'todo',
        reason: 'api',
        payload: { todoListId: item.todoListId },
      },
    });
    await workbenchBus.activate({
      typeId: 'todo',
      instanceKey: null,
      action: 'focusItem',
      payload: { itemId: item.id },
    });
  }, []);

  const openQuickAdd = useCallback(async () => {
    await workbenchBus.activateDetailed({
      typeId: 'todo',
      instanceKey: null,
      action: 'quickAdd',
      payload: { dueDate: selectedKey },
      fallbackLaunch: { typeId: 'todo', reason: 'api' },
    });
  }, [selectedKey]);

  const completeItem = useCallback(async (item: TodoItem) => {
    setCompletingId(item.id);
    try {
      await completeTodoAgendaItem(item.id);
    } catch (error) {
      showGlobalNotification(
        'error',
        t('agenda.completeFailed', { defaultValue: '完成任务失败' }),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setCompletingId(null);
    }
  }, [t]);

  useWorkbenchGestures({
    target: widgetRef,
    swipeThreshold: 36,
    preventDefaultSwipe: true,
    onSwipe: (gesture) => {
      if (gesture.phase === 'start') {
        swipeCommittedRef.current = false;
        return;
      }
      if (
        gesture.phase !== 'end' ||
        swipeCommittedRef.current ||
        gesture.axis !== 'x' ||
        Math.abs(gesture.deltaX) < 52
      ) return;
      swipeCommittedRef.current = true;
      changeMonth(gesture.deltaX > 0 ? 1 : -1);
    },
  });

  return (
    <section
      ref={widgetRef}
      className="wb-agenda-widget wb-glass wb-glass-highlight"
      aria-label={t('agenda.label', { defaultValue: '日历与学习日程' })}
      data-testid="wb-agenda-widget"
      onClick={(event) => {
        if (event.target === event.currentTarget) void openTodoView();
      }}
    >
      <header className="wb-agenda-header">
        <button
          type="button"
          className="wb-agenda-month"
          onClick={() => {
            setVisibleMonth(new Date(today.getFullYear(), today.getMonth(), 1));
            setSelectedKey(todayKey);
          }}
          title={t('agenda.backToToday', { defaultValue: '回到今天' })}
        >
          <span className="wb-agenda-month-copy">
            <strong>{monthLabel}</strong>
            <small>{t('agenda.pendingCount', { count: snapshot.items.length, defaultValue: `${snapshot.items.length} 项待安排` })}</small>
          </span>
        </button>
        <div className="wb-agenda-header-actions">
          <button
            type="button"
            className="wb-agenda-icon-button"
            onClick={() => changeMonth(-1)}
            aria-label={t('agenda.previousMonth', { defaultValue: '上个月' })}
            title={t('agenda.previousMonth', { defaultValue: '上个月' })}
          >
            <CaretLeft size={15} weight="bold" />
          </button>
          <button
            type="button"
            className="wb-agenda-icon-button"
            onClick={() => changeMonth(1)}
            aria-label={t('agenda.nextMonth', { defaultValue: '下个月' })}
            title={t('agenda.nextMonth', { defaultValue: '下个月' })}
          >
            <CaretRight size={15} weight="bold" />
          </button>
          <button
            type="button"
            className="wb-agenda-icon-button wb-agenda-add-button"
            onClick={() => void openQuickAdd()}
            aria-label={t('agenda.quickAdd', { defaultValue: '添加日程' })}
            title={t('agenda.quickAdd', { defaultValue: '添加日程' })}
          >
            <Plus size={16} weight="bold" />
          </button>
        </div>
      </header>

      <div className="wb-agenda-calendar" role="grid" aria-label={monthLabel}>
        <div className="wb-agenda-weekdays" role="row">
          {weekdayLabels.map((label, index) => (
            <span key={`${label}-${index}`} role="columnheader">{label}</span>
          ))}
        </div>
        <div className="wb-agenda-days" key={formatLocalDateKey(visibleMonth)}>
          {calendarDays.map((day) => {
            const key = formatLocalDateKey(day);
            const dayItems = itemsByDate.get(key) ?? [];
            const isCurrentMonth = day.getMonth() === visibleMonth.getMonth();
            const isToday = key === todayKey;
            const isSelected = key === selectedKey;
            return (
              <button
                type="button"
                role="gridcell"
                key={key}
                className="wb-agenda-day"
                data-outside={!isCurrentMonth || undefined}
                data-today={isToday || undefined}
                data-selected={isSelected || undefined}
                data-date={key}
                tabIndex={isSelected ? 0 : -1}
                aria-selected={isSelected}
                aria-current={isToday ? 'date' : undefined}
                aria-label={dayItems.length > 0
                  ? t('agenda.datePendingCount', {
                    date: new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(day),
                    count: dayItems.length,
                    defaultValue: `${new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(day)}，${dayItems.length} 项待办`,
                  })
                  : new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(day)}
                onClick={() => selectDate(day, true)}
                onKeyDown={(event) => handleDayKeyDown(event, day)}
              >
                <span>{day.getDate()}</span>
                <span className="wb-agenda-day-dots" aria-hidden="true">
                  {dayItems.slice(0, 3).map((item) => (
                    <i
                      key={item.id}
                      style={{ backgroundColor: listColor(listsById.get(item.todoListId), item.todoListId) }}
                    />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="wb-agenda-divider" />

      <div className="wb-agenda-list-header">
        <div>
          <strong>{selectedLabel}</strong>
          {selectedKey === todayKey && overdueItems.length > 0 ? (
            <span className="wb-agenda-overdue-count">
              <WarningCircle size={12} weight="fill" />
              {t('agenda.overdueCount', { count: overdueItems.length, defaultValue: `${overdueItems.length} 项逾期` })}
            </span>
          ) : null}
        </div>
        <button type="button" className="wb-agenda-open-button" onClick={() => void openTodoView()}>
          {t('agenda.openTodo', { defaultValue: '待办' })}
          <ArrowRight size={13} weight="bold" />
        </button>
      </div>

      <div className="wb-agenda-list" aria-live="polite">
        {snapshot.isLoading ? (
          <div className="wb-agenda-empty">{t('agenda.loading', { defaultValue: '正在整理日程…' })}</div>
        ) : agendaItems.length === 0 ? (
          <button
            type="button"
            className="wb-agenda-empty wb-agenda-empty-action"
            onClick={() => void openTodoView()}
          >
            <Check size={16} weight="bold" />
            <span>{t('agenda.clear', { defaultValue: '这一天没有待完成事项' })}</span>
            <ArrowRight className="wb-agenda-empty-arrow" size={13} weight="bold" />
          </button>
        ) : (
          agendaItems.map((item) => {
            const overdue = Boolean(item.dueDate && item.dueDate < todayKey);
            const list = listsById.get(item.todoListId);
            return (
              <div className="wb-agenda-item" key={item.id} data-overdue={overdue || undefined}>
                <button
                  type="button"
                  className="wb-agenda-check"
                  disabled={completingId === item.id}
                  onClick={() => void completeItem(item)}
                  aria-label={t('agenda.completeItem', { title: item.title, defaultValue: `完成 ${item.title}` })}
                >
                  <span style={{ borderColor: listColor(list, item.todoListId) }}>
                    {completingId === item.id ? <Check size={9} weight="bold" /> : null}
                  </span>
                </button>
                <button type="button" className="wb-agenda-item-main" onClick={() => void openTodoItem(item)}>
                  <span className="wb-agenda-item-title">{item.title}</span>
                  <span className="wb-agenda-item-meta">
                    <i style={{ backgroundColor: listColor(list, item.todoListId) }} />
                    <span>{list?.title ?? t('agenda.unknownList', { defaultValue: '待办' })}</span>
                    <span>·</span>
                    <time>{overdue ? item.dueDate : item.dueTime || t('agenda.allDay', { defaultValue: '全天' })}</time>
                  </span>
                </button>
              </div>
            );
          })
        )}
      </div>
      {hiddenCount > 0 ? (
        <button type="button" className="wb-agenda-more" onClick={() => void openTodoView()}>
          {t('agenda.more', { count: hiddenCount, defaultValue: `还有 ${hiddenCount} 项` })}
        </button>
      ) : null}
      {snapshot.error && snapshot.updatedAt === 0 ? (
        <div className="wb-agenda-error">{t('agenda.loadFailed', { defaultValue: '日程暂时不可用' })}</div>
      ) : null}
    </section>
  );
});

DesktopAgendaWidget.displayName = 'DesktopAgendaWidget';

export default DesktopAgendaWidget;
