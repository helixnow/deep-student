import React from 'react';
import { SidebarSimple, X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { DsButton } from '@/components/ui/DsButton';

interface SandboxToolbarProps {
  title: string;
  subtitle?: string;
  meta?: string;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onClose: () => void;
  /** 宿主全局顶栏已挂载检查器开关时隐藏工具栏内重复按钮 */
  hideInspectorToggle?: boolean;
}

export function SandboxToolbar({
  title,
  subtitle,
  meta,
  inspectorOpen,
  onToggleInspector,
  onClose,
  hideInspectorToggle = false,
}: SandboxToolbarProps) {
  const { t } = useTranslation('workbench');
  // DsButton iconOnly 已内建 coarse 指针 ≥44px 触控目标
  const iconBtnClass = '!h-8 !w-8 !p-0';
  return (
    <header className="flex items-center justify-between gap-4 border-b border-border/70 px-5 py-4">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-semibold text-foreground">{title}</h1>
        {subtitle ? (
          <p className="mt-1 truncate text-xs text-muted-foreground">{subtitle}</p>
        ) : null}
        {meta ? (
          <p className="mt-1 text-xs text-muted-foreground">{meta}</p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        {!hideInspectorToggle && (
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={onToggleInspector}
            title={inspectorOpen ? t('sandbox.closeInspector') : t('sandbox.openInspector')}
            aria-label={inspectorOpen ? t('sandbox.closeInspector') : t('sandbox.openInspector')}
            className={iconBtnClass}
          >
            <SidebarSimple size={16} />
          </DsButton>
        )}
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={onClose}
          title={t('sandbox.close')}
          aria-label={t('sandbox.close')}
          className={iconBtnClass}
        >
          <X size={16} />
        </DsButton>
      </div>
    </header>
  );
}

export default SandboxToolbar;
