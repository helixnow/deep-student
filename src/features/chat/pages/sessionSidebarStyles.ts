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
  if (variant === 'section') {
    return cn(
      'group/sidebar-section flex items-center justify-between px-3 py-1.5 rounded-2xl transition-colors',
      clickable && 'cursor-pointer hover:bg-[var(--sidebar-study-hover)]',
      className,
    );
  }

  return cn(
    'group mx-1 flex items-start gap-2.5 rounded-2xl border border-transparent px-3 py-2 cursor-pointer transition-[background-color,color,box-shadow] duration-150',
    draggable && 'cursor-grab active:cursor-grabbing',
    selected
      ? 'bg-[var(--sidebar-study-selected)] text-foreground hover:bg-[var(--sidebar-study-selected)]'
      : 'text-foreground/80 hover:text-foreground hover:bg-[var(--sidebar-study-hover)]',
    dragging && 'shadow-lg ring-1 ring-border bg-card z-50',
    className,
  );
}
