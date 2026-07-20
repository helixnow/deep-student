/**
 * StatusBar — 学习状态菜单栏（docs/research/macos-2026/07）
 *
 * OS 桌面的应用级顶栏：左侧品牌，右侧命令、学习信号、设置与今日节律。
 * macOS 原生 File/Edit/View/Window/Help 仍由 Tauri 菜单栏提供，避免在这里重复。
 * 「今日节律」flyout：到期闪卡 / 番茄 / 自动化健康 / 任务入口。
 * Windows 右侧为窗控胶囊让位。
 */
import React, { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import {
  Cards,
  GearSix,
  Lightning,
  MagnifyingGlass,
  Robot,
  SquaresFour,
  Timer,
} from '@phosphor-icons/react';
import { DeepStudentMark } from '@/components/ui/DeepStudentLogo';
import { toggleAppsPanel } from './appsPanelStore';
import { StatusBarBrandMenu } from './StatusBarBrandMenu';
import {
  getAutomationSummary,
  type AutomationSummary,
} from '@/features/settings/components/automationSettingsApi';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { isMacOS, isWindows } from '@/utils/platform';
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
    return <>{t('menubar.pomodoroIdle')}</>;
  }
  const phase =
    mode === 'work'
      ? t('menubar.pomodoroWork')
      : t('menubar.pomodoroBreak');
  const paused =
    status === 'paused'
      ? ` · ${t('apps.system.paused')}`
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
  void workbenchBus.activate({
    typeId: 'flashcards',
    instanceKey: '',
    action: 'startReview',
    payload: FLASHCARDS_DUE_PAYLOAD,
    fallbackLaunch: {
      typeId: 'flashcards',
      reason: 'api',
      payload: FLASHCARDS_DUE_PAYLOAD,
    },
  });
}

function launchAutomations(): void {
  void workbenchBus.activate({
    typeId: 'todo',
    instanceKey: '',
    action: 'showAutomations',
    fallbackLaunch: {
      typeId: 'todo',
      reason: 'api',
      payload: { todoView: 'automations' },
    },
  });
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FLYOUT_FOCUSABLE)).filter((el) => {
    if (el.closest('[inert]')) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  });
}

/** 学习中心 flyout 离场编排：wb-kf-window-close(90ms) 播完再卸载 + 小余量
 * （此前 180ms 多挂约一倍空壳时间，离场显拖沓） */
const MENUBAR_FLYOUT_EXIT_MS = 120;

const StatusBarComponent: React.FC = () => {
  const { t } = useTranslation('workbench');
  // 相位机：open → closing（播离场）→ closed（卸载）；closing 中再点入口直接回 open
  const [centerPhase, setCenterPhase] = useState<'closed' | 'open' | 'closing'>('closed');
  const centerOpen = centerPhase === 'open';
  const panelRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const brandButtonRef = useRef<HTMLButtonElement | null>(null);
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [automation, setAutomation] = useState<AutomationSummary | null>(null);
  const titleId = useId();
  const winChromeInset = isWindows();
  const macChrome = isMacOS();
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

  const closeCenter = useCallback(
    () => setCenterPhase((p) => (p === 'open' ? 'closing' : p)),
    [],
  );
  const closeBrandMenu = useCallback(() => setBrandMenuOpen(false), []);
  // 浮层互斥（macOS 菜单栏语义：同时最多一个打开的菜单/面板）
  const toggleCenter = useCallback(() => {
    setBrandMenuOpen(false);
    setCenterPhase((p) => (p === 'open' ? 'closing' : 'open'));
  }, []);
  const toggleBrandMenu = useCallback(() => {
    closeCenter();
    setBrandMenuOpen((v) => !v);
  }, [closeCenter]);
  // 统一搜索入口：打开全部应用面板（应用 + 命令），不再弹独立命令面板
  const openUnifiedSearch = useCallback(() => toggleAppsPanel(), []);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const value = await getAutomationSummary((command, args) => invoke(command, args));
        if (!disposed) setAutomation(value);
      } catch {
        // The status item stays as a quiet entry even when summary loading fails.
      }
    };
    const schedulePoll = (intervalMs: number) => {
      if (disposed) return;
      if (timer !== undefined) window.clearInterval(timer);
      timer = window.setInterval(refresh, intervalMs);
    };
    void refresh();
    // 事件优先：先按 30s 轮询启动；事件桥建立后放宽到 5 分钟兜底（防事件丢失），
    // listen 失败则保持 30s 轮询作为唯一刷新通道。
    schedulePoll(30_000);
    let unlisten: (() => void) | undefined;
    void listen('chat_v2://automations_changed', refresh).then((value) => {
      if (disposed) {
        value();
        return;
      }
      unlisten = value;
      schedulePoll(300_000);
    }).catch(() => {
      // The 30-second poll remains available when the desktop event bridge fails.
    });
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearInterval(timer);
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    // Exposé 打开时收起全部菜单栏浮层（此前品牌菜单会残留在 Exposé 之上）
    if (exposeOpen) {
      closeCenter();
      closeBrandMenu();
    }
  }, [exposeOpen, closeCenter, closeBrandMenu]);

  // 离场相位：播完 wb-kf-window-close 再真正卸载（jsdom 无动画也走同一定时器）
  useEffect(() => {
    if (centerPhase !== 'closing') return undefined;
    const timer = window.setTimeout(() => setCenterPhase('closed'), MENUBAR_FLYOUT_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [centerPhase]);

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

  const handleDragMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!macChrome || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('[data-no-drag]')) return;
    event.preventDefault();
    if (event.detail === 2) {
      void getCurrentWindow().toggleMaximize();
      return;
    }
    void getCurrentWindow().startDragging();
  }, [macChrome]);

  const automationRunning = automation?.runningCount ?? 0;
  const automationFailed = automation?.failedCount ?? 0;
  const automationEnabled = automation?.enabledCount ?? 0;

  return (
    <div
      className="wb-menubar"
      data-wb-menubar
      data-testid="wb-menubar"
      data-chrome-inset={winChromeInset ? 'windows' : undefined}
      data-macos-chrome={macChrome ? 'integrated' : undefined}
      role="banner"
      aria-label={t('menubar.label')}
    >
      {macChrome ? (
        <div
          className="wb-menubar-drag-region"
          data-testid="wb-menubar-drag-region"
          aria-hidden="true"
          onMouseDown={handleDragMouseDown}
        />
      ) : null}
      <div className="wb-menubar-leading" data-no-drag>
        <button
          ref={brandButtonRef}
          type="button"
          className="wb-menubar-item wb-menubar-brand"
          data-testid="wb-menubar-brand"
          aria-label={t('menubar.brandMenu')}
          aria-haspopup="menu"
          aria-expanded={brandMenuOpen}
          title={t('menubar.appName')}
          onClick={toggleBrandMenu}
        >
          <DeepStudentMark className="wb-menubar-brand-mark" title="" />
          <span className="wb-menubar-brand-label">
            {t('menubar.appName')}
          </span>
        </button>
        <StatusBarBrandMenu
          open={brandMenuOpen}
          anchorRef={brandButtonRef}
          onClose={closeBrandMenu}
        />
      </div>
      <div className="wb-menubar-trailing" data-no-drag>
        <button
          type="button"
          className="wb-menubar-item wb-menubar-item-icon-only wb-menubar-command"
          data-testid="wb-menubar-command"
          aria-label={t('menubar.openAppsPanel')}
          title={t('menubar.openAppsPanel')}
          onClick={openUnifiedSearch}
        >
          <MagnifyingGlass size={15} weight="bold" className="wb-menubar-item-icon" aria-hidden />
        </button>
        <div className="wb-menubar-status-slot" data-testid="wb-menubar-status-slot">
          <StatusBarItems
            dueCount={dueCount}
            taskCount={taskCount}
            automation={automation}
          />
        </div>

        <button
          type="button"
          className="wb-menubar-item wb-menubar-item-icon-only wb-menubar-settings"
          data-testid="wb-menubar-settings"
          aria-label={t('menubar.openSettings')}
          title={t('menubar.openSettings')}
          onClick={() => launchApp('settings')}
        >
          <GearSix size={15} weight="bold" className="wb-menubar-item-icon" aria-hidden />
        </button>

        <button
          type="button"
          className="wb-menubar-item wb-menubar-item-icon-only"
          data-testid="wb-menubar-center"
          data-wb-status-item="center"
          aria-label={t('menubar.openCenter')}
          aria-haspopup="dialog"
          aria-expanded={centerOpen}
          title={t('menubar.centerTitle')}
          onClick={toggleCenter}
        >
          <SquaresFour size={14} weight="duotone" className="wb-menubar-item-icon" aria-hidden />
        </button>

        {centerPhase !== 'closed' ? (
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
              data-phase={centerPhase}
              data-testid="wb-menubar-flyout"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              tabIndex={-1}
            >
              <h2 id={titleId} className="wb-menubar-flyout-title">
                {t('menubar.centerTitle')}
              </h2>

              <div
                className="wb-menubar-rhythm"
                role="group"
                aria-label={t('menubar.centerTitle')}
                data-testid="wb-menubar-rhythm"
              >
                <button
                  type="button"
                  className="wb-menubar-rhythm-row"
                  data-testid="wb-menubar-module-flashcards"
                  data-primary={dueCount > 0 ? 'true' : undefined}
                  aria-label={`${t('menubar.rhythmFlashcards')}: ${t('menubar.flashcardsDueShort', { count: dueCount })}`}
                  onClick={runAndClose(launchFlashcardsDue)}
                >
                  <span className="wb-menubar-rhythm-icon" aria-hidden="true">
                    <Cards size={18} weight="duotone" />
                  </span>
                  <span className="wb-menubar-rhythm-text" aria-hidden="true">
                    <span className="wb-menubar-rhythm-label">
                      {t('menubar.rhythmFlashcards')}
                    </span>
                    <span className="wb-menubar-rhythm-detail">
                      {t('menubar.flashcardsDueShort', { count: dueCount })}
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  className="wb-menubar-rhythm-row"
                  data-testid="wb-menubar-module-pomodoro"
                  onClick={runAndClose(() => launchApp('pomodoro'))}
                >
                  <span className="wb-menubar-rhythm-icon" aria-hidden="true">
                    <Timer size={18} weight="duotone" />
                  </span>
                  <span className="wb-menubar-rhythm-text">
                    <span className="wb-menubar-rhythm-label">
                      {t('menubar.rhythmPomodoro')}
                    </span>
                    <span className="wb-menubar-rhythm-detail">
                      <PomodoroFlyoutDetail />
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  className="wb-menubar-rhythm-row"
                  data-testid="wb-menubar-module-automations"
                  data-status={
                    automationRunning
                      ? 'running'
                      : automationFailed
                        ? 'error'
                        : 'idle'
                  }
                  aria-label={`${t('menubar.rhythmAutomation')}: ${t('menubar.rhythmAutomationDetail', {
                    running: automationRunning,
                    failed: automationFailed,
                    enabled: automationEnabled,
                  })}`}
                  onClick={runAndClose(launchAutomations)}
                >
                  <span className="wb-menubar-rhythm-icon" aria-hidden="true">
                    <Robot size={18} weight="duotone" />
                  </span>
                  <span className="wb-menubar-rhythm-text" aria-hidden="true">
                    <span className="wb-menubar-rhythm-label">
                      {t('menubar.rhythmAutomation')}
                    </span>
                    <span className="wb-menubar-rhythm-detail">
                      {t('menubar.rhythmAutomationDetail', {
                        running: automationRunning,
                        failed: automationFailed,
                        enabled: automationEnabled,
                      })}
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  className="wb-menubar-rhythm-row"
                  data-testid="wb-menubar-module-tasks"
                  aria-label={`${t('menubar.rhythmTasks')}: ${t('menubar.rhythmTasksDetail', { count: taskCount })}`}
                  onClick={runAndClose(() => launchApp('taskDashboard'))}
                >
                  <span className="wb-menubar-rhythm-icon" aria-hidden="true">
                    <Lightning size={18} weight="duotone" />
                  </span>
                  <span className="wb-menubar-rhythm-text" aria-hidden="true">
                    <span className="wb-menubar-rhythm-label">
                      {t('menubar.rhythmTasks')}
                    </span>
                    <span className="wb-menubar-rhythm-detail">
                      {t('menubar.rhythmTasksDetail', { count: taskCount })}
                    </span>
                  </span>
                </button>
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
