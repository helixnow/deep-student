import React from 'react';
import { ShieldChevron } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { CustomScrollArea } from '@/components/custom-scroll-area';
import { WindowControls } from '@/components/WindowControls';
import { DsButton } from '@/components/ui/DsButton';
import type { StartupRecoveryStatus } from './dataRecoveryApi';
import { RecoveryCenter } from './RecoveryCenter';

interface RecoveryShellProps {
  status: StartupRecoveryStatus;
  debugPreview?: boolean;
  onDebugExit?: () => void;
}

export const RecoveryShell: React.FC<RecoveryShellProps> = ({
  status,
  debugPreview = false,
  onDebugExit,
}) => {
  const { t } = useTranslation(['data']);

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header
        data-tauri-drag-region
        className="flex h-12 shrink-0 items-center border-b border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel)] px-4"
      >
        <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-shell-control)] bg-primary/10 text-primary">
            <ShieldChevron size={16} weight="fill" />
          </div>
          <div data-tauri-drag-region className="truncate text-sm font-semibold">
            {t('data:recovery.shell_title')}
          </div>
          {debugPreview && (
            <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
              {t('data:recovery.debug_preview_badge')}
            </span>
          )}
        </div>
        {debugPreview && (
          <DsButton className="mr-2" size="sm" variant="ghost" onClick={onDebugExit}>
            {t('data:recovery.debug_exit_preview')}
          </DsButton>
        )}
        <WindowControls />
      </header>

      <CustomScrollArea className="min-h-0 flex-1">
        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
          <div className="mb-7 max-w-3xl">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
              {t('data:recovery.eyebrow')}
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              {t('data:recovery.startup_title')}
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground sm:text-base">
              {t('data:recovery.startup_description')}
            </p>
          </div>

          <RecoveryCenter
            mode="startup"
            initialStatus={status}
            debugPreview={debugPreview}
            onDebugExit={onDebugExit}
          />
        </main>
      </CustomScrollArea>
    </div>
  );
};

export default RecoveryShell;
