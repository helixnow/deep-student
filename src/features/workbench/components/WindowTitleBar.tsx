/**
 * WindowTitleBar（P3 / O3）— 窗口标题栏（高 38px）。
 *
 * - 左侧三键：关闭（requestClose 流程）/ 最小化 / 缩放（maximize toggle）
 * - 缩放键悬停 350ms 弹出 TileMenuPopover 平铺菜单（对标 macOS 绿灯）
 * - 双击标题栏空白区 = maximize toggle + 涟漪
 * - 标题居中；溢出时 mask 渐隐（替代硬截断省略号）
 * - 材质走 wb-titlebar / wb-traffic-* 契约 + wb-title-* 微交互层
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DisplayMode } from '../core/types';
import { TileMenuPopover, type TileMenuAction } from './TileMenuPopover';
import './WindowTitleBar.css';

export const TITLEBAR_HEIGHT = 38;

/** 缩放键悬停多久弹出平铺菜单（ms） */
export const TILE_MENU_HOVER_DELAY = 350;
/** 指针离开缩放键与菜单后的宽限关闭时间（ms） */
export const TILE_MENU_CLOSE_GRACE = 200;

export interface WindowTitleBarProps {
  windowId: string;
  /** App type enables app-specific chrome, such as Notes tabs in the title bar. */
  appTypeId?: string;
  title: string;
  focused: boolean;
  displayMode: DisplayMode;
  /** 关闭（外层走 requestCloseAnimated → canClose 拦截） */
  onClose: () => void;
  onMinimize: () => void;
  /** 缩放键点击 = maximize/还原 toggle；双击标题栏同 */
  onZoom: () => void;
  /** 平铺菜单选择 */
  onTileAction: (action: TileMenuAction) => void;
  /** 标题栏按下开始拖动（指针引擎接管） */
  onMovePointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
}

const GlyphClose = () => (
  <svg className="wb-title-glyph" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
    <path
      d="M3.2 3.2l5.6 5.6M8.8 3.2L3.2 8.8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
);

const GlyphMin = () => (
  <svg className="wb-title-glyph" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
    <path
      d="M2.5 6h7"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
);

/** floating：向外展开双三角；maximized / tiled：向内还原 */
const GlyphZoom = ({ restore }: { restore: boolean }) =>
  restore ? (
    <svg
      className="wb-title-glyph"
      data-wb-zoom-glyph="restore"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M0 8h6.8L8 6.8V0zM16 8H9.2L8 9.2V16z"
        fill="currentColor"
      />
    </svg>
  ) : (
    <svg
      className="wb-title-glyph"
      data-wb-zoom-glyph="expand"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2 11V2h9zM14 5v9H5z"
        fill="currentColor"
      />
    </svg>
  );

interface RippleSpec {
  id: number;
  x: number;
  y: number;
  size: number;
}

export const WindowTitleBar: React.FC<WindowTitleBarProps> = ({
  windowId,
  appTypeId,
  title,
  focused,
  displayMode,
  onClose,
  onMinimize,
  onZoom,
  onTileAction,
  onMovePointerDown,
}) => {
  const { t } = useTranslation('workbench');
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAutoFocus, setMenuAutoFocus] = useState(false);
  const [titleOverflow, setTitleOverflow] = useState(false);
  const [ripples, setRipples] = useState<RippleSpec[]>([]);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomButtonRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const rippleIdRef = useRef(0);
  /** 标题栏拖拽视觉态启动阈值（与 pointerEngine MOVE_ARM_THRESHOLD_PX 对齐） */
  const dragArmRef = useRef<{ x: number; y: number; armed: boolean } | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // 长标题溢出检测 → mask 渐隐
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) {
      setTitleOverflow(false);
      return;
    }
    const measure = () => {
      setTitleOverflow(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    const ro =
      typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [title]);

  const scheduleOpen = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (menuOpen || openTimer.current) return;
    setMenuAutoFocus(false);
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setMenuOpen(true);
    }, TILE_MENU_HOVER_DELAY);
  }, [menuOpen]);

  const scheduleClose = useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (!menuOpen || closeTimer.current) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setMenuOpen(false);
      setMenuAutoFocus(false);
    }, TILE_MENU_CLOSE_GRACE);
  }, [menuOpen]);

  const closeMenu = useCallback(
    (returnFocus = false) => {
      clearTimers();
      setMenuOpen(false);
      if (returnFocus) zoomButtonRef.current?.focus();
    },
    [clearTimers],
  );

  const handleTileSelect = useCallback(
    (action: TileMenuAction) => {
      closeMenu();
      onTileAction(action);
    },
    [closeMenu, onTileAction],
  );

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  const spawnRipple = useCallback((clientX: number, clientY: number) => {
    const bar = barRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const size = Math.max(rect.width, rect.height) * 2.2;
    const id = ++rippleIdRef.current;
    setRipples((prev) => [...prev, { id, x, y, size }]);
  }, []);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      spawnRipple(e.clientX, e.clientY);
      onZoom();
    },
    [onZoom, spawnRipple],
  );

  const handleRippleEnd = useCallback((id: number) => {
    setRipples((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      // 视觉 dragging 过 1px 阈值才挂 class（DOM 直写，避免 React 重渲染抢首帧）
      const startX = e.clientX;
      const startY = e.clientY;
      dragArmRef.current = { x: startX, y: startY, armed: false };
      const bar = barRef.current;
      const THRESHOLD_SQ = 1; // 1px²
      const onMove = (ev: PointerEvent) => {
        const arm = dragArmRef.current;
        if (!arm || arm.armed) return;
        const dx = ev.clientX - arm.x;
        const dy = ev.clientY - arm.y;
        if (dx * dx + dy * dy < THRESHOLD_SQ) return;
        arm.armed = true;
        bar?.classList.add('wb-title-dragging');
      };
      const onUp = () => {
        dragArmRef.current = null;
        bar?.classList.remove('wb-title-dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      onMovePointerDown?.(e);
    },
    [onMovePointerDown],
  );

  /** 悬停预提升壳层合成层（wb-shell-lift）；离开后短延迟拆除，避免划过 thrash */
  const liftLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shellForLift = (): HTMLElement | null =>
    barRef.current?.closest<HTMLElement>('[data-wb-window]') ?? null;

  const handlePointerEnter = useCallback(() => {
    if (liftLeaveTimerRef.current) {
      clearTimeout(liftLeaveTimerRef.current);
      liftLeaveTimerRef.current = null;
    }
    shellForLift()?.classList.add('wb-shell-lift');
  }, []);

  const handlePointerLeave = useCallback(() => {
    if (liftLeaveTimerRef.current) clearTimeout(liftLeaveTimerRef.current);
    liftLeaveTimerRef.current = setTimeout(() => {
      liftLeaveTimerRef.current = null;
      const shell = shellForLift();
      // 拖拽中保留 will-change（wb-shell-dragging 已覆盖）
      if (shell && !shell.classList.contains('wb-shell-dragging')) {
        shell.classList.remove('wb-shell-lift');
      }
    }, 120);
  }, []);

  useEffect(
    () => () => {
      if (liftLeaveTimerRef.current) clearTimeout(liftLeaveTimerRef.current);
      shellForLift()?.classList.remove('wb-shell-lift');
    },
    [],
  );

  const zoomRestore = displayMode !== 'floating';
  const hostsAppTabs = appTypeId === 'notes' || appTypeId === 'files';

  return (
    <div
      ref={barRef}
      className={`wb-titlebar wb-title-bar relative flex shrink-0 select-none items-center px-2${
        focused ? '' : ' wb-title-bar-idle'
      }`}
      style={{ height: TITLEBAR_HEIGHT, touchAction: 'none' }}
      data-wb-titlebar
      data-wb-title-draggable=""
      data-wb-app-tabs={appTypeId === 'notes' ? 'notes' : appTypeId === 'files' ? 'files' : undefined}
      data-window-id={windowId}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
    >
      <div className="wb-title-ripple-layer" aria-hidden="true">
        {ripples.map((r) => (
          <span
            key={r.id}
            className="wb-title-ripple"
            style={{
              left: r.x,
              top: r.y,
              width: r.size,
              height: r.size,
            }}
            onAnimationEnd={() => handleRippleEnd(r.id)}
          />
        ))}
      </div>
      <div className="wb-traffic relative z-10" data-wb-traffic>
        <button
          type="button"
          className="wb-traffic-close wb-title-key"
          aria-label={t('a11y.close', '关闭窗口')}
          title={t('a11y.close', '关闭窗口')}
          onPointerDown={stop}
          onDoubleClick={stop}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <GlyphClose />
        </button>
        <button
          type="button"
          className="wb-traffic-min wb-title-key"
          aria-label={t('a11y.minimize', '最小化窗口')}
          title={t('a11y.minimize', '最小化窗口')}
          onPointerDown={stop}
          onDoubleClick={stop}
          onClick={(e) => {
            e.stopPropagation();
            onMinimize();
          }}
        >
          <GlyphMin />
        </button>
        {/* 包装层必须与键同尺寸，否则 flex 对齐会把绿灯抬偏 */}
        <div className="wb-traffic-zoom-wrap">
          <button
            ref={zoomButtonRef}
            type="button"
            className="wb-traffic-zoom wb-title-key"
            aria-label={t('a11y.zoom', '缩放窗口')}
            title={t('a11y.zoom', '缩放窗口')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onPointerDown={stop}
            onDoubleClick={stop}
            onPointerEnter={scheduleOpen}
            onPointerLeave={scheduleClose}
            onClick={(e) => {
              e.stopPropagation();
              closeMenu();
              onZoom();
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                clearTimers();
                setMenuAutoFocus(true);
                setMenuOpen(true);
              }
            }}
          >
            <GlyphZoom restore={zoomRestore} />
          </button>
          <TileMenuPopover
            open={menuOpen}
            autoFocus={menuAutoFocus}
            currentMode={displayMode}
            onSelect={handleTileSelect}
            onRequestClose={(options) => closeMenu(options?.returnFocus ?? true)}
            onHoverChange={(hovering) => {
              if (hovering) scheduleOpen();
              else scheduleClose();
            }}
          />
        </div>
      </div>
      {hostsAppTabs ? (
        <div
          className="wb-title-app-slot"
          data-wb-titlebar-slot
          data-window-id={windowId}
        />
      ) : null}
      {/* 标题绝对居中（不受左侧三键宽度影响）；溢出时 mask 渐隐 */}
      {!hostsAppTabs ? (
        <div
          className="pointer-events-none absolute inset-x-16 top-0 flex h-full items-center justify-center"
          aria-hidden={title === ''}
        >
          <span
            ref={titleRef}
            className="wb-title-text text-[13px] leading-none"
            data-wb-window-title
            data-wb-title-overflow={titleOverflow ? '' : undefined}
          >
            {title}
          </span>
        </div>
      ) : null}
    </div>
  );
};

export default WindowTitleBar;
