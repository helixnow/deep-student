import React from 'react';
import { ArrowClockwise, SidebarSimple, X } from '@phosphor-icons/react';

import { NotionButton } from '@/components/ui/NotionButton';

interface SandboxToolbarProps {
  title: string;
  subtitle?: string;
  meta?: string;
  inspectorOpen: boolean;
  onReload: () => void;
  onToggleInspector: () => void;
  onClose: () => void;
}

export function SandboxToolbar({
  title,
  subtitle,
  meta,
  inspectorOpen,
  onReload,
  onToggleInspector,
  onClose,
}: SandboxToolbarProps) {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-border/70 px-5 py-4">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[1.05rem] font-semibold text-foreground">{title}</h1>
        {subtitle ? (
          <p className="mt-1 truncate text-[11px] text-muted-foreground">{subtitle}</p>
        ) : null}
        {meta ? (
          <p className="mt-1 text-[11px] text-muted-foreground">{meta}</p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={onReload}
          title="刷新"
          aria-label="刷新"
          className="!h-8 !w-8 !p-0"
        >
          <ArrowClockwise size={16} />
        </NotionButton>
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={onToggleInspector}
          title={inspectorOpen ? '收起检查器' : '打开检查器'}
          aria-label={inspectorOpen ? '收起检查器' : '打开检查器'}
          className="!h-8 !w-8 !p-0"
        >
          <SidebarSimple size={16} />
        </NotionButton>
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
          className="!h-8 !w-8 !p-0"
        >
          <X size={16} />
        </NotionButton>
      </div>
    </header>
  );
}

export default SandboxToolbar;
