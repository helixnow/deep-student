import React from 'react';
import { CaretRight } from '@phosphor-icons/react';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/lib/utils';

export const WorkbenchSidebarSurface = React.forwardRef<HTMLElement, Omit<React.HTMLAttributes<HTMLElement>, 'aria-label'> & {
  ariaLabel: string;
}>(function WorkbenchSidebarSurface({
  children,
  ariaLabel,
  className,
  ...props
}, ref) {
  return (
    <aside
      ref={ref}
      role="navigation"
      aria-label={ariaLabel}
      data-workbench-sidebar
      data-shell-layer="navigation"
      data-shell-surface="navigation"
      className={cn(
        'font-sidebar-study-ui relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-[color:var(--shell-navigation-surface)] text-[color:var(--shell-navigation-foreground)]',
        className,
      )}
      {...props}
    >
      {children}
    </aside>
  );
});

export function WorkbenchSidebarFixed({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-workbench-sidebar-fixed className={cn('shrink-0 px-2 pb-2 pt-0.5', className)} {...props}>{children}</div>;
}

export function WorkbenchSidebarScroll({ children, className }: React.PropsWithChildren<{ className?: string }>) {
  return (
    <div className="min-h-0 flex-1 w-full">
      <CustomScrollArea
        className={cn('desktop-shell-sidebar-session-scroll min-h-0 flex-1 w-full', className)}
        scrollAutoHide="scroll"
        scrollAutoHideSuspend={false}
        viewportClassName="h-full w-full"
        viewportProps={{
          'data-workbench-sidebar-scroll': true,
          'data-sidebar-scroll-region': 'sessions',
        } as React.HTMLAttributes<HTMLDivElement>}
      >
        {children}
      </CustomScrollArea>
    </div>
  );
}

export function WorkbenchSidebarRowLabel({ children }: React.PropsWithChildren) {
  return <span className="desktop-shell-sidebar-row-title block min-w-0 flex-1 truncate leading-4">{children}</span>;
}

export function WorkbenchSidebarRow({
  rowType = 'nav',
  isActive = false,
  className,
  style,
  leftSlot,
  rightSlot,
  depth = 0,
  children,
  ...buttonProps
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  rowType?: 'nav' | 'thread';
  isActive?: boolean;
  leftSlot?: React.ReactNode;
  rightSlot?: React.ReactNode;
  depth?: number;
}) {
  return (
    <DsButton
      variant="nav"
      size="md"
      data-workbench-sidebar-row={rowType}
      className={cn(
        'desktop-shell-sidebar-row',
        rowType === 'thread' ? 'desktop-shell-thread-row' : 'desktop-shell-nav-row',
        '!w-full !justify-start !px-2.5 !py-1.5 text-left',
        isActive && (rowType === 'thread' ? 'desktop-shell-thread-row--active' : 'desktop-shell-nav-row--active'),
        className,
      )}
      {...buttonProps}
      style={{
        ...style,
        ...(depth ? { paddingLeft: `${10 + depth * 16}px` } : null),
      }}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <span className="flex w-4 shrink-0 items-center justify-center text-[color:inherit]">{leftSlot}</span>
        <span className="min-w-0 flex-1">{children}</span>
        <span className="flex min-w-[24px] shrink-0 items-center justify-end gap-0.5">{rightSlot}</span>
      </span>
    </DsButton>
  );
}

export function WorkbenchSidebarSectionHeader({
  label,
  collapsed,
  onToggle,
  action,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="group/sidebar-top-section flex items-center justify-between gap-2 px-2">
      <DsButton variant="ghost" size="sm" className="!h-auto !min-h-0 min-w-0 flex-1 !justify-start gap-1 rounded-md !px-1 !py-0.5 text-left text-[color:var(--shell-navigation-muted)] outline-none transition-colors hover:text-[color:var(--shell-navigation-foreground)] focus-visible:ring-2 focus-visible:ring-ring" aria-label={label} aria-expanded={!collapsed} onClick={onToggle}>
        <span className="desktop-shell-nav-section-label min-w-0 truncate">{label}</span>
        <CaretRight className={cn('size-3 shrink-0 opacity-0 transition-[opacity,transform] group-hover/sidebar-top-section:opacity-100 group-focus-within/sidebar-top-section:opacity-100', !collapsed && 'rotate-90')} strokeWidth={2.25} />
      </DsButton>
      {action}
    </div>
  );
}
