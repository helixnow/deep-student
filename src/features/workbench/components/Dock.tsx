/**
 * Dock（P5 → O5 → Liquid Glass 灵魂重塑）— 底部居中悬浮启动器 / 切换器
 *
 * - 固定区（DockPinnedStore，快照接线 P11）+ 运行区（store 中有窗的 typeId 去重）
 *   + 最小化窗口缩略槽位（最多 3 张微缩玻璃窗口卡 + `+N` 溢出入口）
 *   + 分隔符 + 右侧统一玻璃底座的「全部应用 / AI 操控中心」入口
 * - 60fps 连续波浪放大（dockMagnification.ts + dockMagnificationStore.ts）：
 *   单监听器 pointermove + rAF 驱动 `.wb-dock-mag` 实时缩放、向上抬升与邻近推开，
 *   指针离场以弹簧曲线回弹至 1.0；reduced-motion / coarse / minimal 自动禁用
 * - 0ms 连续 Tooltip 会话：首次悬停 ~70ms 显现，Dock 内横划相邻图标 0ms 即时切换，
 *   气泡随放大顶边自动抬升
 * - Liquid Glass 光学细节：接入 `.wb-glass-rim` 360° 1px 镜面环 + `--wb-dock-cursor-x`
 *   克制扫光 + 同心圆几何内边距 + 柔和底部接触投影 + 去除自动隐藏呼吸条
 * - 键盘可达：roving tabindex（←/→/Home/End 移动）
 * - dockGeometry：布局变化时 rAF 防抖发布各静止 wrap 的视口坐标，供 Genie 动画消费
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDown, CaretUp, SquaresFour } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { cn } from '../../../lib/utils';
import { appRegistry } from '../core/appRegistry';
import { useWindowStore } from '../core/windowStore';
import { getSortedWindows } from '../core/windowListCache';
import { useMaterialTier } from '../core/materialTier';
import { useDockMagnificationEffective } from '../core/dockMagnificationStore';
import { useDockLiquidGlassFilter } from './dockLiquidGlass';
import { DockItem } from './DockItem';
import { DockContextMenu } from './DockContextMenu';
import { useDockPinned } from './DockPinnedStore';
import {
  clearDockGeometry,
  getMinimizedDockItemKey,
  publishDockIconRects,
  registerDockGeometryMeasurer,
  type DockIconRect,
} from './dockGeometry';
import {
  DEFAULT_MAG_ICON_SIZE_PX,
  DEFAULT_MAG_RADIUS_PX,
  computeDockCursorPercent,
  computeDockMagnification,
} from './dockMagnification';
import {
  APPS_DOCK_TYPE_ID,
  closeAppsPanel,
  isAppsPanelOpen,
  toggleAppsPanel,
  useAppsPanelOpen,
} from './appsPanelStore';
import { useImmersiveWindowId } from '../core/immersiveMode';
import { useComposerDockHeight } from '@/hooks/useComposerDockHeight';
import {
  AGENT_CONTROL_DOCK_ID,
  AgentControlDockEntry,
} from './AgentControlCenter';
import { startDockAgentBadgeTracking } from '../agent/visuals/dockBadgeStore';
import './Dock.css';

export {
  getDockPinned,
  setDockPinned,
  toggleDockPinned,
  pinDockItemAt,
  unpinDockItem,
  reorderDockPinned,
  subscribeDockPinned,
  useDockPinned,
  useDockPinnedDragReorder,
  useDockRunningDragToPin,
} from './DockPinnedStore';

export interface DockMobileClearanceState {
  revealed: boolean;
  clearancePx: number;
}

export interface DockProps {
  /** 自动隐藏（设置接线 P11）：隐藏至底缘 4px 热区 */
  autohide?: boolean;
  /** Dock 尺寸百分比，默认 100，桌面设置范围 75..125 */
  size?: number;
  className?: string;
  /** 窄屏（<= 767px）程序坞展开/收起时的底部布局让位高度回调 */
  onMobileClearanceChange?: (state: DockMobileClearanceState) => void;
}

/** 首次悬停 Tooltip 显现延迟（ms）；会话激活后横划相邻图标 0ms 即时切换 */
export const DOCK_TOOLTIP_INITIAL_DELAY_MS = 70;
/** 图标间隙内维持 Tooltip 会话热态的宽限时间（ms） */
export const DOCK_TOOLTIP_SESSION_GRACE_MS = 140;
/** 最小化窗口缩略槽位最多直接展示张数，超出归入 +N 溢出入口 */
export const DOCK_MAX_MINIMIZED_SLOTS = 3;

const MINIMIZED_OVERFLOW_DOCK_ID = '__minimized_overflow__';
const DOCK_COLLAPSE_ID = '__dock_collapse__';
const MOBILE_DOCK_FALLBACK_HEIGHT_PX = 58;
const MOBILE_DOCK_FALLBACK_BOTTOM_PX = 4;
const MOBILE_DOCK_CLEARANCE_GAP_PX = 10;
/** 窄屏（<= 767px）收起态底部唤出把手专属让位高度（>= 36–44px 触控热区，避免与聊天 `+` 附件按钮重叠） */
export const MOBILE_DOCK_HANDLE_CLEARANCE_PX = 40;
/** 触控唤出后忽略浏览器补发合成 click 的保护窗口（ms） */
const HOTZONE_TOUCH_CLICK_GUARD_MS = 450;

function computeMobileDockClearancePx(dockEl: HTMLElement | null, scale: number): number {
  const measuredHeight = dockEl?.offsetHeight ?? 0;
  const dockHeight =
    measuredHeight > 0 ? measuredHeight : Math.ceil(MOBILE_DOCK_FALLBACK_HEIGHT_PX * scale);
  let bottomOffset = MOBILE_DOCK_FALLBACK_BOTTOM_PX;
  if (dockEl && typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    const parsed = Number.parseFloat(window.getComputedStyle(dockEl).bottom);
    if (Number.isFinite(parsed) && parsed >= 0) {
      bottomOffset = parsed;
    }
  }
  return Math.ceil(dockHeight + bottomOffset + MOBILE_DOCK_CLEARANCE_GAP_PX);
}

function useRegistryVersion(): void {
  const [, setVersion] = React.useState(0);
  React.useEffect(() => appRegistry.subscribe(() => setVersion((v) => v + 1)), []);
}

// ---------------------------------------------------------------------------
// rAF 调度（jsdom / 非可视环境兜底 setTimeout）
// ---------------------------------------------------------------------------

function rafSchedule(cb: FrameRequestCallback): number {
  if (typeof window.requestAnimationFrame === 'function') return window.requestAnimationFrame(cb);
  return window.setTimeout(() => cb(performance.now()), 16) as unknown as number;
}

function rafCancel(id: number): void {
  if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(id);
  else window.clearTimeout(id);
}

/** DockItem 图标层的发现属性（DockItem.tsx 渲染，勿改动字面量；dockGeometry 与放大引擎共同消费） */
const MAG_ITEM_ATTR = 'data-wb-dock-mag-item';

interface CachedMagEntry {
  wrap: HTMLElement;
  magEl: HTMLElement;
  centerX: number;
}

// ---------------------------------------------------------------------------
// Dock
// ---------------------------------------------------------------------------

const DOCK_COMPACT_COLLAPSED_STORAGE_KEY = 'wb.dock.compactCollapsed';
const WORKBENCH_ACTIVE_SESSION_STORAGE_KEY = 'ds.workbench.activeSession';

function hasPersistedCompactDockCollapse(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return (
      window.sessionStorage?.getItem(DOCK_COMPACT_COLLAPSED_STORAGE_KEY) === '1' ||
      window.sessionStorage?.getItem(WORKBENCH_ACTIVE_SESSION_STORAGE_KEY) === '1'
    );
  } catch {
    return false;
  }
}

function writePersistedCompactDockCollapse(collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (collapsed) {
      window.sessionStorage?.setItem(DOCK_COMPACT_COLLAPSED_STORAGE_KEY, '1');
    } else {
      window.sessionStorage?.removeItem(DOCK_COMPACT_COLLAPSED_STORAGE_KEY);
    }
  } catch {
    // 隐私模式/受限环境忽略存储异常
  }
}

function DockImpl({
  autohide = false,
  size = 100,
  className,
  onMobileClearanceChange,
}: DockProps) {
  const { t } = useTranslation();
  useRegistryVersion();

  // ACR 4.0（A5 跨界最小接线）：agent 后台完成角标——Dock 存续期间订阅
  // presence/windowStore（只读），角标渲染在 DockItem 内
  React.useEffect(() => startDockAgentBadgeTracking(), []);

  const appsPanelOpen = useAppsPanelOpen();
  const immersiveWindowId = useImmersiveWindowId();
  const composerDockHeight = useComposerDockHeight();
  const desktopWidth = useWindowStore((s) => s.desktopSize.w);
  const readCompactViewport = React.useCallback((): boolean => {
    if (typeof window === 'undefined') return false;
    if (typeof window.matchMedia === 'function') {
      if (
        window.matchMedia('(max-width: 767px)')?.matches ||
        window.matchMedia('(max-width: 640px)')?.matches
      ) {
        return true;
      }
    }
    return window.innerWidth > 0 && window.innerWidth <= 767;
  }, []);
  const [mqlCompactViewport, setMqlCompactViewport] = React.useState(readCompactViewport);
  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const syncViewport = () => setMqlCompactViewport(readCompactViewport());
    syncViewport();
    const mqlMobile =
      typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 767px)') : null;
    const mqlNarrow =
      typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 640px)') : null;
    mqlMobile?.addEventListener?.('change', syncViewport);
    mqlNarrow?.addEventListener?.('change', syncViewport);
    window.addEventListener('resize', syncViewport);
    return () => {
      mqlMobile?.removeEventListener?.('change', syncViewport);
      mqlNarrow?.removeEventListener?.('change', syncViewport);
      window.removeEventListener('resize', syncViewport);
    };
  }, [readCompactViewport]);
  const isCompactViewport = mqlCompactViewport || (desktopWidth > 0 && desktopWidth <= 767);

  const [isTypingInComposer, setIsTypingInComposer] = React.useState(false);
  const composerBlurTimerRef = React.useRef(0);
  React.useEffect(() => {
    if (composerBlurTimerRef.current) {
      window.clearTimeout(composerBlurTimerRef.current);
      composerBlurTimerRef.current = 0;
    }
    if (!isCompactViewport || composerDockHeight === null) {
      setIsTypingInComposer(false);
      return undefined;
    }
    const isComposerField = (el: Element | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      if (!el.matches('textarea, input, [contenteditable="true"]')) return false;
      return Boolean(
        el.closest('.unified-input-docked, [data-composer-panel-anchor], [data-testid="chat-input"]'),
      );
    };
    const handleFocusIn = (ev: FocusEvent) => {
      if (composerBlurTimerRef.current) {
        window.clearTimeout(composerBlurTimerRef.current);
        composerBlurTimerRef.current = 0;
      }
      setIsTypingInComposer(isComposerField((ev.target as Element | null) ?? document.activeElement));
    };
    const handleFocusOut = (ev: FocusEvent) => {
      const nextTarget = ev.relatedTarget as Element | null;
      if (isComposerField(nextTarget)) {
        if (composerBlurTimerRef.current) {
          window.clearTimeout(composerBlurTimerRef.current);
          composerBlurTimerRef.current = 0;
        }
        setIsTypingInComposer(true);
        return;
      }
      // 延迟过 click 时窗再复位，避免 360px 窄屏点「发送/添加与会话选项」时 Dock 立即弹出压住按钮
      if (composerBlurTimerRef.current) window.clearTimeout(composerBlurTimerRef.current);
      composerBlurTimerRef.current = window.setTimeout(() => {
        composerBlurTimerRef.current = 0;
        setIsTypingInComposer(isComposerField(document.activeElement));
      }, 260);
    };
    setIsTypingInComposer(isComposerField(document.activeElement));
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    return () => {
      if (composerBlurTimerRef.current) {
        window.clearTimeout(composerBlurTimerRef.current);
        composerBlurTimerRef.current = 0;
      }
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
    };
  }, [isCompactViewport, composerDockHeight]);

  const hasOpenWindow = useWindowStore((s) =>
    Object.values(s.windows).some((w) => !w.minimized),
  );
  const [compactCollapsedPersisted, setCompactCollapsedPersisted] = React.useState(() =>
    hasPersistedCompactDockCollapse(),
  );
  const hadOpenWindowRef = React.useRef(hasOpenWindow);
  React.useEffect(() => {
    const prevOpen = hadOpenWindowRef.current;
    hadOpenWindowRef.current = hasOpenWindow;
    if (!isCompactViewport) return;
    if (hasOpenWindow) {
      setCompactCollapsedPersisted(true);
      writePersistedCompactDockCollapse(true);
    } else if (prevOpen) {
      setCompactCollapsedPersisted(false);
      writePersistedCompactDockCollapse(false);
    }
  }, [isCompactViewport, hasOpenWindow]);

  const effectiveAutohide =
    autohide ||
    Boolean(immersiveWindowId) ||
    isTypingInComposer ||
    (isCompactViewport && (hasOpenWindow || compactCollapsedPersisted));
  const pinned = useDockPinned();
  const tier = useMaterialTier();
  const {
    effectiveEnabled: magEnabled,
    maxScale: magMaxScale,
    prefersReducedMotion,
  } = useDockMagnificationEffective();

  // 运行区指纹：有窗口的 typeId 按最早开窗时间保序去重后 join。
  const runningKey = useWindowStore((s) => {
    const ordered = getSortedWindows(s.windows);
    const seen: string[] = [];
    for (const win of ordered) {
      if (!seen.includes(win.typeId)) seen.push(win.typeId);
    }
    return seen.join('|');
  });
  const runningTypeIds = React.useMemo(
    () => (runningKey ? runningKey.split('|') : []),
    [runningKey],
  );

  // 最小化窗口指纹：收集所有 minimized === true 的窗口，按开窗顺序排布
  const minimizedKey = useWindowStore((s) =>
    getSortedWindows(s.windows)
      .filter((w) => w.minimized)
      .map((w) => `${w.id}:${w.typeId}:${w.title}`)
      .join('|'),
  );
  const minimizedWindows = React.useMemo(
    () => getSortedWindows(useWindowStore.getState().windows).filter((w) => w.minimized),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- minimizedKey 即最小化窗口数据指纹
    [minimizedKey],
  );
  const visibleMinimized = minimizedWindows.slice(0, DOCK_MAX_MINIMIZED_SLOTS);
  const overflowMinimized = minimizedWindows.slice(DOCK_MAX_MINIMIZED_SLOTS);

  const [overflowOpen, setOverflowOpen] = React.useState(false);
  const overflowWrapRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (overflowOpen && overflowMinimized.length === 0) {
      setOverflowOpen(false);
    }
  }, [overflowOpen, overflowMinimized.length]);

  const onOverflowOutsidePointerDown = React.useCallback((event: Event) => {
    if (!overflowWrapRef.current?.contains(event.target as Node)) {
      setOverflowOpen(false);
    }
  }, []);

  const onOverflowKeyDown = React.useCallback((event: Event) => {
    if ((event as KeyboardEvent).key === 'Escape') {
      setOverflowOpen(false);
    }
  }, []);

  useEventRegistry(
    overflowOpen
      ? [
          { target: 'document', type: 'pointerdown', listener: onOverflowOutsidePointerDown },
          { target: 'document', type: 'keydown', listener: onOverflowKeyDown },
        ]
      : [],
    [overflowOpen, onOverflowOutsidePointerDown, onOverflowKeyDown],
  );

  const runningExtra = runningTypeIds.filter((id) => !pinned.includes(id));
  const appOrderedIds = [...pinned, ...runningExtra];
  const minimizedSlotIds = [
    ...visibleMinimized.map((w) => getMinimizedDockItemKey(w.id)),
    ...(overflowMinimized.length > 0 ? [MINIMIZED_OVERFLOW_DOCK_ID] : []),
  ];
  const orderedIds = [
    ...appOrderedIds,
    ...minimizedSlotIds,
    APPS_DOCK_TYPE_ID,
    AGENT_CONTROL_DOCK_ID,
    ...(isCompactViewport && effectiveAutohide ? [DOCK_COLLAPSE_ID] : []),
  ];
  const orderedKey = orderedIds.join('|');
  const normalizedSize = Number.isFinite(size) ? size : 100;
  const dockScale = Math.max(0.75, Math.min(1.25, normalizedSize / 100));

  // ---- roving tabindex ----
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const effectiveActiveId =
    activeId && orderedIds.includes(activeId) ? activeId : orderedIds[0] ?? null;
  const itemButtonRefs = React.useRef(new Map<string, HTMLButtonElement>());

  const registerButtonRef = (typeId: string) => (el: HTMLButtonElement | null) => {
    if (el) itemButtonRefs.current.set(typeId, el);
    else itemButtonRefs.current.delete(typeId);
  };

  const handleToolbarKeyDown = (event: React.KeyboardEvent) => {
    if (orderedIds.length === 0) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    if (
      (event.target as HTMLElement | null)?.closest(
        '[data-testid="wb-dock-window-list"], [data-testid="wb-dock-minimized-overflow-list"]',
      )
    ) {
      return;
    }
    event.preventDefault();
    const count = orderedIds.length;
    const currentIndex = effectiveActiveId ? orderedIds.indexOf(effectiveActiveId) : 0;
    let nextIndex = currentIndex;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + count) % count;
    else if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % count;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = count - 1;
    const nextId = orderedIds[nextIndex];
    setActiveId(nextId);
    itemButtonRefs.current.get(nextId)?.focus();
  };

  // ---- 0ms 连续 Tooltip 会话（首次 ~70ms，Dock 内横划 0ms 即时切换）----
  const [hoveredTipId, setHoveredTipId] = React.useState<string | null>(null);
  const [tipSessionActive, setTipSessionActive] = React.useState(false);
  const tipSessionActiveRef = React.useRef(false);
  const tipOpenTimerRef = React.useRef(0);
  const tipGraceTimerRef = React.useRef(0);

  const clearTipTimers = React.useCallback(() => {
    if (tipOpenTimerRef.current) {
      window.clearTimeout(tipOpenTimerRef.current);
      tipOpenTimerRef.current = 0;
    }
    if (tipGraceTimerRef.current) {
      window.clearTimeout(tipGraceTimerRef.current);
      tipGraceTimerRef.current = 0;
    }
  }, []);

  const resetTipSession = React.useCallback(() => {
    clearTipTimers();
    tipSessionActiveRef.current = false;
    setTipSessionActive(false);
    setHoveredTipId(null);
  }, [clearTipTimers]);

  const handleTipItemEnter = React.useCallback(
    (itemId: string) => {
      clearTipTimers();
      if (tipSessionActiveRef.current) {
        setHoveredTipId(itemId);
        return;
      }
      tipOpenTimerRef.current = window.setTimeout(() => {
        tipOpenTimerRef.current = 0;
        tipSessionActiveRef.current = true;
        setTipSessionActive(true);
        setHoveredTipId(itemId);
      }, DOCK_TOOLTIP_INITIAL_DELAY_MS);
    },
    [clearTipTimers],
  );

  const handleTipItemLeave = React.useCallback(() => {
    if (tipOpenTimerRef.current) {
      window.clearTimeout(tipOpenTimerRef.current);
      tipOpenTimerRef.current = 0;
    }
    if (tipGraceTimerRef.current) {
      window.clearTimeout(tipGraceTimerRef.current);
    }
    tipGraceTimerRef.current = window.setTimeout(() => {
      tipGraceTimerRef.current = 0;
      tipSessionActiveRef.current = false;
      setTipSessionActive(false);
      setHoveredTipId(null);
    }, DOCK_TOOLTIP_SESSION_GRACE_MS);
  }, []);

  React.useEffect(() => () => clearTipTimers(), [clearTipTimers]);

  // ---- autohide（reveal ~180ms / conceal ~150ms 防误触；离开热区取消）----
  const [revealed, setRevealed] = React.useState(!effectiveAutohide);
  const [revealing, setRevealing] = React.useState(false);
  const revealedRef = React.useRef(!effectiveAutohide);
  const clickRevealedRef = React.useRef(false);
  const revealTimerRef = React.useRef(0);
  const concealTimerRef = React.useRef(0);
  const hotzoneRef = React.useRef<HTMLButtonElement | null>(null);
  const lastTouchRevealAtRef = React.useRef(0);

  const updateRevealed = React.useCallback((next: boolean) => {
    revealedRef.current = next;
    setRevealed(next);
  }, []);

  const [holdClearanceForPointer, setHoldClearanceForPointer] = React.useState(false);
  const holdClearanceReleaseTimerRef = React.useRef(0);
  const holdClearanceSafetyTimerRef = React.useRef(0);

  const clearHoldClearanceTimers = React.useCallback(() => {
    if (holdClearanceReleaseTimerRef.current) {
      window.clearTimeout(holdClearanceReleaseTimerRef.current);
      holdClearanceReleaseTimerRef.current = 0;
    }
    if (holdClearanceSafetyTimerRef.current) {
      window.clearTimeout(holdClearanceSafetyTimerRef.current);
      holdClearanceSafetyTimerRef.current = 0;
    }
  }, []);

  const releaseHoldClearance = React.useCallback(() => {
    clearHoldClearanceTimers();
    setHoldClearanceForPointer(false);
  }, [clearHoldClearanceTimers]);

  const scheduleHoldClearanceRelease = React.useCallback(() => {
    if (holdClearanceReleaseTimerRef.current) return;
    holdClearanceReleaseTimerRef.current = window.setTimeout(() => {
      holdClearanceReleaseTimerRef.current = 0;
      releaseHoldClearance();
    }, 0);
  }, [releaseHoldClearance]);

  const revealDock = React.useCallback(
    (viaClick = false) => {
      releaseHoldClearance();
      if (viaClick) {
        clickRevealedRef.current = true;
        if (isCompactViewport && !hasOpenWindow) {
          setCompactCollapsedPersisted(false);
          writePersistedCompactDockCollapse(false);
        }
      }
      if (!revealedRef.current) setRevealing(true);
      updateRevealed(true);
    },
    [hasOpenWindow, isCompactViewport, releaseHoldClearance, updateRevealed],
  );

  const clearAutohideTimers = React.useCallback(() => {
    if (revealTimerRef.current) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = 0;
    }
    if (concealTimerRef.current) {
      window.clearTimeout(concealTimerRef.current);
      concealTimerRef.current = 0;
    }
  }, []);

  const scheduleReveal = React.useCallback(() => {
    if (concealTimerRef.current) {
      window.clearTimeout(concealTimerRef.current);
      concealTimerRef.current = 0;
    }
    if (revealTimerRef.current) return;
    revealTimerRef.current = window.setTimeout(() => {
      revealTimerRef.current = 0;
      revealDock();
    }, 180);
  }, [revealDock]);

  const concealDockImmediate = React.useCallback(() => {
    setOverflowOpen(false);
    clickRevealedRef.current = false;
    clearAutohideTimers();
    setRevealing(false);
    updateRevealed(false);
    if (isCompactViewport) {
      setCompactCollapsedPersisted(true);
      writePersistedCompactDockCollapse(true);
    }
  }, [clearAutohideTimers, isCompactViewport, updateRevealed]);

  const scheduleConceal = React.useCallback(() => {
    if (revealTimerRef.current) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = 0;
    }
    if (!revealedRef.current || concealTimerRef.current) return;
    concealTimerRef.current = window.setTimeout(() => {
      concealTimerRef.current = 0;
      clickRevealedRef.current = false;
      setRevealing(false);
      updateRevealed(false);
      if (isCompactViewport) {
        setCompactCollapsedPersisted(true);
        writePersistedCompactDockCollapse(true);
      }
    }, 150);
  }, [isCompactViewport, updateRevealed]);

  React.useEffect(() => {
    clearAutohideTimers();
    clickRevealedRef.current = false;
    setRevealing(false);
    updateRevealed(!effectiveAutohide);
    return () => clearAutohideTimers();
  }, [effectiveAutohide, clearAutohideTimers, updateRevealed]);

  // 窄屏（< 768px）切换/新开前台窗后立即收起 Dock，避免遮挡目标窗底部 CTA
  const topFocusId = useWindowStore((s) => s.focusStack[s.focusStack.length - 1] ?? null);
  const prevTopFocusRef = React.useRef<string | null>(topFocusId);
  React.useEffect(() => {
    const prev = prevTopFocusRef.current;
    prevTopFocusRef.current = topFocusId;
    if (!isCompactViewport || !hasOpenWindow || prev === topFocusId) return;
    concealDockImmediate();
  }, [topFocusId, isCompactViewport, hasOpenWindow, concealDockImmediate]);
  const hidden = effectiveAutohide && !revealed;

  const dockZoneRef = React.useRef<HTMLDivElement | null>(null);
  const dockRef = React.useRef<HTMLDivElement | null>(null);
  useDockLiquidGlassFilter(dockRef, !hidden && tier === 'full');
  const isInsideDockPortal = React.useCallback((target: Node | null): boolean => {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest('.wb-agent-control-popover'));
  }, []);
  const hasOpenAgentControlPopover = React.useCallback((): boolean => {
    if (typeof document === 'undefined') return false;
    return document.querySelector('.wb-agent-control-popover[data-state="open"]') !== null;
  }, []);
  const onAutohideOutsidePointerDown = React.useCallback(
    (event: Event) => {
      const target = event.target as Node | null;
      if (
        dockRef.current?.contains(target) ||
        hotzoneRef.current?.contains(target) ||
        isInsideDockPortal(target)
      ) {
        return;
      }
      if (isCompactViewport && effectiveAutohide && revealedRef.current) {
        // 指针按下期间保持布局让位直至 pointerup/click 结算，防止发送按钮在松手前下移错位导致无法一次点中
        clearHoldClearanceTimers();
        setHoldClearanceForPointer(true);
      }
      concealDockImmediate();
    },
    [
      clearHoldClearanceTimers,
      concealDockImmediate,
      effectiveAutohide,
      isCompactViewport,
      isInsideDockPortal,
    ],
  );
  const onAutohideOutsideClick = React.useCallback(
    (event: Event) => {
      const target = event.target as Node | null;
      if (
        dockRef.current?.contains(target) ||
        hotzoneRef.current?.contains(target) ||
        isInsideDockPortal(target)
      ) {
        return;
      }
      concealDockImmediate();
    },
    [concealDockImmediate, isInsideDockPortal],
  );
  const onAutohideOutsideFocusIn = React.useCallback(
    (event: Event) => {
      const target = event.target as Node | null;
      if (
        !target ||
        target === document ||
        target === document.body ||
        target === document.documentElement
      ) {
        return;
      }
      if (
        dockRef.current?.contains(target) ||
        hotzoneRef.current?.contains(target) ||
        isInsideDockPortal(target)
      ) {
        return;
      }
      concealDockImmediate();
    },
    [concealDockImmediate, isInsideDockPortal],
  );
  const onAutohideKeyDown = React.useCallback(
    (event: Event) => {
      const ke = event as KeyboardEvent;
      if (ke.key !== 'Escape' || ke.isComposing || ke.keyCode === 229) return;
      // AI 桌面操控弹层打开时优先让弹层消费 Escape，避免先收起 Dock 却把弹层留在原地。
      if (hasOpenAgentControlPopover()) return;
      if (!isAppsPanelOpen()) {
        ke.preventDefault();
        ke.stopPropagation();
      }
      if (
        dockRef.current?.contains(document.activeElement) &&
        document.activeElement instanceof HTMLElement
      ) {
        document.activeElement.blur();
      }
      concealDockImmediate();
    },
    [concealDockImmediate, hasOpenAgentControlPopover],
  );
  useEventRegistry(
    effectiveAutohide && revealed
      ? [
          {
            target: 'document',
            type: 'pointerdown',
            listener: onAutohideOutsidePointerDown,
            options: true,
          },
          {
            target: 'document',
            type: 'click',
            listener: onAutohideOutsideClick,
            options: true,
          },
          {
            target: 'document',
            type: 'focusin',
            listener: onAutohideOutsideFocusIn,
          },
          {
            target: 'window',
            type: 'keydown',
            listener: onAutohideKeyDown,
            options: true,
          },
        ]
      : [],
    [
      effectiveAutohide,
      revealed,
      onAutohideOutsidePointerDown,
      onAutohideOutsideClick,
      onAutohideOutsideFocusIn,
      onAutohideKeyDown,
    ],
  );
  useEventRegistry(
    holdClearanceForPointer
      ? [
          {
            target: 'window',
            type: 'pointerup',
            listener: scheduleHoldClearanceRelease,
            options: true,
          },
          {
            target: 'window',
            type: 'pointercancel',
            listener: releaseHoldClearance,
            options: true,
          },
          {
            target: 'window',
            type: 'blur',
            listener: releaseHoldClearance,
          },
        ]
      : [],
    [holdClearanceForPointer, scheduleHoldClearanceRelease, releaseHoldClearance],
  );
  React.useEffect(() => {
    if (!holdClearanceForPointer) return undefined;
    holdClearanceSafetyTimerRef.current = window.setTimeout(() => {
      holdClearanceSafetyTimerRef.current = 0;
      releaseHoldClearance();
    }, 400);
    return () => clearHoldClearanceTimers();
  }, [holdClearanceForPointer, clearHoldClearanceTimers, releaseHoldClearance]);

  const mobileClearanceActive =
    isCompactViewport && ((effectiveAutohide && revealed) || holdClearanceForPointer);
  const mobileCollapsedHandleActive =
    isCompactViewport && effectiveAutohide && hidden && !holdClearanceForPointer;
  const clearanceTargetsRef = React.useRef<Set<HTMLElement>>(new Set());
  const lastReportedClearanceRef = React.useRef<DockMobileClearanceState | null>(null);
  const syncMobileDockClearance = React.useCallback(() => {
    if (typeof document === 'undefined') return;
    const clearancePx = mobileClearanceActive
      ? computeMobileDockClearancePx(dockRef.current, dockScale)
      : 0;
    const revealedFlag = mobileClearanceActive && clearancePx > 0;
    const collapsedHandleFlag = mobileCollapsedHandleActive && !revealedFlag;
    const handleClearancePx = collapsedHandleFlag ? MOBILE_DOCK_HANDLE_CLEARANCE_PX : 0;
    const targets: HTMLElement[] = [document.documentElement];
    const wbRoot = dockZoneRef.current?.closest<HTMLElement>('[data-wb-workbench-root]');
    const wbDesktop = dockZoneRef.current?.closest<HTMLElement>('[data-wb-desktop]');
    if (wbRoot) targets.push(wbRoot);
    if (wbDesktop) targets.push(wbDesktop);
    for (const el of targets) {
      clearanceTargetsRef.current.add(el);
      if (revealedFlag) {
        el.setAttribute('data-wb-dock-revealed', 'true');
        el.style.setProperty('--wb-mobile-dock-clearance', `${clearancePx}px`);
      } else {
        el.removeAttribute('data-wb-dock-revealed');
        el.style.setProperty('--wb-mobile-dock-clearance', '0px');
      }
      if (collapsedHandleFlag) {
        el.setAttribute('data-wb-dock-collapsed', 'true');
        el.style.setProperty('--wb-mobile-dock-handle-clearance', `${handleClearancePx}px`);
      } else {
        el.removeAttribute('data-wb-dock-collapsed');
        el.style.setProperty('--wb-mobile-dock-handle-clearance', '0px');
      }
    }
    const prev = lastReportedClearanceRef.current;
    if (!prev || prev.revealed !== revealedFlag || prev.clearancePx !== clearancePx) {
      const next = { revealed: revealedFlag, clearancePx };
      lastReportedClearanceRef.current = next;
      onMobileClearanceChange?.(next);
    }
  }, [dockScale, mobileClearanceActive, mobileCollapsedHandleActive, onMobileClearanceChange]);
  const syncMobileDockClearanceRef = React.useRef(syncMobileDockClearance);
  syncMobileDockClearanceRef.current = syncMobileDockClearance;

  React.useLayoutEffect(() => {
    syncMobileDockClearance();
  }, [syncMobileDockClearance]);

  React.useEffect(() => {
    const targets = clearanceTargetsRef.current;
    return () => {
      if (typeof document !== 'undefined') {
        targets.add(document.documentElement);
      }
      for (const el of targets) {
        el.removeAttribute('data-wb-dock-revealed');
        el.style.removeProperty('--wb-mobile-dock-clearance');
        el.removeAttribute('data-wb-dock-collapsed');
        el.style.removeProperty('--wb-mobile-dock-handle-clearance');
      }
      targets.clear();
      lastReportedClearanceRef.current = null;
      onMobileClearanceChange?.({ revealed: false, clearancePx: 0 });
    };
  }, [onMobileClearanceChange]);

  React.useLayoutEffect(() => {
    if (dockRef.current) {
      dockRef.current.inert = hidden;
    }
  }, [hidden]);

  // ---- 60fps 连续波浪放大 + Specular Shimmer（单监听器 pointermove + rAF）----
  const magRafRef = React.useRef(0);
  const magPointerXRef = React.useRef<number | null>(null);
  const magEntriesRef = React.useRef<CachedMagEntry[] | null>(null);
  const magDockRectRef = React.useRef<{ left: number; width: number } | null>(null);
  const shimmerAllowed = tier !== 'minimal' && !prefersReducedMotion;

  const invalidateMagCache = React.useCallback(() => {
    magEntriesRef.current = null;
    magDockRectRef.current = null;
  }, []);

  const ensureMagCache = React.useCallback(() => {
    const dock = dockRef.current;
    if (!dock) return;
    if (!magDockRectRef.current) {
      const dockRect = dock.getBoundingClientRect();
      magDockRectRef.current = { left: dockRect.left, width: dockRect.width };
    }
    if (!magEntriesRef.current) {
      const entries: CachedMagEntry[] = [];
      dock.querySelectorAll<HTMLElement>(`[${MAG_ITEM_ATTR}]`).forEach((magEl) => {
        const wrap = magEl.closest<HTMLElement>('[data-wb-dock-item-wrap]');
        if (!wrap) return;
        const rect = wrap.getBoundingClientRect();
        entries.push({
          wrap,
          magEl,
          centerX: rect.left + rect.width / 2,
        });
      });
      magEntriesRef.current = entries;
    }
  }, []);

  const resetMagnification = React.useCallback(() => {
    if (magRafRef.current) {
      rafCancel(magRafRef.current);
      magRafRef.current = 0;
    }
    magPointerXRef.current = null;
    invalidateMagCache();
    const dock = dockRef.current;
    if (!dock) return;
    dock.removeAttribute('data-wb-dock-magging');
    dock.removeAttribute('data-wb-dock-shimmer');
    dock.querySelectorAll<HTMLElement>(`[${MAG_ITEM_ATTR}]`).forEach((magEl) => {
      magEl.style.transform = '';
      const wrap = magEl.closest<HTMLElement>('[data-wb-dock-item-wrap]');
      if (!wrap) return;
      wrap.style.removeProperty('--wb-dock-mag-weight');
      wrap.style.removeProperty('--wb-dock-mag-x');
      wrap.style.removeProperty('--wb-dock-tip-lift');
      wrap.style.removeProperty('--wb-dock-mag-z');
    });
  }, [invalidateMagCache]);

  const flushMagnificationFrame = React.useCallback(() => {
    magRafRef.current = 0;
    const dock = dockRef.current;
    const pointerX = magPointerXRef.current;
    if (!dock || pointerX === null || hidden) return;

    // 拖拽排序 / 拖入固定 / 拖离取消固定期间暂停波浪放大，避免两套 transform 冲突
    if (dock.querySelector('[data-wb-dock-pinned-dragging]')) {
      resetMagnification();
      return;
    }

    ensureMagCache();
    const dockRect = magDockRectRef.current;
    if (shimmerAllowed && dockRect && dockRect.width > 0) {
      const pct = computeDockCursorPercent(pointerX, dockRect.left, dockRect.width);
      if (pct !== null) {
        dock.style.setProperty('--wb-dock-cursor-x', `${pct.toFixed(1)}%`);
        dock.setAttribute('data-wb-dock-shimmer', 'true');
      }
    }

    if (!magEnabled) {
      dock.removeAttribute('data-wb-dock-magging');
      return;
    }

    const entries = magEntriesRef.current;
    if (!entries || entries.length === 0) return;

    const centersX = entries.map((e) => e.centerX);
    const results = computeDockMagnification(pointerX, centersX, {
      radius: DEFAULT_MAG_RADIUS_PX * dockScale,
      maxScale: magMaxScale,
      iconSize: DEFAULT_MAG_ICON_SIZE_PX * dockScale,
    });

    dock.setAttribute('data-wb-dock-magging', 'true');
    for (let i = 0; i < entries.length; i += 1) {
      const { wrap, magEl } = entries[i];
      const { scale, liftY, offsetX, weight, topLiftPx } = results[i];
      if (weight > 0.001 || Math.abs(offsetX) > 0.05) {
        magEl.style.transform = `translate3d(${offsetX.toFixed(2)}px, ${liftY.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
        wrap.style.setProperty('--wb-dock-mag-weight', weight.toFixed(3));
        wrap.style.setProperty('--wb-dock-mag-x', `${offsetX.toFixed(2)}px`);
        wrap.style.setProperty('--wb-dock-tip-lift', `${topLiftPx.toFixed(1)}px`);
        wrap.style.setProperty('--wb-dock-mag-z', String(2 + Math.round(weight * 8)));
      } else {
        magEl.style.transform = '';
        wrap.style.removeProperty('--wb-dock-mag-weight');
        wrap.style.removeProperty('--wb-dock-mag-x');
        wrap.style.removeProperty('--wb-dock-tip-lift');
        wrap.style.removeProperty('--wb-dock-mag-z');
      }
    }
  }, [dockScale, ensureMagCache, hidden, magEnabled, magMaxScale, resetMagnification, shimmerAllowed]);

  const scheduleMagnification = React.useCallback(
    (clientX: number, pointerType?: string) => {
      if (pointerType === 'touch') return;
      if (!magEnabled && !shimmerAllowed) return;
      magPointerXRef.current = clientX;
      if (magRafRef.current) return;
      let ranSync = false;
      const id = rafSchedule(() => {
        ranSync = true;
        flushMagnificationFrame();
      });
      magRafRef.current = ranSync ? 0 : id;
    },
    [flushMagnificationFrame, magEnabled, shimmerAllowed],
  );

  // 布局、开关、倍率或显隐变更时清理缓存 / 回弹
  React.useEffect(() => {
    invalidateMagCache();
    if (!magEnabled || hidden) {
      resetMagnification();
    }
    if (hidden) {
      resetTipSession();
    }
  }, [orderedKey, dockScale, magEnabled, magMaxScale, hidden, invalidateMagCache, resetMagnification, resetTipSession]);

  React.useEffect(() => () => resetMagnification(), [resetMagnification]);

  const handleDockPointerEnter = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return;
    clickRevealedRef.current = false;
    if (effectiveAutohide) {
      clearAutohideTimers();
      revealDock();
    }
    invalidateMagCache();
    if (Number.isFinite(event.clientX)) {
      scheduleMagnification(event.clientX, event.pointerType);
    }
  };

  const handleDockPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (Number.isFinite(event.clientX)) {
      scheduleMagnification(event.clientX, event.pointerType);
    }
  };

  const handleDockPointerLeave = (event: React.PointerEvent<HTMLDivElement>) => {
    // 忽略从子项冒泡上来的合成 leave（仅处理真正离开 Dock 容器本身的离场）
    if (event.target !== event.currentTarget) return;
    if (event.pointerType === 'touch') return;
    resetMagnification();
    resetTipSession();
    if (!effectiveAutohide) return;
    // AI 桌面操控弹层挂载在 Portal 中：指针移入弹层或弹层打开期间不收起 Dock
    if (hasOpenAgentControlPopover()) return;
    // 焦点仍在 Dock 内（键盘用户）时不收起
    if (dockRef.current?.contains(document.activeElement)) return;
    scheduleConceal();
  };

  const isWithinTouchClickGuard = () =>
    lastTouchRevealAtRef.current > 0 &&
    Date.now() - lastTouchRevealAtRef.current < HOTZONE_TOUCH_CLICK_GUARD_MS;

  const triggerHotzoneReveal = React.useCallback(
    (fromTouch = false) => {
      if (fromTouch) {
        lastTouchRevealAtRef.current = Date.now();
      }
      clearAutohideTimers();
      revealDock(true);
    },
    [clearAutohideTimers, revealDock],
  );

  const handleHotzonePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!hidden) return;
      event.stopPropagation();
      if (event.pointerType === 'touch' || event.pointerType === 'pen') {
        event.preventDefault();
      }
    },
    [hidden],
  );

  const handleHotzoneTouchStart = React.useCallback(
    (event: React.TouchEvent<HTMLButtonElement>) => {
      if (!hidden) return;
      event.stopPropagation();
    },
    [hidden],
  );

  const handleHotzoneTouchEnd = React.useCallback(
    (event: React.TouchEvent<HTMLButtonElement>) => {
      const withinGuard = isWithinTouchClickGuard();
      if (!hidden && !withinGuard) return;
      event.preventDefault();
      event.stopPropagation();
      if (hidden && !revealedRef.current) {
        triggerHotzoneReveal(true);
      } else {
        lastTouchRevealAtRef.current = Date.now();
      }
    },
    [hidden, triggerHotzoneReveal],
  );

  const handleHotzonePointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      const withinGuard = isWithinTouchClickGuard();
      if (!hidden && !withinGuard) return;
      event.preventDefault();
      event.stopPropagation();
      if (hidden && !revealedRef.current) {
        triggerHotzoneReveal(true);
      } else {
        lastTouchRevealAtRef.current = Date.now();
      }
    },
    [hidden, triggerHotzoneReveal],
  );

  const handleHotzoneClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const withinGuard = isWithinTouchClickGuard();
      if (!hidden) {
        if (withinGuard) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      triggerHotzoneReveal(false);
    },
    [hidden, triggerHotzoneReveal],
  );

  const handleHotzoneKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (!hidden) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        triggerHotzoneReveal(false);
      }
    },
    [hidden, triggerHotzoneReveal],
  );

  const handleHotzonePointerEnter = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === 'touch') return;
      scheduleReveal();
    },
    [scheduleReveal],
  );

  const handleHotzonePointerLeave = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === 'touch') return;
      if (revealTimerRef.current) {
        window.clearTimeout(revealTimerRef.current);
        revealTimerRef.current = 0;
      }
      if (clickRevealedRef.current) return;
      scheduleConceal();
    },
    [scheduleConceal],
  );

  const handleDockBlur = (event: React.FocusEvent) => {
    if (!effectiveAutohide) return;
    const next = event.relatedTarget as Node | null;
    if (next && (dockRef.current?.contains(next) || isInsideDockPortal(next))) return;
    if (hasOpenAgentControlPopover()) return;
    scheduleConceal();
  };

  // ---- dockGeometry 发布（O9 genie 收敛点；§4 协作接口）----
  const geometryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureGeometry = React.useCallback((): Record<string, DockIconRect> => {
    const map: Record<string, DockIconRect> = {};
    dockRef.current?.querySelectorAll<HTMLElement>(`[${MAG_ITEM_ATTR}]`).forEach((el) => {
      const typeId = el.getAttribute(MAG_ITEM_ATTR);
      const wrap = el.parentElement;
      if (!typeId || !wrap) return;
      // 测 wrap（静止锚点，不受 .wb-dock-mag 放大 transform 污染）
      const rect = wrap.getBoundingClientRect();
      map[typeId] = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    });
    return map;
  }, []);
  const publishGeometry = React.useCallback(() => {
    if (!dockRef.current) return;
    publishDockIconRects(measureGeometry());
  }, [measureGeometry]);

  // 挂载即登记（早于首个防抖发布）：之后任一次提交里开窗，opening 相位取坐标缺项时都能现场补测
  React.useLayoutEffect(() => registerDockGeometryMeasurer(measureGeometry), [measureGeometry]);

  const publishGeometrySoon = React.useCallback(() => {
    invalidateMagCache();
    if (geometryTimerRef.current !== null) clearTimeout(geometryTimerRef.current);
    // 延后到 resize/布局帧结算后的独立宏任务再测，避免在首帧 rAF 里同步强制整页重排
    geometryTimerRef.current = setTimeout(() => {
      geometryTimerRef.current = null;
      publishGeometry();
    }, 220);
  }, [invalidateMagCache, publishGeometry]);

  React.useEffect(() => {
    publishGeometrySoon();
  }, [orderedKey, hidden, publishGeometrySoon]);

  // resize 经 useEventRegistry 注册（无裸 window.addEventListener）
  useEventRegistry(
    [{ target: 'window', type: 'resize', listener: publishGeometrySoon }],
    [publishGeometrySoon],
  );

  // ResizeObserver / autohide transitionend → 补一次精确坐标；卸载清空 provider
  React.useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return undefined;
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === dock && event.propertyName === 'transform') publishGeometrySoon();
    };
    dock.addEventListener('transitionend', onTransitionEnd);
    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            publishGeometrySoon();
            syncMobileDockClearanceRef.current();
          })
        : null;
    observer?.observe(dock);
    return () => {
      dock.removeEventListener('transitionend', onTransitionEnd);
      observer?.disconnect();
      if (geometryTimerRef.current !== null) {
        clearTimeout(geometryTimerRef.current);
        geometryTimerRef.current = null;
      }
      clearDockGeometry();
    };
  }, [publishGeometrySoon]);

  const focusDockItem = (itemId: string) => {
    setActiveId(itemId);
    if (effectiveAutohide) {
      clearAutohideTimers();
      revealDock();
    }
  };

  const renderItem = (typeId: string) => (
    <DockContextMenu key={typeId} typeId={typeId}>
      <DockItem
        typeId={typeId}
        tabIndex={typeId === effectiveActiveId ? 0 : -1}
        buttonRef={registerButtonRef(typeId)}
        tipManaged
        tipActive={hoveredTipId === typeId}
        onTipPointerEnter={() => handleTipItemEnter(typeId)}
        onTipPointerLeave={handleTipItemLeave}
        onItemFocus={() => focusDockItem(typeId)}
      />
    </DockContextMenu>
  );

  const restoreMinimizedWindow = (windowId: string) => {
    setOverflowOpen(false);
    if (isAppsPanelOpen()) {
      closeAppsPanel();
    }
    useWindowStore.getState().focusWindow(windowId);
    if (isCompactViewport && effectiveAutohide) {
      clickRevealedRef.current = false;
      scheduleConceal();
    }
  };

  return (
    <div
      ref={dockZoneRef}
      className={cn(
        'wb-dock-zone pointer-events-none absolute inset-x-0 bottom-0 flex justify-center',
        className,
      )}
      data-immersive={immersiveWindowId ? 'true' : undefined}
      data-compact-typing={isTypingInComposer ? 'true' : undefined}
      data-compact-window={isCompactViewport && hasOpenWindow ? 'true' : undefined}
      data-compact-collapsed={isCompactViewport && compactCollapsedPersisted ? 'true' : undefined}
      data-dock-revealed={mobileClearanceActive ? 'true' : undefined}
      data-dock-collapsed={mobileCollapsedHandleActive ? 'true' : undefined}
      style={{ zIndex: 'var(--wb-z-dock, 9000)' }}
    >
      {effectiveAutohide && (
        <button
          ref={hotzoneRef}
          type="button"
          data-testid="wb-dock-hotzone"
          data-collapsed={hidden ? 'true' : 'false'}
          data-mobile-handle={isCompactViewport && hidden ? 'true' : undefined}
          tabIndex={hidden ? 0 : -1}
          aria-hidden={!hidden || undefined}
          aria-expanded={hidden ? false : undefined}
          aria-label={
            hidden
              ? (isCompactViewport
                  ? t('workbench:dock.autohideHintTouch')
                  : t('workbench:dock.autohideHint'))
              : undefined
          }
          title={
            hidden
              ? (isCompactViewport
                  ? t('workbench:dock.autohideHintTouch')
                  : t('workbench:dock.autohideHint'))
              : undefined
          }
          style={{
            zIndex: hidden ? 'calc(var(--wb-z-dock, 9000) + 1)' : 0,
            touchAction: 'manipulation',
          }}
          // 桌面收起态保持 6px 纯净底缘热区；移动端（<= 767px）收起态提供居中 40px 触控唤出把手，避开聊天 `+` / 发送按钮
          className={cn(
            'wb-dock-hotzone absolute bottom-0',
            hidden
              ? isCompactViewport
                ? 'wb-dock-mobile-handle pointer-events-auto left-1/2 flex h-10 min-h-[40px] min-w-[148px] -translate-x-1/2 cursor-pointer items-center justify-center'
                : 'pointer-events-auto inset-x-0 h-1.5 min-h-[6px] cursor-pointer'
              : isCompactViewport
                ? 'pointer-events-none inset-x-0 h-4 min-h-[16px]'
                : 'pointer-events-auto inset-x-0 h-4 min-h-[16px]',
          )}
          onPointerDown={handleHotzonePointerDown}
          onTouchStart={handleHotzoneTouchStart}
          onTouchEnd={handleHotzoneTouchEnd}
          onPointerUp={handleHotzonePointerUp}
          onClick={handleHotzoneClick}
          onKeyDown={handleHotzoneKeyDown}
          onPointerEnter={handleHotzonePointerEnter}
          onPointerLeave={handleHotzonePointerLeave}
        >
          {isCompactViewport && hidden && (
            <span
              aria-hidden="true"
              data-testid="wb-dock-mobile-handle-pill"
              className="wb-dock-mobile-handle-pill pointer-events-none inline-flex items-center justify-center gap-1.5"
            >
              <CaretUp size={11} weight="bold" className="wb-dock-mobile-handle-chevron shrink-0" />
              <span className="wb-dock-mobile-handle-label">{t('workbench:dock.label')}</span>
            </span>
          )}
        </button>
      )}
      <div
        ref={dockRef}
        role="toolbar"
        aria-orientation="horizontal"
        aria-label={t('workbench:dock.label')}
        aria-hidden={hidden || undefined}
        {...(hidden ? ({ inert: '' } as React.HTMLAttributes<HTMLDivElement>) : {})}
        data-testid="wb-dock"
        data-autohide={effectiveAutohide || undefined}
        data-hidden={hidden || undefined}
        data-revealing={revealing || undefined}
        data-tip-session={tipSessionActive ? 'active' : undefined}
        data-size={Math.round(dockScale * 100)}
        style={{ '--wb-dock-scale': dockScale } as React.CSSProperties}
        className={cn(
          'wb-dock wb-glass-rim flex items-end',
          effectiveAutohide && 'wb-dock-slide',
          hidden ? 'pointer-events-none' : 'pointer-events-auto',
        )}
        onKeyDown={handleToolbarKeyDown}
        onClick={(event) => {
          if (!isCompactViewport || !effectiveAutohide || !revealedRef.current) return;
          const target = event.target as HTMLElement | null;
          if (!target) return;
          if (
            target.closest(
              '[data-testid="wb-dock-minimized-overflow"], [data-testid="wb-dock-window-list"], [data-testid="wb-dock-collapse-button"], [data-testid="wb-dock-agent-control-button"]',
            )
          ) {
            return;
          }
          const itemBtn = target.closest<HTMLElement>('[data-type-id]');
          if (!itemBtn) return;
          window.requestAnimationFrame(() => {
            if (dockRef.current?.querySelector('[data-testid="wb-dock-window-list"]')) return;
            concealDockImmediate();
          });
        }}
        onPointerEnter={handleDockPointerEnter}
        onPointerMove={handleDockPointerMove}
        onPointerLeave={handleDockPointerLeave}
        onFocusCapture={() => {
          if (!effectiveAutohide) return;
          clearAutohideTimers();
          revealDock();
        }}
        onBlurCapture={handleDockBlur}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) setRevealing(false);
        }}
      >
        {pinned.map(renderItem)}
        {pinned.length > 0 && runningExtra.length > 0 && (
          <div
            role="separator"
            aria-orientation="vertical"
            data-testid="wb-dock-separator"
            className="wb-dock-separator mx-1 h-8 w-px self-center"
          />
        )}
        {runningExtra.map(renderItem)}

        {/* 最小化窗口缩略槽位：位于右侧分隔线前，展示最多 3 张微缩玻璃窗口卡 + +N 溢出入口 */}
        {minimizedWindows.length > 0 && appOrderedIds.length > 0 && (
          <div
            role="separator"
            aria-orientation="vertical"
            data-testid="wb-dock-minimized-separator"
            className="wb-dock-separator mx-1 h-8 w-px self-center"
          />
        )}
        {visibleMinimized.map((win) => {
          const slotId = getMinimizedDockItemKey(win.id);
          const def = appRegistry.get(win.typeId);
          const appLabel = def ? t(def.nameKey, def.typeId) : win.typeId;
          const cardTitle = win.title.trim() || appLabel;
          return (
            <div
              key={win.id}
              data-testid={`wb-dock-minimized-${win.id}`}
              data-wb-dock-item-wrap=""
              data-tip-managed="true"
              data-tip-active={hoveredTipId === slotId ? 'true' : undefined}
              className="wb-dock-item-wrap wb-dock-min-wrap relative flex flex-col items-center"
              onPointerEnter={() => handleTipItemEnter(slotId)}
              onPointerLeave={handleTipItemLeave}
              onPointerCancel={handleTipItemLeave}
            >
              <div className="wb-dock-mag" data-wb-dock-mag-item={slotId}>
                <div className="wb-dock-bounce">
                  <DsButton
                    ref={registerButtonRef(slotId)}
                    type="button"
                    variant="ghost"
                    size="icon"
                    iconOnly
                    data-type-id={win.typeId}
                    data-window-id={win.id}
                    data-testid={`wb-dock-minimized-button-${win.id}`}
                    className="wb-dock-item wb-dock-min-card group relative flex items-center justify-center outline-none"
                    aria-label={`${cardTitle}, ${t('workbench:dock.minimized')}`}
                    tabIndex={effectiveActiveId === slotId ? 0 : -1}
                    onClick={() => restoreMinimizedWindow(win.id)}
                    onFocus={() => focusDockItem(slotId)}
                  >
                    <span aria-hidden="true" className="wb-dock-min-card-surface">
                      <span className="wb-dock-min-card-titlebar">
                        <i className="wb-dock-min-dot" />
                        <i className="wb-dock-min-dot" />
                        <i className="wb-dock-min-dot" />
                      </span>
                      <span className="wb-dock-min-card-body">
                        <span className="wb-dock-min-line wb-dock-min-line-wide" />
                        <span className="wb-dock-min-line wb-dock-min-line-mid" />
                      </span>
                    </span>
                    <span aria-hidden="true" className="wb-dock-min-card-badge">
                      {def?.icon ?? (
                        <span className="text-2xs font-semibold uppercase opacity-80">
                          {win.typeId.slice(0, 1)}
                        </span>
                      )}
                    </span>
                  </DsButton>
                </div>
              </div>
              <span
                aria-hidden
                data-testid={`wb-dock-tip-min-${win.id}`}
                className="wb-dock-tip"
              >
                {cardTitle}
              </span>
            </div>
          );
        })}

        {overflowMinimized.length > 0 && (
          <div
            ref={overflowWrapRef}
            data-testid="wb-dock-minimized-overflow-wrap"
            data-wb-dock-item-wrap=""
            data-tip-managed="true"
            data-tip-active={
              hoveredTipId === MINIMIZED_OVERFLOW_DOCK_ID && !overflowOpen ? 'true' : undefined
            }
            className="wb-dock-item-wrap wb-dock-min-wrap relative flex flex-col items-center"
            onPointerEnter={() => handleTipItemEnter(MINIMIZED_OVERFLOW_DOCK_ID)}
            onPointerLeave={handleTipItemLeave}
            onPointerCancel={handleTipItemLeave}
          >
            <div className="wb-dock-mag" data-wb-dock-mag-item={MINIMIZED_OVERFLOW_DOCK_ID}>
              <div className="wb-dock-bounce">
                <DsButton
                  ref={registerButtonRef(MINIMIZED_OVERFLOW_DOCK_ID)}
                  type="button"
                  variant="ghost"
                  size="icon"
                  iconOnly
                  data-testid="wb-dock-minimized-overflow"
                  className="wb-dock-item wb-dock-min-overflow relative flex items-center justify-center outline-none"
                  aria-label={`${t('workbench:dock.minimized')} +${overflowMinimized.length}`}
                  aria-haspopup="menu"
                  aria-expanded={overflowOpen}
                  tabIndex={effectiveActiveId === MINIMIZED_OVERFLOW_DOCK_ID ? 0 : -1}
                  onClick={() => setOverflowOpen((open) => !open)}
                  onFocus={() => focusDockItem(MINIMIZED_OVERFLOW_DOCK_ID)}
                >
                  <span aria-hidden="true" className="wb-dock-min-overflow-pill">
                    +{overflowMinimized.length}
                  </span>
                </DsButton>
              </div>
            </div>
            {!overflowOpen && (
              <span
                aria-hidden
                data-testid="wb-dock-tip-min-overflow"
                className="wb-dock-tip"
              >
                {`${t('workbench:dock.minimized')} (+${overflowMinimized.length})`}
              </span>
            )}
            {overflowOpen && (
              <div
                role="menu"
                aria-label={t('workbench:dock.minimized')}
                data-testid="wb-dock-minimized-overflow-list"
                className="wb-dock-min-popover wb-glass wb-glass-rim"
              >
                {overflowMinimized.map((win) => {
                  const def = appRegistry.get(win.typeId);
                  const appLabel = def ? t(def.nameKey, def.typeId) : win.typeId;
                  const cardTitle = win.title.trim() || appLabel;
                  return (
                    <DsButton
                      key={win.id}
                      type="button"
                      role="menuitem"
                      variant="ghost"
                      size="sm"
                      data-testid={`wb-dock-minimized-overflow-item-${win.id}`}
                      className="wb-dock-min-popover-item"
                      onClick={() => restoreMinimizedWindow(win.id)}
                    >
                      <span aria-hidden="true" className="wb-dock-min-popover-icon">
                        {def?.icon ?? (
                          <span className="text-2xs font-semibold uppercase">
                            {win.typeId.slice(0, 1)}
                          </span>
                        )}
                      </span>
                      <span className="wb-dock-min-popover-title">{cardTitle}</span>
                    </DsButton>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* 右侧分隔线：分隔主应用/最小化槽位与右侧系统工具入口 */}
        {(appOrderedIds.length > 0 || minimizedWindows.length > 0) && (
          <div
            role="separator"
            aria-orientation="vertical"
            data-testid="wb-dock-apps-separator"
            className="wb-dock-separator mx-1 h-8 w-px self-center"
          />
        )}
        <div
          data-testid={`wb-dock-item-${APPS_DOCK_TYPE_ID}`}
          data-wb-dock-item-wrap=""
          data-tip-managed="true"
          data-tip-active={hoveredTipId === APPS_DOCK_TYPE_ID ? 'true' : undefined}
          className="wb-dock-item-wrap relative flex flex-col items-center"
          onPointerEnter={() => handleTipItemEnter(APPS_DOCK_TYPE_ID)}
          onPointerLeave={handleTipItemLeave}
          onPointerCancel={handleTipItemLeave}
        >
          <div className="wb-dock-mag" data-wb-dock-mag-item={APPS_DOCK_TYPE_ID}>
            <div className="wb-dock-bounce">
              <button
                ref={registerButtonRef(APPS_DOCK_TYPE_ID)}
                type="button"
                data-type-id={APPS_DOCK_TYPE_ID}
                data-testid="wb-dock-apps-button"
                className="wb-dock-item group relative flex h-11 w-11 items-center justify-center rounded-xl outline-none"
                aria-label={t('workbench:dock.apps')}
                aria-expanded={appsPanelOpen}
                tabIndex={effectiveActiveId === APPS_DOCK_TYPE_ID ? 0 : -1}
                onClick={() => {
                  clearAutohideTimers();
                  toggleAppsPanel();
                  if (isCompactViewport && effectiveAutohide) {
                    concealDockImmediate();
                  }
                }}
                onFocus={() => focusDockItem(APPS_DOCK_TYPE_ID)}
              >
                <span
                  aria-hidden
                  className="wb-dock-item-icon pointer-events-none flex h-full w-full items-center justify-center"
                >
                  <span className="wb-dock-utility-tile wb-dock-utility-tile-apps">
                    <SquaresFour size={20} weight="duotone" />
                  </span>
                </span>
              </button>
            </div>
          </div>
          <span aria-hidden data-testid={`wb-dock-tip-${APPS_DOCK_TYPE_ID}`} className="wb-dock-tip">
            {t('workbench:dock.apps')}
          </span>
        </div>
        <AgentControlDockEntry
          tabIndex={effectiveActiveId === AGENT_CONTROL_DOCK_ID ? 0 : -1}
          buttonRef={registerButtonRef(AGENT_CONTROL_DOCK_ID)}
          tipManaged
          tipActive={hoveredTipId === AGENT_CONTROL_DOCK_ID}
          onTipPointerEnter={() => handleTipItemEnter(AGENT_CONTROL_DOCK_ID)}
          onTipPointerLeave={handleTipItemLeave}
          onFocus={() => focusDockItem(AGENT_CONTROL_DOCK_ID)}
        />
        {isCompactViewport && effectiveAutohide && (
          <div
            data-testid={`wb-dock-item-${DOCK_COLLAPSE_ID}`}
            data-wb-dock-item-wrap=""
            data-tip-managed="true"
            data-tip-active={hoveredTipId === DOCK_COLLAPSE_ID ? 'true' : undefined}
            className="wb-dock-item-wrap relative flex flex-col items-center"
            onPointerEnter={() => handleTipItemEnter(DOCK_COLLAPSE_ID)}
            onPointerLeave={handleTipItemLeave}
            onPointerCancel={handleTipItemLeave}
          >
            <div className="wb-dock-mag" data-wb-dock-mag-item={DOCK_COLLAPSE_ID}>
              <div className="wb-dock-bounce">
                <button
                  ref={registerButtonRef(DOCK_COLLAPSE_ID)}
                  type="button"
                  data-type-id={DOCK_COLLAPSE_ID}
                  data-testid="wb-dock-collapse-button"
                  className="wb-dock-item group relative flex h-11 w-11 items-center justify-center rounded-xl outline-none"
                  aria-label={t('workbench:dock.collapse')}
                  title={t('workbench:dock.collapse')}
                  tabIndex={effectiveActiveId === DOCK_COLLAPSE_ID ? 0 : -1}
                  onClick={(event) => {
                    event.currentTarget.blur();
                    concealDockImmediate();
                  }}
                  onFocus={() => focusDockItem(DOCK_COLLAPSE_ID)}
                >
                  <span
                    aria-hidden
                    className="wb-dock-item-icon pointer-events-none flex h-full w-full items-center justify-center"
                  >
                    <span className="wb-dock-utility-tile wb-dock-utility-tile-collapse">
                      <CaretDown size={18} weight="bold" />
                    </span>
                  </span>
                </button>
              </div>
            </div>
            <span aria-hidden data-testid={`wb-dock-tip-${DOCK_COLLAPSE_ID}`} className="wb-dock-tip">
              {t('workbench:dock.collapse')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** props 仅 autohide/size/className（稳定），memo 隔离父级（桌面壳）重渲染 */
export const Dock = React.memo(DockImpl);
Dock.displayName = 'Dock';
