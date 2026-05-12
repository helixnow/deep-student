import { cn } from "@/lib/utils";

type SidebarUpdateBadgeProps = {
  className?: string;
};

export function SidebarUpdateBadge({ className }: SidebarUpdateBadgeProps) {
  return (
    <span
      data-slot="sidebar-update-badge"
      className={cn(
        "inline-flex h-6 items-center rounded-full border border-transparent bg-primary px-2 text-xs font-medium leading-none text-primary-foreground",
        className,
      )}
    >
      更新
    </span>
  );
}
