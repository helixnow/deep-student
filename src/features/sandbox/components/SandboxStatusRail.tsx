import React from 'react';
import { SidebarSimple } from '@phosphor-icons/react';

import { NotionButton } from '@/components/ui/NotionButton';

interface SandboxStatusRailProps {
  onOpenInspector: () => void;
}

export function SandboxStatusRail({ onOpenInspector }: SandboxStatusRailProps) {
  return (
    <aside className="flex h-full w-full flex-col items-stretch gap-3 border-l border-border bg-[color:var(--shell-inspector-panel)] px-2 py-3">
      <div className="px-1">
        <span className="block text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          预览
        </span>
      </div>
      <NotionButton
        variant="ghost"
        size="icon"
        iconOnly
        onClick={onOpenInspector}
        title="展开"
        aria-label="展开"
        className="!h-8 !w-8 !p-0"
      >
        <SidebarSimple size={16} />
      </NotionButton>
    </aside>
  );
}

export default SandboxStatusRail;
