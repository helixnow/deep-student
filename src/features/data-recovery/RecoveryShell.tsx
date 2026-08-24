import React from 'react';
import { ShieldChevron } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { CustomScrollArea } from '@/components/custom-scroll-area';
import { WindowControls } from '@/components/WindowControls';
import { DsButton } from '@/components/ui/DsButton';
import { getMobileShellCssVars } from '@/app/shell/mobileShell';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { isMobilePlatform } from '@/utils/platform';
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
        <div data-tauri-drag-region={dragRegion} className="flex min-w-0 flex-1 items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-shell-control)] bg-primary/10 text-primary">
            <ShieldChevron size={16} weight="fill" />
          </div>
          <div data-tauri-drag-region={dragRegion} className="truncate text-sm font-semibold">
            {t('data:recovery.shell_title')}
          </div>
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
