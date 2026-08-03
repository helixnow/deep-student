import { cn } from '@/lib/utils';

type SidebarStudyRowVariant = 'session' | 'section';

interface SidebarStudyRowClassOptions {
  variant: SidebarStudyRowVariant;
  selected?: boolean;
  clickable?: boolean;
  draggable?: boolean;
  dragging?: boolean;
  className?: string;
}

export function getSidebarStudyRowClassName({
  variant,
  selected = false,
  clickable = true,
  draggable = false,
  dragging = false,
  className,
}: SidebarStudyRowClassOptions): string {
  const sharedRowClasses = 'group flex min-h-[2.75rem] w-full min-w-0 shrink-0 items-center rounded-2xl border border-transparent px-2.5 py-1.5 transition-[background-color,color,box-shadow] duration-150';

  if (variant === 'section') {
    return cn(
      sharedRowClasses,
      'group/sidebar-section justify-between',
      clickable && 'cursor-pointer hover:bg-[var(--sidebar-study-hover)]',
      selected
        ? 'bg-[var(--sidebar-study-selected)] text-foreground hover:bg-[var(--sidebar-study-selected)]'
        : 'text-foreground/80 hover:text-foreground',
      className,
    );
  }

  return cn(
    sharedRowClasses,
    'gap-2.5 cursor-pointer',
    draggable && 'cursor-grab active:cursor-grabbing',
    selected
      ? 'bg-[var(--sidebar-study-selected)] text-foreground hover:bg-[var(--sidebar-study-selected)]'
      : 'text-foreground/80 hover:text-foreground hover:bg-[var(--sidebar-study-hover)]',
    dragging && 'shadow-lg ring-1 ring-border bg-card z-50',
    className,
  );
}
