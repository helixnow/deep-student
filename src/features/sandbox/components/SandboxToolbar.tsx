import React from 'react';
import { ArrowClockwise, SidebarSimple, X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation('workbench');
  // 触屏（coarse 指针）下图标按钮放大到 ≥40px 触控目标
  const iconBtnClass = '!h-8 !w-8 !p-0 [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10';
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
          title={t('sandbox.refresh')}
          aria-label={t('sandbox.refresh')}
          className={iconBtnClass}
        >
          <ArrowClockwise size={16} />
        </NotionButton>
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={onToggleInspector}
          title={inspectorOpen ? t('sandbox.closeInspector') : t('sandbox.openInspector')}
          aria-label={inspectorOpen ? t('sandbox.closeInspector') : t('sandbox.openInspector')}
          className={iconBtnClass}
        >
          <SidebarSimple size={16} />
        </NotionButton>
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={onClose}
          title={t('sandbox.close')}
          aria-label={t('sandbox.close')}
          className={iconBtnClass}
        >
          <X size={16} />
        </NotionButton>
      </div>
    </header>
  );
}

export default SandboxToolbar;
