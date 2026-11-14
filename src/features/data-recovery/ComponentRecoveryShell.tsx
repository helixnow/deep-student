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
import { useComponentReasonText } from '@/components/system-status/useComponentReasonText';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/shad/Tabs';
import { getMobileShellCssVars } from '@/app/shell/mobileShell';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { isMobilePlatform } from '@/utils/platform';
import type { StartupComponentIssue } from '@/stores/systemStatusStore';
import { exportStartupRecoveryReport, retryRecoveryStartup } from './dataRecoveryApi';
import { describeComponentRecovery, type ComponentRecoveryDescription } from './recoveryDescription';

const RECOVERY_TABS = ['status', 'next'] as const;

const DESCRIPTION_KEYS = {
  kept: 'data:recovery.component_recovery_description',
  restored: 'data:recovery.component_recovery_description_restored',
  removed: 'data:recovery.component_recovery_description_removed',
  restore_failed: 'data:recovery.component_recovery_description_restore_failed',
  mixed: 'data:recovery.component_recovery_description_mixed',
} as const satisfies Record<ComponentRecoveryDescription, string>;
type RecoveryTab = (typeof RECOVERY_TABS)[number];

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
  const reasonText = useComponentReasonText();
  const affected = components.filter((component) => component.status !== 'healthy');
  const healthy = components.filter((component) => component.status === 'healthy');
  const [exportError, setExportError] = useState<string | null>(null);
  const [tab, setTab] = useState<RecoveryTab>('status');
  // 对齐 App.tsx 标题栏契约：窗口控制与拖拽区仅在桌面平台且非小屏渲染，
  // 移动端顶栏只保留标题并避让系统安全区。
  const { isSmallScreen } = useBreakpoint();
  const showDesktopWindowChrome = !isMobilePlatform() && !isSmallScreen;
  const dragRegion = showDesktopWindowChrome ? true : undefined;

  return (
    <div
      className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground"
      // 恢复壳挂载在 App shell 之外，--mobile-safe-area-* 需在本树根部自行定义
      style={getMobileShellCssVars() as React.CSSProperties}
    >
      <header
        data-tauri-drag-region={dragRegion}
        className="flex shrink-0 items-center border-b border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-panel)] px-4"
        style={{
          paddingTop: 'var(--mobile-safe-area-top, env(safe-area-inset-top, 0px))',
          height: 'calc(3rem + var(--mobile-safe-area-top, env(safe-area-inset-top, 0px)))',
        }}
      >
        <div data-tauri-drag-region={dragRegion} className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
          <span>{t('data:recovery.shell_title')}</span>
          {debugPreview && (
            <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
              {t('data:recovery.debug_preview_badge')}
            </span>
          )}
        </div>
        {debugPreview && (
          <DsButton className="mr-2 [@media(pointer:coarse)]:!min-h-11" size="sm" variant="ghost" onClick={onDebugExit}>
            {t('data:recovery.debug_exit_preview')}
          </DsButton>
        )}
        {showDesktopWindowChrome && <WindowControls />}
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
                  {/* RUST-FIX(RF-W09-recovery-description-by-outcome): Rust 版无论恢复做了什么都写“数据文件仍在原位置，没有被当作空数据覆盖” */}
                  {t(DESCRIPTION_KEYS[describeComponentRecovery(affected)])}
                </p>
              </div>
            </div>
          </div>

          <Tabs value={tab} onValueChange={(value) => setTab(value as RecoveryTab)} className="mt-6">
            {/* RUST-FIX(RF-W09-recovery-shell-tab-roles): Rust 版两个标签是普通 button，没有 tablist/tab/aria-selected，读屏软件不知道哪个被选中（语义与方向键现由共享 Tabs 提供） */}
            <TabsList aria-orientation="horizontal" aria-label={t('data:recovery.component_recovery_title')}>
              {RECOVERY_TABS.map((value) => (
                <TabsTrigger key={value} value={value}>
                  {t(value === 'status' ? 'data:recovery.component_tab_status' : 'data:recovery.component_tab_next')}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="status" tabIndex={0}>
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
                          {reasonText(component.reason) ?? t('data:recovery.component_unknown_reason')}
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

            <TabsContent value="next" tabIndex={0}>
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
                        className="[@media(pointer:coarse)]:!min-h-11"
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
                        className="[@media(pointer:coarse)]:!min-h-11"
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
