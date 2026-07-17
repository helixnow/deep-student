/**
 * ExposeOverlay — 窗口俯瞰（Mission Control 式，P6 交付 / O7 打磨）
 *
 * 核心约束（设计文档 §6.3）：
 * - 对现有窗口 DOM 施加 transform 等比缩小，**不卸载不截图**；
 *   通过 `[data-wb-window-id]` 定位窗口壳元素，注入 `data-expose-transform`
 *   + `wb-expose-flip` + 内联 transform / `--wb-expose-scale`；
 * - 网格布局保持每窗宽高比（computeExposeLayout 纯函数，可单测）；
 * - FLIP：进入时缓存原 rect → 计算网格目标 → transform 过渡飞入；
 *   退出/选中时反向飞回原位后再交还焦点；关窗后网格平滑重排；
 * - 点击缩略聚焦并退出；Esc / 点击空白退出；方向键导航 + Enter 选中；
 * - 背景使用 §0.3 契约类 `wb-expose-backdrop`；动效仅 transform/opacity。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowStore } from '../core/windowStore';
import { useWorkbenchOverlay } from '../core/shortcuts';
import { appRegistry } from '../core/appRegistry';
import type { Frame, Size, WorkbenchWindow } from '../core/types';
import { requestCloseAnimated } from '../hooks/useWindowLifecycleAnim';
import { useFocusReturn } from '../hooks/useWorkbenchA11y';
import './ExposeOverlay.css';

// ============================================================================
// 网格布局纯函数（导出供测试）
// ============================================================================

export interface ExposeItem {
  id: string;
  /** 当前视觉 frame（桌面坐标系） */
  frame: Frame;
}

export interface ExposeTarget {
  id: string;
  /** 缩放后的目标矩形（桌面坐标系） */
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

export interface ExposeLayoutOptions {
  /** 桌面四周留白 */
  padding?: number;
  /** 缩略图间距 */
  gap?: number;
  /** 每格下方标题标签预留高度 */
  labelHeight?: number;
}

/**
 * 按窗口数计算行列网格；每窗在自己的格内等比缩放（保持宽高比，不放大），
 * 空间顺序（先上后下、先左后右）排布，末行居中。
 */
export function computeExposeLayout(
  items: ExposeItem[],
  desktop: Size,
  options?: ExposeLayoutOptions,
): ExposeTarget[] {
  const n = items.length;
  if (n === 0) return [];

  const padding = options?.padding ?? 48;
  const gap = options?.gap ?? 24;
  const labelHeight = options?.labelHeight ?? 32;

  // 空间顺序：主序 y、次序 x（120px 行容差聚类，避免近似同行时抖动）
  const sorted = [...items].sort((a, b) => {
    const rowA = Math.round(a.frame.y / 120);
    const rowB = Math.round(b.frame.y / 120);
    return rowA !== rowB ? rowA - rowB : a.frame.x - b.frame.x;
  });

  // 行列：按桌面宽高比取近方形网格
  const aspect = desktop.h > 0 ? desktop.w / desktop.h : 1.6;
  const cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * aspect))));
  const rows = Math.ceil(n / cols);

  const innerW = desktop.w - padding * 2;
  const innerH = desktop.h - padding * 2;
  const cellW = Math.max(1, (innerW - (cols - 1) * gap) / cols);
  const rowTotalH = Math.max(1, (innerH - (rows - 1) * gap) / rows);
  const availH = Math.max(1, rowTotalH - labelHeight);

  const targets: ExposeTarget[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    const row = Math.floor(i / cols);
    const col = i % cols;
    // 末行不满时整体居中
    const itemsInRow = row === rows - 1 ? n - (rows - 1) * cols : cols;
    const rowOffsetX = ((cols - itemsInRow) * (cellW + gap)) / 2;

    const srcW = Math.max(1, item.frame.w);
    const srcH = Math.max(1, item.frame.h);
    const scale = Math.max(0.05, Math.min(cellW / srcW, availH / srcH, 1));
    const w = srcW * scale;
    const h = srcH * scale;

    const cellX = padding + rowOffsetX + col * (cellW + gap);
    const cellY = padding + row * (rowTotalH + gap);
    targets.push({
      id: item.id,
      x: cellX + (cellW - w) / 2,
      y: cellY + (availH - h) / 2,
      w,
      h,
      scale,
    });
  }
  return targets;
}

/** 导出：与 computeExposeLayout 相同的列数算法（键盘导航用） */
export function computeExposeCols(itemCount: number, desktop: Size): number {
  if (itemCount <= 0) return 1;
  const aspect = desktop.h > 0 ? desktop.w / desktop.h : 1.6;
  return Math.max(1, Math.min(itemCount, Math.ceil(Math.sqrt(itemCount * aspect))));
}

// ============================================================================
// DOM transform / FLIP 注入
// ============================================================================

/** 退出/FLIP 兜底时长（> --wb-motion-gentle 320ms；animationend 为快路径） */
const FLIP_FALLBACK_MS = 400;
const DISSOLVE_FALLBACK_MS = 220;

interface AppliedEntry {
  el: HTMLElement;
  prevTransform: string;
  prevTransition: string;
  prevOrigin: string;
  prevWillChange: string;
  prevClassName: string;
}

interface PendingRestore {
  timer: number;
  el: HTMLElement;
  transition: string;
  origin: string;
  willChange: string;
}

function parseCssDurationMs(raw: string): number | null {
  const v = raw.trim();
  if (!v) return null;
  if (v.endsWith('ms')) {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  if (v.endsWith('s')) {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n * 1000 : null;
  }
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 读取 FLIP 时长：reduced-motion / minimal 归零；否则读 --wb-motion-gentle
 *（与 CSS --wb-expose-duration 同源）。收尾逻辑不依赖真实动画时长。
 */
function getMotionDurationMs(rootEl?: Element | null): number {
  try {
    if (typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return 0;
    }
  } catch {
    /* jsdom 等环境无 matchMedia 实现时忽略 */
  }
  if (document.documentElement.getAttribute('data-wb-material') === 'minimal') return 0;

  const probe = rootEl ?? document.documentElement;
  try {
    const fromExpose = parseCssDurationMs(
      getComputedStyle(probe).getPropertyValue('--wb-expose-duration'),
    );
    if (fromExpose != null) return Math.max(0, fromExpose);
  } catch { /* ignore */ }
  try {
    const fromToken = parseCssDurationMs(
      getComputedStyle(document.documentElement).getPropertyValue('--wb-motion-gentle'),
    );
    if (fromToken != null) return Math.max(0, fromToken);
  } catch { /* ignore */ }
  return 320;
}

function flipTransition(durationMs: number): string {
  if (durationMs <= 0) return 'none';
  return `transform ${durationMs}ms var(--wb-ease-spring-soft, cubic-bezier(0.3, 1.12, 0.36, 1))`;
}

function collectWindowElements(): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>();
  document.querySelectorAll<HTMLElement>('[data-wb-window-id]').forEach((el) => {
    const id = el.getAttribute('data-wb-window-id');
    if (id) map.set(id, el);
  });
  return map;
}

function moveSelection(
  index: number,
  key: string,
  cols: number,
  count: number,
): number {
  if (count <= 0) return 0;
  const row = Math.floor(index / cols);
  const col = index % cols;
  const lastRow = Math.floor((count - 1) / cols);
  switch (key) {
    case 'ArrowRight':
      return Math.min(count - 1, index + 1);
    case 'ArrowLeft':
      return Math.max(0, index - 1);
    case 'ArrowDown': {
      if (row >= lastRow) return index;
      return Math.min(count - 1, index + cols);
    }
    case 'ArrowUp': {
      if (row <= 0) return index;
      const prev = index - cols;
      return prev >= 0 ? prev : index;
    }
    default:
      return index;
  }
}

// ============================================================================
// 组件
// ============================================================================

interface TargetWithTitle extends ExposeTarget {
  title: string;
}

type ExposePhase = 'entering' | 'open' | 'closing';

/** 关闭态 selector 的稳定空引用：窗口变更不再触发重渲染 */
const EMPTY_WINDOWS: Record<string, WorkbenchWindow> = {};

const ExposeOverlayComponent: React.FC = () => {
  const { t } = useTranslation();
  const exposeOpen = useWorkbenchOverlay((s) => s.exposeOpen);
  const closeExpose = useWorkbenchOverlay((s) => s.closeExpose);

  /** 退出动画期间仍保持挂载（声明须在 windows 订阅之前，供 active 短路） */
  const [rendered, setRendered] = useState(false);

  // 关闭且不在退出动画期时不消费 windows（恒返回同一空引用，窗口变更不重渲染）
  const active = exposeOpen || rendered;
  const windows = useWindowStore((s) => (active ? s.windows : EMPTY_WINDOWS));
  const desktopSize = useWindowStore((s) => s.desktopSize);
  const focusWindow = useWindowStore((s) => s.focusWindow);

  // 打开时记录焦点；Esc/backdrop 关闭后归还；选中开窗走 skipNextReturn 自行落焦
  const { skipNextReturn } = useFocusReturn(exposeOpen);
  const [phase, setPhase] = useState<ExposePhase>('entering');
  const [targets, setTargets] = useState<TargetWithTitle[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [dissolvingId, setDissolvingId] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const hitLayerRef = useRef<HTMLDivElement | null>(null);
  /** 已施加 transform 的窗口（用于恢复原状） */
  const appliedRef = useRef<Map<string, AppliedEntry>>(new Map());
  /** 会话内缓存的原始视觉矩形（元素已被 transform 后不可再量测） */
  const sourceRectsRef = useRef<Map<string, Frame>>(new Map());
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dissolveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dissolveUnsubscribeRef = useRef<(() => void) | null>(null);
  const restoreTimersRef = useRef<Map<string, PendingRestore>>(new Map());
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const finishPendingRestore = useCallback((id: string) => {
    const pending = restoreTimersRef.current.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.el.style.transition = pending.transition;
    pending.el.style.transformOrigin = pending.origin;
    pending.el.style.willChange = pending.willChange;
    restoreTimersRef.current.delete(id);
  }, []);

  const restoreOne = useCallback((id: string, animate: boolean) => {
    finishPendingRestore(id);
    const entry = appliedRef.current.get(id);
    if (!entry) return;
    const { el } = entry;
    const duration = animate ? getMotionDurationMs(rootRef.current) : 0;
    el.style.transition = flipTransition(duration);
    el.style.transform = entry.prevTransform;
    el.removeAttribute('data-expose-transform');
    el.style.removeProperty('--wb-expose-scale');
    el.classList.remove('wb-expose-flip');
    appliedRef.current.delete(id);
    sourceRectsRef.current.delete(id);
    if (duration <= 0) {
      el.style.transition = entry.prevTransition;
      el.style.transformOrigin = entry.prevOrigin;
      el.style.willChange = entry.prevWillChange;
      return;
    }
    const pending: PendingRestore = {
      timer: window.setTimeout(() => {
        if (restoreTimersRef.current.get(id) !== pending) return;
        finishPendingRestore(id);
      }, duration),
      el,
      transition: entry.prevTransition,
      origin: entry.prevOrigin,
      willChange: entry.prevWillChange,
    };
    restoreTimersRef.current.set(id, pending);
  }, [finishPendingRestore]);

  const restoreAll = useCallback((animate: boolean) => {
    const ids = [...appliedRef.current.keys()];
    for (const id of ids) restoreOne(id, animate);
    sourceRectsRef.current.clear();
  }, [restoreOne]);

  // 打开/窗口集合变化 → 量测 + 施加 FLIP transform
  useEffect(() => {
    if (!exposeOpen) return;
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    setRendered(true);
    setPhase((p) => (p === 'closing' ? 'entering' : p === 'open' ? 'open' : 'entering'));

    const visibleWindows = Object.values(windows).filter((w) => !w.minimized);
    const elements = collectWindowElements();
    const rootRect = rootRef.current?.getBoundingClientRect();
    const originX = rootRect && rootRect.width > 0 ? rootRect.left : 0;
    const originY = rootRect && rootRect.height > 0 ? rootRect.top : 0;

    // 原始视觉矩形：优先会话缓存，其次 DOM 量测，最后 store frame 兜底
    const items: ExposeItem[] = [];
    const liveIds = new Set<string>();
    for (const win of visibleWindows) {
      liveIds.add(win.id);
      const cached = sourceRectsRef.current.get(win.id);
      if (cached) {
        items.push({ id: win.id, frame: cached });
        continue;
      }
      const el = elements.get(win.id);
      let frame: Frame | null = null;
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          frame = { x: rect.left - originX, y: rect.top - originY, w: rect.width, h: rect.height };
        }
      }
      if (!frame) frame = { ...win.frame };
      sourceRectsRef.current.set(win.id, frame);
      items.push({ id: win.id, frame });
    }

    // 已关闭但仍挂着 transform 的窗：立即还原（不动画）
    for (const id of [...appliedRef.current.keys()]) {
      if (!liveIds.has(id)) restoreOne(id, false);
    }

    const layout = computeExposeLayout(items, desktopSize);
    const duration = getMotionDurationMs(rootRef.current);

    for (const target of layout) {
      const el = elements.get(target.id);
      if (!el) continue;
      // 关闭动画尚未收尾便重新打开：先完成旧会话恢复，防止旧 timer
      // 在新会话中途覆盖 transition/origin/will-change。
      finishPendingRestore(target.id);
      const source = sourceRectsRef.current.get(target.id);
      if (!source) continue;
      if (!appliedRef.current.has(target.id)) {
        appliedRef.current.set(target.id, {
          el,
          prevTransform: el.style.transform,
          prevTransition: el.style.transition,
          prevOrigin: el.style.transformOrigin,
          prevWillChange: el.style.willChange,
          prevClassName: el.className,
        });
      }
      const tx = target.x - source.x;
      const ty = target.y - source.y;
      el.style.transition = flipTransition(duration);
      el.style.transformOrigin = 'top left';
      el.style.willChange = 'transform';
      el.style.setProperty('--wb-expose-scale', String(target.scale));
      el.style.transform = `translate(${tx}px, ${ty}px) scale(${target.scale})`;
      el.setAttribute('data-expose-transform', 'true');
      el.classList.add('wb-expose-flip');
    }

    const titleById = new Map(visibleWindows.map((w) => {
      const fallback = appRegistry.get(w.typeId)?.nameKey;
      const title = w.title
        || (fallback ? t(fallback, w.typeId) : '')
        || t('workbench:expose.untitled');
      return [w.id, title] as const;
    }));
    const nextTargets = layout.map((tg) => ({ ...tg, title: titleById.get(tg.id) ?? '' }));
    setTargets(nextTargets);

    // 选中：保留仍存在的选中项；否则取焦点栈顶；再否则首项
    setSelectedId((prev) => {
      if (prev && nextTargets.some((tg) => tg.id === prev)) return prev;
      const stack = useWindowStore.getState().focusStack;
      const focused = [...stack].reverse().find((id) => nextTargets.some((tg) => tg.id === id));
      return focused ?? nextTargets[0]?.id ?? null;
    });

    // entering → open（backdrop 入场动画结束后）
    if (duration <= 0) {
      setPhase('open');
    } else {
      const tOpen = window.setTimeout(() => setPhase('open'), duration);
      return () => window.clearTimeout(tOpen);
    }
    return undefined;
  }, [exposeOpen, windows, desktopSize, t, restoreOne, finishPendingRestore]);

  // 关闭 → 反向 FLIP 飞回原位后卸载
  useEffect(() => {
    if (exposeOpen || !rendered) return;
    setPhase('closing');
    setHoveredId(null);
    restoreAll(true);
    const duration = getMotionDurationMs(rootRef.current);
    const wait = duration > 0 ? Math.max(duration, FLIP_FALLBACK_MS) : 0;
    exitTimerRef.current = setTimeout(() => {
      setRendered(false);
      setTargets([]);
      setSelectedId(null);
      setDissolvingId(null);
      setPhase('entering');
      exitTimerRef.current = null;
    }, wait);
    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, [exposeOpen, rendered, restoreAll]);

  // 组件卸载兜底恢复
  useEffect(() => () => {
    restoreAll(false);
    for (const id of [...restoreTimersRef.current.keys()]) finishPendingRestore(id);
    if (dissolveTimerRef.current) clearTimeout(dissolveTimerRef.current);
    dissolveUnsubscribeRef.current?.();
    dissolveUnsubscribeRef.current = null;
  }, [restoreAll, finishPendingRestore]);

  const focusWindowShell = useCallback((id: string) => {
    const esc =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(id)
        : id;
    const el = document.querySelector<HTMLElement>(`[data-wb-window-id="${esc}"]`);
    if (!el || !document.contains(el)) return;
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  }, []);

  const handlePick = useCallback((id: string) => {
    // 跳过 useFocusReturn 归还，避免与目标窗壳抢焦点
    skipNextReturn();
    focusWindow(id);
    closeExpose();
    // 关闭提交后再落到窗壳（tabIndex=-1 的 data-wb-window-id 根）
    requestAnimationFrame(() => {
      focusWindowShell(id);
    });
  }, [skipNextReturn, focusWindow, closeExpose, focusWindowShell]);

  /**
   * 俯瞰关窗：走 requestCloseAnimated（canClose + 壳退场），通过后再 dissolve。
   * 真实窗在 Exposé 下用纯 opacity 退场（见 WindowLifecycle.css 覆盖），避免与 FLIP scale 复合。
   * canClose 拒绝时不标 dissolve、不关窗。dissolve 标记保持到窗真正从 store 移除。
   */
  const handleCloseCell = useCallback(async (id: string) => {
    if (dissolvingId) return;
    const ok = await requestCloseAnimated(id);
    if (!ok) return;

    setDissolvingId(id);

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (dissolveTimerRef.current) {
        clearTimeout(dissolveTimerRef.current);
        dissolveTimerRef.current = null;
      }
      unsub();
      if (dissolveUnsubscribeRef.current === unsub) dissolveUnsubscribeRef.current = null;
      restoreOne(id, false);
      setDissolvingId((cur) => (cur === id ? null : cur));
    };

    const unsub = useWindowStore.subscribe((s) => {
      if (!s.windows[id]) settle();
    });
    dissolveUnsubscribeRef.current?.();
    dissolveUnsubscribeRef.current = unsub;
    // 已关闭（同步路径）或兜底超时
    if (!useWindowStore.getState().windows[id]) {
      settle();
      return;
    }
    const duration = getMotionDurationMs(rootRef.current);
    // dissolve 视觉 + closing orphan 兜底（~340ms）取较大值，避免 cell 提前恢复
    const wait = duration > 0 ? Math.max(DISSOLVE_FALLBACK_MS, 400) : 0;
    if (dissolveTimerRef.current) clearTimeout(dissolveTimerRef.current);
    if (wait <= 0) {
      settle();
      return;
    }
    dissolveTimerRef.current = setTimeout(settle, wait);
  }, [dissolvingId, restoreOne]);

  // 键盘：方向键导航 / Enter 选中 / Esc 取消
  useEffect(() => {
    if (!exposeOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeExpose();
        return;
      }
      if (e.key === 'Tab') {
        const dialog = hitLayerRef.current;
        if (!dialog) return;
        const focusables = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusables.length === 0) {
          e.preventDefault();
          dialog.focus({ preventScroll: true });
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const activeElement = document.activeElement;
        const inside = activeElement instanceof Node && dialog.contains(activeElement);
        if (e.shiftKey ? !inside || activeElement === first : !inside || activeElement === last) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus({ preventScroll: true });
        }
        return;
      }
      if (e.key === 'Enter') {
        const target = e.target;
        if (target instanceof HTMLElement && target.closest('button, a, input, select, textarea')) {
          return;
        }
        const id = selectedIdRef.current;
        if (id) {
          e.preventDefault();
          e.stopPropagation();
          handlePick(id);
        }
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight'
        || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedId((prev) => {
          const ids = targets.map((tg) => tg.id);
          if (ids.length === 0) return prev;
          const gridCols = computeExposeCols(ids.length, desktopSize);
          const cur = Math.max(0, ids.indexOf(prev ?? ids[0]));
          const next = moveSelection(cur, e.key, gridCols, ids.length);
          return ids[next] ?? prev;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [exposeOpen, closeExpose, handlePick, targets, desktopSize]);

  // 选中项变化时把焦点落到对应 pick 按钮（焦点环 + 键盘可达）
  useEffect(() => {
    if (!exposeOpen || phase === 'closing') return;
    const root = rootRef.current;
    if (!root) return;
    if (!selectedId) {
      hitLayerRef.current?.focus({ preventScroll: true });
      return;
    }
    const pick = root.querySelector<HTMLElement>(
      `[data-wb-expose-cell="${selectedId}"] .wb-expose-cell-pick`,
    );
    if (pick && document.activeElement !== pick) {
      try {
        pick.focus({ preventScroll: true });
      } catch {
        pick.focus();
      }
    }
  }, [selectedId, exposeOpen, phase, targets]);

  if (!rendered && !exposeOpen) return null;

  const fading = phase === 'closing';

  return (
    <div
      ref={rootRef}
      data-wb-expose-root
      data-phase={phase}
      className="wb-expose-root"
      aria-hidden={fading}
    >
      {/* 俯瞰背景：位于壁纸之上、窗口层之下（--wb-z-expose-backdrop = 5） */}
      <div
        className="wb-expose-backdrop absolute inset-0"
        style={{ zIndex: 'var(--wb-z-expose-backdrop)' }}
      />
      {/* 命中层：覆盖所有窗口，点击空白退出、点击缩略聚焦 */}
      <div
        ref={hitLayerRef}
        className="wb-expose-hitlayer"
        style={{ zIndex: 'var(--wb-z-overlay)' }}
        data-dim={hoveredId ? 'true' : undefined}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-label={t('workbench:expose.title')}
        onClick={() => closeExpose()}
      >
        {targets.length === 0 && !fading && (
          <div className="wb-expose-empty">
            <div className="wb-expose-empty-card wb-glass" role="status">
              <span>{t('workbench:expose.empty')}</span>
              <span className="wb-expose-empty-hint">
                {t('workbench:expose.emptyHint')}
              </span>
            </div>
          </div>
        )}
        {targets.map((target) => {
          const selected = selectedId === target.id;
          const dissolving = dissolvingId === target.id;
          return (
            <div
              key={target.id}
              data-wb-expose-cell={target.id}
              data-selected={selected ? 'true' : undefined}
              data-dissolving={dissolving ? 'true' : undefined}
              className="wb-expose-cell"
              style={{
                left: target.x,
                top: target.y,
                width: target.w,
                height: target.h + 36,
              }}
              onMouseEnter={() => setHoveredId(target.id)}
              onMouseLeave={() => setHoveredId((cur) => (cur === target.id ? null : cur))}
            >
              <button
                type="button"
                className="wb-expose-cell-pick"
                tabIndex={selected ? 0 : -1}
                aria-label={target.title}
                title={target.title}
                aria-current={selected ? 'true' : undefined}
                onFocus={() => setSelectedId(target.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  handlePick(target.id);
                }}
              >
                {/* 缩略命中区（窗口本体由 transform 后的真实 DOM 呈现） */}
                <span
                  className="wb-expose-cell-hit"
                  style={{ height: target.h }}
                  aria-hidden
                />
                {/* 标题标签：玻璃小条，窗口下方 */}
                <span
                  className="wb-expose-label wb-glass"
                  style={{ top: target.h + 6, maxWidth: target.w }}
                >
                  {target.title}
                </span>
              </button>
              <button
                type="button"
                className="wb-expose-close"
                tabIndex={selected ? 0 : -1}
                aria-label={t('workbench:expose.closeWindow')}
                title={t('workbench:expose.closeWindow')}
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseCell(target.id);
                }}
              >
                {/* 矢量叉线：任意缩放下都保持锐利（与速查表关闭按钮一致） */}
                <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                  <path
                    d="M2 2 L10 10 M10 2 L2 10"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const ExposeOverlay = React.memo(ExposeOverlayComponent);
ExposeOverlay.displayName = 'ExposeOverlay';

export default ExposeOverlay;
