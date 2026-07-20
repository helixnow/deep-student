/**
 * StatusBarMenu — 顶栏下拉菜单通用壳（macOS 菜单栏下拉语义）
 *
 * 从 StatusBarBrandMenu 抽出的可复用弹层：品牌 / 聚焦应用 / 窗口菜单共用。
 * 视觉与桌面右键菜单同款：复用 wb-desk-menu 玻璃面板类族（DesktopContextMenu.css），
 * 定位在锚点按钮正下方、左对齐（macOS 下拉落位）。
 *
 * 交互：↑↓/Home/End 移动、Enter 走按钮原生激活、Esc/Tab/点外/窗口失焦关闭；
 * 打开聚焦首个菜单项、关闭焦点还给锚点按钮；液体玻璃透镜与右键菜单同 hook。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiquidGlassLens } from '../core/liquidGlassLens';
import './DesktopContextMenu.css';

const EDGE_PAD = 8;
const FALLBACK_W = 224;
/** 菜单与顶栏的纵向间隙 */
const MENU_GAP = 4;

export interface StatusBarMenuProps {
  open: boolean;
  /** 锚点按钮（定位锚 + 焦点归还目标） */
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  /** role=menu 的 aria-label */
  label: string;
  onClose: () => void;
  testId?: string;
  children: React.ReactNode;
}

export const StatusBarMenu: React.FC<StatusBarMenuProps> = ({
  open,
  anchorRef,
  label,
  onClose,
  testId,
  children,
}) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // 离场相位：open→false 时先播 wb-desk-menu 的 closing 动画再卸载
  const [closing, setClosing] = useState(false);
  const wasOpenRef = useRef(false);
  const mounted = open || closing;
  useLiquidGlassLens(panelRef, mounted);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      setClosing(false);
      return undefined;
    }
    // 从已打开状态收起才播离场；初始 closed 不播
    if (!wasOpenRef.current) return undefined;
    wasOpenRef.current = false;
    setClosing(true);
    const timer = window.setTimeout(() => setClosing(false), 100);
    return () => window.clearTimeout(timer);
  }, [open]);

  // 定位：锚点按钮正下方、左缘对齐，视口内钳制
  const place = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const w = panelRef.current?.offsetWidth || FALLBACK_W;
    const left = Math.max(EDGE_PAD, Math.min(rect.left, window.innerWidth - w - EDGE_PAD));
    setPos({ left, top: rect.bottom + MENU_GAP });
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) {
      if (!closing) setPos(null);
      return undefined;
    }
    place();
    // 打开期间跟随视口变化重定位（拖窗/缩放后菜单不脱锚）
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, closing, place]);

  // 焦点：打开时记录前一焦点并聚焦首个菜单项（macOS 菜单键盘语义）；关闭时归还
  useEffect(() => {
    if (!open) return undefined;
    prevFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstItem = panelRef.current?.querySelector<HTMLButtonElement>(
      'button[data-wb-desk-item]:not(:disabled)',
    );
    (firstItem ?? panelRef.current)?.focus({ preventScroll: true });
    return () => {
      const prev = prevFocusRef.current;
      prevFocusRef.current = null;
      if (prev && prev.isConnected) prev.focus({ preventScroll: true });
      else anchorRef.current?.focus({ preventScroll: true });
    };
  }, [open, anchorRef]);

  // Esc / 窗口失焦关闭（与桌面右键菜单同兜底）
  useEffect(() => {
    if (!open) return undefined;
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onWindowBlur = () => onClose();
    document.addEventListener('keydown', onDocKeyDown);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('keydown', onDocKeyDown);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [open, onClose]);

  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[data-wb-desk-item]:not(:disabled)',
      ) ?? [],
    );
    if (items.length === 0) return;
    const active = document.activeElement as HTMLButtonElement | null;
    const idx = active ? items.indexOf(active) : -1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        items[(idx + 1 + items.length) % items.length]?.focus({ preventScroll: true });
        break;
      case 'ArrowUp':
        e.preventDefault();
        items[idx <= 0 ? items.length - 1 : idx - 1]?.focus({ preventScroll: true });
        break;
      case 'Home':
        e.preventDefault();
        items[0]?.focus({ preventScroll: true });
        break;
      case 'End':
        e.preventDefault();
        items[items.length - 1]?.focus({ preventScroll: true });
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
      case 'Tab':
        e.preventDefault();
        onClose();
        break;
      default:
        break;
    }
  };

  if (!mounted) return null;

  return createPortal(
    <>
      <div
        className="wb-desk-menu-backdrop"
        style={{ position: 'fixed' }}
        aria-hidden="true"
        onPointerDown={open ? onClose : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          if (open) onClose();
        }}
      />
      <div
        ref={panelRef}
        className="wb-desk-menu wb-glass-lens"
        data-wb-statusbar-menu
        data-phase={open ? 'open' : 'closing'}
        data-testid={testId}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        style={{
          position: 'fixed',
          left: pos?.left ?? 0,
          top: pos?.top ?? 0,
          visibility: pos ? 'visible' : 'hidden',
        }}
        onKeyDown={onPanelKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {children}
      </div>
    </>,
    document.body,
  );
};

export default StatusBarMenu;
