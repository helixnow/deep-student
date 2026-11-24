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
import { SquaresFour } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { cn } from '../../../lib/utils';
import { appRegistry } from '../core/appRegistry';
import { useWindowStore } from '../core/windowStore';
import { getSortedWindows } from '../core/windowListCache';
import { useMaterialTier } from '../core/materialTier';
import { useDockMagnificationEffective } from '../core/dockMagnificationStore';
import { WallpaperReplica } from '../core/liquidGlassLens';
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

export interface DockProps {
  /** 自动隐藏（设置接线 P11）：隐藏至底缘 4px 热区 */
  autohide?: boolean;
  /** Dock 尺寸百分比，默认 100，桌面设置范围 75..125 */
  size?: number;
  className?: string;
}

/** 首次悬停 Tooltip 显现延迟（ms）；会话激活后横划相邻图标 0ms 即时切换 */
export const DOCK_TOOLTIP_INITIAL_DELAY_MS = 70;
/** 图标间隙内维持 Tooltip 会话热态的宽限时间（ms） */
export const DOCK_TOOLTIP_SESSION_GRACE_MS = 140;
/** 最小化窗口缩略槽位最多直接展示张数，超出归入 +N 溢出入口 */
export const DOCK_MAX_MINIMIZED_SLOTS = 3;

const MINIMIZED_OVERFLOW_DOCK_ID = '__minimized_overflow__';

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

function DockImpl({ autohide = false, size = 100, className }: DockProps) {
  const { t } = useTranslation();
  useRegistryVersion();

  // ACR 4.0（A5 跨界最小接线）：agent 后台完成角标——Dock 存续期间订阅
  // presence/windowStore（只读），角标渲染在 DockItem 内
  React.useEffect(() => startDockAgentBadgeTracking(), []);

  const appsPanelOpen = useAppsPanelOpen();
  const immersiveWindowId = useImmersiveWindowId();
  const composerDockHeight = useComposerDockHeight();
  const desktopWidth = useWindowStore((s) => s.desktopSize.w);
  const [mqlCompactViewport, setMqlCompactViewport] = React.useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? Boolean(window.matchMedia('(max-width: 640px)')?.matches)
      : false,
  );
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia('(max-width: 640px)');
    if (!mql) return undefined;
    const syncViewport = () => setMqlCompactViewport(Boolean(mql.matches));
    syncViewport();
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', syncViewport);
      return () => mql.removeEventListener('change', syncViewport);
    }
    return undefined;
  }, []);
  const isCompactViewport = mqlCompactViewport || (desktopWidth > 0 && desktopWidth <= 640);

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
  const hotzoneRef = React.useRef<HTMLDivElement | null>(null);

  const updateRevealed = React.useCallback((next: boolean) => {
    revealedRef.current = next;
    setRevealed(next);
  }, []);

  const revealDock = React.useCallback(
    (viaClick = false) => {
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
    [hasOpenWindow, isCompactViewport, updateRevealed],
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

  const scheduleConceal = React.useCallback(() => {
    if (revealTimerRef.current) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = 0;
    }
    if (concealTimerRef.current) return;
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

  // 窄屏（<= 640px）切换/新开前台窗后立即收起 Dock，避免遮挡目标窗底部 CTA
  const topFocusId = useWindowStore((s) => s.focusStack[s.focusStack.length - 1] ?? null);
  const prevTopFocusRef = React.useRef<string | null>(topFocusId);
  React.useEffect(() => {
    const prev = prevTopFocusRef.current;
    prevTopFocusRef.current = topFocusId;
    if (!isCompactViewport || !hasOpenWindow || prev === topFocusId) return;
    clickRevealedRef.current = false;
    clearAutohideTimers();
    setRevealing(false);
    updateRevealed(false);
  }, [topFocusId, isCompactViewport, hasOpenWindow, clearAutohideTimers, updateRevealed]);
  const hidden = effectiveAutohide && !revealed;

  const dockRef = React.useRef<HTMLDivElement | null>(null);
  const onAutohideOutsidePointerDown = React.useCallback(
    (event: Event) => {
      const target = event.target as Node | null;
      if (dockRef.current?.contains(target) || hotzoneRef.current?.contains(target)) return;
      clickRevealedRef.current = false;
      clearAutohideTimers();
      setRevealing(false);
      updateRevealed(false);
      if (isCompactViewport) {
        setCompactCollapsedPersisted(true);
        writePersistedCompactDockCollapse(true);
      }
    },
    [clearAutohideTimers, isCompactViewport, updateRevealed],
  );
  useEventRegistry(
    effectiveAutohide && revealed
      ? [{ target: 'document', type: 'pointerdown', listener: onAutohideOutsidePointerDown }]
      : [],
    [effectiveAutohide, revealed, onAutohideOutsidePointerDown],
  );
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
    resetMagnification();
    resetTipSession();
    if (!effectiveAutohide) return;
    // 焦点仍在 Dock 内（键盘用户）时不收起
    if (dockRef.current?.contains(document.activeElement)) return;
    scheduleConceal();
  };

  const handleDockBlur = (event: React.FocusEvent) => {
    if (!effectiveAutohide) return;
    const next = event.relatedTarget as Node | null;
    if (next && dockRef.current?.contains(next)) return;
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
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => publishGeometrySoon()) : null;
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
      className={cn(
        'wb-dock-zone pointer-events-none absolute inset-x-0 bottom-0 flex justify-center',
        className,
      )}
      data-immersive={immersiveWindowId ? 'true' : undefined}
      data-compact-typing={isTypingInComposer ? 'true' : undefined}
      data-compact-window={isCompactViewport && hasOpenWindow ? 'true' : undefined}
      data-compact-collapsed={isCompactViewport && compactCollapsedPersisted ? 'true' : undefined}
      style={{ zIndex: 'var(--wb-z-dock)' }}
    >
      {effectiveAutohide && (
        <div
          ref={hotzoneRef}
          data-testid="wb-dock-hotzone"
          data-collapsed={hidden ? 'true' : 'false'}
          role={hidden ? 'button' : undefined}
          tabIndex={hidden ? 0 : undefined}
          aria-hidden={!hidden || undefined}
          aria-label={hidden ? t('workbench:dock.autohideHint') : undefined}
          title={hidden ? t('workbench:dock.autohideHint') : undefined}
          // 收起态保持 6px 底缘热区（避免挡住底部应用操作栏）；展开态补足高度消除热区→Dock 间断缝
          className={cn(
            'wb-dock-hotzone pointer-events-auto absolute inset-x-0 bottom-0',
            hidden ? 'h-1.5 min-h-[6px] cursor-pointer' : 'h-4 min-h-[16px]',
          )}
          onClick={
            hidden
              ? () => {
                  clearAutohideTimers();
                  revealDock(true);
                }
              : undefined
          }
          onKeyDown={
            hidden
              ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    clearAutohideTimers();
                    revealDock(true);
                  }
                }
              : undefined
          }
          onPointerEnter={scheduleReveal}
          onPointerLeave={() => {
            if (revealTimerRef.current) {
              window.clearTimeout(revealTimerRef.current);
              revealTimerRef.current = 0;
            }
            if (clickRevealedRef.current) return;
            scheduleConceal();
          }}
        />
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
        <WallpaperReplica hostRef={dockRef} />
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
      </div>
    </div>
  );
}

/** props 仅 autohide/size/className（稳定），memo 隔离父级（桌面壳）重渲染 */
export const Dock = React.memo(DockImpl);
Dock.displayName = 'Dock';
