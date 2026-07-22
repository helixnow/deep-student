import React, { useState } from 'react';
import {
  ArrowClockwise,
  CheckCircle,
  Database,
  Export,
  ShieldCheck,
  Warning,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { WindowControls } from '@/components/WindowControls';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { DsButton } from '@/components/ui/DsButton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/shad/Tabs';
import type { StartupComponentIssue } from '@/stores/systemStatusStore';
import { exportStartupRecoveryReport, retryRecoveryStartup } from './dataRecoveryApi';

interface ComponentRecoveryShellProps {
  components: StartupComponentIssue[];
  debugPreview?: boolean;
  onDebugExit?: () => void;
}

export const ComponentRecoveryShell: React.FC<ComponentRecoveryShellProps> = ({
  components,
  debugPreview = false,
  onDebugExit,
}) => {
  const { t } = useTranslation(['data']);
  const affected = components.filter((component) => component.status !== 'healthy');
  const healthy = components.filter((component) => component.status === 'healthy');
  const [exportError, setExportError] = useState<string | null>(null);

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header
        data-tauri-drag-region
        className="flex h-12 shrink-0 items-center border-b border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel)] px-4"
      >
        <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
          <span>{t('data:recovery.shell_title')}</span>
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
        <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
          <div className="rounded-[var(--radius-shell-panel)] border border-warning/30 bg-warning/5 p-5">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning/10 text-warning">
                <ShieldCheck size={21} weight="fill" />
              </div>
              <div>
                <h1 className="text-xl font-semibold tracking-tight">
                  {t('data:recovery.component_recovery_title')}
                </h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {t('data:recovery.component_recovery_description')}
                </p>
              </div>
            </div>
          </div>

          <Tabs defaultValue="status" className="mt-6">
            <TabsList>
              <TabsTrigger value="status">{t('data:recovery.component_tab_status')}</TabsTrigger>
              <TabsTrigger value="next">{t('data:recovery.component_tab_next')}</TabsTrigger>
            </TabsList>

            <TabsContent value="status">
              <div className="space-y-3">
                {affected.map((component) => (
                  <div
                    key={component.component}
                    className="rounded-[var(--radius-shell-panel)] border border-warning/25 bg-[color:var(--surface-panel)] p-4"
                  >
                    <div className="flex items-start gap-3">
                      <Database className="mt-0.5 shrink-0 text-warning" size={18} />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">{component.component}</span>
                          <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                            {component.status}
                          </span>
                        </div>
                        <p className="mt-1 break-words text-sm leading-6 text-muted-foreground">
                          {component.reason || t('data:recovery.component_unknown_reason')}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}

                {healthy.length > 0 && (
                  <div className="rounded-[var(--radius-shell-panel)] border border-success/25 bg-success/5 p-4">
                    <div className="flex items-center gap-2 text-sm font-medium text-success">
                      <CheckCircle size={17} weight="fill" />
                      {t('data:recovery.component_healthy_preserved', { count: healthy.length })}
                    </div>
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="next">
              <div className="rounded-[var(--radius-shell-panel)] border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel)] p-5">
                <div className="flex items-start gap-3">
                  <Warning className="mt-0.5 shrink-0 text-warning" size={18} />
                  <div>
                    <h2 className="text-sm font-semibold">
                      {t('data:recovery.component_next_title')}
                    </h2>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {t('data:recovery.component_next_description')}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <DsButton
                        onClick={() => {
                          if (debugPreview) {
                            onDebugExit?.();
                          } else {
                            void retryRecoveryStartup();
                          }
                        }}
                      >
                        <ArrowClockwise size={16} className="mr-1.5" />
                        {t('data:recovery.retry_startup')}
                      </DsButton>
                      {!debugPreview && <DsButton
                        variant="secondary"
                        onClick={() => {
                          setExportError(null);
                          void exportStartupRecoveryReport().catch((error) => {
                            setExportError(error instanceof Error ? error.message : String(error));
                          });
                        }}
                      >
                        <Export size={16} className="mr-1.5" />
                        {t('data:recovery.export_diagnostic')}
                      </DsButton>}
                    </div>
                    {exportError && (
                      <p className="mt-3 break-words text-sm text-destructive">{exportError}</p>
                    )}
                  </div>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </main>
      </CustomScrollArea>
    </div>
  );
};

export default ComponentRecoveryShell;
