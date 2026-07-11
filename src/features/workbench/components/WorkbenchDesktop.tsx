/**
 * WorkbenchDesktop（P11）— 学习 OS 桌面总装
 *
 * 层序（O1 --wb-z-* 刻度 / COORDINATION 裁决）：
 *   壁纸(--wb-z-wallpaper) → 空桌面引导(--wb-z-desktop-ui) → expose backdrop(--wb-z-expose-backdrop)
 *   → 窗口层(--wb-z-window-layer, isolation:isolate，内部窗口 zIndex 10..N)
 *   → 中缝(--wb-z-tiling-divider) → SnapPreview(--wb-z-snap-preview)
 *   → Dock(--wb-z-dock) → 学习状态菜单栏(--wb-z-menubar) → Dock 飞出层
 *   → 桌面右键菜单(--wb-z-desktop-menu) → DevPanel(--wb-z-hud)
 *   → Expose 命中层(--wb-z-overlay) / WindowSwitcher(--wb-z-switcher)
 *
 * 启动链路：loadSnapshot → prune（已删资源 / 投射型壳）→ hydrate →
 *   setDockPinned（默认 chat/files/settings/todo）→ startScheduler（挂载即启）→
 *   registerSystemProjections → resyncProjections。
 * 持久化：订阅 store（windows/tilingRatios）与 Dock 固定区 → saveSnapshot（防抖 2s）；
 *   卸载时 flushSnapshot 立即落盘。
 * 卸载清理：stopScheduler / dispose projections / 注销 provider。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import '../styles/workbench.css';
import '../styles/a11y-cursor.css';
import '../apps/registerAll';
import { DEFAULT_DOCK_PINNED } from '../apps/registerAll';
import { useWindowStore } from '../core/windowStore';
import { getSortedWindows } from '../core/windowListCache';
import { startScheduler } from '../core/scheduler';
import {
  flushSnapshot,
  loadSnapshot,
  registerDockPinnedProvider,
  saveSnapshot,
} from '../core/snapshot';
import { resyncProjections } from '../core/projection';
import { registerSystemProjections } from '../apps/system/projections';
import { setMaterialTier, useMaterialTier, type MaterialTierSetting } from '../core/materialTier';
import {
  computeTiledFrame,
  getActiveTilingPair,
  MAX_TILING_RATIO,
  MIN_TILING_RATIO,
} from '../core/tiling';
import { RESOURCE_APP_TYPE_IDS } from '../apps/content/typeMap';
import { NOTES_APP_TYPE_ID } from '../apps/notes/register';
import { normalizeSingletonAppWindows } from '../core/snapshotWindowPolicy';
import type { SnapZone, WorkbenchWindow } from '../core/types';
import { setActiveSnapZone } from '../core/snapZoneStore';
import { WallpaperLayer, DEFAULT_WALLPAPER, type WallpaperConfig } from './WallpaperLayer';
import { DesktopContextMenu, useDesktopGestures } from './DesktopContextMenu';
import { useWallpaperCoveragePause } from '../hooks/useWallpaperCoveragePause';
import { EmptyDesktop } from './EmptyDesktop';
import { WindowShell } from './WindowShell';
import { SnapPreview } from './SnapPreview';
import { installInteractionTraceBridge } from '../core/interactionTrace';

// DEV：挂全局桥 + 允许空桌面时也能落盘/控制台读交互延迟
installInteractionTraceBridge();
import { Dock, getDockPinned, setDockPinned, subscribeDockPinned } from './Dock';
import { StatusBar } from './StatusBar';
import { AppsPanel } from './AppsPanel';
import { ExposeOverlay } from './ExposeOverlay';
import { WindowSwitcher } from './WindowSwitcher';
import { ShortcutCheatsheet } from './ShortcutCheatsheet';
import { WorkbenchDevPanel } from './WorkbenchDevPanel';
import { WorkbenchEventBridge } from './WorkbenchEventBridge';
import { useWorkbenchShortcuts } from '../hooks/useWorkbenchShortcuts';
import { useCompositorNudge } from '../hooks/useCompositorNudge';
import { useDesktopDrop } from '../hooks/useDesktopDrop';
import { handleDesktopResourceDrop } from '../apps/files/desktopDragBridge';
import { useTilingDivider } from './window-shell/useTilingDivider';
import {
  getWorkbenchDesktopOffset,
  setWorkbenchDesktopOffsetProvider,
} from './window-shell/workbenchPointerAdapter';

// ---------------------------------------------------------------------------
// 设置读取（key 契约见 P10 WorkbenchSettingsSection；热更新走 workbench:settings-changed）
// ---------------------------------------------------------------------------

const SETTING_KEYS = {
  materialTier: 'desktop.workbenchMaterialTier',
  wallpaper: 'desktop.workbenchWallpaper',
  tileMargins: 'desktop.workbenchTileMargins',
  dockAutohide: 'desktop.workbenchDockAutohide',
  devPanel: 'desktop.workbenchDevPanel',
  dockMagnification: 'desktop.workbenchDockMagnification',
} as const;

/** Dock 邻近放大：写 html dataset，供 Dock.tsx MutationObserver 门控 */
function applyDockMagDataset(enabled: boolean): void {
  if (typeof document === 'undefined') return;
  if (enabled) {
    delete document.documentElement.dataset.wbDockMag;
  } else {
    document.documentElement.dataset.wbDockMag = 'off';
  }
}

interface TileMarginsSetting {
  enabled: boolean;
  px: number;
}

const DEFAULT_TILE_MARGINS: TileMarginsSetting = { enabled: true, px: 8 };

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    (Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__) ||
      Boolean((window as unknown as Record<string, unknown>).__TAURI_IPC__))
  );
}

async function readSetting(key: string): Promise<string | null> {
  try {
    if (!isTauriRuntime()) {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    }
    return await invoke<string | null>('get_setting', { key });
  } catch {
    return null;
  }
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return { ...fallback, ...(parsed as Partial<T>) };
  } catch {
    /* 坏数据回退默认值 */
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// 快照恢复的业务侧过滤
// ---------------------------------------------------------------------------

/** 投射型应用的壳不随快照自动恢复（设计 §7：只有宿主重新投射时才恢复） */
const PROJECTION_ONLY_TYPE_IDS = new Set(['pomodoro']);
const LEGACY_NOTES_WINDOW_TYPE_IDS = new Set(['note', 'mindmap']);

/** 将升级前的独立 note/mindmap 窗口折叠为一个统一 Notes 应用壳。 */
export function migrateLegacyNotesSnapshotWindows(
  windows: WorkbenchWindow[],
): WorkbenchWindow[] {
  const legacy = windows.filter((win) => LEGACY_NOTES_WINDOW_TYPE_IDS.has(win.typeId));
  if (legacy.length === 0) return windows;
  if (windows.some((win) => win.typeId === NOTES_APP_TYPE_ID)) {
    return windows.filter((win) => !LEGACY_NOTES_WINDOW_TYPE_IDS.has(win.typeId));
  }
  const keeper = legacy.reduce((latest, candidate) =>
    candidate.lastFocusedAt > latest.lastFocusedAt ? candidate : latest,
  );
  return windows.flatMap((win) => {
    if (!LEGACY_NOTES_WINDOW_TYPE_IDS.has(win.typeId)) return [win];
    return win.id === keeper.id
      ? [{ ...win, typeId: NOTES_APP_TYPE_ID, instanceKey: null, title: '' }]
      : [];
  });
}

/**
 * 丢弃 instanceKey 指向已删除资源的窗口壳（设计 §7）。
 * 存在性检查失败（后端不可用等）时宁可保留，交给 resourceSync 运行时兜底。
 */
async function pruneSnapshotWindows(windows: WorkbenchWindow[]): Promise<WorkbenchWindow[]> {
  const migratedWindows = migrateLegacyNotesSnapshotWindows(windows);
  const survivors = await Promise.all(
    migratedWindows.map(async (win) => {
      if (PROJECTION_ONLY_TYPE_IDS.has(win.typeId)) {
        console.info('[workbench] snapshot window skipped (projection-only):', win.typeId);
        return null;
      }
      if (!win.instanceKey || !RESOURCE_APP_TYPE_IDS.has(win.typeId)) return win;
      try {
        const { dstu } = await import('@/dstu');
        const result = await dstu.get(`/${win.instanceKey}`);
        if (result.ok) return win;
        console.info(
          '[workbench] snapshot window dropped (resource missing):',
          win.typeId,
          win.instanceKey,
        );
        return null;
      } catch {
        return win;
      }
    }),
  );
  return normalizeSingletonAppWindows(
    survivors.filter((win): win is WorkbenchWindow => win !== null),
  );
}

// ---------------------------------------------------------------------------
// 左右平铺中缝
// ---------------------------------------------------------------------------

const TilingDivider: React.FC<{ leftId: string; rightId: string; margin: number }> = ({
  leftId,
  rightId,
  margin,
}) => {
  const { t } = useTranslation('workbench');
  const divider = useTilingDivider(leftId, rightId, {
    margin,
    // ANTI-REGRESSION：与窗口拖拽共用缓存快照，禁止在此 getBoundingClientRect。
    getDesktopOffset: getWorkbenchDesktopOffset,
  });
  const desktopSize = useWindowStore((s) => s.desktopSize);
  const leftFrame = computeTiledFrame('tiled-left', { desktopSize, margin, ratio: divider.ratio });
  if (!leftFrame) return null;
  const centerX = leftFrame.x + leftFrame.w + margin / 2;
  const valueNow = Math.round(divider.ratio * 100);
  return (
    <div
      data-wb-tiling-divider
      role="separator"
      aria-orientation="vertical"
      aria-label={t('a11y.tilingDivider', '平铺分割条')}
      aria-valuemin={Math.round(MIN_TILING_RATIO * 100)}
      aria-valuemax={Math.round(MAX_TILING_RATIO * 100)}
      aria-valuenow={valueNow}
      tabIndex={0}
      onPointerDown={divider.onPointerDown}
      onKeyDown={divider.onKeyDown}
      style={{
        position: 'absolute',
        left: centerX - 4,
        top: 0,
        bottom: 0,
        width: 8,
        cursor: 'col-resize',
        zIndex: 'var(--wb-z-tiling-divider)',
        touchAction: 'none',
        pointerEvents: 'auto',
      }}
    />
  );
};

// ---------------------------------------------------------------------------
// 桌面组件
// ---------------------------------------------------------------------------

export const WorkbenchDesktop: React.FC = () => {
  const { t } = useTranslation('workbench');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [desktopOffset, setDesktopOffset] = useState({ x: 0, y: 0 });
  /** 吸附引擎读取 ref 快照；拖拽热路径绝不能重新测量 DOMRect。 */
  const desktopOffsetRef = useRef({ x: 0, y: 0 });

  // ---- 设置状态（启动回放 + workbench:settings-changed 热更新）----
  const [wallpaper, setWallpaper] = useState<WallpaperConfig>(DEFAULT_WALLPAPER);
  const [tileMargins, setTileMargins] = useState<TileMarginsSetting>(DEFAULT_TILE_MARGINS);
  const [dockAutohide, setDockAutohide] = useState(false);
  const [devPanel, setDevPanel] = useState(false);

  const tileMargin = tileMargins.enabled ? tileMargins.px : 0;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [
        tierVal,
        wallpaperVal,
        marginsVal,
        autohideVal,
        devPanelVal,
        dockMagVal,
      ] = await Promise.all([
        readSetting(SETTING_KEYS.materialTier),
        readSetting(SETTING_KEYS.wallpaper),
        readSetting(SETTING_KEYS.tileMargins),
        readSetting(SETTING_KEYS.dockAutohide),
        readSetting(SETTING_KEYS.devPanel),
        readSetting(SETTING_KEYS.dockMagnification),
      ]);
      if (cancelled) return;
      const tier = String(tierVal ?? '');
      setMaterialTier(
        tier === 'full' || tier === 'reduced' || tier === 'minimal'
          ? (tier as MaterialTierSetting)
          : 'auto',
      );
      setWallpaper(parseJson<WallpaperConfig>(wallpaperVal, DEFAULT_WALLPAPER));
      setTileMargins(parseJson<TileMarginsSetting>(marginsVal, DEFAULT_TILE_MARGINS));
      setDockAutohide(String(autohideVal ?? '') === 'true');
      setDevPanel(String(devPanelVal ?? '') === 'true');
      // 未设置默认开放大；显式 'false' 关闭（写 dataset 供 Dock 门控）
      applyDockMagDataset(String(dockMagVal ?? '') !== 'false');
    })();

    const onSettingsChanged = (e: Event) => {
      const { key, value } = (e as CustomEvent<{ key?: string; value?: unknown }>).detail ?? {};
      switch (key) {
        case SETTING_KEYS.wallpaper:
          if (value && typeof value === 'object') setWallpaper(value as WallpaperConfig);
          break;
        case SETTING_KEYS.tileMargins:
          if (value && typeof value === 'object') {
            setTileMargins({ ...DEFAULT_TILE_MARGINS, ...(value as Partial<TileMarginsSetting>) });
          }
          break;
        case SETTING_KEYS.dockAutohide:
          setDockAutohide(value === true);
          break;
        case SETTING_KEYS.devPanel:
          setDevPanel(value === true);
          break;
        case SETTING_KEYS.dockMagnification:
          applyDockMagDataset(value !== false && value !== 'false');
          break;
        default:
          // materialTier 由设置页直接调 setMaterialTier，无需处理
          break;
      }
    };
    window.addEventListener('workbench:settings-changed', onSettingsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('workbench:settings-changed', onSettingsChanged);
      applyDockMagDataset(true);
    };
  }, []);

  // ---- 桌面尺寸 / 偏移（ResizeObserver → rAF 合帧 + 尾随防抖 → store.setDesktopSize）----
  // O13：连续 resize 时每帧至多写一次 store（tiled 窗口逐帧跟随不滞后），
  // 布局稳定后 160ms 再校一次最终 rect；等值短路避免无效重渲染。
  // floating 窗口的钳回可视区自适应发生在 store.setDesktopSize 内（O11 职责）。
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    let raf = 0;
    let settleTimer = 0;
    const measure = () => {
      raf = 0;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const prev = useWindowStore.getState().desktopSize;
        if (prev.w !== rect.width || prev.h !== rect.height) {
          useWindowStore.getState().setDesktopSize({ w: rect.width, h: rect.height });
        }
      }
      const nextOffset = { x: rect.left, y: rect.top };
      desktopOffsetRef.current = nextOffset;
      setDesktopOffset((prev) =>
        prev.x === nextOffset.x && prev.y === nextOffset.y ? prev : nextOffset,
      );
    };
    const schedule = () => {
      if (typeof requestAnimationFrame === 'function') {
        if (!raf) raf = requestAnimationFrame(measure);
      } else {
        measure();
      }
      if (settleTimer) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(measure, 160);
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(el);
    // provider 只返回 ResizeObserver 已测得的快照。禁止在这里恢复
    // getBoundingClientRect()：PointerEngine 会在起拖时调用 provider，布局读取会
    // 与 focus/cursor/drag class 的样式写入相撞，造成跨平台首帧强制 layout。
    setWorkbenchDesktopOffsetProvider(() => desktopOffsetRef.current);
    return () => {
      observer?.disconnect();
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      if (settleTimer) window.clearTimeout(settleTimer);
      setWorkbenchDesktopOffsetProvider(null);
    };
  }, []);

  // ---- 启动链路 + 持久化订阅 + 卸载清理 ----
  useEffect(() => {
    let disposed = false;
    const stopScheduler = startScheduler();
    const disposeProjections = registerSystemProjections();
    registerDockPinnedProvider(getDockPinned);
    const unsubscribePinned = subscribeDockPinned(() => saveSnapshot());
    const unsubscribeStore = useWindowStore.subscribe((state, prev) => {
      if (state.windows !== prev.windows || state.tilingRatios !== prev.tilingRatios) {
        saveSnapshot();
      }
    });
    let unlistenCloseRequested: (() => void) | null = null;
    if (isTauriRuntime()) {
      void import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) =>
          getCurrentWindow().onCloseRequested(async () => {
            // Tauri 会 await handler 后再 destroy；这里是真正可等待的退出屏障。
            await flushSnapshot();
          }),
        )
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlistenCloseRequested = unlisten;
        })
        .catch((error) => {
          console.warn('[workbench] close-request snapshot hook failed:', error);
        });
    }

    void (async () => {
      const snapshot = await loadSnapshot();
      if (disposed) return;
      if (snapshot) {
        const windows = await pruneSnapshotWindows(snapshot.windows);
        if (disposed) return;
        useWindowStore.getState().hydrate(windows, snapshot.tilingRatios, {
          preserveExisting: true,
        });
        setDockPinned(
          snapshot.dockPinned.length > 0 ? snapshot.dockPinned : [...DEFAULT_DOCK_PINNED],
        );
      } else if (getDockPinned().length === 0) {
        setDockPinned([...DEFAULT_DOCK_PINNED]);
      }
      setHydrated(true);
      // 快照恢复完成后补投运行中的长活实例（番茄钟等）
      resyncProjections();
    })();

    return () => {
      disposed = true;
      unsubscribeStore();
      unsubscribePinned();
      unlistenCloseRequested?.();
      // 先落盘（buildSnapshot 同步采集，provider 仍在）再注销
      void flushSnapshot();
      registerDockPinnedProvider(null);
      disposeProjections();
      stopScheduler();
    };
  }, []);

  // ---- 快捷键（俯瞰 / 切换器 / 平铺全集 / 速查表）----
  useWorkbenchShortcuts({ enabled: true });

  // ---- Windows WebView2 呈现自愈（2026-07-10 整层错位事故；详见 hook 头注释）----
  useCompositorNudge(rootRef);

  // ---- O17/O19：桌面资源拖放落点（files → 桌面开窗）----
  useDesktopDrop({
    target: rootRef,
    accept: (info) => info.hasResource,
    onDrop: (payload, point) => {
      if (payload.kind !== 'resource') return;
      void handleDesktopResourceDrop({ resource: payload.resource, point });
    },
  });

  // ---- O13：桌面手势（空白区右键菜单 / 双击 show desktop）----
  const gestures = useDesktopGestures(rootRef);
  useMaterialTier();
  useWallpaperCoveragePause();

  // ---- 窗口集合 ----
  // selector 只返回渲染相关字段的指纹字符串：moveWindow / setTitle 等不改变
  // id/displayMode/minimized/zIndex 的 set 不再触发 Desktop 整树重渲染
  //（zIndex 进指纹是因为 tilingPair 取 zIndex 最高者）
  const windowsFingerprint = useWindowStore((s) =>
    getSortedWindows(s.windows)
      .map((w) => `${w.id}:${w.displayMode}:${w.minimized ? 1 : 0}:${w.zIndex}`)
      .join('|'),
  );
  const orderedWindows = useMemo(() => {
    void windowsFingerprint;
    return getSortedWindows(useWindowStore.getState().windows);
  }, [windowsFingerprint]);

  const handleSnapZoneChange = useCallback((_windowId: string, zone: SnapZone) => {
    // 写入独立 store，勿 setState 刷整棵 Desktop（拖拽卡顿主因之一）
    setActiveSnapZone(zone);
  }, []);

  // 左右平铺对（各取 zIndex 最高者）→ 中缝
  const tilingPair = useMemo(() => {
    const pair = getActiveTilingPair(orderedWindows);
    return pair ? { leftId: pair.left.id, rightId: pair.right.id } : null;
  }, [orderedWindows]);

  return (
    <div
      ref={rootRef}
      data-wb-desktop
      // absolute inset-0：不依赖百分比高度链，避免父级 flex/contain 抖动时桌面只占半屏
      className="absolute inset-0 overflow-hidden"
      tabIndex={0}
      aria-label={t('a11y.desktop', '工作台桌面')}
      onContextMenu={gestures.onDesktopContextMenu}
      onKeyDown={gestures.onDesktopKeyDown}
      onDoubleClick={gestures.onDesktopDoubleClick}
    >
      <div className="wb-wallpaper-frame" aria-hidden="true">
        <WallpaperLayer wallpaper={wallpaper} />
      </div>

      {hydrated && orderedWindows.length === 0 && <EmptyDesktop />}

      {/* 窗口层：自成 stacking context（COORDINATION 裁决），内部 zIndex 与 overlay 定值互不干扰。
          层本身指针穿透（空桌面引导可点），窗口壳 / 中缝各自恢复 pointer-events */}
      <div
        data-wb-window-layer
        className="absolute inset-0"
        style={{ isolation: 'isolate', zIndex: 'var(--wb-z-window-layer)', pointerEvents: 'none' }}
      >
        {orderedWindows.map((win) => (
          <WindowShell
            key={win.id}
            windowId={win.id}
            tileMargin={tileMargin}
            onSnapZoneChange={handleSnapZoneChange}
          />
        ))}
        {tilingPair && (
          <TilingDivider
            leftId={tilingPair.leftId}
            rightId={tilingPair.rightId}
            margin={tileMargin}
          />
        )}
      </div>

      <SnapPreview margin={tileMargin} desktopOffset={desktopOffset} />

      <ExposeOverlay />
      <WindowSwitcher />
      <ShortcutCheatsheet />

      <Dock autohide={dockAutohide} />

      {/* SB1：学习状态菜单栏（z 介于 Dock 与 Dock 飞出层；透明字层） */}
      <StatusBar />

      {/* L4：全部应用面板（Dock / 桌面右键共用 openAppsPanel） */}
      <AppsPanel />

      {devPanel && <WorkbenchDevPanel />}

      {/* O13：桌面空白区右键菜单（z 见 DesktopContextMenu.css，介于 snap 与 DevPanel 之间） */}
      <DesktopContextMenu
        anchor={gestures.menuAnchor}
        wallpaper={wallpaper}
        onClose={gestures.closeMenu}
        onShowDesktop={gestures.toggleShowDesktop}
      />

      <WorkbenchEventBridge />
    </div>
  );
};

export default WorkbenchDesktop;
