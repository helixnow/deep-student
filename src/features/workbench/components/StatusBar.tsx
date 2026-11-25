/**
 * StatusBar — 学习状态菜单栏（对标 macOS 菜单栏：状态项 + 控制中心交互模式）
 *
 * OS 桌面的应用级顶栏：左侧品牌 + 聚焦应用 / 窗口菜单，右侧命令、学习信号、
 * 设置、今日节律与时钟（今日日程 flyout）。
 * macOS 原生 File/Edit/View/Window/Help 仍由 Tauri 菜单栏提供，避免在这里重复。
 * 「今日节律」flyout：到期闪卡 / 番茄 / 自动化健康 / 任务入口。
 * autohide：desktop.workbenchMenuBarAutohide（menuBarAutohideStore，可被外部强制）；
 * 隐藏至顶缘 4px 热区，reveal ~180ms / conceal ~150ms 防误触（对齐 Dock autohide）。
 * Windows：三键（最小化/最大化/关闭）直接融入顶栏最右端，整条空白区可拖拽。
 */
import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import {
  Browser,
  Cards,
  Drop,
  DropHalf,
  GearSix,
  Image,
  Lightning,
  MagnifyingGlass,
  Moon,
  Notebook,
  Robot,
  Rows,
  SquaresFour,
  Sun,
  Timer,
  WarningDiamond,
} from '@phosphor-icons/react';
import { DeepStudentMark } from '@/components/ui/DeepStudentLogo';
import { DsButton } from '@/components/ui/DsButton';
import { WindowControls } from '@/components/WindowControls';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { useTheme } from '@/hooks/useTheme';
import { getSetting, saveSetting } from '@/utils/settingsApi';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import { closeAppsPanel, toggleAppsPanel, useAppsPanelOpen } from './appsPanelStore';
import { useDesktopName } from './desktopNameStore';
import { StatusBarBrandMenu } from './StatusBarBrandMenu';
import { StatusBarAppMenus } from './StatusBarAppMenus';
import { StatusBarClock } from './StatusBarClock';
import {
  MENUBAR_AUTOHIDE_SETTING_KEY,
  useMenuBarAutohide,
  useMenuBarAutohideStore,
} from './menuBarAutohideStore';
import {
  DEFAULT_WALLPAPER,
  WALLPAPER_PRESETS,
  type WallpaperConfig,
} from './WallpaperLayer';
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
import { useWindowStore } from '../core/windowStore';
import { workbenchBus } from '../core/workbenchBus';
import { parsePersistedWallpaper } from '../core/persistedSettings';
import {
  initLiquidGlassAppearance,
  MAX_GLASS_CLARITY,
  MIN_GLASS_CLARITY,
  useLiquidGlassClarity,
} from '../core/liquidGlassAppearanceStore';
import {
  getTodayLearningSnapshot,
  subscribeTodayLearning,
} from '@/features/learning-today/todayLearningStore';
import { openTodayReviewTarget } from '@/features/learning-today/openTodayReview';
import { useWorkbenchOverlay } from '../core/shortcuts';
import { useFocusReturn } from '../hooks/useWorkbenchA11y';
import { useLiquidGlassLens, WallpaperReplica } from '../core/liquidGlassLens';
import { StatusBarItems, formatStatusBarTime } from './StatusBarItems';
import { StudyFlowStageSwitcher } from './StudyFlowStageSwitcher';
import './StatusBar.css';

export { formatStatusBarTime } from './StatusBarItems';

export type StatusBarMenuId = 'brand' | 'app' | 'window' | 'control-center' | 'clock';

const MENU_CYCLE_ORDER: readonly StatusBarMenuId[] = [
  'brand',
  'app',
  'window',
  'control-center',
  'clock',
];

const MENU_TRIGGER_TEST_IDS: Record<StatusBarMenuId, string> = {
  brand: 'wb-menubar-brand',
  app: 'wb-menubar-appmenu',
  window: 'wb-menubar-windowmenu',
  'control-center': 'wb-menubar-center',
  clock: 'wb-menubar-clock',
};

const DOCK_AUTOHIDE_SETTING_KEY = 'desktop.workbenchDockAutohide';
const WALLPAPER_SETTING_KEY = 'desktop.workbenchWallpaper';

async function persistWorkbenchSetting(
  key: string,
  raw: string,
  parsed: unknown,
): Promise<void> {
  try {
    await saveSetting(key, raw);
  } catch {
    // 落盘失败仍派发热更新，本次会话内即时生效
  }
  try {
    window.dispatchEvent(
      new CustomEvent('workbench:settings-changed', { detail: { key, value: parsed } }),
    );
  } catch {
    // noop
  }
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement && target.type !== 'range') return true;
  return false;
}

function isInsideMenuBarOrPortal(
  target: EventTarget | null,
  bar: HTMLElement | null,
): boolean {
  if (!(target instanceof Node)) return false;
  if (bar?.contains(target)) return true;
  const element = target instanceof Element ? target : target.parentElement;
  return Boolean(
    element?.closest(
      '.wb-menubar, [data-wb-statusbar-menu], .wb-menubar-flyout, .wb-menubar-hotzone',
    ),
  );
}

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

/**
 * Flyout 内错题 / 笔记两条复习线（与对话首页「今日待复习」同口径）。
 * 只在 flyout 打开时订阅，避免常驻顶栏为笔记复习日期持续列目录；为 0 时不占行。
 */
const RhythmReviewRows: React.FC<{ onPick: (fn: () => void) => () => void }> = ({ onPick }) => {
  const { t } = useTranslation('workbench');
  const today = useSyncExternalStore(subscribeTodayLearning, getTodayLearningSnapshot, getTodayLearningSnapshot);
  const rows = [
    {
      key: 'mistakes',
      count: today.mistakes,
      icon: <WarningDiamond size={18} weight="duotone" />,
      label: t('menubar.rhythmMistakes'),
      detail: t('menubar.rhythmMistakesDetail', { count: today.mistakes }),
      open: () => openTodayReviewTarget('mistakes'),
    },
    {
      key: 'notes',
      count: today.notes,
      icon: <Notebook size={18} weight="duotone" />,
      label: t('menubar.rhythmNotes'),
      detail: t('menubar.rhythmNotesDetail', { count: today.notes }),
      open: () => openTodayReviewTarget('notes'),
    },
  ].filter((row) => row.count > 0);
  return (
    <>
      {rows.map((row) => (
        <button
          key={row.key}
          type="button"
          className="wb-menubar-rhythm-row"
          data-testid={`wb-menubar-module-${row.key}`}
          data-primary="true"
          aria-label={`${row.label}: ${row.detail}`}
          onClick={onPick(row.open)}
        >
          <span className="wb-menubar-rhythm-icon" aria-hidden="true">{row.icon}</span>
          <span className="wb-menubar-rhythm-text" aria-hidden="true">
            <span className="wb-menubar-rhythm-label">{row.label}</span>
            <span className="wb-menubar-rhythm-detail">{row.detail}</span>
          </span>
        </button>
      ))}
    </>
  );
};

const FLYOUT_FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const FLASHCARDS_DUE_PAYLOAD = { screen: 'session', mode: 'due' } as const;

function launchApp(typeId: string): void {
  workbenchBus.launch({ typeId, reason: 'api' });
  closeAppsPanel();
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
  closeAppsPanel();
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
  closeAppsPanel();
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
  const { t, i18n } = useTranslation('workbench');
  const isEnglish = Boolean(i18n.language?.startsWith('en'));
  // 统一顶栏展开菜单状态：支持 5 个顶栏菜单的 0ms 横滑切换与 ←/→ 循环
  const [activeMenuId, setActiveMenuId] = useState<StatusBarMenuId | null>(null);
  // 控制中心离场相位机：open → closing（播离场）→ closed（卸载）；切至相邻菜单时 0ms 瞬切
  const [centerPhase, setCenterPhase] = useState<'closed' | 'open' | 'closing'>('closed');
  const centerOpen = activeMenuId === 'control-center';
  const brandMenuOpen = activeMenuId === 'brand';
  const clockMenuOpen = activeMenuId === 'clock';
  const panelRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const brandButtonRef = useRef<HTMLButtonElement | null>(null);
  const [stageMenuOpen, setStageMenuOpen] = useState(false);
  const [clockOverlayMounted, setClockOverlayMounted] = useState(false);
  const [automation, setAutomation] = useState<AutomationSummary | null>(null);
  const [dockAutohide, setDockAutohide] = useState(false);
  const [wallpaper, setWallpaper] = useState<WallpaperConfig>(DEFAULT_WALLPAPER);
  const titleId = useId();
  const claritySliderId = useId();
  const winChromeInset = isWindows();
  const macChrome = isMacOS();
  // Spaces 最小命名：品牌钮悬停提示显示用户命名的桌面（未命名回退默认品牌名）
  const desktopName = useDesktopName();
  const { isDarkMode, toggleDarkMode } = useTheme();
  const { clarity, setClarity } = useLiquidGlassClarity();
  const menuBarAutohideSetting = useMenuBarAutohideStore((s) => s.settingEnabled);
  useLiquidGlassLens(panelRef, centerOpen, { staticOnly: true });

  useEffect(() => {
    initLiquidGlassAppearance();
  }, []);

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
  const appsPanelOpen = useAppsPanelOpen();

  const { skipNextReturn } = useFocusReturn(centerOpen);

  const closeActiveMenu = useCallback(() => {
    setActiveMenuId(null);
  }, []);

  const toggleMenu = useCallback((id: StatusBarMenuId) => {
    setActiveMenuId((cur) => (cur === id ? null : id));
  }, []);

  const hoverMenu = useCallback((id: StatusBarMenuId) => {
    setActiveMenuId((cur) => (cur !== null && cur !== id ? id : cur));
  }, []);

  const cycleMenu = useCallback((delta: 1 | -1) => {
    setActiveMenuId((cur) => {
      if (cur === null) return null;
      const bar = barRef.current;
      const visibleOrder = bar
        ? MENU_CYCLE_ORDER.filter((id) => {
            const trigger = bar.querySelector<HTMLElement>(
              `[data-testid="${MENU_TRIGGER_TEST_IDS[id]}"]`,
            );
            if (!trigger) return false;
            return getComputedStyle(trigger).display !== 'none';
          })
        : [];
      const order = visibleOrder.length > 0 ? visibleOrder : MENU_CYCLE_ORDER;
      const idx = order.indexOf(cur);
      const base = idx === -1 ? 0 : idx;
      return order[(base + delta + order.length) % order.length];
    });
  }, []);

  const renderedCenterPhase: 'closed' | 'open' | 'closing' = centerOpen ? 'open' : centerPhase;

  // 同步控制中心相位：相邻菜单切换 0ms 瞬切并跳过焦点归还；收起到 null 播离场动画
  useEffect(() => {
    if (activeMenuId === 'control-center') {
      setCenterPhase('open');
      return;
    }
    setCenterPhase((prev) => {
      if (prev === 'closed') return 'closed';
      if (activeMenuId !== null) {
        skipNextReturn();
        return 'closed';
      }
      return 'closing';
    });
  }, [activeMenuId, skipNextReturn]);

  // 统一搜索入口：打开全部应用面板（应用 + 命令），不再弹独立命令面板
  const openUnifiedSearch = useCallback(() => {
    setActiveMenuId(null);
    toggleAppsPanel();
  }, []);

  // ---- 菜单栏 autohide（对齐 Dock：reveal ~180ms / conceal ~150ms 防误触）----
  const autohide = useMenuBarAutohide();
  const [revealed, setRevealed] = useState(!autohide);
  const revealedRef = useRef(!autohide);
  const revealTimerRef = useRef(0);
  const concealTimerRef = useRef(0);
  const overlaysOpen =
    activeMenuId !== null || centerPhase !== 'closed' || clockOverlayMounted || stageMenuOpen;

  const updateRevealed = useCallback((next: boolean) => {
    revealedRef.current = next;
    setRevealed(next);
  }, []);

  const clearAutohideTimers = useCallback(() => {
    if (revealTimerRef.current) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = 0;
    }
    if (concealTimerRef.current) {
      window.clearTimeout(concealTimerRef.current);
      concealTimerRef.current = 0;
    }
  }, []);

  const revealBar = useCallback(() => {
    clearAutohideTimers();
    updateRevealed(true);
  }, [clearAutohideTimers, updateRevealed]);

  const scheduleReveal = useCallback(() => {
    if (concealTimerRef.current) {
      window.clearTimeout(concealTimerRef.current);
      concealTimerRef.current = 0;
    }
    if (revealTimerRef.current) return;
    revealTimerRef.current = window.setTimeout(() => {
      revealTimerRef.current = 0;
      updateRevealed(true);
    }, 180);
  }, [updateRevealed]);

  const scheduleConceal = useCallback(() => {
    if (revealTimerRef.current) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = 0;
    }
    if (concealTimerRef.current) return;
    concealTimerRef.current = window.setTimeout(() => {
      concealTimerRef.current = 0;
      updateRevealed(false);
    }, 150);
  }, [updateRevealed]);

  useEffect(() => {
    clearAutohideTimers();
    updateRevealed(!autohide);
    return () => clearAutohideTimers();
  }, [autohide, clearAutohideTimers, updateRevealed]);

  // 浮层关闭后收起（指针仍悬停 / 焦点仍在栏内时保持展开，避免在光标下消失）
  useEffect(() => {
    if (!autohide || overlaysOpen) return;
    const bar = barRef.current;
    if (bar?.contains(document.activeElement)) return;
    let hovered = false;
    try {
      hovered = bar?.matches(':hover') ?? false;
    } catch {
      hovered = false;
    }
    if (hovered) return;
    scheduleConceal();
  }, [autohide, overlaysOpen, scheduleConceal]);

  // 设置读取：get_setting 启动回放（菜单栏 / 程序坞自动隐藏 + 当前壁纸）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [menubarRaw, dockRaw, wallpaperRaw] = await Promise.all([
          invoke<string | null>('get_setting', { key: MENUBAR_AUTOHIDE_SETTING_KEY }).catch(
            () => null,
          ),
          getSetting(DOCK_AUTOHIDE_SETTING_KEY).catch(() => null),
          getSetting(WALLPAPER_SETTING_KEY).catch(() => null),
        ]);
        if (cancelled) return;
        useMenuBarAutohideStore.getState().setSettingEnabled(String(menubarRaw ?? '') === 'true');
        setDockAutohide(String(dockRaw ?? '') === 'true');
        setWallpaper(parsePersistedWallpaper(wallpaperRaw, DEFAULT_WALLPAPER));
      } catch {
        // 读失败保持默认
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // workbench:settings-changed 热更新（集中走 useEventRegistry）
  const settingsEvents = useMemo(
    () => [
      {
        target: 'window' as const,
        type: 'workbench:settings-changed',
        listener: (event: Event) => {
          const { key, value } =
            (event as CustomEvent<{ key?: string; value?: unknown }>).detail ?? {};
          if (key === MENUBAR_AUTOHIDE_SETTING_KEY) {
            useMenuBarAutohideStore
              .getState()
              .setSettingEnabled(value === true || value === 'true');
          } else if (key === DOCK_AUTOHIDE_SETTING_KEY) {
            setDockAutohide(value === true || value === 'true');
          } else if (key === WALLPAPER_SETTING_KEY) {
            setWallpaper(parsePersistedWallpaper(value, DEFAULT_WALLPAPER));
          }
        },
      },
    ],
    [],
  );
  useEventRegistry(settingsEvents, [settingsEvents]);

  // autohide 时工作区顶到屏幕顶缘（menubar 变 overlay）；属性挂在桌面根上供 CSS 消费
  useEffect(() => {
    const root = barRef.current?.closest('[data-wb-workbench-root]');
    if (!(root instanceof HTMLElement)) return undefined;
    if (autohide) root.setAttribute('data-wb-menubar-autohide', 'true');
    else root.removeAttribute('data-wb-menubar-autohide');
    return () => root.removeAttribute('data-wb-menubar-autohide');
  }, [autohide]);

  const barHidden = autohide && !revealed && !overlaysOpen;

  const handleBarPointerEnter = useCallback(() => {
    if (!autohide) return;
    revealBar();
  }, [autohide, revealBar]);

  const handleBarPointerLeave = useCallback(() => {
    if (!autohide) return;
    // 焦点仍在菜单栏内（键盘用户）时不收起
    if (barRef.current?.contains(document.activeElement)) return;
    scheduleConceal();
  }, [autohide, scheduleConceal]);

  const handleBarFocusCapture = useCallback(() => {
    if (!autohide) return;
    revealBar();
  }, [autohide, revealBar]);

  const handleBarBlurCapture = useCallback(
    (event: React.FocusEvent) => {
      if (!autohide) return;
      const next = event.relatedTarget as Node | null;
      if (next && barRef.current?.contains(next)) return;
      scheduleConceal();
    },
    [autohide, scheduleConceal],
  );

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
    // Exposé 或统一搜索面板（⌘K）打开时收起全部菜单栏浮层
    if (exposeOpen || appsPanelOpen) {
      closeActiveMenu();
    }
  }, [exposeOpen, appsPanelOpen, closeActiveMenu]);

  useEffect(() => {
    // 阶段切换器紧凑菜单展开时收起顶栏互斥菜单
    if (stageMenuOpen) {
      closeActiveMenu();
    }
  }, [stageMenuOpen, closeActiveMenu]);

  // 离场相位：播完 wb-kf-window-close 再真正卸载（jsdom 无动画也走同一定时器）
  useEffect(() => {
    if (centerPhase !== 'closing') return undefined;
    const timer = window.setTimeout(() => setCenterPhase('closed'), MENUBAR_FLYOUT_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [centerPhase]);

  // 顶栏菜单展开期间若外部打开新窗口或切换焦点窗口，自动收起菜单并跳过焦点归还
  useEffect(() => {
    if (activeMenuId === null) return undefined;
    const initial = useWindowStore.getState();
    let prevTop = initial.focusStack[initial.focusStack.length - 1] ?? null;
    let prevWindowIds = new Set(Object.keys(initial.windows));

    return useWindowStore.subscribe((state) => {
      const nextTop = state.focusStack[state.focusStack.length - 1] ?? null;
      const nextWindowIds = Object.keys(state.windows);
      const hasNewWindow = nextWindowIds.some((id) => !prevWindowIds.has(id));
      const focusChanged = nextTop !== null && nextTop !== prevTop;

      if (hasNewWindow || focusChanged) {
        skipNextReturn();
        closeActiveMenu();
        return;
      }

      prevTop = nextTop;
      prevWindowIds = new Set(nextWindowIds);
    });
  }, [activeMenuId, closeActiveMenu, skipNextReturn]);

  // 展开任一顶栏菜单时：统一接管 Escape 关闭（优先于可编辑焦点拦截）与 ←/→ 相邻菜单循环切换
  const activeMenuKeyboardEvents = useMemo(() => {
    if (activeMenuId === null) return [];
    const onKeyDown: EventListener = (event) => {
      const e = event as KeyboardEvent;
      if (e.key === 'Escape') {
        if (isComposingKeyEvent(e)) return;
        if (
          e.target instanceof HTMLElement &&
          e.target.closest('[data-testid="wb-menubar-brand-rename-form"]')
        ) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        closeActiveMenu();
        return;
      }
      if (isEditableKeyboardTarget(e.target)) return;
      const isRangeInput =
        e.target instanceof HTMLInputElement && e.target.type === 'range';
      if (isRangeInput) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        cycleMenu(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        cycleMenu(-1);
      }
    };
    const onPointerDown: EventListener = (event) => {
      if (isInsideMenuBarOrPortal(event.target, barRef.current)) return;
      skipNextReturn();
      closeActiveMenu();
    };
    return [
      { target: 'window' as const, type: 'keydown', listener: onKeyDown, options: true },
      { target: 'document' as const, type: 'pointerdown', listener: onPointerDown, options: true },
    ];
  }, [activeMenuId, closeActiveMenu, cycleMenu, skipNextReturn]);
  useEventRegistry(activeMenuKeyboardEvents, [activeMenuKeyboardEvents]);

  useEffect(() => {
    if (!centerOpen) return undefined;
    const panel = panelRef.current;
    if (!panel) return undefined;

    const focusInitial = () => {
      const focusable = getFocusable(panel);
      (focusable[0] ?? panel).focus({ preventScroll: true });
    };
    const raf = window.requestAnimationFrame(focusInitial);
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [centerOpen]);

  // 控制中心 Tab 焦点陷阱（useEventRegistry）
  const centerFocusTrapEvents = useMemo(() => {
    if (!centerOpen) return [];
    const handleKeyDown: EventListener = (event) => {
      const e = event as KeyboardEvent;
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
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
    return [
      { target: 'document' as const, type: 'keydown', listener: handleKeyDown, options: true },
    ];
  }, [centerOpen]);
  useEventRegistry(centerFocusTrapEvents, [centerFocusTrapEvents]);

  const runAndClose = useCallback(
    (fn: () => void) => () => {
      skipNextReturn();
      closeActiveMenu();
      fn();
    },
    [closeActiveMenu, skipNextReturn],
  );

  // ---- macOS 27 控制中心 2×2 快捷玻璃磁贴动作 ----
  const handleToggleDockAutohide = useCallback(() => {
    const next = !dockAutohide;
    setDockAutohide(next);
    void persistWorkbenchSetting(DOCK_AUTOHIDE_SETTING_KEY, String(next), next);
  }, [dockAutohide]);

  const handleToggleMenuBarAutohide = useCallback(() => {
    const next = !menuBarAutohideSetting;
    useMenuBarAutohideStore.getState().setSettingEnabled(next);
    void persistWorkbenchSetting(MENUBAR_AUTOHIDE_SETTING_KEY, String(next), next);
  }, [menuBarAutohideSetting]);

  const handleCycleWallpaper = useCallback(() => {
    const currentIdx =
      wallpaper.kind === 'theme'
        ? WALLPAPER_PRESETS.findIndex((preset) => preset.id === wallpaper.value)
        : -1;
    const nextPreset = WALLPAPER_PRESETS[(currentIdx + 1) % WALLPAPER_PRESETS.length];
    const nextConfig: WallpaperConfig = { kind: 'theme', value: nextPreset.id };
    setWallpaper(nextConfig);
    void persistWorkbenchSetting(WALLPAPER_SETTING_KEY, JSON.stringify(nextConfig), nextConfig);
  }, [wallpaper]);

  const currentWallpaperName = useMemo(() => {
    if (wallpaper.kind === 'image') {
      return t('desktopMenu.customWallpaper');
    }
    const preset =
      WALLPAPER_PRESETS.find((item) => item.id === wallpaper.value) ?? WALLPAPER_PRESETS[0];
    return t(preset.nameKey);
  }, [wallpaper, t]);

  const handleFlyoutKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') {
      return;
    }
    const items = getFocusable(panel);
    if (items.length === 0) return;
    e.preventDefault();
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? items.indexOf(active) : -1;
    if (e.key === 'Home') {
      items[0]?.focus({ preventScroll: true });
      return;
    }
    if (e.key === 'End') {
      items[items.length - 1]?.focus({ preventScroll: true });
      return;
    }
    const nextIdx =
      e.key === 'ArrowDown'
        ? (idx + 1 + items.length) % items.length
        : idx <= 0
          ? items.length - 1
          : idx - 1;
    items[nextIdx]?.focus({ preventScroll: true });
  }, []);

  const handleDragMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (activeMenuId !== null) {
      closeActiveMenu();
    }
    if ((!macChrome && !winChromeInset) || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('[data-no-drag]')) return;
    event.preventDefault();
    if (event.detail === 2) {
      void getCurrentWindow().toggleMaximize();
      return;
    }
    void getCurrentWindow().startDragging();
  }, [activeMenuId, closeActiveMenu, macChrome, winChromeInset]);

  const automationRunning = automation?.runningCount ?? 0;
  const automationFailed = automation?.failedCount ?? 0;
  const automationEnabled = automation?.enabledCount ?? 0;
  const sharedBackdropTestId =
    activeMenuId === 'control-center'
      ? 'wb-menubar-flyout-backdrop'
      : activeMenuId === 'clock'
        ? 'wb-menubar-clock-backdrop'
        : 'wb-menubar-menu-backdrop';
  const clarityLabel = t('menubar.glassClarity', {
    defaultValue: isEnglish ? 'Liquid Glass' : '液态玻璃通透度',
  });
  const stateOnLabel = t('menubar.controlOn', { defaultValue: isEnglish ? 'On' : '已开启' });
  const stateOffLabel = t('menubar.controlOff', { defaultValue: isEnglish ? 'Off' : '已关闭' });
  const appearanceTitle = t('settings:appearance.appearance', {
    defaultValue: isEnglish ? 'Appearance' : '外观',
  });
  const appearanceState = isDarkMode
    ? t('settings:appearance.theme.dark', { defaultValue: isEnglish ? 'Dark' : '深色' })
    : t('settings:appearance.theme.light', { defaultValue: isEnglish ? 'Light' : '浅色' });

  return (
    <>
      {/* 单一共享外部点击关闭层：z-index 严格位于 .wb-menubar 之下，
          不阻挡菜单触发器之间的 pointerenter，实现 0ms 横滑切换 */}
      {activeMenuId !== null
        ? createPortal(
            <div
              className="wb-menubar-dismiss-backdrop"
              data-testid={sharedBackdropTestId}
              aria-hidden="true"
              onPointerDown={closeActiveMenu}
              onClick={closeActiveMenu}
              onContextMenu={(e) => {
                e.preventDefault();
                closeActiveMenu();
              }}
            />,
            document.body,
          )
        : null}

      {/* 顶缘 4px 热区：portal 到 body 且置于菜单栏 React 子树之外，
          避免 React 合成 enter/leave 沿 portal 父链冒泡到菜单栏（会绕过防误触延迟）。
          隐藏时负责滑出；滑出后指针未进入菜单栏就离开顶缘时负责收起
          （reveal/conceal 防误触参数与 Dock 一致）。 */}
      {autohide
        ? createPortal(
            <div
              className="wb-menubar-hotzone"
              data-testid="wb-menubar-hotzone"
              aria-hidden="true"
              onPointerEnter={scheduleReveal}
              onPointerLeave={() => {
                if (revealTimerRef.current) {
                  window.clearTimeout(revealTimerRef.current);
                  revealTimerRef.current = 0;
                }
                scheduleConceal();
              }}
            />,
            document.body,
          )
        : null}
    <div
      ref={barRef}
      className="wb-menubar"
      data-wb-menubar
      data-testid="wb-menubar"
      data-chrome-inset={winChromeInset ? 'windows' : undefined}
      data-macos-chrome={macChrome ? 'integrated' : undefined}
      data-autohide={autohide ? 'true' : undefined}
      data-hidden={barHidden ? 'true' : undefined}
      role="banner"
      aria-label={t('menubar.label')}
      onPointerEnter={handleBarPointerEnter}
      onPointerLeave={handleBarPointerLeave}
      onFocusCapture={handleBarFocusCapture}
      onBlurCapture={handleBarBlurCapture}
    >
      {macChrome || winChromeInset ? (
        <div
          className="wb-menubar-drag-region"
          data-testid="wb-menubar-drag-region"
          aria-hidden="true"
          onMouseDown={handleDragMouseDown}
        />
      ) : null}
      <div className="wb-menubar-leading" data-no-drag>
        {/* macOS 苹果菜单语义：品牌钮只留 logo，应用名由右侧聚焦应用菜单加粗显示 */}
        <button
          ref={brandButtonRef}
          type="button"
          className="wb-menubar-item wb-menubar-item-icon-only wb-menubar-brand"
          data-testid="wb-menubar-brand"
          aria-label={t('menubar.brandMenu')}
          aria-haspopup="menu"
          aria-expanded={brandMenuOpen}
          title={desktopName ?? t('menubar.appName')}
          onClick={() => toggleMenu('brand')}
          onPointerEnter={() => hoverMenu('brand')}
        >
          <DeepStudentMark className="wb-menubar-brand-mark" title="" />
        </button>
        <StatusBarBrandMenu
          open={brandMenuOpen}
          anchorRef={brandButtonRef}
          onClose={closeActiveMenu}
          hideBackdrop
          instantExit={activeMenuId !== null}
        />
        <StatusBarAppMenus
          activeMenuId={activeMenuId}
          onToggleMenu={toggleMenu}
          onHoverMenu={hoverMenu}
          onCloseMenu={closeActiveMenu}
        />
      </div>
      <div className="wb-menubar-stage-slot" data-no-drag>
        <StudyFlowStageSwitcher onOpenChange={setStageMenuOpen} />
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
            onBeforeNavigate={closeActiveMenu}
          />
        </div>

        <button
          type="button"
          className="wb-menubar-item wb-menubar-item-icon-only wb-menubar-settings"
          data-testid="wb-menubar-settings"
          aria-label={t('menubar.openSettings')}
          title={t('menubar.openSettings')}
          onClick={() => {
            closeActiveMenu();
            launchApp('settings');
          }}
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
          onClick={() => toggleMenu('control-center')}
          onPointerEnter={() => hoverMenu('control-center')}
        >
          <SquaresFour size={14} weight="duotone" className="wb-menubar-item-icon" aria-hidden />
        </button>

        {renderedCenterPhase !== 'closed' ? (
          <div
            ref={panelRef}
            className="wb-glass wb-glass-highlight wb-glass-lens wb-menubar-flyout wb-menubar-cc-flyout"
            data-open="true"
            data-phase={renderedCenterPhase}
            data-testid="wb-menubar-flyout"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            onKeyDown={handleFlyoutKeyDown}
          >
            <WallpaperReplica hostRef={panelRef} enabled />

            {/* macOS 27 控制中心顶部 2×2 快捷玻璃磁贴 */}
            <div
              className="wb-cc-grid"
              role="group"
              aria-label={t('menubar.controlCenterQuick', {
                defaultValue: isEnglish ? 'Quick Controls' : '快捷控制',
              })}
              data-testid="wb-menubar-cc-grid"
            >
              <DsButton
                variant="ghost"
                size="sm"
                className="wb-cc-tile"
                data-testid="wb-cc-tile-dock-autohide"
                data-active={dockAutohide ? 'true' : undefined}
                aria-pressed={dockAutohide}
                onClick={handleToggleDockAutohide}
              >
                <span className="wb-cc-tile-badge" aria-hidden="true">
                  <Rows size={15} weight={dockAutohide ? 'fill' : 'duotone'} />
                </span>
                <span className="wb-cc-tile-copy">
                  <span className="wb-cc-tile-label">{t('settings.dockAutohide.title')}</span>
                  <span className="wb-cc-tile-sub">
                    {dockAutohide ? stateOnLabel : stateOffLabel}
                  </span>
                </span>
              </DsButton>

              <DsButton
                variant="ghost"
                size="sm"
                className="wb-cc-tile"
                data-testid="wb-cc-tile-menubar-autohide"
                data-active={menuBarAutohideSetting ? 'true' : undefined}
                aria-pressed={menuBarAutohideSetting}
                onClick={handleToggleMenuBarAutohide}
              >
                <span className="wb-cc-tile-badge" aria-hidden="true">
                  <Browser size={15} weight={menuBarAutohideSetting ? 'fill' : 'duotone'} />
                </span>
                <span className="wb-cc-tile-copy">
                  <span className="wb-cc-tile-label">{t('settings.menubarAutohide.title')}</span>
                  <span className="wb-cc-tile-sub">
                    {menuBarAutohideSetting ? stateOnLabel : stateOffLabel}
                  </span>
                </span>
              </DsButton>

              <DsButton
                variant="ghost"
                size="sm"
                className="wb-cc-tile"
                data-testid="wb-cc-tile-theme"
                data-active={isDarkMode ? 'true' : undefined}
                aria-pressed={isDarkMode}
                onClick={toggleDarkMode}
              >
                <span className="wb-cc-tile-badge" aria-hidden="true">
                  {isDarkMode ? <Moon size={15} weight="fill" /> : <Sun size={15} weight="duotone" />}
                </span>
                <span className="wb-cc-tile-copy">
                  <span className="wb-cc-tile-label">{appearanceTitle}</span>
                  <span className="wb-cc-tile-sub">{appearanceState}</span>
                </span>
              </DsButton>

              <DsButton
                variant="ghost"
                size="sm"
                className="wb-cc-tile"
                data-testid="wb-cc-tile-wallpaper"
                onClick={handleCycleWallpaper}
              >
                <span className="wb-cc-tile-badge" aria-hidden="true">
                  <Image size={15} weight="duotone" />
                </span>
                <span className="wb-cc-tile-copy">
                  <span className="wb-cc-tile-label">{t('settings.wallpaper.title')}</span>
                  <span className="wb-cc-tile-sub">{currentWallpaperName}</span>
                </span>
              </DsButton>
            </div>

            {/* macOS 27 Liquid Glass 连续通透度滑块 */}
            <div className="wb-cc-clarity" data-testid="wb-cc-clarity">
              <div className="wb-cc-clarity-header">
                <label htmlFor={claritySliderId} className="wb-cc-clarity-label">
                  {clarityLabel}
                </label>
                <span className="wb-cc-clarity-value" data-testid="wb-cc-clarity-value">
                  {clarity}%
                </span>
              </div>
              <div className="wb-cc-clarity-track">
                <DropHalf
                  size={15}
                  weight="duotone"
                  className="wb-cc-clarity-icon"
                  aria-hidden="true"
                />
                <input
                  id={claritySliderId}
                  type="range"
                  min={MIN_GLASS_CLARITY}
                  max={MAX_GLASS_CLARITY}
                  step={1}
                  value={clarity}
                  className="wb-cc-clarity-slider"
                  data-testid="wb-cc-clarity-slider"
                  aria-label={clarityLabel}
                  aria-valuemin={MIN_GLASS_CLARITY}
                  aria-valuemax={MAX_GLASS_CLARITY}
                  aria-valuenow={clarity}
                  aria-valuetext={`${clarity}%`}
                  style={{ '--wb-slider-pct': `${clarity}%` } as React.CSSProperties}
                  onChange={(e) => setClarity(Number(e.target.value))}
                />
                <Drop
                  size={15}
                  weight="duotone"
                  className="wb-cc-clarity-icon"
                  aria-hidden="true"
                />
              </div>
            </div>

            {/* 下方完整保留原有的今日学习节律快捷入口 */}
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

              <RhythmReviewRows onPick={runAndClose} />

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
        ) : null}

        {/* 时钟居右端（macOS 菜单栏时钟落位）；点击展开今日日程 flyout */}
        <StatusBarClock
          open={clockMenuOpen}
          onToggle={() => toggleMenu('clock')}
          onHoverTrigger={() => hoverMenu('clock')}
          onClose={closeActiveMenu}
          onOpenChange={setClockOverlayMounted}
          hideBackdrop
          instantExit={activeMenuId !== null}
        />

        {/* Windows：三键直接融入顶栏最右端（无独立胶囊/logo），拖拽由整条 drag-region 接管 */}
        {winChromeInset ? (
          <div
            className="wb-menubar-window-controls"
            data-testid="wb-menubar-window-controls"
            data-no-drag
          >
            <WindowControls />
          </div>
        ) : null}
      </div>
    </div>
    </>
  );
};

export const StatusBar = React.memo(StatusBarComponent);
StatusBar.displayName = 'StatusBar';

export default StatusBar;
