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
import { ChevronRight, Search, Check } from 'lucide-react';
import { CustomScrollArea } from '../../custom-scroll-area';
import './AppMenu.css';

// ============ Context ============

interface AppMenuContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLDivElement>;
  contentRef: React.RefObject<HTMLDivElement>;
  mode: 'dropdown' | 'context';
  position: { x: number; y: number };
  setPosition: (pos: { x: number; y: number }) => void;
}

const AppMenuContext = React.createContext<AppMenuContextValue | null>(null);

// ============ Root Component ============

export interface AppMenuProps {
  /** 受控模式的开关状态 */
  open?: boolean;
  /** 开关状态变化回调 */
  onOpenChange?: (open: boolean) => void;
  /** 菜单模式：dropdown (下拉) 或 context (右键) */
  mode?: 'dropdown' | 'context';
  children: React.ReactNode;
}

export function AppMenu({ open, onOpenChange, mode = 'dropdown', children }: AppMenuProps) {
  const isControlled = open !== undefined;
  const [internalOpen, setInternalOpen] = React.useState(false);
  const [position, setPosition] = React.useState({ x: 0, y: 0 });
  const actualOpen = isControlled ? !!open : internalOpen;

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange]
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
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
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
    <AppMenuContext.Provider value={{ open: actualOpen, setOpen, triggerRef: containerRef, contentRef, mode, position, setPosition }}>
      <div ref={containerRef} className="app-menu-root relative inline-flex">
        {children}
      </div>
    </AppMenuContext.Provider>
  );
}

// ============ Trigger ============

export interface AppMenuTriggerProps {
  asChild?: boolean;
  children: React.ReactNode;
}

export function AppMenuTrigger({ asChild, children }: AppMenuTriggerProps) {
  const ctx = React.useContext(AppMenuContext);
  const Comp = asChild ? Slot : 'button';
  
  if (!ctx) return <>{children}</>;

  const handleClick = (e: React.MouseEvent) => {
    if (ctx.mode === 'dropdown') {
      ctx.setOpen(!ctx.open);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (ctx.mode === 'context') {
      e.preventDefault();
      ctx.setPosition({ x: e.clientX, y: e.clientY });
      ctx.setOpen(true);
    }
  };

  return (
    <Comp
      type={asChild ? undefined : 'button'}
      aria-haspopup="menu"
      aria-expanded={ctx.open}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      className="app-menu-trigger"
    >
      {children}
    </Comp>
  );
}

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
  ...rest
}: AppMenuContentProps) {
  const ctx = React.useContext(AppMenuContext);
  const { t } = useTranslation('app_menu');
  const [position, setPosition] = React.useState<{ top: number; left: number; origin: 'top' | 'bottom' }>({ top: 0, left: 0, origin: 'top' });
  const [internalSearchValue, setInternalSearchValue] = React.useState('');
  const fallbackContentRef = React.useRef<HTMLDivElement | null>(null);
  const contentRef = ctx?.contentRef ?? fallbackContentRef;
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const isOpen = !!ctx?.open;
  const resolvedSearchPlaceholder = searchPlaceholder || t('app_menu.search.placeholder');

  const actualSearchValue = searchValue !== undefined ? searchValue : internalSearchValue;
  const handleSearchChange = (value: string) => {
    if (onSearchChange) {
      onSearchChange(value);
    } else {
      setInternalSearchValue(value);
    }
  };

  React.useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    if (!isOpen) return;
    
    const updatePosition = () => {
      const contentEl = contentRef.current;
      if (!contentEl) return;

      const contentRect = contentEl.getBoundingClientRect();
      const gap = 6;
      let top: number;
      let left: number;
      let origin: 'top' | 'bottom' = 'top';

      if (ctx?.mode === 'context') {
        // 右键菜单模式：使用鼠标位置
        top = ctx.position.y;
        left = ctx.position.x;
      } else {
        // 下拉菜单模式：使用触发器位置
        const triggerEl = ctx?.triggerRef.current;
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

      setPosition({ top, left, origin });
    };

    const rafId = requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [align, ctx, isOpen]);

  // 自动聚焦搜索框
  React.useEffect(() => {
    if (isOpen && showSearch && searchInputRef.current) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [isOpen, showSearch]);

  if (!ctx || !isOpen) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={contentRef}
      role="menu"
      tabIndex={-1}
      className={cn(
        'app-menu-content',
        position.origin === 'bottom' ? 'app-menu-origin-bottom' : 'app-menu-origin-top',
        className
      )}
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        width: width,
        ...(maxHeight ? { maxHeight, display: 'flex', flexDirection: 'column' as const, overflow: 'hidden' } : {}),
        ...style,
      }}
      {...rest}
    >
      {showSearch && (
        <div className="app-menu-search" style={{ flexShrink: 0 }}>
          <Search className="app-menu-search-icon" />
          <input
            ref={searchInputRef}
            type="text"
            className="app-menu-search-input"
            placeholder={resolvedSearchPlaceholder}
            value={actualSearchValue}
            onChange={(e) => handleSearchChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
      {maxHeight ? (
        <CustomScrollArea style={{ flex: 1, minHeight: 0 }}>
          {children}
        </CustomScrollArea>
      ) : (
        children
      )}
    </div>,
    document.body
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
  ({ className, icon, children, shortcut, destructive, disabled, checked, suffix, onClick, ...rest }, ref) => {
    const ctx = React.useContext(AppMenuContext);
    
    return (
      <button
        ref={ref}
        role="menuitem"
        disabled={disabled}
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
        {checked !== undefined && (
          <span className="app-menu-item-check">
            {checked && <Check className="w-4 h-4" />}
          </span>
        )}
        <span className="app-menu-item-content">{children}</span>
        {suffix && <span className="app-menu-item-suffix">{suffix}</span>}
        {shortcut && <span className="app-menu-item-shortcut">{shortcut}</span>}
      </button>
    );
  }
);
AppMenuItem.displayName = 'AppMenuItem';

// ============ SubMenu ============

export interface AppMenuSubProps {
  children: React.ReactNode;
}

interface AppMenuSubContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const AppMenuSubContext = React.createContext<AppMenuSubContextValue | null>(null);

export function AppMenuSub({ children }: AppMenuSubProps) {
  const [open, setOpen] = React.useState(false);
  
  return (
    <AppMenuSubContext.Provider value={{ open, setOpen }}>
      <div 
        className="app-menu-sub"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
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

export function AppMenuSubTrigger({ icon, children, disabled, className, ...rest }: AppMenuSubTriggerProps) {
  const subCtx = React.useContext(AppMenuSubContext);
  
  return (
    <div
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={subCtx?.open}
      className={cn(
        'app-menu-item app-menu-sub-trigger',
        disabled && 'app-menu-item-disabled',
        className
      )}
      {...rest}
    >
      {icon && <span className="app-menu-item-icon">{icon}</span>}
      <span className="app-menu-item-content">{children}</span>
      <ChevronRight className="app-menu-sub-arrow" />
    </div>
  );
}

export interface AppMenuSubContentProps extends React.HTMLAttributes<HTMLDivElement> {}

export function AppMenuSubContent({ className, children, ...rest }: AppMenuSubContentProps) {
  const subCtx = React.useContext(AppMenuSubContext);
  
  if (!subCtx?.open) return null;
  
  return (
    <div
      role="menu"
      className={cn('app-menu-sub-content', className)}
      {...rest}
    >
      {children}
    </div>
  );
}

// ============ Separator ============

export interface AppMenuSeparatorProps extends React.HTMLAttributes<HTMLDivElement> {}

export function AppMenuSeparator({ className, ...rest }: AppMenuSeparatorProps) {
  return <div className={cn('app-menu-separator', className)} role="separator" {...rest} />;
}

// ============ Label ============

export interface AppMenuLabelProps extends React.HTMLAttributes<HTMLDivElement> {}

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

export interface AppMenuFooterProps extends React.HTMLAttributes<HTMLDivElement> {}

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
  ...rest
}: AppMenuSwitchItemProps) {
  return (
    <div
      role="menuitemcheckbox"
      aria-checked={checked}
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
      {...rest}
    >
      {icon && <span className="app-menu-item-icon">{icon}</span>}
      <span className="app-menu-item-content">{children}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
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
  ...rest
}: AppMenuCheckboxItemProps) {
  return (
    <div
      role="menuitemcheckbox"
      aria-checked={checked}
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

export interface AppMenuShortcutProps extends React.HTMLAttributes<HTMLSpanElement> {}

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
