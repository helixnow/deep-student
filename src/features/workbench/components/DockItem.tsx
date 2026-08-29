/**
 * DockItem（P5 → O5 打磨）— Dock 单个应用项
 *
 * - 点击三分支：无实例 → workbenchBus.launch；单实例 → focus（已聚焦 → minimize）；
 *   多实例 → DockWindowList 弹层
 * - 角标：appRegistry badgeSource（badgeBus 推送为主 + 30s 低频兜底轮询 +
 *   registry subscribe），wb-dock-badge
 * - 作为 DockContextMenu（AppMenu context 模式）的 asChild 触发器：
 *   接受并透传 className / onContextMenu 等外部 props 到根元素
 *
 * O5 动效层（样式见 Dock.css，由 Dock.tsx 统一 import）：
 * - DOM 分层：wrap（静止锚点，供 dockGeometry 测量）
 *     └ .wb-dock-mag（图标静态内层；data-wb-dock-mag-item 供 dockGeometry/genie 发现，
 *         悬停不做放大/位移 —— 图标保持静止，仅 tooltip 显示应用名）
 *         └ .wb-dock-bounce（launch bounce 层，CSS keyframes）
 *             └ button.wb-dock-item（契约类，基线 hover/焦点行为保留）
 * - launch bounce：窗口数 false→true 沿触发，animationend 自清；
 *   reduced-motion / minimal 档不置 bouncing（animation:none 时 end 永不触发）
 * - 长按 ~400ms 出窗口列表（P2，对标 macOS 长按 Dock 图标出窗口菜单）：
 *   任意运行中应用（含单实例）都可长按弹出 DockWindowList；短按点击行为不变
 * - 运行指示点：wb-dock-ind 淡入（静态点；定位仍由契约类 wb-dock-indicator 提供）
 * - tooltip：wb-dock-tip 玻璃气泡带箭头（hover/focus-within 显示；弹层打开时不渲染）；
 *   原生 title 已移除避免双气泡，可访问名仍由 aria-label 提供
 * - 触屏等价（a11y 清单 §4）：未运行应用长按 = 钉住 tooltip 显示应用名且不触发
 *   launch；运行中应用长按开列表后，应用名由 DockWindowList 头部提供
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { appRegistry } from '../core/appRegistry';
import { subscribeAppBadgeChanged } from '../core/badgeBus';
import { useWindowStore } from '../core/windowStore';
import { useWorkbenchOverlay } from '../core/shortcuts';
import { getSortedWindows } from '../core/windowListCache';
import { workbenchBus } from '../core/workbenchBus';
import type { AppBadge, WorkbenchWindow } from '../core/types';
import { useMaterialTier } from '../core/materialTier';
import { prefetchFrozenWindows } from '../core/wakePrefetchIntent';
import { requestMinimizeAnimated } from '../hooks/useWindowLifecycleAnim';
import { DockWindowList } from './DockWindowList';
import { useDockPinnedDragReorder } from './DockPinnedStore';
import { dockLongPressTolerancePx } from './dockGestures';
// ACR 4.0（A5 跨界最小接线）：agent 后台完成角标（样式在 agent-visuals.css）
import { useDockAgentBadge } from '../agent/visuals/dockBadgeStore';
import '../agent/visuals/agent-visuals.css';

/**
 * 角标兜底轮询间隔（2026-08：2s → 30s）。即时性由 badgeBus 推送承担
 *（各数据源状态变化时 notifyAppBadgeChanged），轮询只作防事件丢失的对账。
 */
const BADGE_POLL_MS = 30_000;
/** launch bounce 时长兜底（与 Dock.css 780ms 对齐，略加余量） */
const BOUNCE_FALLBACK_MS = 920;
/** 长按出窗口列表判定时长（与 WindowTitleBar 绿灯长按 400ms 基建对齐） */
export const DOCK_LONGPRESS_DELAY = 400;
/** 长按钉住的 tooltip 在松手后的驻留时长（触屏用户读完应用名再消失） */
export const DOCK_TIP_LINGER_MS = 1600;

function badgeEquals(a: AppBadge | null, b: AppBadge | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.value === b.value;
}

// ---------------------------------------------------------------------------
// 角标共享 ticker（低频兜底）：模块级单一 setInterval（首个订阅启动，最后一个
// 退订停止）；document.hidden 时跳过 tick，visibilitychange 恢复可见时立即
// read 一次补齐。即时刷新走 badgeBus 推送，不依赖本 ticker。
// ---------------------------------------------------------------------------

const badgeTickSubscribers = new Set<() => void>();
let badgeTickTimer = 0;

function badgeTickAll(): void {
  badgeTickSubscribers.forEach((cb) => cb());
}

function onBadgeVisibilityChange(): void {
  if (!document.hidden) badgeTickAll();
}

function subscribeBadgeTick(cb: () => void): () => void {
  badgeTickSubscribers.add(cb);
  if (badgeTickSubscribers.size === 1) {
    badgeTickTimer = window.setInterval(() => {
      if (document.hidden) return;
      badgeTickAll();
    }, BADGE_POLL_MS);
    document.addEventListener('visibilitychange', onBadgeVisibilityChange);
  }
  return () => {
    badgeTickSubscribers.delete(cb);
    if (badgeTickSubscribers.size === 0) {
      window.clearInterval(badgeTickTimer);
      badgeTickTimer = 0;
      document.removeEventListener('visibilitychange', onBadgeVisibilityChange);
    }
  };
}

/**
 * 角标：badgeSource 拉模式 —
 * badgeBus 推送（数据源变化即时失效）为主 + 共享 30s 兜底 ticker
 * + registry 变更即时刷新
 */
export function useDockBadge(typeId: string): AppBadge | null {
  const [badge, setBadge] = React.useState<AppBadge | null>(
    () => appRegistry.get(typeId)?.badgeSource?.() ?? null,
  );

  React.useEffect(() => {
    const read = () => {
      const next = appRegistry.get(typeId)?.badgeSource?.() ?? null;
      setBadge((prev) => (badgeEquals(prev, next) ? prev : next));
    };
    read();
    const unsubscribePush = subscribeAppBadgeChanged(typeId, read);
    const unsubscribeTick = subscribeBadgeTick(read);
    const unsubscribe = appRegistry.subscribe(read);
    return () => {
      unsubscribePush();
      unsubscribeTick();
      unsubscribe();
    };
  }, [typeId]);

  return badge;
}

function useRegistryVersion(): void {
  const [, setVersion] = React.useState(0);
  React.useEffect(() => appRegistry.subscribe(() => setVersion((v) => v + 1)), []);
}

export interface DockItemProps extends React.HTMLAttributes<HTMLDivElement> {
  typeId: string;
  /** roving tabindex：仅活动项为 0 */
  tabIndex?: number;
  /** 图标按钮 ref（Dock roving 焦点管理用） */
  buttonRef?: (el: HTMLButtonElement | null) => void;
  /** 图标按钮获得焦点（Dock 更新 roving 活动项） */
  onItemFocus?: () => void;
}

export const DockItem = React.forwardRef<HTMLDivElement, DockItemProps>(
  ({ typeId, tabIndex = 0, buttonRef, onItemFocus, className, children: _children, onPointerDown, onPointerEnter, onPointerMove, onPointerUp, onPointerLeave, onPointerCancel, ...rest }, forwardedRef) => {
    const { t } = useTranslation();
    useRegistryVersion();

    const def = appRegistry.get(typeId);
    // 指纹订阅（selector 返回原始字符串，zustand Object.is 去重）：只覆盖下游
    // 实际消费且会变化的字段 — id（key/onSelect/缩略图）、minimized（弹层标记）、
    // title（弹层标题/aria）；条目数与排序由指纹结构隐含。其他窗口的 move/focus
    // 提交不再触发本 item 重渲染。
    const winsKey = useWindowStore((s) =>
      getSortedWindows(s.windows)
        .filter((w) => w.typeId === typeId)
        .map((w) => `${w.id}:${w.minimized ? 1 : 0}:${w.title}`)
        .join('|'),
    );
    const wins = React.useMemo<WorkbenchWindow[]>(
      () =>
        getSortedWindows(useWindowStore.getState().windows).filter((w) => w.typeId === typeId),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- winsKey 即窗口数据指纹
      [winsKey, typeId],
    );
    const running = wins.length > 0;
    const badge = useDockBadge(typeId);
    // ACR 4.0：agent 在该应用的非聚焦窗口完成 run → 绿点；聚焦后由 store 清除
    const agentDoneBadge = useDockAgentBadge(typeId);

    const [listOpen, setListOpen] = React.useState(false);
    const wrapRef = React.useRef<HTMLDivElement | null>(null);
    const innerButtonRef = React.useRef<HTMLButtonElement | null>(null);
    // O6：固定区拖拽排序（一行接线；非固定项返回空对象）
    const pinnedDrag = useDockPinnedDragReorder(typeId);

    // ---- 长按图标出窗口列表（P2）----
    // 参考 WindowTitleBar 绿灯长按基建：计时器 + 移动阈值取消 + pointerup 清理。
    // 任意运行中应用（含单实例）长按都弹 DockWindowList；触发后抑制随之而来的
    // click，短按点击（launch / focus / minimize / 多实例 toggle）完全不变。
    const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const longPressFiredRef = React.useRef(false);
    /** tolerance 按下时按 pointerType 取档（触屏放宽，见 dockGestures） */
    const longPressStartRef = React.useRef<{ x: number; y: number; tolerance: number } | null>(
      null,
    );

    // ---- 触屏 tooltip 等价（a11y 清单 §4）----
    // 无 hover 环境下，未运行应用的长按把 tooltip 钉住显示应用名
    //（运行中应用的长按被窗口列表占用，应用名由列表头部提供）。
    // 松手后驻留 DOCK_TIP_LINGER_MS 再消失，保证触屏用户来得及读。
    const [tipPinned, setTipPinned] = React.useState(false);
    const tipLingerTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const scheduleTipUnpin = React.useCallback(() => {
      if (tipLingerTimerRef.current !== null) clearTimeout(tipLingerTimerRef.current);
      tipLingerTimerRef.current = setTimeout(() => {
        tipLingerTimerRef.current = null;
        setTipPinned(false);
      }, DOCK_TIP_LINGER_MS);
    }, []);

    React.useEffect(
      () => () => {
        if (tipLingerTimerRef.current !== null) clearTimeout(tipLingerTimerRef.current);
      },
      [],
    );

    const clearLongPress = React.useCallback(() => {
      if (longPressTimerRef.current !== null) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      longPressStartRef.current = null;
    }, []);

    React.useEffect(() => clearLongPress, [clearLongPress]);

    // ---- launch bounce：窗口数 false→true 沿触发（任意 launch 路径都命中）----
    // 初值 = 首渲染的 running：挂载时已在运行（固定切换重建、快照恢复）不弹
    // reduced-motion / minimal：CSS animation:none → animationend 永不触发，故不置 bouncing
    const tier = useMaterialTier();
    // 订阅系统偏好变化（此前只在渲染时读一次，会话中改系统设置不生效）
    const prefersReduced = React.useSyncExternalStore(
      React.useCallback((notify: () => void) => {
        const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
        media?.addEventListener?.('change', notify);
        return () => media?.removeEventListener?.('change', notify);
      }, []),
      () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches),
      () => false,
    );
    const bounceEnabled = tier !== 'minimal' && !prefersReduced;

    const [bouncing, setBouncing] = React.useState(false);
    const prevRunningRef = React.useRef(running);
    React.useEffect(() => {
      if (running && !prevRunningRef.current) {
        if (bounceEnabled) setBouncing(true);
      }
      prevRunningRef.current = running;
    }, [running, bounceEnabled]);

    // animationend 兜底：极端情况下（切档 animation:none）超时自清，避免 bouncing 卡死
    React.useEffect(() => {
      if (!bouncing) return undefined;
      const id = window.setTimeout(() => setBouncing(false), BOUNCE_FALLBACK_MS);
      return () => window.clearTimeout(id);
    }, [bouncing]);

    const setWrapRef = (el: HTMLDivElement | null) => {
      wrapRef.current = el;
      if (typeof forwardedRef === 'function') forwardedRef(el);
      else if (forwardedRef) forwardedRef.current = el;
    };
    const setButtonRef = (el: HTMLButtonElement | null) => {
      innerButtonRef.current = el;
      buttonRef?.(el);
    };

    // 弹层打开时窗口数降到 0 → 自动收起
    //（长按支持单实例出列表后，1 个窗口的列表是合法状态，不再 <2 收起）
    React.useEffect(() => {
      if (listOpen && wins.length < 1) setListOpen(false);
    }, [listOpen, wins.length]);

    // 外部点击关闭弹层（DockItem 自身区域不算外部，避免按钮再点击时先关后开的抖动）
    React.useEffect(() => {
      if (!listOpen) return;
      const onDocPointerDown = (event: PointerEvent) => {
        if (!wrapRef.current?.contains(event.target as Node)) setListOpen(false);
      };
      document.addEventListener('pointerdown', onDocPointerDown);
      return () => document.removeEventListener('pointerdown', onDocPointerDown);
    }, [listOpen]);

    const label = def ? t(def.nameKey, def.typeId) : typeId;

    const badgeText =
      badge?.kind === 'count'
        ? typeof badge.value === 'number' && badge.value > 99
          ? '99+'
          : String(badge.value ?? '')
        : null;

    // 可访问名：应用名 + 运行中 + 角标数量（角标视觉节点 aria-hidden，避免重复朗读）
    const ariaLabel = [
      label,
      running ? t('workbench:dock.running') : null,
      badgeText,
      agentDoneBadge ? t('workbench:agent.core.dockDoneBadge') : null,
    ]
      .filter(Boolean)
      .join(', ');

    const handleClick = () => {
      // 长按已开列表：这次松手的 click 不再当普通点击（保持列表打开）
      if (longPressFiredRef.current) {
        longPressFiredRef.current = false;
        return;
      }
      const state = useWindowStore.getState();
      const current = Object.values(state.windows)
        .filter((w) => w.typeId === typeId)
        .sort((a, b) => a.createdAt - b.createdAt);

      const dueBadgeCount =
        typeId === 'flashcards'
        && badge?.kind === 'count'
        && typeof badge.value === 'number'
        && badge.value > 0
          ? badge.value
          : 0;
      const duePayload = { screen: 'session', mode: 'due' } as const;

      if (current.length === 0) {
        if (dueBadgeCount > 0) {
          void workbenchBus.activate({
            typeId,
            instanceKey: '',
            action: 'startReview',
            payload: duePayload,
            fallbackLaunch: {
              typeId,
              reason: 'dock',
              payload: duePayload,
            },
          });
          return;
        }
        workbenchBus.launch({
          typeId,
          reason: 'dock',
        });
        return;
      }
      if (current.length === 1) {
        // 有到期角标时：热启动也进入 due 复习，而不是只 focus/minimize
        if (dueBadgeCount > 0) {
          void workbenchBus.activate({
            typeId,
            instanceKey: '',
            action: 'startReview',
            payload: duePayload,
            fallbackLaunch: {
              typeId,
              reason: 'dock',
              payload: duePayload,
            },
          });
          return;
        }
        const win = current[0];
        const topId = state.focusStack[state.focusStack.length - 1];
        if (topId === win.id && !win.minimized) {
          requestMinimizeAnimated(win.id);
        } else {
          state.focusWindow(win.id);
        }
        return;
      }
      setListOpen((open) => !open);
    };

    const dismissList = () => {
      setListOpen(false);
      innerButtonRef.current?.focus();
    };

    /** App Exposé 入口（列表底部「显示全部窗口」）：以本应用为过滤打开俯瞰 */
    const showAllWindows = React.useCallback(() => {
      setListOpen(false);
      useWorkbenchOverlay.getState().openExpose({ appTypeId: typeId });
    }, [typeId]);

    const pinnedOnPointerDown =
      'onPointerDown' in pinnedDrag ? pinnedDrag.onPointerDown : undefined;
    const pinnedDataAttrs =
      'onPointerDown' in pinnedDrag
        ? { 'data-wb-dock-pinned-id': (pinnedDrag as { 'data-wb-dock-pinned-id': string })['data-wb-dock-pinned-id'] }
        : {};

    return (
      <div
        ref={setWrapRef}
        data-testid={`wb-dock-item-${typeId}`}
        data-wb-dock-item-wrap=""
        data-tip-pinned={tipPinned || undefined}
        className={cn('wb-dock-item-wrap relative flex flex-col items-center', className)}
        {...rest}
        {...pinnedDataAttrs}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          pinnedOnPointerDown?.(event);
          // 新一轮按下先清掉上次长按的 click 抑制标记（长按后在 wrap 外松手时
          // click 不会发生，标记会残留到下一次交互）
          longPressFiredRef.current = false;
          // 长按判定只从图标按钮本体开始（弹层/角标区域不算）。
          // 运行中 → 窗口列表；未运行 → 钉住 tooltip（触屏应用名获取途径），
          // 两条路径都抑制随后的 click（长按不该触发 launch/focus）。
          if (
            event.button === 0 &&
            !listOpen &&
            (event.target as HTMLElement | null)?.closest?.('button.wb-dock-item')
          ) {
            clearLongPress();
            longPressStartRef.current = {
              x: event.clientX,
              y: event.clientY,
              tolerance: dockLongPressTolerancePx(event.pointerType),
            };
            longPressTimerRef.current = setTimeout(() => {
              longPressTimerRef.current = null;
              longPressStartRef.current = null;
              longPressFiredRef.current = true;
              if (running) {
                setListOpen(true);
              } else {
                if (tipLingerTimerRef.current !== null) {
                  clearTimeout(tipLingerTimerRef.current);
                  tipLingerTimerRef.current = null;
                }
                setTipPinned(true);
              }
            }, DOCK_LONGPRESS_DELAY);
          }
        }}
        onPointerMove={(event) => {
          onPointerMove?.(event);
          // 移动超过容差 = 拖拽（固定区重排）或滑动，取消长按。
          // 容差按指针类型差异化（触屏 10px / 鼠标笔 5px），且触屏拖拽
          // 重排阈值恒大于长按容差 —— 抖动不误取消，重排不误启动。
          const start = longPressStartRef.current;
          if (start && longPressTimerRef.current !== null) {
            const dx = event.clientX - start.x;
            const dy = event.clientY - start.y;
            if (Math.hypot(dx, dy) > start.tolerance) clearLongPress();
          }
        }}
        onPointerUp={(event) => {
          onPointerUp?.(event);
          clearLongPress();
          // 钉住的 tooltip：松手后驻留一段时间再消失
          if (tipPinned) scheduleTipUnpin();
          // 长按开列表后按住滑到列表项上松手 = 直接选中（对齐 macOS 长按菜单滑选）
          if (longPressFiredRef.current) {
            const target = event.target as HTMLElement | null;
            const item = target?.closest?.('[data-wb-docklist-window]');
            const windowId = item?.getAttribute('data-wb-docklist-window');
            if (windowId) {
              longPressFiredRef.current = false;
              useWindowStore.getState().focusWindow(windowId);
              setListOpen(false);
            } else if (target?.closest?.('[data-wb-docklist-show-all]')) {
              longPressFiredRef.current = false;
              showAllWindows();
            }
          }
        }}
        onPointerLeave={(event) => {
          onPointerLeave?.(event);
          clearLongPress();
          if (tipPinned) scheduleTipUnpin();
        }}
        onPointerCancel={(event) => {
          onPointerCancel?.(event);
          clearLongPress();
          if (tipPinned) scheduleTipUnpin();
        }}
        onPointerEnter={(event) => {
          onPointerEnter?.(event);
          // 悬停即视为「即将聚焦」：该应用的 frozen 窗提前预取回 background
          // （intent 层负责 frozen 判定与同窗冷却去重，扫过 Dock 不打调度器）
          prefetchFrozenWindows(wins.map((w) => w.id));
        }}
      >
        {/* 图标内层：data-wb-dock-mag-item 供 dockGeometry / genie 收敛点发现（无悬停放大） */}
        <div className="wb-dock-mag" data-wb-dock-mag-item={typeId}>
          <div
            className="wb-dock-bounce"
            data-testid={`wb-dock-bounce-${typeId}`}
            data-bouncing={bouncing || undefined}
            onAnimationEnd={(event) => {
              if (event.animationName === 'wb-dock-bounce-launch') setBouncing(false);
            }}
          >
            <button
              ref={setButtonRef}
              type="button"
              data-type-id={typeId}
              data-running={running || undefined}
              className={cn(
                'wb-dock-item group relative flex h-11 w-11 items-center justify-center rounded-xl outline-none',
              )}
              aria-label={ariaLabel}
              tabIndex={tabIndex}
              /* 任意运行中应用都可长按出窗口列表（多实例仍可点击 toggle） */
              aria-haspopup={running ? 'menu' : undefined}
              aria-expanded={running ? listOpen : undefined}
              onClick={handleClick}
              onFocus={onItemFocus}
            >
              <span
                aria-hidden
                className={cn(
                  'wb-dock-item-icon pointer-events-none flex h-full w-full items-center justify-center',
                )}
              >
                {def?.icon ?? (
                  <span className="text-sm font-semibold uppercase opacity-70">{typeId.slice(0, 1)}</span>
                )}
              </span>
              {agentDoneBadge && (
                <span
                  aria-hidden
                  data-testid={`wb-dock-agent-badge-${typeId}`}
                  className="wb-dock-agent-badge"
                />
              )}
              {badge && (
                <span
                  aria-hidden
                  data-testid={`wb-dock-badge-${typeId}`}
                  data-kind={badge.kind}
                  /* 颜色一律走契约 token（--wb-dock-badge-bg/fg），不用 Tailwind 色板压主题 */
                  className={cn(
                    'wb-dock-badge absolute',
                    badge.kind === 'count'
                      ? '-right-1 -top-1 h-4 min-w-[16px] rounded-full px-1 text-center text-2xs font-medium leading-4'
                      : 'right-0 top-0 h-2 w-2 min-w-0 rounded-full p-0',
                  )}
                >
                  {badgeText}
                </span>
              )}
            </button>
          </div>
        </div>
        {running && (
          <span
            aria-hidden
            data-testid={`wb-dock-indicator-${typeId}`}
            className="wb-dock-indicator wb-dock-ind"
          />
        )}
        {!listOpen && (
          <span aria-hidden data-testid={`wb-dock-tip-${typeId}`} className="wb-dock-tip">
            {label}
          </span>
        )}
        {listOpen && wins.length > 0 && (
          <DockWindowList
            appLabel={label}
            typeId={typeId}
            windows={wins}
            ownerRef={wrapRef}
            onSelect={(windowId) => {
              useWindowStore.getState().focusWindow(windowId);
              setListOpen(false);
            }}
            onDismiss={dismissList}
            onShowAllWindows={showAllWindows}
          />
        )}
      </div>
    );
  },
);
DockItem.displayName = 'DockItem';
