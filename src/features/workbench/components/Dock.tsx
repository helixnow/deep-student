/**
 * Dock（P5 → O5 打磨）— 底部居中悬浮启动器 / 切换器
 *
 * - 固定区（DockPinnedStore，快照接线 P11）+ 运行区（store 中有窗的 typeId 去重）+ 分隔符
 * - 键盘可达：roving tabindex（←/→/Home/End 移动，Enter/Space 走原生 button 激活）
 * - autohide：prop 驱动（用户设置项，或任一窗口最大化时由桌面强制）—
 *   隐藏至底缘 4px 热区；reveal ~180ms / conceal ~150ms 防误触延迟；
 *   弹出后指针未进入 Dock 就离开底缘也会自动收起（macOS 同语义）
 *
 * O5 动效层（样式见 Dock.css）：
 * - Dock 悬停保持静止，只显示名称气泡；邻近放大已关闭。
 * - autohide 滑入用 O1 overshoot 曲线（wb-dock-slide，复合 translate(-50%, y)）。
 * - dockGeometry：每次布局来源变化（items / 显隐 / resize / 滑动结束）rAF 防抖发布
 *   各 typeId 图标 wrap 的视口坐标，供 O9 genie 最小化收敛点消费。
 *
 * 材质由 CSS 类名契约提供（wb-dock 等，P4 实现），本文件只用类名 + Tailwind 布局工具类。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { appRegistry } from '../core/appRegistry';
import { useWindowStore } from '../core/windowStore';
import { getSortedWindows } from '../core/windowListCache';
import { SquaresFour } from '@phosphor-icons/react';
import { DockItem } from './DockItem';
import { DockContextMenu } from './DockContextMenu';
import { useDockPinned } from './DockPinnedStore';
import {
  clearDockGeometry,
  publishDockIconRects,
  type DockIconRect,
} from './dockGeometry';
import { dockMagLeftExpansion } from './dockMagnification';
import {
  APPS_DOCK_TYPE_ID,
  toggleAppsPanel,
  useAppsPanelOpen,
} from './appsPanelStore';
import {
  AGENT_CONTROL_DOCK_ID,
  AgentControlDockEntry,
} from './AgentControlCenter';
import './Dock.css';

export {
  getDockPinned,
  setDockPinned,
  toggleDockPinned,
  reorderDockPinned,
  subscribeDockPinned,
  useDockPinned,
  useDockPinnedDragReorder,
} from './DockPinnedStore';

export interface DockProps {
  /** 自动隐藏（设置接线 P11）：隐藏至底缘 4px 热区 */
  autohide?: boolean;
  className?: string;
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

// ---------------------------------------------------------------------------
// 邻近放大 magnification 引擎（rAF 直写 DOM，不进 React state）
// ---------------------------------------------------------------------------

/** DockItem 放大层的发现属性（DockItem.tsx 渲染，勿改动字面量） */
const MAG_ITEM_ATTR = 'data-wb-dock-mag-item';
/** 放大激活期间挂在 .wb-dock 上（Dock.css 消费） */
const MAGGING_ATTR = 'data-wb-dock-magging';

interface MagEntry {
  /** .wb-dock-mag 放大层（transform 写入目标） */
  el: HTMLElement;
  /** item wrap（静止锚点；tooltip 可见时写 --wb-dock-lift） */
  wrap: HTMLElement;
  /** dock 局部 x 中心 */
  center: number;
  width: number;
  height: number;
  /** 上次写入的 lift（0.5px 阈值防冗余写） */
  lift: number;
  /** 上次写入的水平位移（与指示点同步） */
  dx: number;
}

interface MagState {
  items: MagEntry[];
  dockLeft: number;
  /** 指针视口 x（step 内减当前 dockLeft；兼容 padding 扩张） */
  pointerX: number;
  /** 上一帧指针视口 x（静止判定） */
  lastPointerX: number;
  /** 进出场强度 0..1（指数趋近，保证进出连续无硬切） */
  strength: number;
  target: number;
  raf: number;
  lastTs: number | null;
  magScale: number;
  sigma: number;
  attack: number;
  /** 上次写入的总扩张量（玻璃 padding） */
  magExtra: number;
  /** 上次全量重测 item 中心时的 magExtra（漂移阈值触发） */
  measuredMagExtra: number;
  /** 距上次全量 item 重测的帧数（节流兜底） */
  framesSinceItemMeasure: number;
}

/** padding 扩张导致中心漂移：超过此 Δ 才全量重测 item（px） */
const MAG_REMEASURE_EXTRA_PX = 2;
/** 即使 magExtra 未超阈值，每 N 帧也重测一次 item（防慢漂） */
const MAG_REMEASURE_EVERY_N_FRAMES = 8;

function readCssNumber(el: HTMLElement, name: string, fallback: number): number {
  const raw = getComputedStyle(el).getPropertyValue(name);
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * @param itemsKey items 列表指纹；放大激活中列表变化（开/关窗、固定切换）即重测几何
 */
function useDockMagnification(
  dockRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  itemsKey: string,
): void {
  const stateRef = React.useRef<MagState>({
    items: [],
    dockLeft: 0,
    pointerX: 0,
    lastPointerX: 0,
    strength: 0,
    target: 0,
    raf: 0,
    lastTs: null,
    magScale: 1.5,
    sigma: 56,
    attack: 60,
    magExtra: 0,
    measuredMagExtra: 0,
    framesSinceItemMeasure: 0,
  });

  const measure = React.useCallback(() => {
    const dock = dockRef.current;
    const s = stateRef.current;
    if (!dock) {
      s.items = [];
      return;
    }
    s.magScale = readCssNumber(dock, '--wb-dock-mag-scale', 1.5);
    s.sigma = Math.max(1, readCssNumber(dock, '--wb-dock-mag-sigma', 56));
    s.attack = Math.max(1, readCssNumber(dock, '--wb-dock-mag-attack', 60));
    s.dockLeft = dock.getBoundingClientRect().left;
    const prevByEl = new Map(s.items.map((it) => [it.el, it]));
    const next: MagEntry[] = [];
    dock.querySelectorAll<HTMLElement>(`[${MAG_ITEM_ATTR}]`).forEach((el) => {
      const wrap = el.parentElement as HTMLElement | null;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const prev = prevByEl.get(el);
      next.push({
        el,
        wrap,
        center: rect.left - s.dockLeft + rect.width / 2,
        width: rect.width || 44,
        height: rect.height || 44,
        lift: prev?.lift ?? 0,
        dx: prev?.dx ?? 0,
      });
    });
    s.items = next;
    s.measuredMagExtra = s.magExtra;
    s.framesSinceItemMeasure = 0;
  }, [dockRef]);

  /** 仅刷新已缓存条目的中心/宽高（padding 扩张后相对 dockLeft 的漂移校正） */
  const remeasureItemCenters = React.useCallback(() => {
    const s = stateRef.current;
    for (const it of s.items) {
      const rect = it.wrap.getBoundingClientRect();
      it.center = rect.left - s.dockLeft + rect.width / 2;
      it.width = rect.width || it.width;
      it.height = rect.height || it.height;
    }
    s.measuredMagExtra = s.magExtra;
    s.framesSinceItemMeasure = 0;
  }, []);

  React.useEffect(() => {
    const dock = dockRef.current;
    if (!dock || !enabled) return undefined;
    const s = stateRef.current;

    const clearWrites = () => {
      for (const it of s.items) {
        it.el.style.transform = '';
        it.wrap.style.removeProperty('--wb-dock-lift');
        it.wrap.style.removeProperty('--wb-dock-ind-dx');
        it.lift = 0;
        it.dx = 0;
      }
      dock.style.removeProperty('--wb-dock-mag-extra');
      s.magExtra = 0;
      s.measuredMagExtra = 0;
      s.framesSinceItemMeasure = 0;
      dock.removeAttribute(MAGGING_ATTR);
    };

    /** 指针下的 wrap（由 pointermove 维护，避免每帧 matches(':hover')） */
    let hoveredWrap: HTMLElement | null = null;
    const tipVisible = (wrap: HTMLElement): boolean =>
      wrap === hoveredWrap || wrap.matches(':focus-within');

    const step = (ts: number) => {
      const dt = s.lastTs == null ? 16 : Math.min(48, Math.max(1, ts - s.lastTs));
      s.lastTs = ts;
      // 强度指数趋近目标：进场丝滑升起、离场平滑归位，且对帧率波动稳定
      const k = 1 - Math.exp(-dt / s.attack);
      s.strength += (s.target - s.strength) * k;
      if (Math.abs(s.target - s.strength) < 0.012) s.strength = s.target;

      const items = s.items;
      const n = items.length;
      if (n === 0 || (s.strength === 0 && s.target === 0)) {
        s.raf = 0;
        s.lastTs = null;
        clearWrites();
        return;
      }

      // 玻璃 padding 变化会平移 dock 左缘：每帧只重测 dockLeft（1 次 rect，便宜）。
      // item 中心相对 dock 在 magExtra 未大变时稳定；超阈值或每 N 帧再全量重测，避免漂移。
      s.dockLeft = dock.getBoundingClientRect().left;
      s.framesSinceItemMeasure += 1;
      const extraDelta = Math.abs(s.magExtra - s.measuredMagExtra);
      if (
        extraDelta > MAG_REMEASURE_EXTRA_PX ||
        s.framesSinceItemMeasure >= MAG_REMEASURE_EVERY_N_FRAMES
      ) {
        remeasureItemCenters();
      }
      // pointerX 存视口 x；step 内减当前 dockLeft，兼容 padding 扩张导致的左缘平移
      const localPointerX = s.pointerX - s.dockLeft;

      const peak = (s.magScale - 1) * s.strength;
      const twoSigmaSq = 2 * s.sigma * s.sigma;
      const scales = new Array<number>(n);
      const extras = new Array<number>(n);
      let total = 0;
      for (let i = 0; i < n; i++) {
        const it = items[i];
        const d = it.center - localPointerX;
        const scale = 1 + peak * Math.exp(-(d * d) / twoSigmaSq);
        scales[i] = scale;
        const extra = it.width * (scale - 1);
        extras[i] = extra;
        total += extra;
      }

      // 指针连续锚定：左侧扩张量随指针在 rest 布局中平滑变化（跨图标无跳变）
      // dx_i = prefix_i + extra_i/2 − leftOfPointer；指针下 rest 点屏幕位置保持不动
      const centers = new Array<number>(n);
      const widths = new Array<number>(n);
      for (let i = 0; i < n; i++) {
        centers[i] = items[i].center;
        widths[i] = items[i].width;
      }
      const leftOfPointer = dockMagLeftExpansion(localPointerX, centers, widths, extras);

      let prefix = 0;
      for (let i = 0; i < n; i++) {
        const it = items[i];
        const extra = extras[i];
        const dx = prefix + extra * 0.5 - leftOfPointer;
        prefix += extra;
        it.el.style.transform = `translate3d(${dx.toFixed(2)}px, 0, 0) scale(${scales[i].toFixed(4)})`;
        it.dx = dx;
        // 指示点水平跟随（CSS 变量，不覆盖 animation 的 transform）
        it.wrap.style.setProperty('--wb-dock-ind-dx', `${dx.toFixed(2)}px`);

        // 图标向上溢出量 → tooltip 抬升（仅 tip 可见时写，走 transform 合成路径）
        const lift = (scales[i] - 1) * it.height;
        if (tipVisible(it.wrap)) {
          if (Math.abs(lift - it.lift) > 0.5) {
            it.lift = lift;
            it.wrap.style.setProperty('--wb-dock-lift', `${lift.toFixed(1)}px`);
          }
        } else if (it.lift !== 0) {
          it.lift = 0;
          it.wrap.style.removeProperty('--wb-dock-lift');
        }
      }

      // 玻璃对称加宽：取左右扩张的较大侧 ×2，避免锚点偏移时单侧溢出，且保持内容居中不位移
      // （padding 为 transform/opacity 纪律的明确豁免；layout 代价局限在 Dock 小子树）
      const padExtra = 2 * Math.max(leftOfPointer, total - leftOfPointer);
      if (Math.abs(padExtra - s.magExtra) > 0.5) {
        s.magExtra = padExtra;
        dock.style.setProperty('--wb-dock-mag-extra', `${padExtra.toFixed(1)}px`);
      }

      // strength 到位且指针静止 → 暂停 rAF；pointermove 再唤醒
      const strengthSettled = s.strength === s.target;
      const pointerStill = Math.abs(s.pointerX - s.lastPointerX) < 0.25;
      s.lastPointerX = s.pointerX;
      if (strengthSettled && pointerStill && s.target === 1) {
        s.raf = 0;
        s.lastTs = null;
        return;
      }

      s.raf = rafSchedule(step);
    };

    const start = () => {
      if (s.raf) return;
      dock.setAttribute(MAGGING_ATTR, '');
      s.lastTs = null;
      s.lastPointerX = s.pointerX - 1; // 强制首帧不因「静止」误停
      s.raf = rafSchedule(step);
    };

    const resolveHoveredWrap = (event: PointerEvent): HTMLElement | null => {
      const t = event.target;
      if (!(t instanceof Element)) return null;
      return t.closest<HTMLElement>('[data-wb-dock-item-wrap]') ?? null;
    };

    const onPointerEnter = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (document.documentElement.hasAttribute('data-wb-dragging')) return;
      measure();
      if (s.magScale <= 1.001 || s.items.length === 0) return;
      // 存视口 x；step 内减当前 dockLeft，兼容 padding 扩张导致的左缘平移
      if (Number.isFinite(event.clientX)) s.pointerX = event.clientX;
      hoveredWrap = resolveHoveredWrap(event);
      s.target = 1;
      start();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      // 窗拖期间有 pointer capture，通常收不到；防御性停放大，避免抢合成带宽
      if (document.documentElement.hasAttribute('data-wb-dragging')) {
        hoveredWrap = null;
        s.target = 0;
        start();
        return;
      }
      if (s.magScale <= 1.001 || s.items.length === 0) return;
      if (Number.isFinite(event.clientX)) s.pointerX = event.clientX;
      hoveredWrap = resolveHoveredWrap(event);
      s.target = 1;
      start();
    };

    const onPointerLeave = () => {
      // 不硬切：目标归零，循环自行衰减到 0 后清写并停帧
      hoveredWrap = null;
      s.target = 0;
      start();
    };

    dock.addEventListener('pointerenter', onPointerEnter);
    dock.addEventListener('pointermove', onPointerMove);
    dock.addEventListener('pointerleave', onPointerLeave);
    return () => {
      dock.removeEventListener('pointerenter', onPointerEnter);
      dock.removeEventListener('pointermove', onPointerMove);
      dock.removeEventListener('pointerleave', onPointerLeave);
      if (s.raf) {
        rafCancel(s.raf);
        s.raf = 0;
      }
      s.lastTs = null;
      s.strength = 0;
      s.target = 0;
      clearWrites();
    };
  }, [dockRef, enabled, measure, remeasureItemCenters]);

  // 放大进行中 items 变化（开/关窗、固定切换）→ 立即重测，防错位
  React.useEffect(() => {
    if (stateRef.current.raf) measure();
  }, [itemsKey, measure]);
}

// ---------------------------------------------------------------------------
// Dock
// ---------------------------------------------------------------------------

function DockImpl({ autohide = false, className }: DockProps) {
  const { t } = useTranslation();
  useRegistryVersion();

  const appsPanelOpen = useAppsPanelOpen();
  const pinned = useDockPinned();

  // 运行区指纹：有窗口的 typeId 按最早开窗时间保序去重后 join。
  // selector 返回原始字符串（zustand 默认 Object.is 比较）——windows 引用每次 set
  // 都会变，但指纹只在「运行应用集合/顺序」实质变化时变，避免 move/focus/setTitle
  // 等提交无谓重渲染整个 Dock。
  const runningKey = useWindowStore((s) => {
    const ordered = getSortedWindows(s.windows);
    const seen: string[] = [];
    for (const win of ordered) {
      if (!seen.includes(win.typeId)) seen.push(win.typeId);
    }
    return seen.join('|');
  });
  // 空指纹 → 空列表（''.split('|') 会产生 ['']，需规避）
  const runningTypeIds = React.useMemo(
    () => (runningKey ? runningKey.split('|') : []),
    [runningKey],
  );

  const runningExtra = runningTypeIds.filter((id) => !pinned.includes(id));
  // 应用项 + 右侧固定「全部应用 / AI 操控」入口（伪 typeId，不进 appRegistry / pinned）
  const appOrderedIds = [...pinned, ...runningExtra];
  const orderedIds = [...appOrderedIds, APPS_DOCK_TYPE_ID, AGENT_CONTROL_DOCK_ID];
  const orderedKey = orderedIds.join('|');

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
    // 弹层内的 ↑/↓/Esc 自己处理；←/→ 等只在 Dock 条上生效
    if ((event.target as HTMLElement | null)?.closest('[data-testid="wb-dock-window-list"]')) return;
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

  // ---- autohide（reveal ~180ms / conceal ~150ms 防误触；离开热区取消）----
  const [revealed, setRevealed] = React.useState(!autohide);
  const revealTimerRef = React.useRef(0);
  const concealTimerRef = React.useRef(0);

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
      setRevealed(true);
    }, 180);
  }, []);

  const scheduleConceal = React.useCallback(() => {
    if (revealTimerRef.current) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = 0;
    }
    if (concealTimerRef.current) return;
    concealTimerRef.current = window.setTimeout(() => {
      concealTimerRef.current = 0;
      setRevealed(false);
    }, 150);
  }, []);

  React.useEffect(() => {
    clearAutohideTimers();
    if (!autohide) setRevealed(true);
    else setRevealed(false);
    return () => clearAutohideTimers();
  }, [autohide, clearAutohideTimers]);
  const hidden = autohide && !revealed;

  const dockRef = React.useRef<HTMLDivElement | null>(null);

  const handleDockPointerLeave = () => {
    if (!autohide) return;
    // 焦点仍在 Dock 内（键盘用户）时不收起
    if (dockRef.current?.contains(document.activeElement)) return;
    scheduleConceal();
  };

  const handleDockBlur = (event: React.FocusEvent) => {
    if (!autohide) return;
    const next = event.relatedTarget as Node | null;
    if (next && dockRef.current?.contains(next)) return;
    scheduleConceal();
  };

  // Dock 悬停不做放大或位移，只保留 DockItem 的名称 tooltip。
  useDockMagnification(dockRef, false, orderedKey);

  // ---- dockGeometry 发布（O9 genie 收敛点；§4 协作接口）----
  const geometryRafRef = React.useRef(0);
  const publishGeometry = React.useCallback(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const map: Record<string, DockIconRect> = {};
    dock.querySelectorAll<HTMLElement>(`[${MAG_ITEM_ATTR}]`).forEach((el) => {
      const typeId = el.getAttribute(MAG_ITEM_ATTR);
      const wrap = el.parentElement;
      if (!typeId || !wrap) return;
      // 测 wrap（静止锚点）：不被放大 transform 污染，放大中坐标依旧稳定
      const rect = wrap.getBoundingClientRect();
      map[typeId] = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    });
    publishDockIconRects(map);
  }, []);

  const publishGeometrySoon = React.useCallback(() => {
    if (geometryRafRef.current) return;
    geometryRafRef.current = rafSchedule(() => {
      geometryRafRef.current = 0;
      publishGeometry();
    });
  }, [publishGeometry]);

  // 图标布局来源只有两个：items 集合（orderedKey 指纹）与 autohide 显隐（hidden）。
  // 依赖收窄到这两者即可，无需每次渲染都 rAF 排队 + 逐图标 getBoundingClientRect；
  // 主题/材质切换等引起的坐标变化由下方 ResizeObserver 与 transitionend 兜底补测。
  React.useEffect(() => {
    publishGeometrySoon();
  }, [orderedKey, hidden, publishGeometrySoon]);

  // resize / autohide 滑动结束 → 补一次精确坐标；卸载清空 provider
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
    window.addEventListener('resize', publishGeometrySoon);
    return () => {
      dock.removeEventListener('transitionend', onTransitionEnd);
      observer?.disconnect();
      window.removeEventListener('resize', publishGeometrySoon);
      if (geometryRafRef.current) {
        rafCancel(geometryRafRef.current);
        geometryRafRef.current = 0;
      }
      clearDockGeometry();
    };
  }, [publishGeometrySoon]);

  const renderItem = (typeId: string) => (
    <DockContextMenu key={typeId} typeId={typeId}>
      <DockItem
        typeId={typeId}
        tabIndex={typeId === effectiveActiveId ? 0 : -1}
        buttonRef={registerButtonRef(typeId)}
        onItemFocus={() => {
          setActiveId(typeId);
          if (autohide) {
            clearAutohideTimers();
            setRevealed(true);
          }
        }}
      />
    </DockContextMenu>
  );

  return (
    <div
      className={cn(
        'wb-dock-zone pointer-events-none absolute inset-x-0 bottom-0 flex justify-center',
        className,
      )}
      style={{ zIndex: 'var(--wb-z-dock)' }}
    >
      {autohide && (
        <div
          data-testid="wb-dock-hotzone"
          aria-hidden
          // 两种状态都接管底缘 4px：隐藏时负责弹出；弹出后指针没上移到 Dock
          // 就离开底缘时负责收起（macOS 同语义；热区与弹出的 Dock 纵向不重叠，
          // 上移到 Dock 时由 Dock 的 pointerenter 清掉收起计时器，不会误收）
          className="wb-dock-hotzone pointer-events-auto absolute inset-x-0 bottom-0 h-1"
          onPointerEnter={scheduleReveal}
          onPointerLeave={() => {
            // 未满 reveal 延迟即离开热区 → 取消弹出，防 4px 热区误触闪现
            if (revealTimerRef.current) {
              window.clearTimeout(revealTimerRef.current);
              revealTimerRef.current = 0;
            }
            scheduleConceal();
          }}
        />
      )}
      <div
        ref={dockRef}
        role="toolbar"
        aria-orientation="horizontal"
        aria-label={t('workbench:dock.label')}
        data-testid="wb-dock"
        data-autohide={autohide || undefined}
        data-hidden={hidden || undefined}
        className={cn(
          'wb-dock flex items-end gap-1 py-1.5 mb-2',
          // 水平 padding 由 Dock.css 管（基础 + --wb-dock-mag-extra 磁吸扩张）
          // autohide 滑入滑出（Dock.css：overshoot 进 / 标准曲线出，复合 translate(-50%, y)）
          autohide && 'wb-dock-slide',
          hidden ? 'pointer-events-none' : 'pointer-events-auto',
        )}
        onKeyDown={handleToolbarKeyDown}
        onPointerEnter={() => {
          if (!autohide) return;
          clearAutohideTimers();
          setRevealed(true);
        }}
        onPointerLeave={handleDockPointerLeave}
        onFocusCapture={() => {
          if (!autohide) return;
          clearAutohideTimers();
          setRevealed(true);
        }}
        onBlurCapture={handleDockBlur}
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
        {/* L4：右侧固定「全部应用」入口（不进 DEFAULT_DOCK_PINNED / appRegistry） */}
        {appOrderedIds.length > 0 && (
          <div
            role="separator"
            aria-orientation="vertical"
            data-testid="wb-dock-apps-separator"
            className="wb-dock-separator mx-1 h-8 w-px self-center"
          />
        )}
        <div
          data-testid={`wb-dock-item-${APPS_DOCK_TYPE_ID}`}
          className="wb-dock-item-wrap relative flex flex-col items-center"
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
                onClick={() => toggleAppsPanel()}
                onFocus={() => {
                  setActiveId(APPS_DOCK_TYPE_ID);
                  if (autohide) {
                    clearAutohideTimers();
                    setRevealed(true);
                  }
                }}
              >
                <span
                  aria-hidden
                  className="wb-dock-item-icon pointer-events-none flex h-full w-full items-center justify-center"
                >
                  <SquaresFour size={26} weight="duotone" />
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
          onFocus={() => {
            setActiveId(AGENT_CONTROL_DOCK_ID);
            if (autohide) {
              clearAutohideTimers();
              setRevealed(true);
            }
          }}
        />
      </div>
    </div>
  );
}

/** props 仅 autohide/className（稳定），memo 隔离父级（桌面壳）重渲染 */
export const Dock = React.memo(DockImpl);
Dock.displayName = 'Dock';
