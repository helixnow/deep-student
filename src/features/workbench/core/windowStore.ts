/**
 * Workbench 窗口状态机（主责 P1 → O11 打磨：焦点切换平滑 / 瞬态进出场标记 /
 * cascade 感知分布 / hydrate 跨分辨率自适应与逐帧唤醒钩子。
 * WorkbenchStoreState 冻结接口保持不变，仅追加可选扩展）
 *
 * 其他子代理：只允许通过 useWindowStore(selector) 消费，禁止修改本文件。
 *
 * 不变量（由本文件结构性保证）：
 * 1. focusStack = 全部非 minimized 窗口按 zIndex 升序排列（后 = 最近聚焦），
 *    因此栈顶窗口必然持有非 minimized 窗口中的最高 zIndex；
 * 2. focusWindow 总是把目标窗口 zIndex 提到全局最高（已是栈顶时 no-op，
 *    避免无意义的 zIndex 跳变与重渲染），故非 minimized 窗口的
 *    z 序与聚焦新近度一致；
 * 3. tiled/maximized 窗口的渲染矩形由 computeTiledFrame 派生，desktopSize
 *    变化时不改写其 frame（frame 仅是落位前的冗余快照）；
 * 4. transientPhases 为派生 UI 状态，绝不持久化（快照白名单外）。
 */
import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type {
  DisplayMode,
  Frame,
  OpenWindowInput,
  Size,
  WindowLifecycle,
  WindowTransientPhase,
  WorkbenchStoreState,
  WorkbenchWindow,
} from './types';
import { appRegistry } from './appRegistry';

const Z_BASE = 10;
const CASCADE_STEP = 24;
const CASCADE_ORIGIN = 48;
const SMALL_DESKTOP_WIDTH = 1280;
/** desktopSize 收缩时保证 floating 窗口至少露出的边缘宽度 */
const MIN_VISIBLE_EDGE = 48;
const TITLEBAR_HEIGHT = 38;

/**
 * O11：zTop 达到该值时，在同一次 set 内把全部窗口 zIndex 紧凑重排回 Z_BASE 起点
 * （相对序不变 → 单次 React 提交 → 浏览器 stacking 不产生任何视觉跳变）。
 * 防止长会话中 zIndex 无限增长。
 */
export const WINDOW_Z_COMPACT_THRESHOLD = 2000;

let zTop = Z_BASE;
let cascadeIndex = 0;

const DEFAULT_DESKTOP: Size = { w: 1280, h: 800 };
/** hydrate 自适应时窗口收缩下限的兜底（应用未注册 minSize 时用） */
const ADAPT_FALLBACK_MIN_SIZE: Size = { w: 200, h: 150 };

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** displayMode 切换的 restoreFrame / frame 语义（单次与批量共用） */
function applyDisplayModeTransition(win: WorkbenchWindow, mode: DisplayMode): WorkbenchWindow {
  if (win.displayMode === mode) return win;
  const enteringManaged = mode !== 'floating' && win.displayMode === 'floating';
  const returningFloating = mode === 'floating';
  return {
    ...win,
    displayMode: mode,
    // 首次离开 floating 才记录 restoreFrame；tiled↔maximized 互切保留原值
    restoreFrame: enteringManaged
      ? win.frame
      : returningFloating
        ? null
        : win.restoreFrame,
    frame: returningFloating && win.restoreFrame ? win.restoreFrame : win.frame,
  };
}

/**
 * 级联落位（O11 感知已有窗分布）：
 * 1. 依次扫描 48+24k 槽位，取第一个未被现有 floating 窗口占用的槽
 *    （关窗 / 移窗后空出的槽位会被复用，避免新窗与已有窗完全重叠）；
 * 2. 槽位全满时按轮转序回卷（保持确定性，也不总叠死在同一槽上）。
 */
function nextCascadeOrigin(
  w: number,
  h: number,
  desktopSize: Size,
  windows: Record<string, WorkbenchWindow>,
): { x: number; y: number } {
  const maxOffset = Math.min(desktopSize.w - w, desktopSize.h - h);
  const slotCount = Math.max(1, Math.floor((maxOffset - CASCADE_ORIGIN) / CASCADE_STEP) + 1);
  const slotPos = (k: number): { x: number; y: number } => {
    const offset = CASCADE_ORIGIN + k * CASCADE_STEP;
    return {
      x: Math.max(0, Math.min(offset, desktopSize.w - w)),
      y: Math.max(0, Math.min(offset, desktopSize.h - h)),
    };
  };
  // 占用判定：现有 floating 窗（含最小化，恢复时会回原位）左上角落在槽位半步内
  const occupied = Object.values(windows).filter((win) => win.displayMode === 'floating');
  const isFree = (x: number, y: number): boolean =>
    !occupied.some(
      (win) =>
        Math.abs(win.frame.x - x) < CASCADE_STEP / 2 && Math.abs(win.frame.y - y) < CASCADE_STEP / 2,
    );
  for (let k = 0; k < slotCount; k++) {
    const pos = slotPos(k);
    if (isFree(pos.x, pos.y)) {
      cascadeIndex = k + 1;
      return pos;
    }
  }
  const k = cascadeIndex % slotCount;
  cascadeIndex = k + 1;
  return slotPos(k);
}

function nextFrame(
  input: OpenWindowInput,
  desktopSize: Size,
  windows: Record<string, WorkbenchWindow>,
): Frame {
  const def = appRegistry.get(input.typeId);
  const w = input.initialFrame?.w ?? def?.defaultFrame.w ?? 720;
  const h = input.initialFrame?.h ?? def?.defaultFrame.h ?? 520;
  if (input.initialFrame?.x != null && input.initialFrame?.y != null) {
    return { x: input.initialFrame.x, y: input.initialFrame.y, w, h };
  }
  const cascade = nextCascadeOrigin(w, h, desktopSize, windows);
  return {
    x: input.initialFrame?.x ?? cascade.x,
    y: input.initialFrame?.y ?? cascade.y,
    w,
    h,
  };
}

/**
 * zIndex 过渡分配（O11）：zTop 越过阈值时紧凑重排。
 * 必须在产生新 zIndex 的同一次 set 内调用——单次提交内相对序不变，
 * 重排对用户完全不可见（无跳变闪烁）。
 */
function maybeCompactZ(windows: Record<string, WorkbenchWindow>): Record<string, WorkbenchWindow> {
  if (zTop < WINDOW_Z_COMPACT_THRESHOLD) return windows;
  const sorted = Object.values(windows).sort((a, b) => a.zIndex - b.zIndex);
  const compacted: Record<string, WorkbenchWindow> = {};
  sorted.forEach((win, index) => {
    compacted[win.id] = { ...win, zIndex: Z_BASE + index };
  });
  zTop = Z_BASE + Math.max(sorted.length - 1, 0);
  return compacted;
}

// ---------------------------------------------------------------------------
// O11：快照恢复的跨分辨率自适应（snapshot.loadSnapshot 停放 → hydrate 消费）
// ---------------------------------------------------------------------------

let pendingRestoreDesktopSize: Size | null = null;

/**
 * 停放「快照保存时的桌面尺寸」，供下一次 hydrate 做比例缩放自适应；
 * hydrate 消费后自动清空。由 snapshot.loadSnapshot 调用（新导出，非冻结契约）。
 */
export function setPendingRestoreDesktopSize(size: Size | null): void {
  pendingRestoreDesktopSize =
    size && Number.isFinite(size.w) && Number.isFinite(size.h) && size.w > 0 && size.h > 0
      ? { w: size.w, h: size.h }
      : null;
}

/**
 * 多显示器 / 分辨率变化的窗口几何自适应：
 * 1. 已知快照桌面尺寸时按比例缩放位置（保持相对布局）；
 * 2. 超过当前桌面的窗口等比收缩到放得下（保持宽高比，尊重应用 minSize）；
 * 3. 钳回可视区（与 setDesktopSize 相同的可见性保证）。
 */
function adaptFrameToDesktop(
  frame: Frame,
  savedDesktop: Size | null,
  desktop: Size,
  minSize: Size,
): Frame {
  let { x, y, w, h } = frame;
  if (
    savedDesktop &&
    savedDesktop.w > 0 &&
    savedDesktop.h > 0 &&
    (savedDesktop.w !== desktop.w || savedDesktop.h !== desktop.h)
  ) {
    x = (x / savedDesktop.w) * desktop.w;
    y = (y / savedDesktop.h) * desktop.h;
  }
  if (w > desktop.w || h > desktop.h) {
    const fit = Math.min(desktop.w / w, desktop.h / h);
    w = Math.max(minSize.w, w * fit);
    h = Math.max(minSize.h, h * fit);
  }
  const maxX = Math.max(0, desktop.w - MIN_VISIBLE_EDGE);
  const minX = Math.min(0, MIN_VISIBLE_EDGE - w);
  x = clampNumber(x, minX, maxX);
  y = clampNumber(y, 0, Math.max(0, desktop.h - TITLEBAR_HEIGHT));
  return { x, y, w, h };
}

// ---------------------------------------------------------------------------
// O11：hydrate 后回调（snapshot.ts 注册逐帧唤醒调度；无注册时退化为
// scheduler 下一帧全量重算的原有行为）
// ---------------------------------------------------------------------------

let postHydrateHook: (() => void) | null = null;

/** 注册 hydrate 完成后的回调（传 null 注销）；当前由 snapshot.ts 的逐帧唤醒使用 */
export function registerPostHydrateHook(hook: (() => void) | null): void {
  postHydrateHook = hook;
}

/** focusStack 唯一真相源：非 minimized 窗口按 zIndex 升序（后 = 最近聚焦） */
function deriveFocusStack(windows: Record<string, WorkbenchWindow>): string[] {
  return Object.values(windows)
    .filter((win) => !win.minimized)
    .sort((a, b) => a.zIndex - b.zIndex)
    .map((win) => win.id);
}

export const useWindowStore = create<WorkbenchStoreState>((set, get) => ({
  windows: {},
  focusStack: [],
  lifecycles: {},
  launchPayloads: {},
  tilingRatios: {},
  desktopSize: { ...DEFAULT_DESKTOP },
  transientPhases: {},

  openWindow: (input) => {
    const state = get();
    // multi 去重：同 typeId+instanceKey 已存在 → focus
    if (input.instanceKey != null) {
      const existing = Object.values(state.windows).find(
        (win) => win.typeId === input.typeId && win.instanceKey === input.instanceKey,
      );
      if (existing) {
        state.focusWindow(existing.id);
        return existing.id;
      }
    }
    // single 去重
    const def = appRegistry.get(input.typeId);
    if (def?.instanceMode === 'single') {
      const existing = Object.values(state.windows).find((win) => win.typeId === input.typeId);
      if (existing) {
        state.focusWindow(existing.id);
        return existing.id;
      }
    }

    const id = nanoid(10);
    const now = Date.now();
    const smallDesktop = state.desktopSize.w < SMALL_DESKTOP_WIDTH;
    const win: WorkbenchWindow = {
      id,
      typeId: input.typeId,
      instanceKey: input.instanceKey ?? null,
      title: input.title ?? '',
      frame: nextFrame(input, state.desktopSize, state.windows),
      restoreFrame: null,
      displayMode: smallDesktop ? 'maximized' : 'floating',
      minimized: false,
      zIndex: ++zTop,
      createdAt: now,
      lastFocusedAt: now,
    };
    set((s) => {
      const windows = maybeCompactZ({ ...s.windows, [id]: win });
      return {
        windows,
        focusStack: deriveFocusStack(windows),
        launchPayloads:
          input.payload !== undefined
            ? { ...s.launchPayloads, [id]: input.payload }
            : s.launchPayloads,
        // O9 开窗动画标记；动画结束由 O9 清除（残留无害）
        transientPhases: { ...s.transientPhases, [id]: 'opening' as WindowTransientPhase },
      };
    });
    return id;
  },

  closeWindow: (id) => {
    set((s) => {
      if (!s.windows[id]) return s;
      const { [id]: _w, ...windows } = s.windows;
      const { [id]: _p, ...launchPayloads } = s.launchPayloads;
      const { [id]: _l, ...lifecycles } = s.lifecycles;
      const { [id]: _t, ...transientPhases } = s.transientPhases ?? {};
      return {
        windows,
        launchPayloads,
        lifecycles,
        transientPhases,
        focusStack: deriveFocusStack(windows),
      };
    });
  },

  focusWindow: (id) => {
    set((s) => {
      const win = s.windows[id];
      if (!win) return s;
      // 已是焦点窗（栈顶且未最小化）→ no-op：不 bump zIndex、不产生新对象，
      // 消除点击焦点窗内容时的重渲染 / 快照防抖 / zIndex 跳变（焦点切换平滑核心）
      if (!win.minimized && s.focusStack[s.focusStack.length - 1] === id) return s;
      const wasMinimized = win.minimized;
      const windows = maybeCompactZ({
        ...s.windows,
        [id]: { ...win, zIndex: ++zTop, minimized: false, lastFocusedAt: Date.now() },
      });
      return {
        windows,
        focusStack: deriveFocusStack(windows),
        // 反最小化时给 O9 恢复动画标记
        transientPhases: wasMinimized
          ? { ...s.transientPhases, [id]: 'restoring' as WindowTransientPhase }
          : s.transientPhases,
      };
    });
  },

  minimizeWindow: (id, minimized = true) => {
    set((s) => {
      const win = s.windows[id];
      if (!win || win.minimized === minimized) return s;
      const windows = { ...s.windows, [id]: { ...win, minimized } };
      // 最小化提交 = 'minimizing' 动画结束 → 清除标记；
      // 反最小化（不抢焦点路径）→ 给 O9 恢复动画标记
      const transientPhases = { ...s.transientPhases };
      if (minimized) delete transientPhases[id];
      else transientPhases[id] = 'restoring';
      // 反最小化不抢焦点：按自身 zIndex 回到栈中原有位置
      return { windows, transientPhases, focusStack: deriveFocusStack(windows) };
    });
  },

  setWindowTransient: (id, phase) => {
    set((s) => {
      if (!s.windows[id]) return s;
      const current = s.transientPhases ?? {};
      if (phase === null) {
        if (!(id in current)) return s;
        const { [id]: _t, ...transientPhases } = current;
        return { transientPhases };
      }
      if (current[id] === phase) return s;
      return { transientPhases: { ...current, [id]: phase } };
    });
  },

  moveWindow: (id, frame) => {
    set((s) => {
      const win = s.windows[id];
      if (!win) return s;
      return { windows: { ...s.windows, [id]: { ...win, frame } } };
    });
  },

  setDisplayMode: (id, mode: DisplayMode) => {
    set((s) => {
      const win = s.windows[id];
      if (!win || win.displayMode === mode) return s;
      return {
        windows: {
          ...s.windows,
          [id]: applyDisplayModeTransition(win, mode),
        },
      };
    });
  },

  batchSetDisplayModes: (entries) => {
    if (!entries.length) return;
    set((s) => {
      let changed = false;
      const windows = { ...s.windows };
      for (const { id, mode } of entries) {
        const win = windows[id];
        if (!win || win.displayMode === mode) continue;
        windows[id] = applyDisplayModeTransition(win, mode);
        changed = true;
      }
      return changed ? { windows } : s;
    });
  },

  setTitle: (id, title) => {
    set((s) => {
      const win = s.windows[id];
      if (!win || win.title === title) return s;
      return { windows: { ...s.windows, [id]: { ...win, title } } };
    });
  },

  setLifecycles: (map: Record<string, WindowLifecycle>) => set({ lifecycles: map }),

  setTilingRatio: (key, ratio) => {
    set((s) => ({ tilingRatios: { ...s.tilingRatios, [key]: ratio } }));
  },

  setDesktopSize: (size) => {
    set((s) => {
      // tiled/maximized 的渲染矩形由 computeTiledFrame(desktopSize) 派生，frame 不动；
      // floating 窗口钳回可视区，避免缩小桌面后窗口整体丢失在屏幕外。
      let changed = false;
      const windows = { ...s.windows };
      for (const win of Object.values(s.windows)) {
        if (win.displayMode !== 'floating') continue;
        const f = win.frame;
        const maxX = Math.max(0, size.w - MIN_VISIBLE_EDGE);
        const minX = Math.min(0, MIN_VISIBLE_EDGE - f.w);
        const x = clampNumber(f.x, minX, maxX);
        const y = clampNumber(f.y, 0, Math.max(0, size.h - TITLEBAR_HEIGHT));
        if (x !== f.x || y !== f.y) {
          windows[win.id] = { ...win, frame: { ...f, x, y } };
          changed = true;
        }
      }
      return changed ? { desktopSize: size, windows } : { desktopSize: size };
    });
  },

  hydrate: (windows, tilingRatios) => {
    // 多显示器 / 分辨率自适应：快照桌面尺寸（loadSnapshot 停放）→ 当前桌面
    const savedDesktop = pendingRestoreDesktopSize;
    pendingRestoreDesktopSize = null;
    const desktop = get().desktopSize;

    // zIndex 归一化：按快照 z 序（同 z 按 lastFocusedAt）重排为紧凑序列，
    // focusStack 由归一化后的 z 序派生 → 结构性满足「focus 必最高 zIndex」。
    const sorted = [...windows].sort(
      (a, b) => a.zIndex - b.zIndex || a.lastFocusedAt - b.lastFocusedAt,
    );
    const map: Record<string, WorkbenchWindow> = {};
    sorted.forEach((win, index) => {
      const minSize = appRegistry.get(win.typeId)?.minSize ?? ADAPT_FALLBACK_MIN_SIZE;
      map[win.id] = {
        ...win,
        zIndex: Z_BASE + index,
        // frame 与 restoreFrame 同步自适应（tiled/maximized 的 frame 是落位前
        // 冗余快照，同样按新桌面矫正，回 floating 时才不会落在屏外）
        frame: adaptFrameToDesktop(win.frame, savedDesktop, desktop, minSize),
        restoreFrame: win.restoreFrame
          ? adaptFrameToDesktop(win.restoreFrame, savedDesktop, desktop, minSize)
          : null,
      };
    });
    zTop = Z_BASE + Math.max(sorted.length - 1, 0);

    const focusStack = deriveFocusStack(map);
    // 逐帧唤醒调度（设计 §7）：首帧只完整渲染焦点窗口，其余先标 background，
    // 由 post-hydrate 钩子（snapshot.ts 注册）逐帧提升；未注册钩子时
    // scheduler 下一帧全量重算即回到完整档位（优雅降级）。
    const topId = focusStack[focusStack.length - 1];
    const lifecycles: Record<string, WindowLifecycle> = {};
    for (const win of sorted) {
      lifecycles[win.id] = win.id === topId ? 'focused' : 'background';
    }

    set({
      windows: map,
      focusStack,
      tilingRatios,
      lifecycles,
      // 快照绝不含 payload / 瞬态标记；整体替换时清空
      launchPayloads: {},
      transientPhases: {},
    });
    postHydrateHook?.();
  },
}));

/**
 * O9 便捷 hook：订阅单窗瞬态进出场阶段（无标记时返回 null）。
 */
export function useWindowTransientPhase(windowId: string): WindowTransientPhase | null {
  return useWindowStore((s) => s.transientPhases?.[windowId] ?? null);
}

/** 仅供单元测试：重置 store 与模块级状态（zTop / cascadeIndex / 停放的恢复尺寸） */
export function resetWindowStoreForTests(desktopSize: Size = { ...DEFAULT_DESKTOP }): void {
  zTop = Z_BASE;
  cascadeIndex = 0;
  pendingRestoreDesktopSize = null;
  useWindowStore.setState({
    windows: {},
    focusStack: [],
    lifecycles: {},
    launchPayloads: {},
    tilingRatios: {},
    desktopSize,
    transientPhases: {},
  });
}
