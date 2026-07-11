/**
 * WindowShell（P3 / O2）— 窗口 chrome 容器。
 *
 * - 静止 / 缩放：left/top/width/height 直写 DOM
 * - 拖拽跟手：锚定 left/top，位移走 translate3d（合成层，避免每帧布局）
 * - 阴影档不随拖拽切换（COORDINATION：勿抬起/放下阴影）
 * - 消费 windowStore 单窗 selector + computeTiledFrame（tiled/maximized 几何）
 * - 标题栏拖动移动、边缘缩放、点击任意处 focusWindow
 * - wb-window / wb-window-focused / wb-window-idle 类名契约 + wb-shell-* 手感层
 * - 拖动期间内容层 pointer-events:none（DOM 直写，不进 state）
 *
 * 指针引擎注入点：P2 的 useWindowPointer（components/window-shell/useWindowPointer.ts）
 * 默认经 useWorkbenchWindowPointer 适配器接入；useDefaultWindowPointer 保留为无吸附兜底。
 */
import React, { memo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DisplayMode,
  Frame,
  Size,
  SnapZone,
  WindowPointerCallbacks,
} from '../core/types';
import { useWindowStore } from '../core/windowStore';
import { recomputeLifecycles } from '../core/scheduler';
import {
  enterShellGestureGlobal,
  leaveShellGestureGlobal,
} from '../core/shellGestureFlags';
import {
  buildTileSettleKeyframes,
  computeTiledFrame,
  getTilingRatioForWindow,
  zoneToDisplayMode,
} from '../core/tiling';
import { prefersReducedMotion } from '../core/pointerEngine';
import {
  beginInteraction,
  endInteraction,
  markInteraction,
  timeInteractionPhase,
} from '../core/interactionTrace';
import { useWorkbenchWindowPointer } from './window-shell/workbenchPointerAdapter';
import { appRegistry } from '../core/appRegistry';
import {
  lockWorkbenchCursor,
  type WorkbenchCursorKind,
} from '../hooks/useWorkbenchGestures';
import { announceWorkbench, getWindowA11yProps } from '../hooks/useWorkbenchA11y';
import {
  requestCloseAnimated,
  requestMinimizeAnimated,
} from '../hooks/useWindowLifecycleAnim';
import { WindowTitleBar, TITLEBAR_HEIGHT } from './WindowTitleBar';
import { WindowResizeHandles, type ResizeDirection } from './WindowResizeHandles';
import { WindowBody } from './WindowBody';
import type { TileMenuAction } from './TileMenuPopover';
import { shouldNotifyAgentUserInput } from '../agent/inputProbe';
import { useWindowPresence } from '../agent/presenceStore';
import { stageManager } from '../agent/stageManager';
import { AgentStrip } from '../agent/visuals/AgentStrip';
import '../agent/visuals/agent-visuals.css';
import './WindowShell.css';

/** 退出 maximize/tile → floating 的 FLIP settle 时长（跟手优先，尽量短） */
const RESTORE_SETTLE_MS = 120;
/**
 * 拖/缩手势 → shellGestureFlags（`<html data-wb-dragging>`）。
 * 视差 / 壁纸流动 / 内容暂停 / SnapPreview 等据此让路。
 *
 * ANTI-REGRESSION（起拖卡一下）：
 * - pointerdown 当帧：壳层跟手 + **同步**挂 data-wb-dragging（内容 MutationObserver 暂停）。
 * - 光标全屏盾、scheduler hint 刷新仍延后（hint 会唤醒全部 WindowBody React 树）。
 * - scheduler 使用明确 begin/end，不得恢复定时续期。
 */

/** 与 useWorkbenchShortcuts TILE_ZONE_LABEL 对齐（windowTiled 公告 zone） */
const TILE_ZONE_LABEL: Partial<Record<DisplayMode, string>> = {
  'tiled-left': '左半屏',
  'tiled-right': '右半屏',
  'tiled-tl': '左上',
  'tiled-tr': '右上',
  'tiled-bl': '左下',
  'tiled-br': '右下',
};

function cursorForResizeEdge(dir: ResizeDirection): WorkbenchCursorKind {
  switch (dir) {
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    case 'nw':
    case 'se':
    default:
      return 'nwse-resize';
  }
}
// ============================================================================
// 指针引擎注入接口
// ============================================================================

export interface WindowShellPointerArgs {
  windowId: string;
  /** 当前已提交 frame（shell 每次渲染保持同步） */
  frameRef: React.RefObject<Frame>;
  minSize: Size;
  getDesktopSize: () => Size;
  /** 冻结契约回调（types.ts WindowPointerCallbacks） */
  callbacks: WindowPointerCallbacks;
  /** 拖动会话开始/结束（shell 用于内容层 pointer-events:none） */
  onDragStateChange?: (dragging: boolean) => void;
  /**
   * move 越过启动阈值时回调（tear-out 还原）。
   * 传入武装瞬间的视口指针坐标；拖拽 tear-out 路径不播 restore settle。
   */
  onMoveArmed?: (point: { x: number; y: number }) => void;
}

export interface WindowShellPointerResult {
  onMovePointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onResizePointerDown: (dir: ResizeDirection, e: React.PointerEvent<HTMLElement>) => void;
}

export type WindowShellPointerHook = (args: WindowShellPointerArgs) => WindowShellPointerResult;

/** SnapZone → DisplayMode（P2 在 tiling.ts 导出 zoneToDisplayMode 后由 P11 切换） */
export function snapZoneToDisplayMode(zone: Exclude<SnapZone, null>): DisplayMode {
  switch (zone) {
    case 'left':
      return 'tiled-left';
    case 'right':
      return 'tiled-right';
    case 'tl':
      return 'tiled-tl';
    case 'tr':
      return 'tiled-tr';
    case 'bl':
      return 'tiled-bl';
    case 'br':
      return 'tiled-br';
    case 'top-maximize':
    default:
      return 'maximized';
  }
}

// ============================================================================
// 默认指针实现（无吸附；P2 引擎就绪后可整体替换）
// ============================================================================

interface PointerSession {
  kind: 'move' | ResizeDirection;
  pointerId: number;
  target: HTMLElement;
  startX: number;
  startY: number;
  startFrame: Frame;
  lastFrame: Frame;
  raf: number;
  latestX: number;
  latestY: number;
  cleanup: () => void;
}

function computeSessionFrame(
  session: PointerSession,
  minSize: Size,
  desktop: Size,
): Frame {
  const dx = session.latestX - session.startX;
  const dy = session.latestY - session.startY;
  const { startFrame: sf, kind } = session;

  if (kind === 'move') {
    const x = Math.min(Math.max(sf.x + dx, -(sf.w - 80)), Math.max(0, desktop.w - 80));
    const y = Math.min(Math.max(sf.y + dy, 0), Math.max(0, desktop.h - TITLEBAR_HEIGHT));
    return { x, y, w: sf.w, h: sf.h };
  }

  let { x, y, w, h } = sf;
  if (kind.includes('e')) {
    w = Math.max(minSize.w, sf.w + dx);
  }
  if (kind.includes('w')) {
    w = Math.max(minSize.w, sf.w - dx);
    x = sf.x + (sf.w - w);
  }
  if (kind.includes('s')) {
    h = Math.max(minSize.h, sf.h + dy);
  }
  if (kind.includes('n')) {
    h = Math.max(minSize.h, sf.h - dy);
    y = sf.y + (sf.h - h);
  }
  return { x, y, w, h };
}

export const useDefaultWindowPointer: WindowShellPointerHook = ({
  frameRef,
  minSize,
  getDesktopSize,
  callbacks,
  onDragStateChange,
}) => {
  const sessionRef = useRef<PointerSession | null>(null);
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const begin = useCallback(
    (kind: 'move' | ResizeDirection, e: React.PointerEvent<HTMLElement>) => {
      if (sessionRef.current || e.button !== 0) return;
      const startFrame = { ...(frameRef.current as Frame) };
      const target = e.currentTarget as HTMLElement;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // jsdom / 不支持捕获时忽略
      }

      const session: PointerSession = {
        kind,
        pointerId: e.pointerId,
        target,
        startX: e.clientX,
        startY: e.clientY,
        startFrame,
        lastFrame: startFrame,
        raf: 0,
        latestX: e.clientX,
        latestY: e.clientY,
        cleanup: () => {},
      };

      const finish = (commit: boolean) => {
        if (sessionRef.current !== session) return;
        session.cleanup();
        if (session.raf) cancelAnimationFrame(session.raf);
        try {
          session.target.releasePointerCapture(session.pointerId);
        } catch {
          // ignore
        }
        sessionRef.current = null;
        onDragStateChange?.(false);
        const cb = cbRef.current;
        if (commit) {
          cb.onCommit(session.lastFrame, null);
        } else {
          // Esc / pointercancel：回原位，不产生位移
          cb.onFrameChange(session.startFrame);
          cb.onSnapZoneChange(null);
          cb.onCommit(session.startFrame, null);
        }
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== session.pointerId) return;
        session.latestX = ev.clientX;
        session.latestY = ev.clientY;
        if (session.raf) return;
        session.raf = requestAnimationFrame(() => {
          session.raf = 0;
          if (sessionRef.current !== session) return;
          const frame = computeSessionFrame(session, minSize, getDesktopSize());
          session.lastFrame = frame;
          const cb = cbRef.current;
          cb.onFrameChange(frame);
          cb.onSnapZoneChange(null);
        });
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== session.pointerId) return;
        finish(true);
      };
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== session.pointerId) return;
        finish(false);
      };
      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') {
          ev.stopPropagation();
          finish(false);
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKeyDown, true);
      session.cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKeyDown, true);
      };

      sessionRef.current = session;
      onDragStateChange?.(true);
    },
    [frameRef, minSize, getDesktopSize, onDragStateChange],
  );

  return {
    onMovePointerDown: (e) => begin('move', e),
    onResizePointerDown: (dir, e) => begin(dir, e),
  };
};

// ============================================================================
// WindowShell
// ============================================================================

const FALLBACK_MIN_SIZE: Size = { w: 320, h: 240 };
const DEFAULT_TILE_MARGIN = 8;

export interface WindowShellProps {
  windowId: string;
  /** 平铺间距 px（设置项由 P11 接线；0 = 关闭 margins），默认 8 */
  tileMargin?: number;
  /** 拖动中吸附区变化（Desktop 层渲染 SnapPreview，P11 接线） */
  onSnapZoneChange?: (windowId: string, zone: SnapZone) => void;
  /** 指针引擎注入（默认内置实现；P11 接入 P2 useWindowPointer 适配器） */
  usePointer?: WindowShellPointerHook;
  /** 内容覆盖；缺省渲染 <WindowBody>（隔离测试/Storybook 场景可注入任意内容） */
  children?: React.ReactNode;
}

interface ShellGestureSession {
  kind: 'move' | 'resize';
  releaseCursor: () => void;
}

const WindowShellImpl: React.FC<WindowShellProps> = ({
  windowId,
  tileMargin = DEFAULT_TILE_MARGIN,
  onSnapZoneChange,
  usePointer,
  children,
}) => {
  const { t } = useTranslation('workbench');
  const win = useWindowStore((s) => s.windows[windowId]);
  const desktopSize = useWindowStore((s) => s.desktopSize);
  const ratio = useWindowStore((s) =>
    getTilingRatioForWindow(s.windows, s.tilingRatios, windowId),
  );
  const focused = useWindowStore(
    (s) => s.focusStack[s.focusStack.length - 1] === windowId,
  );
  /** ACR R1-10：presence 驱动光环 / AgentStrip / 内容区输入探测（无 presence 时零开销） */
  const presence = useWindowPresence(windowId);

  const rootRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<Frame>({ x: 0, y: 0, w: 0, h: 0 });
  /** 手势会话：DOM class/style/光标锁直写，0 次 React 重渲染 */
  const gestureRef = useRef<ShellGestureSession | null>(null);
  /** 退出 maximize/tile 的 FLIP settle（拖拽 tear-out 不走此路径） */
  const restoreAnimRef = useRef<Animation | null>(null);
  /** restoreToFloating 自管 settle 时置位，避免 store 订阅重复播 */
  const ownedRestoreSettleRef = useRef(false);
  /** 拖拽 tear-out 进行中：跳过 restore settle（跟手优先） */
  const tearOutActiveRef = useRef(false);
  /** 非焦点窗按下后待提交的 store focus（拖拽中延后到松手，避免中途重渲染） */
  const pendingFocusRef = useRef(false);
  /** 手势期间 DOM 抬升的 zIndex；重渲染时勿被旧 win.zIndex 盖掉 */
  const dragZRef = useRef<number | null>(null);
  /** move 跟手锚点：left/top 固定于此，位移走 translate3d */
  const dragAnchorRef = useRef<Frame | null>(null);

  const def = win ? appRegistry.get(win.typeId) : undefined;
  const minSize = def?.minSize ?? FALLBACK_MIN_SIZE;
  const appName = def ? t(def.nameKey) : undefined;

  // ---- 有效 frame：tiled/maximized 走 computeTiledFrame，floating 用 win.frame ----
  const tiledFrame =
    win && win.displayMode !== 'floating'
      ? computeTiledFrame(win.displayMode, {
          desktopSize,
          margin: win.displayMode === 'maximized' ? 0 : tileMargin,
          ratio:
            win.displayMode === 'tiled-left' || win.displayMode === 'tiled-right'
              ? ratio
              : undefined,
        })
      : null;
  const frame: Frame = tiledFrame ?? win?.frame ?? frameRef.current;
  // 手势中 frameRef 由引擎直写；勿用 store 快照覆盖，否则重渲染会跳回旧位
  if (!gestureRef.current) {
    frameRef.current = frame;
  }

  // ---- 手势壳层：classList / 光标锁 / 内容层 pointer-events（均不进 state）----
  /**
   * focusWindow / focusSelf 后把 DOM 焦点带入壳（tabIndex=-1）。
   * 拖拽中不抢焦点；焦点已在壳内（含内容/三键）时不挪，避免打断输入与叠双环。
   */
  const bringDomFocusToShell = useCallback(() => {
    const el = rootRef.current;
    if (!el || gestureRef.current) return;
    const active = document.activeElement;
    if (active instanceof Node && el.contains(active)) return;
    el.focus({ preventScroll: true });
  }, []);

  /** 把视觉 frame 落到 left/top，并清空 transform（松手 / 缩放 / tear-out 重锚） */
  const writeLayoutFrame = useCallback((el: HTMLElement, f: Frame) => {
    el.style.left = `${f.x}px`;
    el.style.top = `${f.y}px`;
    el.style.width = `${f.w}px`;
    el.style.height = `${f.h}px`;
    el.style.transform = '';
  }, []);

  /** 起拖时若布局已与锚点一致，跳过写 style，避免无谓强制布局 */
  const ensureLayoutFrame = useCallback(
    (el: HTMLElement, f: Frame) => {
      const left = `${f.x}px`;
      const top = `${f.y}px`;
      const width = `${f.w}px`;
      const height = `${f.h}px`;
      if (
        el.style.left === left &&
        el.style.top === top &&
        el.style.width === width &&
        el.style.height === height &&
        !el.style.transform
      ) {
        return;
      }
      writeLayoutFrame(el, f);
    },
    [writeLayoutFrame],
  );

  const beginShellGesture = useCallback((kind: 'move' | 'resize', cursor: WorkbenchCursorKind) => {
    const el = rootRef.current;
    if (!el) return;
    // 若上一次会话未正常结束，先释放光标锁与全局拖拽旗
    if (gestureRef.current) {
      gestureRef.current.releaseCursor();
      leaveShellGestureGlobal();
    }
    // 光标全屏盾延后一帧：与 pointerdown 同步创建 fixed ::after 会和
    // will-change / 首个 transform 抢同一帧（尤其 WebView2）。
    let cursorRaf = 0;
    let releaseLock: (() => void) | null = null;
    cursorRaf = requestAnimationFrame(() => {
      cursorRaf = 0;
      if (!gestureRef.current) return;
      releaseLock = lockWorkbenchCursor(cursor);
    });
    const releaseCursor = () => {
      if (cursorRaf) {
        cancelAnimationFrame(cursorRaf);
        cursorRaf = 0;
      }
      releaseLock?.();
      releaseLock = null;
    };
    gestureRef.current = { kind, releaseCursor };
    enterShellGestureGlobal();
    const winTypeId = useWindowStore.getState().windows[windowId]?.typeId;
    beginInteraction({
      kind: kind === 'move' ? 'drag' : 'resize',
      windowId,
      meta: winTypeId ? { typeId: winTypeId } : undefined,
    });
    // flag 在 enter 时已挂；begin 之后记相对时刻
    markInteraction('flagSet');

    if (kind === 'move') {
      const anchor = { ...frameRef.current };
      dragAnchorRef.current = anchor;
      timeInteractionPhase('layoutAnchor', () => ensureLayoutFrame(el, anchor), 'layoutAnchor');
      timeInteractionPhase(
        'shellClass',
        () => {
          el.classList.add('wb-shell-dragging');
          el.classList.remove('wb-shell-resizing');
        },
        'shellClass',
      );
    } else {
      dragAnchorRef.current = null;
      timeInteractionPhase(
        'shellClass',
        () => {
          el.classList.add('wb-shell-resizing');
          el.classList.remove('wb-shell-dragging');
        },
        'shellClass',
      );
      markInteraction('firstMove');
    }
    markInteraction('armed');
    // ANTI-REGRESSION：手势期间只关内容命中。禁止动态切 contain /
    // content-visibility（即使延到 rAF）——会在首个 transform 前强制整棵
    // 重内容子树重新布局/绘制，跨 WebView2 / WKWebView / WebKitGTK 都会起拖卡一下。
    //
    // aria-hidden + inert：内容仍可见，但从无障碍树摘掉。WebView2 在 UIA 客户端
    // 活跃时，跟手 translate 会每帧重算控件密集窗（设置）的 AX bounds → ~100ms
    // longtask；display:none 能到 6ms 也符合「AX 子树被剪掉」。视觉不变。
    const content = contentRef.current;
    if (content) {
      content.style.pointerEvents = 'none';
      content.setAttribute('aria-hidden', 'true');
      content.inert = true;
    }
  }, [ensureLayoutFrame, windowId]);

  const endShellGesture = useCallback(() => {
    const el = rootRef.current;
    const session = gestureRef.current;
    if (!session) return;
    gestureRef.current = null;
    session.releaseCursor();
    leaveShellGestureGlobal();
    endInteraction();
    if (!el) return;

    // 松手：把 translate 折进 left/top，阴影/定位与静止态一致
    writeLayoutFrame(el, frameRef.current);
    dragAnchorRef.current = null;
    el.classList.remove('wb-shell-dragging', 'wb-shell-resizing');
    if (contentRef.current) {
      contentRef.current.style.pointerEvents = '';
      contentRef.current.removeAttribute('aria-hidden');
      contentRef.current.inert = false;
    }

    // 拖拽期间延后的焦点：松手后再写 store（跟手优先）
    if (pendingFocusRef.current) {
      pendingFocusRef.current = false;
      const id = windowId;
      queueMicrotask(() => {
        const s = useWindowStore.getState();
        if (s.focusStack[s.focusStack.length - 1] === id) {
          dragZRef.current = null;
          bringDomFocusToShell();
          return;
        }
        s.focusWindow(id);
        dragZRef.current = null;
        bringDomFocusToShell();
        requestAnimationFrame(() => {
          recomputeLifecycles();
        });
      });
    } else {
      dragZRef.current = null;
    }
  }, [windowId, bringDomFocusToShell, writeLayoutFrame]);

  const settleShellFrame = useCallback((f: Frame) => {
    const el = rootRef.current;
    if (!el) return;
    frameRef.current = f;
    // tear-out / commit：重锚 left/top，清空 translate
    if (gestureRef.current?.kind === 'move') {
      dragAnchorRef.current = { ...f };
    }
    writeLayoutFrame(el, f);
  }, [writeLayoutFrame]);

  /** 取消进行中的 restore FLIP（再次抓取 / 新 settle 前） */
  const cancelRestoreSettle = useCallback(() => {
    const anim = restoreAnimRef.current;
    if (!anim) return;
    restoreAnimRef.current = null;
    anim.cancel();
  }, []);

  /**
   * 退出 maximize/tile → floating 的 FLIP settle（与 SnapPreview 进入方向对称）。
   * 拖拽 tear-out 不调用（跟手优先）。记录 from rect → 换 displayMode → 反向 transform → 过渡回 0。
   */
  const runRestoreSettle = useCallback(
    (from: Frame, to: Frame) => {
      cancelRestoreSettle();
      const el = rootRef.current;
      if (!el || prefersReducedMotion()) {
        settleShellFrame(to);
        return;
      }
      const keyframes = buildTileSettleKeyframes(from, to);
      if (!keyframes || typeof el.animate !== 'function') {
        settleShellFrame(to);
        return;
      }
      settleShellFrame(to);
      const prevOrigin = el.style.transformOrigin;
      el.style.transformOrigin = '0 0';
      const anim = el.animate(keyframes as Keyframe[], {
        duration: RESTORE_SETTLE_MS,
        easing: 'linear',
        fill: 'none',
      });
      restoreAnimRef.current = anim;
      const cleanup = () => {
        el.style.transformOrigin = prevOrigin;
        if (restoreAnimRef.current === anim) restoreAnimRef.current = null;
      };
      anim.addEventListener('finish', cleanup);
      anim.addEventListener('cancel', cleanup);
    },
    [cancelRestoreSettle, settleShellFrame],
  );

  /** 非拖拽路径：从 managed → floating，带 FLIP settle */
  const restoreToFloating = useCallback(
    (targetFrame?: Frame) => {
      const store = useWindowStore.getState();
      const current = store.windows[windowId];
      if (!current || current.displayMode === 'floating') return;
      const from = { ...frameRef.current };
      const to =
        targetFrame ??
        current.restoreFrame ?? {
          x: 0,
          y: 0,
          w: def?.defaultFrame.w ?? 720,
          h: def?.defaultFrame.h ?? 520,
        };
      ownedRestoreSettleRef.current = true;
      store.setDisplayMode(windowId, 'floating');
      if (targetFrame) store.moveWindow(windowId, targetFrame);
      runRestoreSettle(from, to);
      queueMicrotask(() => {
        ownedRestoreSettleRef.current = false;
      });
    },
    [windowId, def, runRestoreSettle],
  );

  /**
   * 快捷键等外部路径：managed → floating 时补 FLIP settle。
   * tear-out / restoreToFloating 自管路径跳过。
   */
  useEffect(() => {
    let prevMode = useWindowStore.getState().windows[windowId]?.displayMode;
    return useWindowStore.subscribe((state) => {
      const cur = state.windows[windowId];
      if (!cur) {
        prevMode = undefined;
        return;
      }
      const before = prevMode;
      prevMode = cur.displayMode;
      if (!before || before === 'floating' || cur.displayMode !== 'floating') return;
      if (ownedRestoreSettleRef.current || tearOutActiveRef.current || gestureRef.current) return;
      if (prefersReducedMotion()) return;
      const from = { ...frameRef.current };
      const to = cur.frame;
      // 等 React 提交新布局后再 FLIP（与 SnapPreview 进入方向对称）
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (gestureRef.current || !rootRef.current) return;
          runRestoreSettle(from, to);
        });
      });
    });
  }, [windowId, runRestoreSettle]);

  /**
   * 外部 focusWindow（Dock / 切换器 / 快捷键）：栈顶变为本窗时把 DOM 焦点带入壳。
   * 拖拽中不抢；本窗已是栈顶的 no-op 不触发。
   */
  useEffect(() => {
    let prevTop = useWindowStore.getState().focusStack.at(-1);
    if (prevTop === windowId) {
      queueMicrotask(() => {
        const state = useWindowStore.getState();
        if (state.focusStack.at(-1) !== windowId || state.windows[windowId]?.minimized) return;
        bringDomFocusToShell();
      });
    }
    return useWindowStore.subscribe((state) => {
      const top = state.focusStack.at(-1);
      if (top === prevTop) return;
      prevTop = top;
      if (top !== windowId) return;
      if (gestureRef.current || pendingFocusRef.current) return;
      queueMicrotask(() => {
        if (gestureRef.current) return;
        const latest = useWindowStore.getState();
        if (latest.focusStack.at(-1) !== windowId || latest.windows[windowId]?.minimized) return;
        bringDomFocusToShell();
      });
    });
  }, [windowId, bringDomFocusToShell]);

  /**
   * 拖拽 tear-out：过阈值后从 maximized/tiled 视觉还原为浮动尺寸，按光标相对位置定位。
   * 只写 DOM / frameRef，不写 store——避免拖动中途 React 重渲染卡顿；松手由 onCommit 落库。
   */
  const tearOutToFloating = useCallback(
    (clientX: number, clientY: number) => {
      const store = useWindowStore.getState();
      const current = store.windows[windowId];
      if (!current || current.displayMode === 'floating') return;
      cancelRestoreSettle();
      tearOutActiveRef.current = true;
      const size = current.restoreFrame ?? {
        x: 0,
        y: 0,
        w: def?.defaultFrame.w ?? 720,
        h: def?.defaultFrame.h ?? 520,
      };
      const parentRect = rootRef.current?.parentElement?.getBoundingClientRect();
      const pointerDesktopX = clientX - (parentRect?.left ?? 0);
      const pointerDesktopY = clientY - (parentRect?.top ?? 0);
      const currentFrame = frameRef.current;
      const proportion =
        currentFrame.w > 0
          ? Math.min(Math.max((pointerDesktopX - currentFrame.x) / currentFrame.w, 0), 1)
          : 0.5;
      const newFrame: Frame = {
        x: Math.round(pointerDesktopX - proportion * size.w),
        y: Math.max(0, Math.round(pointerDesktopY - TITLEBAR_HEIGHT / 2)),
        w: size.w,
        h: size.h,
      };
      // 仅 DOM：引擎会立刻以新 frame 为原点继续跟手
      settleShellFrame(newFrame);
    },
    [windowId, def, cancelRestoreSettle, settleShellFrame],
  );

  const handleDragStateChange = useCallback(
    (dragging: boolean) => {
      if (dragging) {
        // stub / 适配器可能只调 true；若壳层尚未 begin，按 move 兜底
        if (!gestureRef.current) beginShellGesture('move', 'grabbing');
      } else {
        endShellGesture();
      }
    },
    [beginShellGesture, endShellGesture],
  );

  const handleMoveArmed = useCallback(
    (point: { x: number; y: number }) => {
      tearOutToFloating(point.x, point.y);
    },
    [tearOutToFloating],
  );

  // ---- 指针回调（冻结契约 WindowPointerCallbacks）----
  const applyFrameToDom = useCallback((f: Frame) => {
    const el = rootRef.current;
    if (!el) return;
    frameRef.current = f;

    // move：锚定 left/top，位移走 translate3d（合成层跟手，避免每帧布局）
    if (gestureRef.current?.kind === 'move') {
      let anchor = dragAnchorRef.current;
      if (!anchor) {
        anchor = { ...f };
        dragAnchorRef.current = anchor;
        writeLayoutFrame(el, anchor);
      }
      // tear-out 改尺寸时重锚（宽高变了就不能只靠 translate）
      if (anchor.w !== f.w || anchor.h !== f.h) {
        dragAnchorRef.current = { ...f };
        writeLayoutFrame(el, f);
        return;
      }
      const dx = f.x - anchor.x;
      const dy = f.y - anchor.y;
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      markInteraction('firstMove');
      return;
    }

    // resize / 静止：布局属性直写
    writeLayoutFrame(el, f);
    if (gestureRef.current?.kind === 'resize') {
      markInteraction('firstMove');
    }
  }, [writeLayoutFrame]);

  const handleSnapZoneChange = useCallback(
    (zone: SnapZone) => {
      onSnapZoneChange?.(windowId, zone);
    },
    [onSnapZoneChange, windowId],
  );

  const handleCommit = useCallback(
    (f: Frame, zone: SnapZone) => {
      const store = useWindowStore.getState();
      if (!store.windows[windowId]) return;
      // 先取整落 DOM，再写 store——避免亚像素跟手 → 整数 commit 的可见跳动被感知成「放下」
      const final = {
        x: Math.round(f.x),
        y: Math.round(f.y),
        w: Math.round(f.w),
        h: Math.round(f.h),
      };
      settleShellFrame(final);
      const zoneMode = zoneToDisplayMode(zone);
      if (zoneMode) {
        store.setDisplayMode(windowId, zoneMode);
      } else {
        if (store.windows[windowId].displayMode !== 'floating') {
          // tear-out / 从平铺拖走：松手才写 floating（拖动中只改了 DOM）
          store.setDisplayMode(windowId, 'floating');
        }
        store.moveWindow(windowId, final);
      }
      tearOutActiveRef.current = false;
      onSnapZoneChange?.(windowId, null);
      // 松手后先落位绘制，遮挡重算延后一帧，避免「放下」卡顿
      requestAnimationFrame(() => {
        recomputeLifecycles();
      });
    },
    [windowId, onSnapZoneChange, settleShellFrame],
  );

  const callbacks: WindowPointerCallbacks = {
    onFrameChange: applyFrameToDom,
    onSnapZoneChange: handleSnapZoneChange,
    onCommit: handleCommit,
  };

  const getDesktopSize = useCallback(() => useWindowStore.getState().desktopSize, []);

  // P11 一行替换点：默认指针实现 = P2 引擎适配器（吸附命中 + 四路回退）；
  // useDefaultWindowPointer 保留为无吸附兜底，隔离测试仍可注入。
  const usePointerImpl = usePointer ?? useWorkbenchWindowPointer;
  const pointer = usePointerImpl({
    windowId,
    frameRef,
    minSize,
    getDesktopSize,
    callbacks,
    onDragStateChange: handleDragStateChange,
    onMoveArmed: handleMoveArmed,
  });

  // ---- 交互 handlers ----
  /**
   * 非焦点窗按下：先 DOM 置顶（即时可拖），store focus 延后。
   * - 若随后进入拖拽：等松手再 focusWindow，避免拖动中途全窗重渲染
   * - 若只是点击内容区：microtask 内无手势，立即 focusWindow
   */
  const focusSelf = useCallback(() => {
    const store = useWindowStore.getState();
    if (store.focusStack[store.focusStack.length - 1] === windowId) {
      // 已是焦点窗：仍尝试入壳（键盘切换后点空白区等）；拖拽中不抢
      bringDomFocusToShell();
      return;
    }

    const el = rootRef.current;
    if (el) {
      let maxZ = 0;
      for (const w of Object.values(store.windows)) {
        if (w.zIndex > maxZ) maxZ = w.zIndex;
      }
      const nextZ = maxZ + 1;
      dragZRef.current = nextZ;
      el.style.zIndex = String(nextZ);
      // 只即时置顶，不在起拖期间切换大模糊阴影。视觉 focused class 交给
      // 松手/纯点击后的 store render，避免阴影 repaint 与首个 transform 争帧。
    }

    pendingFocusRef.current = true;
    queueMicrotask(() => {
      if (!pendingFocusRef.current) return;
      // 标题栏拖拽已在同一次 pointerdown 里抬升壳层 → 延后到 endShellGesture
      if (gestureRef.current) return;
      pendingFocusRef.current = false;
      const s = useWindowStore.getState();
      if (s.focusStack[s.focusStack.length - 1] === windowId) {
        dragZRef.current = null;
        bringDomFocusToShell();
        return;
      }
      s.focusWindow(windowId);
      dragZRef.current = null;
      bringDomFocusToShell();
      requestAnimationFrame(() => {
        recomputeLifecycles();
      });
    });
  }, [windowId, bringDomFocusToShell]);

  /** Tab / 程序化 focus 进入非顶层窗口时同步提升 store，但保留子控件焦点。 */
  const handleFocusCapture = useCallback(() => {
    if (gestureRef.current) return;
    const store = useWindowStore.getState();
    if (store.focusStack.at(-1) === windowId) return;
    pendingFocusRef.current = false;
    dragZRef.current = null;
    store.focusWindow(windowId);
    requestAnimationFrame(() => recomputeLifecycles());
  }, [windowId]);

  const handleMovePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // 适配器已在 pointerdown 抬升壳层；引擎过阈值后才 tear-out / commit
      pointer.onMovePointerDown(e);
    },
    [pointer],
  );

  const handleResizePointerDown = useCallback(
    (dir: ResizeDirection, e: React.PointerEvent<HTMLElement>) => {
      cancelRestoreSettle();
      beginShellGesture('resize', cursorForResizeEdge(dir));
      pointer.onResizePointerDown(dir, e);
    },
    [pointer, beginShellGesture, cancelRestoreSettle],
  );

  const handleClose = useCallback(() => {
    void requestCloseAnimated(windowId).then((closed) => {
      if (closed) recomputeLifecycles();
    });
  }, [windowId]);

  const handleMinimize = useCallback(() => {
    requestMinimizeAnimated(windowId);
    recomputeLifecycles();
  }, [windowId]);

  const handleZoom = useCallback(() => {
    const store = useWindowStore.getState();
    const current = store.windows[windowId];
    if (!current) return;
    const title = current.title || appName || '';
    if (current.displayMode === 'maximized') {
      restoreToFloating();
      announceWorkbench(
        t('a11y.restored', { title, defaultValue: `${title} 已恢复` }),
      );
    } else {
      // floating / tiled → maximized（tiled 进入方向由 SnapPreview settle 承接）
      store.setDisplayMode(windowId, 'maximized');
      announceWorkbench(
        t('a11y.zoomed', { title, defaultValue: `${title} 已最大化` }),
      );
    }
    recomputeLifecycles();
  }, [windowId, restoreToFloating, appName, t]);

  const handleTileAction = useCallback(
    (action: TileMenuAction) => {
      const store = useWindowStore.getState();
      const current = store.windows[windowId];
      if (!current) return;
      const title = current.title || appName || '';
      if (action === 'restore') {
        restoreToFloating();
        announceWorkbench(
          t('a11y.restored', { title, defaultValue: `${title} 已恢复` }),
        );
      } else if (action === 'center') {
        const desktop = store.desktopSize;
        const size =
          current.displayMode === 'floating'
            ? current.frame
            : current.restoreFrame ?? current.frame;
        const centered: Frame = {
          x: Math.max(0, Math.round((desktop.w - size.w) / 2)),
          y: Math.max(0, Math.round((desktop.h - size.h) / 2)),
          w: size.w,
          h: size.h,
        };
        if (current.displayMode !== 'floating') {
          restoreToFloating(centered);
        } else {
          store.moveWindow(windowId, centered);
        }
        // 快捷键 center 无独立 a11y key；从平铺/最大化居中时播 restored（几何已回 floating）
        if (current.displayMode !== 'floating') {
          announceWorkbench(
            t('a11y.restored', { title, defaultValue: `${title} 已恢复` }),
          );
        }
      } else if (action === 'maximized') {
        store.setDisplayMode(windowId, action);
        announceWorkbench(
          t('a11y.zoomed', { title, defaultValue: `${title} 已最大化` }),
        );
      } else {
        store.setDisplayMode(windowId, action);
        const zone = TILE_ZONE_LABEL[action];
        if (zone) {
          announceWorkbench(
            t('a11y.windowTiled', {
              title,
              zone,
              defaultValue: `${title} 已平铺至${zone}`,
            }),
          );
        }
      }
      recomputeLifecycles();
    },
    [windowId, restoreToFloating, appName, t],
  );

  /**
   * ACR R1-10 / R2-06：内容区用户输入 → 仲裁暂停。
   * 过滤：滚轮不绑；标题栏/AgentStrip/中键/纯滚动键不触发。
   */
  const handleAgentUserPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!shouldNotifyAgentUserInput(e)) return;
      stageManager.notifyUserInput(windowId);
    },
    [windowId],
  );
  const handleAgentUserKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!shouldNotifyAgentUserInput(e)) return;
      stageManager.notifyUserInput(windowId);
    },
    [windowId],
  );

  if (!win) return null;

  const a11y = getWindowA11yProps({
    title: win.title,
    appName,
    focused,
    minimized: win.minimized,
    // useTranslation('workbench') 已绑定 namespace，解析为 workbench:a11y.windowRole（locale 已落盘）
    roleDescription: t('a11y.windowRole', { defaultValue: '窗口' }),
  });

  // 手势中可能因 focus/store 触发重渲染：读 gestureRef 保持瞬态定位不被 React style 冲掉
  const activeGesture = gestureRef.current;
  const liveFrame = frameRef.current;

  return (
    <section
      ref={rootRef}
      className={[
        'wb-window',
        // O9 编排（wb-lifec-*）为唯一开窗/最小化动画源；停用旧 wb-anim-open / wb-anim-minimize 挂载
        focused ? 'wb-window-focused' : 'wb-window-idle',
        // 手势类以 DOM classList 为主；重渲染时从 gestureRef 回填，避免被冲掉
        activeGesture?.kind === 'move' ? 'wb-shell-dragging' : '',
        activeGesture?.kind === 'resize' ? 'wb-shell-resizing' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        position: 'absolute',
        // 静止 / 缩放：left/top；拖拽跟手：锚点 left/top + translate3d（见 applyFrameToDom）
        left: activeGesture?.kind === 'move' && dragAnchorRef.current
          ? dragAnchorRef.current.x
          : liveFrame.x,
        top: activeGesture?.kind === 'move' && dragAnchorRef.current
          ? dragAnchorRef.current.y
          : liveFrame.y,
        width: liveFrame.w,
        height: liveFrame.h,
        transform:
          activeGesture?.kind === 'move' && dragAnchorRef.current
            ? `translate3d(${liveFrame.x - dragAnchorRef.current.x}px, ${liveFrame.y - dragAnchorRef.current.y}px, 0)`
            : undefined,
        zIndex: dragZRef.current ?? win.zIndex,
        display: 'flex',
        flexDirection: 'column',
        visibility: win.minimized ? 'hidden' : undefined,
        // 桌面窗口层为 pointer-events:none（P11 总装：让空桌面引导可点），窗口自身恢复命中
        pointerEvents: 'auto',
      }}
      data-wb-window
      data-wb-window-id={windowId}
      data-window-id={windowId}
      data-display-mode={win.displayMode}
      data-focused={focused || undefined}
      data-agent-active={presence?.status === 'acting' ? '' : undefined}
      data-agent-paused={presence?.status === 'pausedByUser' ? '' : undefined}
      {...a11y}
      onPointerDownCapture={focusSelf}
      onFocusCapture={handleFocusCapture}
    >
      <WindowTitleBar
        windowId={windowId}
        appTypeId={win.typeId}
        title={win.title}
        focused={focused}
        displayMode={win.displayMode}
        onClose={handleClose}
        onMinimize={handleMinimize}
        onZoom={handleZoom}
        onTileAction={handleTileAction}
        onMovePointerDown={handleMovePointerDown}
      />
      {presence ? <AgentStrip windowId={windowId} /> : null}
      <div
        ref={contentRef}
        className="relative min-h-0 flex-1"
        data-wb-window-content
        style={activeGesture ? { pointerEvents: 'none' } : undefined}
        onPointerDownCapture={presence ? handleAgentUserPointerDown : undefined}
        onKeyDownCapture={presence ? handleAgentUserKeyDown : undefined}
      >
        {children ?? <WindowBody windowId={windowId} />}
      </div>
      <WindowResizeHandles
        disabled={win.displayMode !== 'floating'}
        onResizePointerDown={handleResizePointerDown}
      />
    </section>
  );
};

/** memo：Desktop 因 snapZone 重渲染时，未变 props 的窗壳不跟着刷 */
export const WindowShell = memo(WindowShellImpl);
WindowShell.displayName = 'WindowShell';

export default WindowShell;
