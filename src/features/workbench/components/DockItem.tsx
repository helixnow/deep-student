/**
 * DockItem（P5 → O5 打磨）— Dock 单个应用项
 *
 * - 点击三分支：无实例 → workbenchBus.launch；单实例 → focus（已聚焦 → minimize）；
 *   多实例 → DockWindowList 弹层
 * - 角标：appRegistry badgeSource（轮询 2s + registry subscribe），wb-dock-badge
 * - 作为 DockContextMenu（AppMenu context 模式）的 asChild 触发器：
 *   接受并透传 className / onContextMenu 等外部 props 到根元素
 *
 * O5 动效层（样式见 Dock.css，由 Dock.tsx 统一 import）：
 * - DOM 分层：wrap（静止锚点，供 dockGeometry 测量）
 *     └ .wb-dock-mag（邻近放大层，Dock.tsx 的 rAF 循环直写 transform，不进 state）
 *         └ .wb-dock-bounce（launch bounce 层，CSS keyframes，与放大互不干扰）
 *             └ button.wb-dock-item（契约类，基线 hover/焦点行为保留）
 * - launch bounce：窗口数 false→true 沿触发，animationend 自清；
 *   reduced-motion / minimal 档不置 bouncing（animation:none 时 end 永不触发）
 * - 运行指示点：wb-dock-ind 淡入（静态点；定位仍由契约类 wb-dock-indicator 提供）
 * - tooltip：wb-dock-tip 玻璃气泡带箭头（hover/focus-within 显示；弹层打开时不渲染）；
 *   原生 title 已移除避免双气泡，可访问名仍由 aria-label 提供
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { appRegistry } from '../core/appRegistry';
import { useWindowStore } from '../core/windowStore';
import { getSortedWindows } from '../core/windowListCache';
import { workbenchBus } from '../core/workbenchBus';
import type { AppBadge, WorkbenchWindow } from '../core/types';
import { useMaterialTier } from '../core/materialTier';
import { requestMinimizeAnimated } from '../hooks/useWindowLifecycleAnim';
import { DockWindowList } from './DockWindowList';
import { useDockPinnedDragReorder } from './DockPinnedStore';

const BADGE_POLL_MS = 2000;
/** launch bounce 时长兜底（与 Dock.css 780ms 对齐，略加余量） */
const BOUNCE_FALLBACK_MS = 920;

function badgeEquals(a: AppBadge | null, b: AppBadge | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.value === b.value;
}

// ---------------------------------------------------------------------------
// 角标共享 ticker：模块级单一 setInterval（首个订阅启动，最后一个退订停止），
// 替代每个 DockItem 自建 2s 定时器；document.hidden 时跳过 tick，
// visibilitychange 恢复可见时立即 read 一次补齐
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

/** 角标：badgeSource 拉模式 — 共享 2s ticker + registry 变更即时刷新 */
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
    const unsubscribeTick = subscribeBadgeTick(read);
    const unsubscribe = appRegistry.subscribe(read);
    return () => {
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
  ({ typeId, tabIndex = 0, buttonRef, onItemFocus, className, children: _children, onPointerDown, ...rest }, forwardedRef) => {
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

    const [listOpen, setListOpen] = React.useState(false);
    const wrapRef = React.useRef<HTMLDivElement | null>(null);
    const innerButtonRef = React.useRef<HTMLButtonElement | null>(null);
    // O6：固定区拖拽排序（一行接线；非固定项返回空对象）
    const pinnedDrag = useDockPinnedDragReorder(typeId);

    // ---- launch bounce：窗口数 false→true 沿触发（任意 launch 路径都命中）----
    // 初值 = 首渲染的 running：挂载时已在运行（固定切换重建、快照恢复）不弹
    // reduced-motion / minimal：CSS animation:none → animationend 永不触发，故不置 bouncing
    const tier = useMaterialTier();
    const prefersReduced =
      typeof window !== 'undefined' &&
      Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
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

    // 弹层打开时窗口数降到 <2 → 自动收起
    React.useEffect(() => {
      if (listOpen && wins.length < 2) setListOpen(false);
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
    const ariaLabel = [label, running ? t('workbench:dock.running') : null, badgeText]
      .filter(Boolean)
      .join(', ');

    const handleClick = () => {
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
        className={cn('wb-dock-item-wrap relative flex flex-col items-center', className)}
        {...rest}
        {...pinnedDataAttrs}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          pinnedOnPointerDown?.(event);
        }}
      >
        {/* 放大层：Dock.tsx 的 magnification 循环按 data-wb-dock-mag-item 发现并直写 transform */}
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
              aria-haspopup={wins.length > 1 ? 'menu' : undefined}
              aria-expanded={wins.length > 1 ? listOpen : undefined}
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
              {badge && (
                <span
                  aria-hidden
                  data-testid={`wb-dock-badge-${typeId}`}
                  data-kind={badge.kind}
                  className={cn(
                    'wb-dock-badge absolute bg-danger text-danger-foreground',
                    badge.kind === 'count'
                      ? '-right-1 -top-1 h-4 min-w-[16px] rounded-full px-1 text-center text-[10px] font-medium leading-4'
                      : 'right-0 top-0 h-2 w-2 rounded-full',
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
        {listOpen && wins.length > 1 && (
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
          />
        )}
      </div>
    );
  },
);
DockItem.displayName = 'DockItem';
