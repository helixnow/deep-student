/**
 * AppMenu - 现代化下拉菜单/右键菜单通用组件
 * 
 * 特性：
 * - 柔和的深色/浅色主题适配
 * - 更大的圆角和内边距，视觉更精致
 * - 支持图标 + 文本 + 快捷键布局
 * - 分组标题、分隔线、底部元信息
 * - 搜索框、开关控件等高级元素
 * - 子菜单支持
 * - DropdownMenu 和 ContextMenu 两种模式
 */

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { Check as PhosphorCheck, CaretRight, MagnifyingGlass } from '@phosphor-icons/react';
import { CustomScrollArea } from '../../custom-scroll-area';
import { useOverlayCoordinator } from '../../shared/OverlayCoordinator';
import { useNestedOverlayZ } from '../../shared/OverlayLayer';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import './AppMenu.css';

// ============ Context ============

interface AppMenuContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLDivElement>;
  contentRef: React.RefObject<HTMLDivElement>;
  menuId: string;
  mode: 'dropdown' | 'context';
  position: { x: number; y: number };
  setPosition: (pos: { x: number; y: number }) => void;
}

const AppMenuContext = React.createContext<AppMenuContextValue | null>(null);

// 键盘导航的起始锚点：识别"当前选中"的菜单项（勾选态 / aria-checked）
function isCheckedMenuItem(item: HTMLElement): boolean {
  return (
    item.getAttribute('aria-checked') === 'true' ||
    item.classList.contains('app-menu-item-checked')
  );
}

// ============ Root Component ============

export interface AppMenuProps {
  /** 受控模式的开关状态 */
  open?: boolean;
  /** 开关状态变化回调 */
  onOpenChange?: (open: boolean) => void;
  /** 菜单模式：dropdown (下拉) 或 context (右键) */
  mode?: 'dropdown' | 'context';
  /** 根容器类名 */
  className?: string;
  children: React.ReactNode;
}

export function AppMenu({ open, onOpenChange, mode = 'dropdown', className, children }: AppMenuProps) {
  const isControlled = open !== undefined;
  const [internalOpen, setInternalOpen] = React.useState(false);
  const [position, setPosition] = React.useState({ x: 0, y: 0 });
  const actualOpen = isControlled ? !!open : internalOpen;
  const menuId = React.useId();
  const { dismissTooltips, registerInteractiveOverlay } = useOverlayCoordinator();

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (next) {
        dismissTooltips();
      }
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [dismissTooltips, isControlled, onOpenChange]
  );

  const handleKeyDown = React.useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    },
    [setOpen]
  );

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!actualOpen) return;
    return registerInteractiveOverlay();
  }, [actualOpen, registerInteractiveOverlay]);

  // 📱 Android 返回键：AppMenu 是自绘浮层（非 Radix），协调器的 Escape 兜底
  // 探测不到它；在根组件统一注册 overlay 级 handler，菜单打开时返回键先关菜单。
  // 桌面端注册无副作用（handleAndroidBack 仅由 Android native 桥调用）。
  React.useEffect(() => {
    if (!actualOpen) return;
    return registerBackHandler(() => {
      setOpen(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [actualOpen, setOpen]);

  React.useEffect(() => {
    if (!actualOpen) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      const targetElement = target instanceof Element ? target : null;
      if (targetElement?.closest(`[data-app-menu-id="${menuId}"]`)) return;
      if (containerRef.current && containerRef.current.contains(target)) return;
      if (contentRef.current && contentRef.current.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [actualOpen, handleKeyDown, setOpen]);

  return (
    <AppMenuContext.Provider value={{ open: actualOpen, setOpen, triggerRef: containerRef, contentRef, menuId, mode, position, setPosition }}>
      <div ref={containerRef} className={cn('app-menu-root relative inline-flex', className)}>
        {children}
      </div>
    </AppMenuContext.Provider>
  );
}

// ============ Trigger ============

export interface AppMenuTriggerProps extends React.HTMLAttributes<HTMLElement> {
  asChild?: boolean;
  children: React.ReactNode;
}

export const AppMenuTrigger = React.forwardRef<HTMLElement, AppMenuTriggerProps>(
  ({ asChild, children, className, onClick, onContextMenu, onKeyDown, ...rest }, ref) => {
  const ctx = React.useContext(AppMenuContext);
  const Comp = (asChild ? Slot : 'button') as React.ElementType;
  
  if (!ctx) return <>{children}</>;

  const handleClick = (e: React.MouseEvent) => {
    onClick?.(e as React.MouseEvent<HTMLElement>);
    if (e.defaultPrevented) return;

    if (ctx.mode === 'dropdown') {
      ctx.setOpen(!ctx.open);
      return;
    }

    // Context menus should only open from the native context-menu gesture.
    // A regular left click can still bubble to the child trigger for selection,
    // but it should never leave the menu open or reopen it.
    ctx.setOpen(false);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    onContextMenu?.(e as React.MouseEvent<HTMLElement>);
    if (e.defaultPrevented && ctx.mode !== 'context') return;

    if (ctx.mode === 'context') {
      e.preventDefault();
      ctx.setPosition({ x: e.clientX, y: e.clientY });
      ctx.setOpen(true);
    }
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    onKeyDown?.(e as React.KeyboardEvent<HTMLElement>);
    if (e.defaultPrevented) return;
    const keyboardContext = e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
    if (ctx.mode === 'context' && keyboardContext) {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      ctx.setPosition({
        x: rect.left + Math.min(16, rect.width / 2),
        y: rect.top + Math.min(16, rect.height / 2),
      });
      ctx.setOpen(true);
      return;
    }
    if (
      ctx.mode === 'dropdown' &&
      (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')
    ) {
      e.preventDefault();
      ctx.setOpen(true);
    }
  };

  return (
    <Comp
      ref={ref}
      id={ctx.menuId + '-trigger'}
      type={asChild ? undefined : 'button'}
      aria-haspopup="menu"
      aria-expanded={ctx.open}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onKeyDown={handleTriggerKeyDown}
      className={cn('app-menu-trigger', className)}
      {...rest}
    >
      {children}
    </Comp>
  );
  }
);
AppMenuTrigger.displayName = 'AppMenuTrigger';

// ============ Content ============

export interface AppMenuContentProps extends React.HTMLAttributes<HTMLDivElement> {
  align?: 'start' | 'center' | 'end';
  /** 菜单宽度 */
  width?: number | string;
  /** 菜单最大高度（超出后滚动） */
  maxHeight?: number | string;
  /** 是否显示搜索框 */
  showSearch?: boolean;
  /** 搜索框占位符 */
  searchPlaceholder?: string;
  /** 搜索值 */
  searchValue?: string;
  /** 搜索值变化回调 */
  onSearchChange?: (value: string) => void;
}

export function AppMenuContent({
  className,
  align = 'start',
  width,
  maxHeight,
  showSearch,
  searchPlaceholder,
  searchValue,
  onSearchChange,
  children,
  style,
  onKeyDown,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  ...rest
}: AppMenuContentProps) {
  const ctx = React.useContext(AppMenuContext);
  const { t } = useTranslation('app_menu');
  // 嵌套层级感知：从最近的 <OverlayLayerProvider> 读取基准 z-index 并抬升一档；
  // 没有 Provider 时退化为默认 popover 档（行为与未引入 Provider 前一致）。
  const nestedZ = useNestedOverlayZ();
  const [position, setPosition] = React.useState<{ top: number; left: number; origin: 'top' | 'bottom' }>({ top: 0, left: 0, origin: 'top' });
  const [internalSearchValue, setInternalSearchValue] = React.useState('');
  const fallbackContentRef = React.useRef<HTMLDivElement | null>(null);
  const contentRef = ctx?.contentRef ?? fallbackContentRef;
  const portalContainerRef = React.useRef<HTMLElement | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const isOpen = !!ctx?.open;
  const menuMode = ctx?.mode;
  const triggerRef = ctx?.triggerRef;
  const contextPositionX = ctx?.position.x ?? 0;
  const contextPositionY = ctx?.position.y ?? 0;
  const [shouldRender, setShouldRender] = React.useState(isOpen);
  const [isClosing, setIsClosing] = React.useState(false);
  const closeTimeoutRef = React.useRef<number | null>(null);
  const resolvedSearchPlaceholder = searchPlaceholder || t('app_menu.search.placeholder');

  const actualSearchValue = searchValue !== undefined ? searchValue : internalSearchValue;
  const handleSearchChange = (value: string) => {
    if (onSearchChange) {
      onSearchChange(value);
    } else {
      setInternalSearchValue(value);
    }
  };

  React.useEffect(() => {
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }

    if (isOpen) {
      setShouldRender(true);
      setIsClosing(false);
      return;
    }

    if (!shouldRender) return;

    setIsClosing(true);
    const closeMs = parseFloat(
      window.getComputedStyle(document.documentElement).getPropertyValue('--dropdown-close-dur')
    ) || 150;

    closeTimeoutRef.current = window.setTimeout(() => {
      setShouldRender(false);
      setIsClosing(false);
      closeTimeoutRef.current = null;
    }, closeMs);

    return () => {
      if (closeTimeoutRef.current !== null) {
        window.clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
    };
  }, [isOpen, shouldRender]);

  React.useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    const triggerEl = triggerRef?.current;
    portalContainerRef.current = triggerEl?.closest('[data-overlay-container="true"]') as HTMLElement | null;
    if (!shouldRender) return;
    
    const updatePosition = () => {
      const contentEl = contentRef.current;
      if (!contentEl) return;

      // Keep collision placement independent from ui-zoom-fade-in transforms.
      const contentRect = {
        width: contentEl.offsetWidth,
        height: contentEl.offsetHeight,
      };
      const gap = 6;
      let top: number;
      let left: number;
      let origin: 'top' | 'bottom' = 'top';

      if (menuMode === 'context') {
        // 默认以点击点为左上角向下展开；下方空间不足时，改用同一点击点
        // 作为左下角向上展开。最后仍走统一边界钳位，处理菜单高于视口等极端情况。
        const fitsBelow = contextPositionY + contentRect.height <= window.innerHeight - 8;
        top = fitsBelow ? contextPositionY : contextPositionY - contentRect.height;
        left = contextPositionX;
        if (!fitsBelow) origin = 'bottom';
      } else {
        // 下拉菜单模式：使用触发器位置
        const triggerEl = triggerRef?.current;
        if (!triggerEl) return;
        const triggerRect = triggerEl.getBoundingClientRect();

        top = triggerRect.bottom + gap;
        if (top + contentRect.height > window.innerHeight - 8) {
          top = triggerRect.top - gap - contentRect.height;
          origin = 'bottom';
          if (top < 8) {
            top = Math.max(8, window.innerHeight - contentRect.height - 8);
          }
        } else {
          top = Math.min(top, window.innerHeight - contentRect.height - 8);
        }

        if (align === 'start') {
          left = triggerRect.left;
        } else if (align === 'center') {
          left = triggerRect.left + triggerRect.width / 2 - contentRect.width / 2;
        } else {
          left = triggerRect.right - contentRect.width;
        }
      }

      // 边界检测
      const maxLeft = window.innerWidth - contentRect.width - 8;
      left = Math.min(Math.max(8, left), maxLeft < 8 ? 8 : maxLeft);
      
      const maxTop = window.innerHeight - contentRect.height - 8;
      top = Math.min(Math.max(8, top), maxTop < 8 ? 8 : maxTop);

      setPosition((prev) => (
        prev.top === top && prev.left === left && prev.origin === origin
          ? prev
          : { top, left, origin }
      ));
    };

    updatePosition();
    const rafId = requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [align, contentRef, contextPositionX, contextPositionY, menuMode, shouldRender, triggerRef]);

  const getEnabledItems = React.useCallback((): HTMLElement[] => {
    const root = contentRef.current;
    if (!root) return [];
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
      ),
    ).filter(
      (item) =>
        !item.hasAttribute('disabled') &&
        item.getAttribute('aria-disabled') !== 'true' &&
        !item.closest('[data-app-menu-sub-content]'),
    );
  }, [contentRef]);

  // 打开后建立键盘入口；timer 必须随 close/reopen 清理，避免旧会话抢焦点。
  // 焦点只落在菜单容器（tabIndex=-1）上，不预先聚焦任何菜单项：
  // 鼠标打开时不会出现"假悬浮"高亮，键盘方向键仍能从容器进入导航。
  React.useEffect(() => {
    if (!isOpen || !shouldRender) return undefined;
    const timer = window.setTimeout(() => {
      if (!isOpen) return;
      if (showSearch && searchInputRef.current) {
        searchInputRef.current.focus({ preventScroll: true });
        return;
      }
      contentRef.current?.focus({ preventScroll: true });
    }, showSearch ? 50 : 0);
    return () => window.clearTimeout(timer);
  }, [contentRef, isOpen, shouldRender, showSearch]);

  const handleContentKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || !ctx) return;
    const items = getEnabledItems();
    const active = document.activeElement instanceof HTMLElement
      ? document.activeElement.closest<HTMLElement>(
          '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
        )
      : null;
    const index = active ? items.indexOf(active) : -1;
    // 尚无聚焦项时（菜单刚打开，焦点在容器上），键盘导航从当前选中项开始
    const checkedIndex = index < 0 ? items.findIndex(isCheckedMenuItem) : -1;
    const focusAt = (next: number) => {
      if (items.length === 0) return;
      const item = items[((next % items.length) + items.length) % items.length];
      item.focus({ preventScroll: true });
      item.scrollIntoView({ block: 'nearest' });
    };
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        focusAt(index < 0 ? (checkedIndex >= 0 ? checkedIndex : 0) : index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        focusAt(index < 0 ? (checkedIndex >= 0 ? checkedIndex : items.length - 1) : index - 1);
        break;
      case 'Home':
        if (event.target === searchInputRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        focusAt(0);
        break;
      case 'End':
        if (event.target === searchInputRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        focusAt(items.length - 1);
        break;
      case 'Escape': {
        event.preventDefault();
        event.stopPropagation();
        ctx.setOpen(false);
        const trigger = ctx.triggerRef.current?.querySelector<HTMLElement>(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled])',
        );
        trigger?.focus({ preventScroll: true });
        break;
      }
      case 'Tab':
        event.stopPropagation();
        ctx.setOpen(false);
        break;
      default:
        break;
    }
  };

  if (!ctx || !shouldRender) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={contentRef}
      role="menu"
      data-app-menu-id={ctx.menuId}
      tabIndex={-1}
      // P3-9 可访问名兜底：调用方未给 aria-label/labelledby 时，下拉菜单
      // 用触发器（按钮文本或其 aria-label）作为菜单名；context 模式触发器
      // 是大面积内容区，不做兜底以免名字冗长。
      aria-label={ariaLabel}
      aria-labelledby={
        ariaLabelledBy ??
        (ariaLabel || ctx.mode !== 'dropdown' ? undefined : `${ctx.menuId}-trigger`)
      }
      className={cn(
        'app-menu-content',
        position.origin === 'bottom' ? 'app-menu-origin-bottom' : 'app-menu-origin-top',
        isOpen && 'app-menu-open',
        isClosing && 'app-menu-closing',
        className
      )}
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        width: width,
        // 嵌套层级感知：仅当外层包裹了 <OverlayLayerProvider> 时才覆盖 z-index；
        // 否则保持 CSS（.app-menu-content 默认 110）行为不变，避免污染既有调用点。
        // 调用方传入的 style.zIndex 优先级最高（兼容显式覆盖）。
        ...(nestedZ !== null ? { zIndex: nestedZ } : {}),
        ...(maxHeight ? { maxHeight, display: 'flex', flexDirection: 'column' as const, overflow: 'hidden' } : {}),
        ...style,
      }}
      onKeyDown={handleContentKeyDown}
      {...rest}
    >
      {showSearch && (
        <div className="app-menu-search" style={{ flexShrink: 0 }}>
          <MagnifyingGlass className="app-menu-search-icon" />
          <input
            ref={searchInputRef}
            type="search"
            className="app-menu-search-input ds-search-input"
            placeholder={resolvedSearchPlaceholder}
            value={actualSearchValue}
            onChange={(e) => handleSearchChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
/>
        </div>
      )}
      <AppMenuSubLevelProvider>
        {maxHeight ? (
          <CustomScrollArea style={{ flex: 1, minHeight: 0 }}>
            {children}
          </CustomScrollArea>
        ) : (
          children
        )}
      </AppMenuSubLevelProvider>
    </div>,
    portalContainerRef.current ?? document.body
  );
}

// ============ Group ============

export interface AppMenuGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 分组标题 */
  label?: string;
}

export function AppMenuGroup({ label, className, children, ...rest }: AppMenuGroupProps) {
  return (
    <div className={cn('app-menu-group', className)} role="group" {...rest}>
      {label && <div className="app-menu-group-label">{label}</div>}
      {children}
    </div>
  );
}

// ============ Item ============

export interface AppMenuItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 左侧图标 */
  icon?: React.ReactNode;
  /** 快捷键显示 */
  shortcut?: string;
  /** 是否危险操作（红色） */
  destructive?: boolean;
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否选中状态 */
  checked?: boolean;
  /** 右侧额外内容 */
  suffix?: React.ReactNode;
}

export const AppMenuItem = React.forwardRef<HTMLButtonElement, AppMenuItemProps>(
  ({ className, icon, children, shortcut, destructive, disabled, checked, suffix, onClick, tabIndex = -1, ...rest }, ref) => {
    const ctx = React.useContext(AppMenuContext);
    
    return (
      <button
        ref={ref}
        role="menuitem"
        disabled={disabled}
        tabIndex={tabIndex}
        className={cn(
          'app-menu-item',
          destructive && 'app-menu-item-destructive',
          disabled && 'app-menu-item-disabled',
          checked && 'app-menu-item-checked',
          className
        )}
        onClick={(event) => {
          if (disabled) return;
          onClick?.(event);
          ctx?.setOpen(false);
        }}
        {...rest}
      >
        {icon && <span className="app-menu-item-icon">{icon}</span>}
        <span className="app-menu-item-content">{children}</span>
        {checked !== undefined && (
          <span className="app-menu-item-check">
            {checked && <PhosphorCheck size={16} weight="bold" />}
          </span>
        )}
        {suffix && <span className="app-menu-item-suffix">{suffix}</span>}
        {shortcut && <span className="app-menu-item-shortcut">{shortcut}</span>}
      </button>
    );
  }
);
AppMenuItem.displayName = 'AppMenuItem';

// ============ Sub 同级互斥协调 ============
// 同一层级（同一个 Content / SubContent 下）的多个 AppMenuSub 互斥：
// 打开一个时其余自动关闭。openOnClick 模式没有 mouseleave 收合路径，
// 没有协调器时多个飞出层会同时叠加显示。
interface AppMenuSubLevelContextValue {
  activeSubId: string | null;
  setActiveSubId: React.Dispatch<React.SetStateAction<string | null>>;
}

const AppMenuSubLevelContext = React.createContext<AppMenuSubLevelContextValue | null>(null);

function AppMenuSubLevelProvider({ children }: { children: React.ReactNode }) {
  const [activeSubId, setActiveSubId] = React.useState<string | null>(null);
  const value = React.useMemo(() => ({ activeSubId, setActiveSubId }), [activeSubId]);
  return (
    <AppMenuSubLevelContext.Provider value={value}>
      {children}
    </AppMenuSubLevelContext.Provider>
  );
}

// ============ SubMenu ============

export interface AppMenuSubProps {
  children: React.ReactNode;
  openOnClick?: boolean;
}

interface AppMenuSubContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLDivElement>;
  contentRef: React.RefObject<HTMLDivElement>;
  openOnClick: boolean;
  keyboardFocusRequest: number;
  openSub: () => void;
  openSubWithKeyboard: () => void;
  closeSub: () => void;
  toggleSub: () => void;
  scheduleClose: () => void;
}

const AppMenuSubContext = React.createContext<AppMenuSubContextValue | null>(null);

export function AppMenuSub({ children, openOnClick = false }: AppMenuSubProps) {
  const [open, setOpen] = React.useState(false);
  const [keyboardFocusRequest, setKeyboardFocusRequest] = React.useState(0);
  const triggerRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const closeTimerRef = React.useRef<number | null>(null);
  const subId = React.useId();
  const levelCtx = React.useContext(AppMenuSubLevelContext);

  const clearCloseTimer = React.useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const claimActive = React.useCallback(() => {
    levelCtx?.setActiveSubId(subId);
  }, [levelCtx, subId]);

  const releaseActive = React.useCallback(() => {
    levelCtx?.setActiveSubId((cur) => (cur === subId ? null : cur));
  }, [levelCtx, subId]);

  const openSub = React.useCallback(() => {
    clearCloseTimer();
    claimActive();
    setOpen(true);
  }, [claimActive, clearCloseTimer]);

  const openSubWithKeyboard = React.useCallback(() => {
    clearCloseTimer();
    claimActive();
    setOpen(true);
    setKeyboardFocusRequest((request) => request + 1);
  }, [claimActive, clearCloseTimer]);

  const closeSub = React.useCallback(() => {
    clearCloseTimer();
    releaseActive();
    setOpen(false);
  }, [clearCloseTimer, releaseActive]);

  const toggleSub = React.useCallback(() => {
    clearCloseTimer();
    const next = !open;
    if (next) {
      claimActive();
    } else {
      releaseActive();
    }
    setOpen(next);
  }, [claimActive, clearCloseTimer, open, releaseActive]);

  const scheduleClose = React.useCallback(() => {
    if (openOnClick) return;
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      releaseActive();
      setOpen(false);
      closeTimerRef.current = null;
    }, 120);
  }, [clearCloseTimer, openOnClick, releaseActive]);

  // 同级互斥：另一个同级子菜单成为激活项时，本子菜单立即收合
  const levelActiveSubId = levelCtx?.activeSubId;
  React.useEffect(() => {
    if (!levelCtx) return;
    if (open && levelActiveSubId !== subId) {
      clearCloseTimer();
      setOpen(false);
    }
  }, [clearCloseTimer, levelActiveSubId, levelCtx, open, subId]);

  React.useEffect(() => {
    return () => {
      clearCloseTimer();
    };
  }, [clearCloseTimer]);
  
  return (
    <AppMenuSubContext.Provider value={{
      open,
      setOpen,
      triggerRef,
      contentRef,
      openOnClick,
      keyboardFocusRequest,
      openSub,
      openSubWithKeyboard,
      closeSub,
      toggleSub,
      scheduleClose,
    }}>
      <div 
        className="app-menu-sub"
        onMouseEnter={openOnClick ? undefined : openSub}
        onMouseLeave={openOnClick ? undefined : scheduleClose}
        onBlur={openOnClick ? undefined : scheduleClose}
      >
        {children}
      </div>
    </AppMenuSubContext.Provider>
  );
}

export interface AppMenuSubTriggerProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  disabled?: boolean;
}

export function AppMenuSubTrigger({ icon, children, disabled, className, onClick, onKeyDown, onMouseEnter, ...rest }: AppMenuSubTriggerProps) {
  const subCtx = React.useContext(AppMenuSubContext);
  
  return (
    <div
      ref={subCtx?.triggerRef}
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={subCtx?.open}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      className={cn(
        'app-menu-item app-menu-sub-trigger',
        disabled && 'app-menu-item-disabled',
        className
      )}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        if (event.defaultPrevented) return;
        if (!disabled) {
          if (subCtx?.openOnClick) return;
          subCtx?.openSub();
        }
      }}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || disabled || !subCtx?.openOnClick) return;
        subCtx.toggleSub();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || disabled || !subCtx) return;
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowRight') {
          event.preventDefault();
          event.stopPropagation();
          subCtx.openSubWithKeyboard();
        }
        if (event.key === 'Escape' || event.key === 'ArrowLeft') {
          event.preventDefault();
          event.stopPropagation();
          subCtx.closeSub();
          subCtx.triggerRef.current?.focus({ preventScroll: true });
        }
      }}
      {...rest}
    >
      {icon && <span className="app-menu-item-icon">{icon}</span>}
      <span className="app-menu-item-content">{children}</span>
      <CaretRight className="app-menu-sub-arrow" />
    </div>
  );
}

export type AppMenuSubContentProps = React.HTMLAttributes<HTMLDivElement>;

export function AppMenuSubContent({
  className,
  children,
  onKeyDown,
  onFocusCapture,
  onBlur,
  ...rest
}: AppMenuSubContentProps) {
  const subCtx = React.useContext(AppMenuSubContext);
  const rootMenuCtx = React.useContext(AppMenuContext);
  const [position, setPosition] = React.useState<{ left: number; top: number } | null>(null);

  const getEnabledItems = React.useCallback((): HTMLElement[] => {
    const root = subCtx?.contentRef.current;
    if (!root) return [];
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
      ),
    ).filter(
      (item) =>
        !item.hasAttribute('disabled') &&
        item.getAttribute('aria-disabled') !== 'true',
    );
  }, [subCtx?.contentRef]);

  React.useEffect(() => {
    if (!subCtx?.open || subCtx.keyboardFocusRequest === 0) return undefined;
    const timer = window.setTimeout(() => {
      if (!subCtx.open) return;
      // 键盘展开子菜单时优先聚焦选中项，其次第一项
      const items = getEnabledItems();
      const target = items.find(isCheckedMenuItem) ?? items[0] ?? subCtx.contentRef.current;
      target?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    getEnabledItems,
    subCtx?.contentRef,
    subCtx?.keyboardFocusRequest,
    subCtx?.open,
  ]);

  React.useLayoutEffect(() => {
    if (!subCtx?.open || typeof window === 'undefined') return;

    const updatePosition = () => {
      const triggerEl = subCtx.triggerRef.current;
      const contentEl = subCtx.contentRef.current;
      if (!triggerEl || !contentEl) return;

      const triggerRect = triggerEl.getBoundingClientRect();
      // The submenu has the same animated entry class as its parent menu.
      const contentRect = {
        width: contentEl.offsetWidth,
        height: contentEl.offsetHeight,
      };
      const viewportPadding = 8;
      const gap = 6;

      const fitsRight = triggerRect.right + gap + contentRect.width <= window.innerWidth - viewportPadding;
      const preferredLeft = fitsRight
        ? triggerRect.right + gap
        : triggerRect.left - gap - contentRect.width;
      const maxLeft = Math.max(viewportPadding, window.innerWidth - contentRect.width - viewportPadding);
      const left = Math.min(Math.max(viewportPadding, preferredLeft), maxLeft);

      const preferredTop = triggerRect.top - 4;
      const maxTop = Math.max(viewportPadding, window.innerHeight - contentRect.height - viewportPadding);
      const top = Math.min(Math.max(viewportPadding, preferredTop), maxTop);

      setPosition((prev) => (
        prev && prev.left === left && prev.top === top
          ? prev
          : { left, top }
      ));
    };

    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [subCtx]);

  if (!subCtx?.open) return null;

  const handleSubContentKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const items = getEnabledItems();
    const active = document.activeElement instanceof HTMLElement
      ? document.activeElement.closest<HTMLElement>(
          '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
        )
      : null;
    const index = active ? items.indexOf(active) : -1;
    const checkedIndex = index < 0 ? items.findIndex(isCheckedMenuItem) : -1;
    const focusAt = (next: number) => {
      if (items.length === 0) return;
      const item = items[((next % items.length) + items.length) % items.length];
      item.focus({ preventScroll: true });
      item.scrollIntoView({ block: 'nearest' });
    };

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        focusAt(index < 0 ? (checkedIndex >= 0 ? checkedIndex : 0) : index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        focusAt(index < 0 ? (checkedIndex >= 0 ? checkedIndex : items.length - 1) : index - 1);
        break;
      case 'Home':
        event.preventDefault();
        event.stopPropagation();
        focusAt(0);
        break;
      case 'End':
        event.preventDefault();
        event.stopPropagation();
        focusAt(items.length - 1);
        break;
      case 'ArrowLeft':
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        subCtx.closeSub();
        subCtx.triggerRef.current?.focus({ preventScroll: true });
        break;
      default:
        break;
    }
  };
  
  return createPortal(
    <div
      ref={subCtx.contentRef}
      role="menu"
      tabIndex={-1}
      data-app-menu-id={rootMenuCtx?.menuId}
      data-app-menu-sub-content=""
      className={cn('app-menu-sub-content', className)}
      onMouseEnter={subCtx.openOnClick ? undefined : subCtx.openSub}
      onMouseLeave={subCtx.openOnClick ? undefined : subCtx.scheduleClose}
      onFocusCapture={(event) => {
        onFocusCapture?.(event);
        if (!event.defaultPrevented) subCtx.openSub();
      }}
      onBlur={(event) => {
        onBlur?.(event);
        if (!event.defaultPrevented) subCtx.scheduleClose();
      }}
      onKeyDown={handleSubContentKeyDown}
      style={{
        position: 'fixed',
        left: position?.left ?? 8,
        top: position?.top ?? 8,
        visibility: position ? 'visible' : 'hidden',
      }}
      {...rest}
    >
      <AppMenuSubLevelProvider>
        {children}
      </AppMenuSubLevelProvider>
    </div>,
    document.body
  );
}

// ============ Separator ============

export type AppMenuSeparatorProps = React.HTMLAttributes<HTMLDivElement>;

export function AppMenuSeparator({ className, ...rest }: AppMenuSeparatorProps) {
  return <div className={cn('app-menu-separator', className)} role="separator" {...rest} />;
}

// ============ Label ============

export type AppMenuLabelProps = React.HTMLAttributes<HTMLDivElement>;

export const AppMenuLabel = React.forwardRef<HTMLDivElement, AppMenuLabelProps>(
  ({ className, ...rest }, ref) => (
    <div
      ref={ref}
      className={cn('app-menu-label', className)}
      {...rest}
/>
  )
);
AppMenuLabel.displayName = 'AppMenuLabel';

// ============ Footer ============

export type AppMenuFooterProps = React.HTMLAttributes<HTMLDivElement>;

export function AppMenuFooter({ className, children, ...rest }: AppMenuFooterProps) {
  return (
    <div className={cn('app-menu-footer', className)} {...rest}>
      {children}
    </div>
  );
}

// ============ Switch Item ============

export interface AppMenuSwitchItemProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
}

export function AppMenuSwitchItem({
  icon,
  children,
  checked = false,
  onCheckedChange,
  disabled,
  className,
  onKeyDown,
  ...rest
}: AppMenuSwitchItemProps) {
  return (
    <div
      role="menuitemcheckbox"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      className={cn(
        'app-menu-item app-menu-switch-item',
        disabled && 'app-menu-item-disabled',
        className
      )}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) {
          onCheckedChange?.(!checked);
        }
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onCheckedChange?.(!checked);
        }
      }}
      {...rest}
    >
      {icon && <span className="app-menu-item-icon">{icon}</span>}
      <span className="app-menu-item-content">{children}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        tabIndex={-1}
        className={cn(
          'app-menu-switch',
          checked && 'app-menu-switch-checked'
        )}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) {
            onCheckedChange?.(!checked);
          }
        }}
      >
        <span className="app-menu-switch-thumb" />
      </button>
    </div>
  );
}

// ============ Checkbox Item (复选框菜单项) ============

export interface AppMenuCheckboxItemProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 是否选中 */
  checked?: boolean;
  /** 选中状态变更回调 */
  onCheckedChange?: (checked: boolean) => void;
  /** 是否禁用 */
  disabled?: boolean;
}

export function AppMenuCheckboxItem({
  children,
  checked = false,
  onCheckedChange,
  disabled,
  className,
  onKeyDown,
  ...rest
}: AppMenuCheckboxItemProps) {
  return (
    <div
      role="menuitemcheckbox"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      className={cn(
        'app-menu-item app-menu-checkbox-item',
        checked && 'app-menu-checkbox-item-checked',
        disabled && 'app-menu-item-disabled',
        className
      )}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) {
          onCheckedChange?.(!checked);
        }
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onCheckedChange?.(!checked);
        }
      }}
      {...rest}
    >
      <span className={cn(
        'w-4 h-4 mr-2 flex items-center justify-center rounded',
        'border border-muted-foreground/40 transition-colors',
        checked && 'bg-primary border-primary',
        disabled && 'opacity-50'
      )}>
        {checked && (
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            className="text-primary-foreground"
          >
            <path
              d="M10 3L4.5 8.5L2 6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
/>
          </svg>
        )}
      </span>
      <span className="app-menu-item-content flex-1">{children}</span>
    </div>
  );
}

// ============ Option Group (类似字体选择器) ============

export interface AppMenuOptionItem {
  value: string;
  label: React.ReactNode;
  description?: string;
}

export interface AppMenuOptionGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  options: AppMenuOptionItem[];
  value?: string;
  onValueChange?: (value: string) => void;
}

export function AppMenuOptionGroup({
  options,
  value,
  onValueChange,
  className,
  ...rest
}: AppMenuOptionGroupProps) {
  return (
    <div className={cn('app-menu-option-group', className)} role="group" {...rest}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemradio"
          tabIndex={-1}
          aria-checked={value === option.value}
          className={cn(
            'app-menu-option-item',
            value === option.value && 'app-menu-option-item-selected'
          )}
          onClick={() => onValueChange?.(option.value)}
        >
          <span className="app-menu-option-label">{option.label}</span>
          {option.description && (
            <span className="app-menu-option-description">{option.description}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// ============ Keyboard Shortcut Display ============

export type AppMenuShortcutProps = React.HTMLAttributes<HTMLSpanElement>;

export function AppMenuShortcut({ className, ...rest }: AppMenuShortcutProps) {
  return (
    <span className={cn('app-menu-shortcut', className)} {...rest} />
  );
}

// ============ Export All ============

export {
  AppMenu as Root,
  AppMenuTrigger as Trigger,
  AppMenuContent as Content,
  AppMenuGroup as Group,
  AppMenuItem as Item,
  AppMenuSub as Sub,
  AppMenuSubTrigger as SubTrigger,
  AppMenuSubContent as SubContent,
  AppMenuSeparator as Separator,
  AppMenuLabel as Label,
  AppMenuFooter as Footer,
  AppMenuSwitchItem as SwitchItem,
  AppMenuOptionGroup as OptionGroup,
  AppMenuShortcut as Shortcut,
};
