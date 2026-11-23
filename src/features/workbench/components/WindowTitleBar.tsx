/**
 * WindowTitleBar（P3 / O3；P1/P2 三键语义补全）— 窗口标题栏（高 38px）。
 *
 * - 左侧三键（对标 macOS）：
 *   红灯 = 关闭（requestClose 流程）；⌥+红灯 = 关闭同应用全部窗口（逐窗尊重
 *   closeGuard）；有未保存修改时中心显示实心圆点（data-dirty，hover 恢复 ×）
 *   黄灯 = 最小化；⌥+黄灯 = 最小化同应用全部窗口（逐窗 genie）
 *   绿灯 = 沉浸模式 toggle（maximize + 菜单栏/Dock 强制 autohide）；
 *   ⌥+绿灯 = 传统 zoom（floating ↔ maximized）
 * - 缩放键悬停 350ms 或长按 400ms 弹出 TileMenuPopover 平铺菜单（对标 macOS 绿灯）
 * - 双击标题栏空白区 = 按设置分发（缩放 / 最小化 / 无动作）
 * - 标题居中；溢出时 mask 渐隐（替代硬截断省略号）
 * - 材质走 wb-titlebar / wb-traffic-* 契约 + wb-title-* 微交互层
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import type { DisplayMode } from '../core/types';
import { MOVE_ARM_THRESHOLD_PX } from '../core/pointerEngine';
import { useWindowDirty } from '../core/windowCloseGuard';
import { toggleImmersive, useWindowImmersive } from '../core/immersiveMode';
import {
  requestCloseAppWindowsAnimated,
  requestMinimizeAppWindowsAnimated,
} from '../hooks/useWindowLifecycleAnim';
import { TileMenuPopover, type TileMenuAction } from './TileMenuPopover';
import { useTitleBarDoubleClickAction } from './titleBarBehaviorStore';
import { TITLEBAR_HEIGHT } from '../core/metrics';
import './WindowTitleBar.css';

// 单一来源在 core/metrics（TS）与 --wb-titlebar-height token（CSS）；
// 此处 re-export 维持既有 import 路径（index.ts / WindowShell 等）。
export { TITLEBAR_HEIGHT };

/** 缩放键悬停多久弹出平铺菜单（ms） */
export const TILE_MENU_HOVER_DELAY = 350;
/** 指针离开缩放键与菜单后的宽限关闭时间（ms） */
export const TILE_MENU_CLOSE_GRACE = 200;
/** 长按绿灯直接打开平铺菜单（ms，对标 macOS 按住绿灯出菜单） */
export const TILE_MENU_LONGPRESS_DELAY = 400;

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
  /** 缩放键点击 = maximize/还原 toggle；双击标题栏同；alt = ⌥+绿灯（填满桌面） */
  onZoom: (opts?: { alt?: boolean }) => void;
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

/** 未保存圆点（macOS：脏窗口红灯非 hover 时中心实心点） */
const GlyphDirtyDot = () => (
  <svg
    className="wb-title-dirty-dot"
    viewBox="0 0 12 12"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="6" cy="6" r="2.4" fill="currentColor" />
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

/** ⌥ 按住时绿灯切为经典 macOS `+` 缩放符号 */
const GlyphPlus = () => (
  <svg
    className="wb-title-glyph"
    data-wb-zoom-glyph="plus"
    viewBox="0 0 12 12"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M6 2.5v7M2.5 6h7"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
);

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
  const dirty = useWindowDirty(windowId);
  const immersive = useWindowImmersive(windowId);
  const doubleClickAction = useTitleBarDoubleClickAction();
  /** 按住 ⌥ 时三键提示切换为批量/传统 zoom 语义，绿灯符号实时切换为 + */
  const [altHeld, setAltHeld] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAutoFocus, setMenuAutoFocus] = useState(false);
  const [titleOverflow, setTitleOverflow] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomButtonRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  /** 标题栏拖拽视觉态启动阈值（与 pointerEngine MOVE_ARM_THRESHOLD_PX 对齐） */
  const dragArmRef = useRef<{ x: number; y: number; armed: boolean } | null>(null);
  /** 本轮视觉拖拽监听清理；失焦 / 重入 / 卸载均须摘掉，避免 class 卡住 */
  const dragArmCleanupRef = useRef<(() => void) | null>(null);

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

  // ⌥ 按下/抬起/失焦状态（集中通过 useEventRegistry 监听，切换三键语义与绿灯 + 符号）
  const altKeyEvents = useMemo(
    () => [
      {
        target: 'window' as const,
        type: 'keydown',
        listener: (event: Event) => {
          const e = event as KeyboardEvent;
          if (e.key === 'Alt') setAltHeld(true);
        },
      },
      {
        target: 'window' as const,
        type: 'keyup',
        listener: (event: Event) => {
          const e = event as KeyboardEvent;
          if (e.key === 'Alt') setAltHeld(false);
        },
      },
      {
        target: 'window' as const,
        type: 'blur',
        listener: () => setAltHeld(false),
      },
    ],
    [],
  );
  useEventRegistry(altKeyEvents, [altKeyEvents]);

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

  /** 长按绿灯直接开菜单：按满 TILE_MENU_LONGPRESS_DELAY 未松手即打开，
   * 并抑制随后的 click（否则松手会触发 zoom 把菜单顶掉）。 */
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearLongPress, [clearLongPress]);

  const handleZoomPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      longPressFiredRef.current = false;
      clearLongPress();
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        longPressFiredRef.current = true;
        clearTimers();
        setMenuAutoFocus(false);
        setMenuOpen(true);
      }, TILE_MENU_LONGPRESS_DELAY);
    },
    [clearLongPress, clearTimers],
  );

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  /** 本次按下序列是否发生过拖拽（armed）；拖过后的双击不触发 zoom（对齐 macOS） */
  const recentDragRef = useRef(false);

  /** 双击标题栏按设置分发：zoom（默认）/ minimize / none（拖过不触发照旧） */
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (recentDragRef.current) {
        recentDragRef.current = false;
        return;
      }
      if (doubleClickAction === 'none') return;
      if (doubleClickAction === 'minimize') {
        onMinimize();
        return;
      }
      onZoom({ alt: e.altKey });
    },
    [doubleClickAction, onMinimize, onZoom],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      dragArmCleanupRef.current?.();
      // 视觉 dragging 过 3px 阈值才挂 class（DOM 直写，避免 React 重渲染抢首帧）
      const startX = e.clientX;
      const startY = e.clientY;
      dragArmRef.current = { x: startX, y: startY, armed: false };
      // 每次按下重置"拖过"标记：仅当本次双击序列中发生拖拽才抑制 zoom
      recentDragRef.current = false;
      const bar = barRef.current;
      // 直接共用内核 pointerEngine 的 MOVE_ARM_THRESHOLD_PX（3px）：
      // 视觉 dragging 态与真实起拖同刻武装；触控板/高分屏双击的 1–2px 微抖
      // 不会被误判成「拖过」而吞掉 zoom。
      const THRESHOLD_SQ = MOVE_ARM_THRESHOLD_PX * MOVE_ARM_THRESHOLD_PX;
      const onMove = (ev: PointerEvent) => {
        const arm = dragArmRef.current;
        if (!arm || arm.armed) return;
        const dx = ev.clientX - arm.x;
        const dy = ev.clientY - arm.y;
        if (dx * dx + dy * dy < THRESHOLD_SQ) return;
        arm.armed = true;
        recentDragRef.current = true;
        bar?.classList.add('wb-title-dragging');
      };
      const onUp = () => {
        dragArmRef.current = null;
        bar?.classList.remove('wb-title-dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        window.removeEventListener('blur', onUp);
        if (dragArmCleanupRef.current === onUp) dragArmCleanupRef.current = null;
      };
      dragArmCleanupRef.current = onUp;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      window.addEventListener('blur', onUp);
      onMovePointerDown?.(e);
    },
    [onMovePointerDown],
  );

  useEffect(() => () => dragArmCleanupRef.current?.(), []);

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
  // 按住 ⌥ 时切换批量 / 传统 zoom 语义提示（macOS 行为）
  const closeLabel = altHeld ? t('a11y.closeAll') : t('a11y.close');
  const minimizeLabel = altHeld ? t('a11y.minimizeAll') : t('a11y.minimize');
  const zoomLabel = altHeld
    ? zoomRestore
      ? t('a11y.zoomRestore')
      : t('a11y.zoom')
    : immersive
      ? t('a11y.immersiveExit')
      : t('a11y.immersiveEnter');
  const seamlessChat = appTypeId === 'chat' || appTypeId === 'chat-session';
  const hostsAppTabs = appTypeId === 'notes' || appTypeId === 'files';
  // todo/skills 工具栏整体 portal 进窗口标题栏（应用名已由菜单栏承接，居中标题冗余）；
  // 题目集/翻译/作文只放资源列表开关，保留居中标题
  const hostsAppTitlebarSlot = hostsAppTabs
    || appTypeId === 'chat'
    || appTypeId === 'todo'
    || appTypeId === 'skills'
    || appTypeId === 'exam'
    || appTypeId === 'translation'
    || appTypeId === 'essay';
  const suppressCenteredTitle = seamlessChat || hostsAppTabs || appTypeId === 'todo' || appTypeId === 'skills';
  /** 长标题被渐隐截断时，悬停标题栏空白区可见完整标题（三键自带 title 优先） */
  const barTooltip = titleOverflow ? title : undefined;

  return (
    <div
      ref={barRef}
      className={`wb-titlebar wb-title-bar relative flex shrink-0 select-none items-center px-2${
        focused ? '' : ' wb-title-bar-idle'
      }`}
      style={{ height: TITLEBAR_HEIGHT, touchAction: 'none' }}
      data-wb-titlebar
      data-wb-title-seamless={seamlessChat ? '' : undefined}
      data-wb-title-draggable=""
      title={barTooltip}
      data-wb-app-tabs={appTypeId === 'notes' ? 'notes' : appTypeId === 'files' ? 'files' : undefined}
      data-window-id={windowId}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
    >
      <div
        className="wb-traffic relative z-10"
        data-wb-traffic
        data-alt-held={altHeld ? 'true' : undefined}
      >
        <button
          type="button"
          className="wb-traffic-close wb-title-key"
          aria-label={closeLabel}
          title={closeLabel}
          data-dirty={dirty ? '' : undefined}
          onPointerDown={stop}
          onDoubleClick={stop}
          onClick={(e) => {
            e.stopPropagation();
            if (e.altKey) {
              // ⌥+红灯：关闭同应用全部窗口（逐窗 requestCloseAnimated，
              // 被 closeGuard 拦下的窗口留下）
              void requestCloseAppWindowsAnimated(windowId);
              return;
            }
            onClose();
          }}
        >
          <GlyphClose />
          <GlyphDirtyDot />
        </button>
        <button
          type="button"
          className="wb-traffic-min wb-title-key"
          aria-label={minimizeLabel}
          title={minimizeLabel}
          onPointerDown={stop}
          onDoubleClick={stop}
          onClick={(e) => {
            e.stopPropagation();
            if (e.altKey) {
              // ⌥+黄灯：最小化同应用全部窗口（含本窗，逐窗 genie）
              requestMinimizeAppWindowsAnimated(windowId);
              return;
            }
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
            /* 绿灯默认 = 沉浸模式 toggle；按住 ⌥ 切回传统 zoom/还原语义 */
            aria-label={zoomLabel}
            title={zoomLabel}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onPointerDown={handleZoomPointerDown}
            onPointerUp={clearLongPress}
            onPointerCancel={clearLongPress}
            onDoubleClick={stop}
            onPointerEnter={scheduleOpen}
            onPointerLeave={() => {
              clearLongPress();
              scheduleClose();
            }}
            onClick={(e) => {
              e.stopPropagation();
              // 长按已开菜单：这次松手的 click 不再当 zoom，保持菜单打开
              if (longPressFiredRef.current) {
                longPressFiredRef.current = false;
                return;
              }
              closeMenu();
              if (e.altKey) {
                // ⌥+绿灯 = 传统 zoom（填满桌面 / 还原），对齐 macOS
                onZoom({ alt: true });
                return;
              }
              // 绿灯默认 = 沉浸模式 toggle（maximize + 菜单栏/Dock 隐藏）
              toggleImmersive(windowId);
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
            {altHeld ? <GlyphPlus /> : <GlyphZoom restore={zoomRestore} />}
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
      {hostsAppTitlebarSlot ? (
        <div
          className="wb-title-app-slot"
          data-wb-titlebar-slot
          data-window-id={windowId}
        />
      ) : null}
      {/* 标题绝对居中（不受左侧三键宽度影响）；溢出时 mask 渐隐 */}
      {!suppressCenteredTitle ? (
        <div
          className="wb-title-center pointer-events-none absolute inset-x-16 top-0 flex h-full items-center justify-center"
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
