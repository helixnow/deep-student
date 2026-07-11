/**
 * StatusBar — 学习状态菜单栏（docs/research/macos-2026/07）
 *
 * 透明顶栏字层：右侧信号项 + 图标入口（无时钟）。
 * 入口打开紧凑学习中心（2×2 瓷砖）。Windows 右侧为窗控胶囊让位。
 */
import React, { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Cards,
  CirclesFour,
  Lightning,
  SquaresFour,
  Timer,
} from '@phosphor-icons/react';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { isWindows } from '@/utils/platform';
import {
  getFlashcardsDueCount,
  subscribeFlashcardsDueCount,
} from '../apps/system/flashcardsDueSource';
import {
  getActiveAnkiTaskCount,
  subscribeAnkiTaskCount,
} from '../apps/system/ankiTaskSource';
import { workbenchBus } from '../core/workbenchBus';
import { useWorkbenchOverlay } from '../core/shortcuts';
import { useFocusReturn } from '../hooks/useWorkbenchA11y';
import { useLiquidGlassLens } from '../core/liquidGlassLens';
import { openAppsPanel } from './appsPanelStore';
import { StatusBarItems, formatStatusBarTime } from './StatusBarItems';
import './StatusBar.css';

export { formatStatusBarTime } from './StatusBarItems';

/** Flyout 内番茄详情：单独订阅 timeLeft，避免 1Hz 刷整棵 StatusBar */
const PomodoroFlyoutDetail: React.FC = () => {
  const { t } = useTranslation('workbench');
  const mode = usePomodoroStore((s) => s.mode);
  const status = usePomodoroStore((s) => s.status);
  const timeLeft = usePomodoroStore((s) => s.timeLeft);
  if (mode === 'idle') {
    return <>{t('menubar.pomodoroIdle', { defaultValue: '未开始' })}</>;
  }
  const phase =
    mode === 'work'
      ? t('menubar.pomodoroWork', { defaultValue: '专注中' })
      : t('menubar.pomodoroBreak', { defaultValue: '休息中' });
  const paused =
    status === 'paused'
      ? ` · ${t('apps.system.paused', { defaultValue: '已暂停' })}`
      : '';
  const label = formatStatusBarTime(timeLeft);
  return (
    <>
      {phase}
      {paused}
      {label ? ` · ${label}` : ''}
    </>
  );
};

const FLYOUT_FOCUSABLE =
  'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const FLASHCARDS_DUE_PAYLOAD = { screen: 'session', mode: 'due' } as const;

function launchApp(typeId: string): void {
  workbenchBus.launch({ typeId, reason: 'api' });
}

function launchFlashcardsDue(): void {
  workbenchBus.launch({
    typeId: 'flashcards',
    reason: 'api',
    payload: FLASHCARDS_DUE_PAYLOAD,
  });
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FLYOUT_FOCUSABLE)).filter((el) => {
    if (el.closest('[inert]')) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  });
}

const StatusBarComponent: React.FC = () => {
  const { t } = useTranslation('workbench');
  const [centerOpen, setCenterOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const winChromeInset = isWindows();
  useLiquidGlassLens(panelRef, centerOpen);

  const dueCount = useSyncExternalStore(
    subscribeFlashcardsDueCount,
    getFlashcardsDueCount,
    () => 0,
  );
  const taskCount = useSyncExternalStore(
    subscribeAnkiTaskCount,
    getActiveAnkiTaskCount,
    () => 0,
  );

  // 番茄钟详情只在 flyout 打开时由叶子订阅 timeLeft，避免 1Hz 刷整棵 StatusBar
  const exposeOpen = useWorkbenchOverlay((s) => s.exposeOpen);

  useFocusReturn(centerOpen);

  const closeCenter = useCallback(() => setCenterOpen(false), []);
  const toggleCenter = useCallback(() => setCenterOpen((v) => !v), []);

  useEffect(() => {
    if (exposeOpen) setCenterOpen(false);
  }, [exposeOpen]);

  useEffect(() => {
    if (!centerOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeCenter();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [centerOpen, closeCenter]);

  useEffect(() => {
    if (!centerOpen) return undefined;
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    if (!panel) return undefined;

    if (backdrop) {
      backdrop.setAttribute('aria-hidden', 'true');
    }

    const focusInitial = () => {
      const focusable = getFocusable(panel);
      (focusable[0] ?? panel).focus({ preventScroll: true });
    };
    const raf = window.requestAnimationFrame(focusInitial);

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
  }, [centerOpen]);

  const runAndClose = useCallback(
    (fn: () => void) => () => {
      closeCenter();
      fn();
    },
    [closeCenter],
  );

  return (
    <div
      className="wb-menubar"
      data-wb-menubar
      data-testid="wb-menubar"
      data-chrome-inset={winChromeInset ? 'windows' : undefined}
      role="banner"
      aria-label={t('menubar.label', { defaultValue: '学习状态栏' })}
    >
      <div className="wb-menubar-trailing">
        <div className="wb-menubar-status-slot" data-testid="wb-menubar-status-slot">
          <StatusBarItems dueCount={dueCount} taskCount={taskCount} />
        </div>

        <button
          type="button"
          className="wb-menubar-item wb-menubar-item-icon-only"
          data-testid="wb-menubar-center"
          data-wb-status-item="center"
          aria-label={t('menubar.openCenter', { defaultValue: '打开学习中心' })}
          aria-haspopup="dialog"
          aria-expanded={centerOpen}
          title={t('menubar.centerTitle', { defaultValue: '学习中心' })}
          onClick={toggleCenter}
        >
          <SquaresFour size={14} weight="duotone" className="wb-menubar-item-icon" aria-hidden />
        </button>

        {centerOpen ? (
          <>
            <div
              ref={backdropRef}
              className="wb-menubar-flyout-backdrop"
              data-testid="wb-menubar-flyout-backdrop"
              aria-hidden="true"
              onClick={closeCenter}
            />
            <div
              ref={panelRef}
              className="wb-glass wb-glass-highlight wb-glass-lens wb-menubar-flyout"
              data-open="true"
              data-testid="wb-menubar-flyout"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              tabIndex={-1}
            >
              <h2 id={titleId} className="wb-menubar-flyout-title">
                {t('menubar.centerTitle', { defaultValue: '学习中心' })}
              </h2>

              <div className="wb-menubar-grid" role="group" aria-label={t('menubar.centerTitle', { defaultValue: '学习中心' })}>
                <button
                  type="button"
                  className="wb-menubar-tile"
                  data-testid="wb-menubar-module-flashcards"
                  data-primary={dueCount > 0 ? 'true' : undefined}
                  onClick={runAndClose(launchFlashcardsDue)}
                >
                  <span className="wb-menubar-tile-icon" aria-hidden="true">
                    <Cards size={18} weight="duotone" />
                  </span>
                  <span className="wb-menubar-tile-label">
                    {t('menubar.moduleFlashcards', { defaultValue: '今日复习' })}
                  </span>
                  <span className="wb-menubar-tile-detail">
                    {t('menubar.flashcardsDueShort', {
                      count: dueCount,
                      defaultValue: `${dueCount} 张到期`,
                    })}
                  </span>
                </button>

                <button
                  type="button"
                  className="wb-menubar-tile"
                  data-testid="wb-menubar-module-tasks"
                  onClick={runAndClose(() => launchApp('taskDashboard'))}
                >
                  <span className="wb-menubar-tile-icon" aria-hidden="true">
                    <Lightning size={18} weight="duotone" />
                  </span>
                  <span className="wb-menubar-tile-label">
                    {t('menubar.moduleTasks', { defaultValue: '制卡任务' })}
                  </span>
                  <span className="wb-menubar-tile-detail">
                    {t('menubar.tasksRunningShort', {
                      count: taskCount,
                      defaultValue: `${taskCount} 进行中`,
                    })}
                  </span>
                </button>

                <button
                  type="button"
                  className="wb-menubar-tile"
                  data-testid="wb-menubar-module-pomodoro"
                  onClick={runAndClose(() => launchApp('pomodoro'))}
                >
                  <span className="wb-menubar-tile-icon" aria-hidden="true">
                    <Timer size={18} weight="duotone" />
                  </span>
                  <span className="wb-menubar-tile-label">
                    {t('menubar.moduleFocus', { defaultValue: '专注' })}
                  </span>
                  <span className="wb-menubar-tile-detail">
                    <PomodoroFlyoutDetail />
                  </span>
                </button>

                <div
                  className="wb-menubar-tile wb-menubar-tile-split"
                  data-testid="wb-menubar-module-desktop"
                >
                  <span className="wb-menubar-tile-icon" aria-hidden="true">
                    <SquaresFour size={18} weight="duotone" />
                  </span>
                  <span className="wb-menubar-tile-label">
                    {t('menubar.moduleDesktop', { defaultValue: '桌面' })}
                  </span>
                  <div className="wb-menubar-tile-actions">
                    <button
                      type="button"
                      className="wb-menubar-tile-action"
                      onClick={runAndClose(() => openAppsPanel())}
                    >
                      <CirclesFour size={12} weight="bold" aria-hidden="true" />
                      {t('menubar.allApps', { defaultValue: '全部应用' })}
                    </button>
                    <button
                      type="button"
                      className="wb-menubar-tile-action"
                      onClick={runAndClose(() => useWorkbenchOverlay.getState().openExpose())}
                    >
                      {t('menubar.expose', { defaultValue: '窗口俯瞰' })}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
};

export const StatusBar = React.memo(StatusBarComponent);
StatusBar.displayName = 'StatusBar';

export default StatusBar;
