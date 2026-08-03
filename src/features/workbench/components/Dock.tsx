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
 * - 悬停不做邻近放大/位移：图标保持静止，仅显示 tooltip 应用名（产品裁决）。
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
import {
  APPS_DOCK_TYPE_ID,
  toggleAppsPanel,
  useAppsPanelOpen,
} from './appsPanelStore';
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
  reorderDockPinned,
  subscribeDockPinned,
  useDockPinned,
  useDockPinnedDragReorder,
} from './DockPinnedStore';

export interface DockProps {
  /** 自动隐藏（设置接线 P11）：隐藏至底缘 4px 热区 */
  autohide?: boolean;
  /** Dock 尺寸百分比，默认 100，桌面设置范围 75..125 */
  size?: number;
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

/** DockItem 图标层的发现属性（DockItem.tsx 渲染，勿改动字面量；dockGeometry 消费） */
const MAG_ITEM_ATTR = 'data-wb-dock-mag-item';

// ---------------------------------------------------------------------------
// Dock
// ---------------------------------------------------------------------------

function DockImpl({ autohide = false, size = 100, className }: DockProps) {
  const { t } = useTranslation();
  useRegistryVersion();

  // ACR 4.0（A5 跨界最小接线）：agent 后台完成角标——Dock 存续期间订阅
  // presence/windowStore（只读），角标渲染在 DockItem 内
  React.useEffect(() => startDockAgentBadgeTracking(), []);

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
  const [revealing, setRevealing] = React.useState(false);
  const revealedRef = React.useRef(!autohide);
  const revealTimerRef = React.useRef(0);
  const concealTimerRef = React.useRef(0);

  const updateRevealed = React.useCallback((next: boolean) => {
    revealedRef.current = next;
    setRevealed(next);
  }, []);

  const revealDock = React.useCallback(() => {
    if (!revealedRef.current) setRevealing(true);
    updateRevealed(true);
  }, [updateRevealed]);

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
      setRevealing(false);
      updateRevealed(false);
    }, 150);
  }, [updateRevealed]);

  React.useEffect(() => {
    clearAutohideTimers();
    setRevealing(false);
    updateRevealed(!autohide);
    return () => clearAutohideTimers();
  }, [autohide, clearAutohideTimers, updateRevealed]);
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
      // 测 wrap（静止锚点）
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
            revealDock();
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
        data-revealing={revealing || undefined}
        data-size={Math.round(dockScale * 100)}
        style={{ '--wb-dock-scale': dockScale } as React.CSSProperties}
        className={cn(
          'wb-dock flex items-end gap-1 py-1.5 mb-2',
          // 水平 padding 由 Dock.css 管
          // autohide 滑入滑出（Dock.css：overshoot 进 / 标准曲线出，复合 translate(-50%, y)）
          autohide && 'wb-dock-slide',
          hidden ? 'pointer-events-none' : 'pointer-events-auto',
        )}
        onKeyDown={handleToolbarKeyDown}
        onPointerEnter={() => {
          if (!autohide) return;
          clearAutohideTimers();
          revealDock();
        }}
        onPointerLeave={handleDockPointerLeave}
        onFocusCapture={() => {
          if (!autohide) return;
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
          data-wb-dock-item-wrap=""
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
                    revealDock();
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
              revealDock();
            }
          }}
        />
      </div>
    </div>
  );
}

/** props 仅 autohide/size/className（稳定），memo 隔离父级（桌面壳）重渲染 */
export const Dock = React.memo(DockImpl);
Dock.displayName = 'Dock';
