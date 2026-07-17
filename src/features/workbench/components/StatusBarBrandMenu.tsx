/**
 * StatusBarBrandMenu — 顶栏「学习桌面」品牌下拉（macOS 苹果菜单语义）
 *
 * 视觉与桌面右键菜单同款：复用 wb-desk-menu 玻璃面板类族（DesktopContextMenu.css）
 * 与其 ActionItem 动作行；定位在品牌钮正下方、左对齐（macOS 下拉落位）。
 *
 * 交互：↑↓/Home/End 移动、Enter 走按钮原生激活、Esc/Tab/点外/窗口失焦关闭；
 * 打开聚焦面板、关闭焦点还给品牌钮；液体玻璃透镜与右键菜单同 hook。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { GearSix, SignOut, SquaresFour } from '@phosphor-icons/react';
import { workbenchBus } from '../core/workbenchBus';
import { useLiquidGlassLens } from '../core/liquidGlassLens';
import { openAppsPanel } from './appsPanelStore';
import { ActionItem } from './DesktopContextMenu';
import { persistWorkbenchModeEnabled } from '@/features/settings/components/workbenchMode';
import './DesktopContextMenu.css';

export interface StatusBarBrandMenuProps {
  open: boolean;
  /** 品牌钮（定位锚 + 焦点归还目标） */
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

const EDGE_PAD = 8;
const FALLBACK_W = 224;
/** 菜单与顶栏的纵向间隙 */
const MENU_GAP = 4;

export const StatusBarBrandMenu: React.FC<StatusBarBrandMenuProps> = ({
  open,
  anchorRef,
  onClose,
}) => {
  const { t } = useTranslation('workbench');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLiquidGlassLens(panelRef, open);

  // 定位：品牌钮正下方、左缘对齐，视口内钳制
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const w = panelRef.current?.offsetWidth || FALLBACK_W;
    const left = Math.max(EDGE_PAD, Math.min(rect.left, window.innerWidth - w - EDGE_PAD));
    setPos({ left, top: rect.bottom + MENU_GAP });
  }, [open, anchorRef]);

  // 焦点：打开时记录前一焦点并聚焦面板；关闭时归还
  useEffect(() => {
    if (!open) return undefined;
    prevFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });
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

  const runAndClose = useCallback(
    (action: () => void) => () => {
      action();
      onClose();
    },
    [onClose],
  );

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

  if (!open) return null;

  return createPortal(
    <>
      <div
        className="wb-desk-menu-backdrop"
        style={{ position: 'fixed' }}
        aria-hidden="true"
        onPointerDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={panelRef}
        className="wb-desk-menu wb-glass-lens"
        data-wb-brand-menu
        role="menu"
        aria-label={t('menubar.brandMenu')}
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
        <ActionItem
          icon={<SquaresFour size={15} weight="duotone" />}
          label={t('workbench:appsPanel.title')}
          testId="wb-menubar-brand-apps"
          onClick={runAndClose(() => openAppsPanel())}
        />
        <ActionItem
          icon={<GearSix size={15} weight="duotone" />}
          label={t('menubar.brandSettings')}
          testId="wb-menubar-brand-settings"
          onClick={runAndClose(() => workbenchBus.launch({ typeId: 'settings', reason: 'api' }))}
        />
        <div className="wb-desk-menu-sep" role="separator" />
        <ActionItem
          icon={<SignOut size={15} weight="duotone" />}
          label={t('menubar.brandExit')}
          testId="wb-menubar-brand-exit"
          onClick={runAndClose(() => {
            // 失败由 helper 统一通知；成功后 App 监听 workbench:mode-changed 切回 legacy 壳
            void persistWorkbenchModeEnabled(false);
          })}
        />
      </div>
    </>,
    document.body,
  );
};

export default StatusBarBrandMenu;
