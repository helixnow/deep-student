import React from 'react';
import { CircleNotch, ShieldChevron } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

export const StartupPreflight: React.FC = () => {
  const { t } = useTranslation(['data']);

  return (
    <div className="flex h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-sm items-center gap-3 rounded-[var(--radius-shell-panel)] border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel)] px-5 py-4 shadow-[var(--shadow-shell-soft)]">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <ShieldChevron size={18} weight="fill" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium">{t('data:recovery.preflight_title')}</div>
          <div className="mt-0.5 flex items-center text-xs text-muted-foreground">
            <CircleNotch className="mr-1.5 animate-spin" size={13} />
            {t('data:recovery.preflight_description')}
          </div>
        </div>
      </div>
    </div>
  );
};

export default StartupPreflight;
