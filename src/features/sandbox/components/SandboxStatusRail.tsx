import React from 'react';
import { SidebarSimple } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { DsButton } from '@/components/ui/DsButton';

interface SandboxStatusRailProps {
  onOpenInspector: () => void;
}

export function SandboxStatusRail({ onOpenInspector }: SandboxStatusRailProps) {
  const { t } = useTranslation('workbench');
  return (
    <aside className="flex h-full w-full flex-col items-stretch gap-3 border-l border-border bg-[color:var(--shell-inspector-panel)] px-2 py-3">
      <div className="px-1">
        <span className="block text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {t('sandbox.preview')}
        </span>
      </div>
      <DsButton
        variant="ghost"
        size="icon"
        iconOnly
        onClick={onOpenInspector}
        title={t('sandbox.expand')}
        aria-label={t('sandbox.expand')}
        className="!h-8 !w-8 !p-0"
      >
        <SidebarSimple size={16} />
      </DsButton>
    </aside>
  );
}

export default SandboxStatusRail;
