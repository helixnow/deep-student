import { cn } from '@/lib/utils';

/** 移动统一抽屉 section 标题 — 与 ModernSidebar / TodoSidebar 同源 */
export const mobileDrawerSectionLabelClassName =
  'desktop-shell-nav-section-label mb-1 block min-w-0 truncate px-3 pt-1';

/** 主导航行 — 对齐 ModernSidebar `desktop-shell-nav-row` */
export function mobileDrawerNavRowClassName(isActive?: boolean, className?: string) {
  return cn(
    'desktop-shell-sidebar-row desktop-shell-nav-row inline-flex min-h-[2.75rem] w-full min-w-0 shrink-0 appearance-none items-center overflow-hidden whitespace-nowrap border border-transparent bg-transparent text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring select-none',
    '!w-full !justify-start !px-2.5 !py-1.5',
    isActive && 'desktop-shell-nav-row--active',
    className,
  );
}

/** 会话/文件夹行 — 对齐 ModernSidebar `desktop-shell-thread-row` */
export function mobileDrawerThreadRowClassName(isActive?: boolean, className?: string) {
  return cn(
    'desktop-shell-sidebar-row desktop-shell-thread-row inline-flex min-h-[2.75rem] w-full min-w-0 shrink-0 appearance-none items-center overflow-hidden whitespace-nowrap border border-transparent bg-transparent text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring select-none',
    '!w-full !justify-start !px-2.5 !py-1.5',
    isActive && 'desktop-shell-thread-row--active',
    className,
  );
}

export const mobileDrawerRowTitleClassName = 'desktop-shell-sidebar-row-title min-w-0 flex-1 truncate';

export const mobileDrawerRowIconWrapClassName =
  'flex w-[18px] shrink-0 items-center justify-center text-[color:inherit] [&_svg]:size-[18px]';
