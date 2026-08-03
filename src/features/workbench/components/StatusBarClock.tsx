/**
 * StatusBarClock — 菜单栏右端时钟 + 今日日程 flyout（macOS 菜单栏时钟语义）
 *
 * - 显示样式对标 macOS：zh「7月19日 周日 20:18」/ en「Sun Jul 19 20:18」，
 *   跟随 i18n locale；timer 对齐到分钟边界（每分钟一次 setState，无 1Hz 重渲染）。
 * - 点击展开今日日程 flyout：数据获取复用桌面日历小组件的共享源
 *   todoAgendaSource（subscribe/get snapshot），仅 flyout 打开期间订阅；
 *   弹层样式与学习中心 flyout 同款（wb-menubar-flyout 玻璃面板 + 相位机离场）。
 */
import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, CheckCircle, WarningCircle } from '@phosphor-icons/react';
import type { TodoItem } from '@/features/todo/types';
import { workbenchBus } from '../core/workbenchBus';
import { useWorkbenchOverlay } from '../core/shortcuts';
import { useFocusReturn } from '../hooks/useWorkbenchA11y';
import { useLiquidGlassLens } from '../core/liquidGlassLens';
import {
  getTodoAgendaSnapshot,
  subscribeTodoAgenda,
} from '../apps/system/todoAgendaSource';
import { formatLocalDateKey } from './DesktopAgendaWidget';

/** 与学习中心 flyout 同步：wb-kf-window-close(90ms) 播完再卸载 + 小余量 */
const CLOCK_FLYOUT_EXIT_MS = 120;
const AGENDA_MAX_ITEMS = 6;

const FLYOUT_FOCUSABLE =
  'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FLYOUT_FOCUSABLE)).filter((el) => {
    if (el.closest('[inert]')) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  });
}

/** macOS 菜单栏时钟文案：zh「7月19日 周日 20:18」/ en「Sun Jul 19 20:18」 */
export function formatMenuBarClock(date: Date, language: string | undefined): string {
  const zh = Boolean(language?.startsWith('zh'));
  const locale = zh ? 'zh-CN' : 'en-US';
  const datePart = new Intl.DateTimeFormat(locale, {
    month: zh ? 'long' : 'short',
    day: 'numeric',
  }).format(date);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date);
  const time = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return zh ? `${datePart} ${weekday} ${time}` : `${weekday} ${datePart} ${time}`;
}

/** 对齐到分钟边界的墙钟（每分钟一次 setState，避免每秒重渲染） */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      // +50ms 余量确保跨过分钟边界后再读墙钟
      const delay = 60_000 - (Date.now() % 60_000) + 50;
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, delay);
    };
    schedule();
    const onVisible = () => {
      if (document.visibilityState === 'visible') setNow(new Date());
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return now;
}

function openTodoToday(): void {
  // 空 instanceKey：activateDetailed 回落焦点窗 / 同 type 首窗（与 StatusBar 其余入口一致）
  void workbenchBus.activateDetailed({
    typeId: 'todo',
    instanceKey: '',
    action: 'showView',
    payload: { view: 'today' },
    fallbackLaunch: { typeId: 'todo', reason: 'api' },
  });
}

/** flyout 内容：仅打开期间挂载，订阅（及其背后的轮询）不落在常驻顶栏上 */
const ClockAgendaList: React.FC<{ onNavigate: () => void }> = ({ onNavigate }) => {
  const { t } = useTranslation('workbench');
  const snapshot = useSyncExternalStore(
    subscribeTodoAgenda,
    getTodoAgendaSnapshot,
    getTodoAgendaSnapshot,
  );
  const todayKey = formatLocalDateKey(new Date());
  const byTime = (a: TodoItem, b: TodoItem): number => {
    if (a.dueTime === b.dueTime) return 0;
    if (!a.dueTime) return 1;
    if (!b.dueTime) return -1;
    return a.dueTime.localeCompare(b.dueTime);
  };
  const overdue = snapshot.items.filter((item) => Boolean(item.dueDate && item.dueDate < todayKey));
  const today = snapshot.items.filter((item) => item.dueDate === todayKey).sort(byTime);
  const all = [...overdue, ...today];
  const shown = all.slice(0, AGENDA_MAX_ITEMS);
  const hiddenCount = all.length - shown.length;

  const handleOpen = () => {
    onNavigate();
    openTodoToday();
  };

  if (snapshot.isLoading && snapshot.updatedAt === 0) {
    return <div className="wb-menubar-agenda-empty">{t('agenda.loading')}</div>;
  }

  return (
    <div className="wb-menubar-agenda" data-testid="wb-menubar-agenda">
      {shown.length === 0 ? (
        <button
          type="button"
          className="wb-menubar-agenda-empty wb-menubar-agenda-empty-action"
          data-testid="wb-menubar-agenda-empty"
          onClick={handleOpen}
        >
          <CheckCircle size={15} weight="duotone" aria-hidden />
          <span>{t('agenda.clear')}</span>
        </button>
      ) : (
        shown.map((item) => {
          const isOverdue = Boolean(item.dueDate && item.dueDate < todayKey);
          return (
            <button
              key={item.id}
              type="button"
              className="wb-menubar-agenda-item"
              data-testid={`wb-menubar-agenda-item-${item.id}`}
              data-overdue={isOverdue || undefined}
              title={item.title}
              onClick={handleOpen}
            >
              <span className="wb-menubar-agenda-item-title">{item.title}</span>
              <span className="wb-menubar-agenda-item-time">
                {isOverdue ? (
                  <>
                    <WarningCircle size={12} weight="fill" aria-hidden />
                    {item.dueDate}
                  </>
                ) : (
                  item.dueTime || t('agenda.allDay')
                )}
              </span>
            </button>
          );
        })
      )}
      {hiddenCount > 0 ? (
        <div className="wb-menubar-agenda-more">{t('agenda.more', { count: hiddenCount })}</div>
      ) : null}
      <button
        type="button"
        className="wb-menubar-agenda-open"
        data-testid="wb-menubar-agenda-open"
        onClick={handleOpen}
      >
        {t('agenda.openTodo')}
        <ArrowRight size={12} weight="bold" aria-hidden />
      </button>
    </div>
  );
};

export interface StatusBarClockProps {
  /** flyout 开合变化时上报（autohide 打开期间保持展开用） */
  onOpenChange?: (open: boolean) => void;
}

export const StatusBarClock: React.FC<StatusBarClockProps> = ({ onOpenChange }) => {
  const { t, i18n } = useTranslation('workbench');
  const now = useMinuteClock();
  // 相位机：与学习中心 flyout 同款（open → closing 播离场 → closed 卸载）
  const [phase, setPhase] = useState<'closed' | 'open' | 'closing'>('closed');
  const open = phase === 'open';
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const exposeOpen = useWorkbenchOverlay((s) => s.exposeOpen);
  useLiquidGlassLens(panelRef, open, { staticOnly: true });
  useFocusReturn(open);

  const close = useCallback(() => setPhase((p) => (p === 'open' ? 'closing' : p)), []);
  const toggle = useCallback(
    () => setPhase((p) => (p === 'open' ? 'closing' : 'open')),
    [],
  );

  useEffect(() => {
    onOpenChange?.(phase !== 'closed');
  }, [phase, onOpenChange]);

  useEffect(() => {
    if (exposeOpen) close();
  }, [exposeOpen, close]);

  useEffect(() => {
    if (phase !== 'closing') return undefined;
    const timer = window.setTimeout(() => setPhase('closed'), CLOCK_FLYOUT_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  // 焦点：打开聚焦首个可聚焦项 + Tab 循环（与学习中心 flyout 同语义）
  useEffect(() => {
    if (!open) return undefined;
    const panel = panelRef.current;
    if (!panel) return undefined;
    const raf = window.requestAnimationFrame(() => {
      const focusable = getFocusable(panel);
      (focusable[0] ?? panel).focus({ preventScroll: true });
    });
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusables = getFocusable(panel);
      if (focusables.length === 0) {
        e.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active ? panel.contains(active) : false;
      if (e.shiftKey) {
        if (!inside || active === first) {
          e.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (!inside || active === last) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open]);

  const label = formatMenuBarClock(now, i18n.language);

  return (
    <>
      <button
        type="button"
        className="wb-menubar-item wb-menubar-clock"
        data-testid="wb-menubar-clock"
        data-wb-status-item="clock"
        aria-label={t('menubar.clockLabel')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('menubar.agendaTitle')}
        onClick={toggle}
      >
        <span className="wb-menubar-item-value">{label}</span>
      </button>

      {phase !== 'closed' ? (
        <>
          <div
            className="wb-menubar-flyout-backdrop"
            data-testid="wb-menubar-clock-backdrop"
            aria-hidden="true"
            onClick={close}
          />
          <div
            ref={panelRef}
            className="wb-glass wb-glass-highlight wb-glass-lens wb-menubar-flyout wb-menubar-clock-flyout"
            data-open="true"
            data-phase={phase}
            data-testid="wb-menubar-clock-flyout"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
          >
            <h2 id={titleId} className="wb-menubar-flyout-title">
              {t('menubar.agendaTitle')}
            </h2>
            <ClockAgendaList onNavigate={close} />
          </div>
        </>
      ) : null}
    </>
  );
};

export default StatusBarClock;
