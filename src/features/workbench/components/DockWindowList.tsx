/**
 * DockWindowList（P5 → O6）— 多实例应用的窗口列表弹层
 *
 * - 实时缩略预览：克隆 `[data-wb-window-id]` DOM 子树 + CSS transform 缩放；
 *   无 DOM / 子节点超重 → 占位卡（图标 + 标题）
 * - 玻璃气泡 + 指向箭头 + 视口边缘钳位（箭头始终指向图标中心）
 * - 分层：外层只做定位 transform（居中 + 钳位）；内层 surface 跑
 *   wb-kf-rise-in / wb-kf-sink-out（避免入场 keyframes 覆盖定位）
 * - 退场：animationend + 超时兜底再 onDismiss；reduced-motion / minimal 直接卸载
 * - hover 高亮、关闭按钮浮现、完整键盘导航 + aria
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { X } from '@phosphor-icons/react';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { cn } from '../../../lib/utils';
import { appRegistry } from '../core/appRegistry';
import type { WorkbenchWindow } from '../core/types';
import { requestCloseAnimated } from '../hooks/useWindowLifecycleAnim';
import { useLiquidGlassLens } from '../core/liquidGlassLens';
import { prefetchFrozenWindow } from '../core/wakePrefetchIntent';
import './DockWindowList.css';

/** 克隆子树节点数上限；超过则回退占位卡（防超重） */
const PREVIEW_NODE_BUDGET = 400;
const PREVIEW_W = 160;
const PREVIEW_H = 100;
const EDGE_PAD = 8;
/** 退场超时兜底（略大于 --wb-motion-quick） */
const EXIT_FALLBACK_MS = 220;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export interface DockWindowListProps {
  /** 应用显示名（窗口无标题时的兜底文案 + aria-label） */
  appLabel: string;
  /** 该应用 typeId（关闭 / 图标兜底） */
  typeId?: string;
  /** 该应用全部窗口（已按 createdAt 排序） */
  windows: WorkbenchWindow[];
  /** 弹层归属的 DockItem 根元素（焦点移入其内部时不视为失焦；钳位锚点） */
  ownerRef: React.RefObject<HTMLElement | null>;
  onSelect: (windowId: string) => void;
  onDismiss: () => void;
  /** 关闭单个窗口（默认走 requestCloseAnimated） */
  onCloseWindow?: (windowId: string) => boolean | void | Promise<boolean | void>;
  /**
   * 「显示全部窗口」入口（P2，对标 macOS Dock 长按菜单的 Show All Windows）：
   * 传入时在列表底部渲染入口项，点击触发本应用的 App Exposé 过滤俯瞰。
   */
  onShowAllWindows?: () => void;
}

function countDescendants(root: Node, budget: number): number {
  let count = 0;
  const walk = (node: Node) => {
    count += 1;
    if (count > budget) return;
    const children = node.childNodes;
    for (let i = 0; i < children.length; i++) walk(children[i]);
  };
  walk(root);
  return count;
}

function sanitizeClone(clone: HTMLElement): void {
  clone.removeAttribute('id');
  clone.removeAttribute('data-wb-window-id');
  clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  clone.querySelectorAll('a, button, input, textarea, select, [tabindex]').forEach((el) => {
    el.setAttribute('tabindex', '-1');
    if (el instanceof HTMLElement) {
      el.style.pointerEvents = 'none';
    }
  });
  clone.style.pointerEvents = 'none';
  clone.style.margin = '0';
  clone.style.position = 'absolute';
  clone.style.left = '0';
  clone.style.top = '0';
  clone.style.transformOrigin = 'top left';
}

function prefersInstantMotion(): boolean {
  if (typeof window === 'undefined') return true;
  if (window.matchMedia?.(REDUCED_MOTION_QUERY)?.matches) return true;
  if (document.documentElement.getAttribute('data-wb-material') === 'minimal') return true;
  return false;
}

function WindowThumb({
  windowId,
  title,
  typeId,
  appLabel,
}: {
  windowId: string;
  title: string;
  typeId?: string;
  appLabel: string;
}): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = React.useState<'preview' | 'placeholder'>('placeholder');

  React.useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();

    const escape = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape : (s: string) => s;
    const source = document.querySelector<HTMLElement>(`[data-wb-window-id="${escape(windowId)}"]`);
    if (!source || !source.isConnected) {
      setMode('placeholder');
      return;
    }
    const nodes = countDescendants(source, PREVIEW_NODE_BUDGET);
    if (nodes > PREVIEW_NODE_BUDGET) {
      setMode('placeholder');
      return;
    }

    const rect = source.getBoundingClientRect();
    const srcW = Math.max(1, rect.width || source.offsetWidth || 400);
    const srcH = Math.max(1, rect.height || source.offsetHeight || 300);
    const scale = Math.min(PREVIEW_W / srcW, PREVIEW_H / srcH);

    try {
      const clone = source.cloneNode(true) as HTMLElement;
      sanitizeClone(clone);
      clone.style.width = `${srcW}px`;
      clone.style.height = `${srcH}px`;
      clone.style.transform = `scale(${scale})`;
      host.replaceChildren(clone);
      setMode('preview');
    } catch {
      setMode('placeholder');
    }

    return () => {
      host.replaceChildren();
    };
  }, [windowId]);

  const def = typeId ? appRegistry.get(typeId) : undefined;

  return (
    <div
      className="wb-docklist-thumb"
      data-mode={mode}
      data-testid={`wb-docklist-thumb-${windowId}`}
      aria-hidden
    >
      <div ref={hostRef} className="wb-docklist-thumb-host" />
      {mode === 'placeholder' && (
        <div className="wb-docklist-thumb-fallback">
          <span className="wb-docklist-thumb-icon">
            {def?.icon ?? (
              <span className="wb-docklist-thumb-letter">{(title || appLabel).slice(0, 1)}</span>
            )}
          </span>
          <span className="wb-docklist-thumb-title">{title || appLabel}</span>
        </div>
      )}
    </div>
  );
}

export function DockWindowList({
  appLabel,
  typeId,
  windows,
  ownerRef,
  onSelect,
  onDismiss,
  onCloseWindow,
  onShowAllWindows,
}: DockWindowListProps) {
  const { t } = useTranslation();
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const surfaceRef = React.useRef<HTMLDivElement | null>(null);
  const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const refocusAfterCloseRef = React.useRef<string | null>(null);
  const refocusRafRef = React.useRef(0);
  const exitTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitAfterRef = React.useRef<(() => void) | null>(null);
  useLiquidGlassLens(surfaceRef);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [offsetX, setOffsetX] = React.useState(0);
  /** open = 入场；closing = 退场中，结束后再 onDismiss */
  const [phase, setPhase] = React.useState<'open' | 'closing'>('open');

  const closeWindow = onCloseWindow ?? requestCloseAnimated;

  const requestWindowClose = React.useCallback(
    async (windowId: string) => {
      refocusAfterCloseRef.current = windowId;
      try {
        const closed = await closeWindow(windowId);
        if (closed === false && refocusAfterCloseRef.current === windowId) {
          refocusAfterCloseRef.current = null;
        }
        return closed;
      } catch {
        if (refocusAfterCloseRef.current === windowId) {
          refocusAfterCloseRef.current = null;
        }
        return false;
      }
    },
    [closeWindow],
  );

  const finishExit = React.useCallback(() => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    const after = exitAfterRef.current;
    exitAfterRef.current = null;
    // 选中路径由 after（onSelect）自行关层；Esc/失焦走 onDismiss
    if (after) after();
    else onDismiss();
  }, [onDismiss]);

  /** 请求关闭：播退场再卸载；reduced-motion / minimal 直接卸载 */
  const requestDismiss = React.useCallback(
    (after?: () => void) => {
      if (phase === 'closing') return;
      exitAfterRef.current = after ?? null;
      if (prefersInstantMotion()) {
        finishExit();
        return;
      }
      setPhase('closing');
      exitTimerRef.current = setTimeout(finishExit, EXIT_FALLBACK_MS);
    },
    [phase, finishExit],
  );

  React.useEffect(() => {
    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      if (refocusRafRef.current) cancelAnimationFrame(refocusRafRef.current);
    };
  }, []);

  // 视口边缘钳位：在外层定位元素上测 rect（不受入场 animation transform 干扰）
  React.useLayoutEffect(() => {
    const panel = rootRef.current;
    const owner = ownerRef.current;
    if (!panel || !owner) return;

    const place = () => {
      // 先清偏移再测自然居中位置
      panel.style.setProperty('--wb-docklist-shift-x', '0px');
      panel.style.setProperty('--wb-docklist-arrow-x', '50%');
      const panelRect = panel.getBoundingClientRect();
      const ownerRect = owner.getBoundingClientRect();
      const iconCenterX = ownerRect.left + ownerRect.width / 2;
      const naturalLeft = iconCenterX - panelRect.width / 2;
      const minLeft = EDGE_PAD;
      const maxLeft = window.innerWidth - EDGE_PAD - panelRect.width;
      const clampedLeft = Math.max(minLeft, Math.min(naturalLeft, Math.max(minLeft, maxLeft)));
      const shift = clampedLeft - naturalLeft;
      setOffsetX(shift);

      const arrowPct = panelRect.width > 0 ? ((iconCenterX - clampedLeft) / panelRect.width) * 100 : 50;
      const arrowClamped = Math.max(12, Math.min(88, arrowPct));
      panel.style.setProperty('--wb-docklist-shift-x', `${shift}px`);
      panel.style.setProperty('--wb-docklist-arrow-x', `${arrowClamped}%`);
    };

    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [ownerRef, windows.length]);

  // 打开时聚焦首项（roving tabindex）
  React.useEffect(() => {
    itemRefs.current[0]?.focus();
  }, []);

  // 关闭当前项后列表会缩短：钳制 roving index，并把焦点落到相邻存活项。
  React.useLayoutEffect(() => {
    itemRefs.current.length = windows.length;
    const next = windows.length > 0 ? Math.min(activeIndex, windows.length - 1) : 0;
    if (next !== activeIndex) setActiveIndex(next);
    const closedWindowId = refocusAfterCloseRef.current;
    if (!closedWindowId || windows.some((win) => win.id === closedWindowId)) return;
    refocusAfterCloseRef.current = null;
    if (windows.length === 0) {
      // owner 是 wrap div（不可聚焦），焦点应落回 Dock 图标按钮本体
      const ownerButton =
        ownerRef.current?.querySelector<HTMLButtonElement>('button.wb-dock-item') ?? null;
      (ownerButton ?? ownerRef.current)?.focus({ preventScroll: true });
      return;
    }
    if (refocusRafRef.current) cancelAnimationFrame(refocusRafRef.current);
    refocusRafRef.current = requestAnimationFrame(() => {
      refocusRafRef.current = 0;
      itemRefs.current[next]?.focus({ preventScroll: true });
    });
  }, [windows, activeIndex, ownerRef]);

  const moveFocus = (index: number) => {
    if (phase === 'closing') return;
    const count = windows.length;
    if (count === 0) return;
    const next = ((index % count) + count) % count;
    setActiveIndex(next);
    itemRefs.current[next]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (phase === 'closing') return;
    const target = event.target as HTMLElement | null;
    // 关闭按钮自己的 Enter/Space 走原生；Delete 仍关窗
    const onCloseBtn = Boolean(target?.closest('.wb-docklist-close'));

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        requestDismiss();
        break;
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault();
        moveFocus(activeIndex + 1);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault();
        moveFocus(activeIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        moveFocus(0);
        break;
      case 'End':
        event.preventDefault();
        moveFocus(windows.length - 1);
        break;
      case 'Enter':
      case ' ':
        if (onCloseBtn) break;
        event.preventDefault();
        if (windows[activeIndex]) {
          const id = windows[activeIndex].id;
          requestDismiss(() => onSelect(id));
        }
        break;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        if (windows[activeIndex]) {
          void requestWindowClose(windows[activeIndex].id);
        }
        break;
      default:
        break;
    }
  };

  const handleBlur = (event: React.FocusEvent) => {
    if (phase === 'closing') return;
    const next = event.relatedTarget as Node | null;
    if (next && (rootRef.current?.contains(next) || ownerRef.current?.contains(next))) return;
    requestDismiss();
  };

  const handleSurfaceAnimationEnd = (event: React.AnimationEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (phase !== 'closing') return;
    finishExit();
  };

  return (
    <div
      ref={rootRef}
      role="menu"
      aria-label={appLabel}
      data-testid="wb-dock-window-list"
      data-wb-docklist-shift={offsetX !== 0 ? 'true' : undefined}
      data-phase={phase}
      className="wb-docklist"
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
    >
      <div
        ref={surfaceRef}
        className={cn('wb-docklist-surface', 'wb-glass', 'wb-glass-lens')}
        onAnimationEnd={handleSurfaceAnimationEnd}
      >
        <div className="wb-docklist-arrow" aria-hidden />
        {/* 应用名头部：触屏无 hover tooltip，长按开列表时由此提供应用名
            （a11y 清单 §4 tooltip 触屏等价）；可访问名已由 role=menu 的
            aria-label 提供，视觉头部对 AT 隐藏避免重复播报 */}
        <div className="wb-docklist-header" aria-hidden data-testid="wb-docklist-header">
          {appLabel}
        </div>
        <CustomScrollArea
          className="wb-docklist-items-scroll"
          fullHeight={false}
          trackOffsetTop={3}
          trackOffsetBottom={3}
          trackOffsetRight={2}
        >
          <div className="wb-docklist-items">
            {windows.map((win, index) => {
            const title = win.title || appLabel;
            return (
              <div
                key={win.id}
                className={cn('wb-docklist-item', index === activeIndex && 'wb-docklist-item--active')}
                data-active={index === activeIndex || undefined}
                data-minimized={win.minimized || undefined}
              >
                <button
                  ref={(el) => {
                    itemRefs.current[index] = el;
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={index === activeIndex ? 0 : -1}
                  className="wb-docklist-item-btn"
                  /* DockItem 长按滑选（pointerup 落点识别）用的窗口标识 */
                  data-wb-docklist-window={win.id}
                  aria-label={
                    win.minimized
                      ? `${title} (${t('workbench:dock.minimized')})`
                      : title
                  }
                  disabled={phase === 'closing'}
                  onClick={() => requestDismiss(() => onSelect(win.id))}
                  onFocus={() => {
                    setActiveIndex(index);
                    // 键盘高亮该窗即「即将聚焦」：frozen 窗提前预取（intent 层去重）
                    prefetchFrozenWindow(win.id);
                  }}
                  onPointerEnter={() => prefetchFrozenWindow(win.id)}
                >
                  <WindowThumb
                    windowId={win.id}
                    title={title}
                    typeId={typeId ?? win.typeId}
                    appLabel={appLabel}
                  />
                  <span className="wb-docklist-item-meta">
                    <span className="wb-docklist-item-title">{title}</span>
                    {win.minimized && (
                      <span className="wb-docklist-item-min">
                        {t('workbench:dock.minimized')}
                      </span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  className="wb-docklist-close"
                  tabIndex={-1}
                  aria-label={t('workbench:dock.closeWindow')}
                  data-testid={`wb-docklist-close-${win.id}`}
                  disabled={phase === 'closing'}
                  onClick={(e) => {
                    e.stopPropagation();
                    void requestWindowClose(win.id);
                  }}
                >
                  <X size={12} weight="bold" aria-hidden />
                </button>
              </div>
            );
            })}
          </div>
        </CustomScrollArea>
        {onShowAllWindows && (
          /* App Exposé 入口：不参与窗口项的方向键 roving（快捷键
             Ctrl+Alt+Shift+E 提供等价键盘路径），Tab/点击可达 */
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="wb-docklist-showall"
            data-wb-docklist-show-all=""
            data-testid="wb-docklist-show-all"
            disabled={phase === 'closing'}
            onClick={() => requestDismiss(() => onShowAllWindows())}
          >
            {t('workbench:dock.showAllWindows')}
          </button>
        )}
      </div>
    </div>
  );
}
