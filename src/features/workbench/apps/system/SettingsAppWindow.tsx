/**
 * SettingsAppWindow — 设置页工作台窗口。
 *
 * 内容区始终渲染真实设置界面；高密度列表由设置模块自身按需加载并虚拟化。
 * ⌘/Ctrl+F：窗口聚焦时把焦点送进侧栏设置搜索框（上千个设置项的快速定位入口）。
 */
import React, { Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppWindowProps } from '../../core/types';
import { WbSysFade, WorkbenchSidebarLayout, WbSysSkeleton } from './SystemWindowShared';
import { useWbSysSize } from './useWbSysSize';
import './SettingsAppWindow.css';

const Settings = React.lazy(() =>
  import('@/features/settings/components/Settings').then((m) => ({ default: m.Settings })),
);
const SettingsShellSidebar = React.lazy(() =>
  import('@/features/settings/components/SettingsShellSidebar').then((m) => ({
    default: m.SettingsShellSidebar,
  })),
);

const SHELL_VAR_RESET = {
  '--shell-titlebar-height': '0px',
  '--shell-layout-gap': '0px',
} as React.CSSProperties;

const SettingsAppWindow: React.FC<AppWindowProps> = ({
  onTitleChange,
  requestClose,
  renderThrottleMs: _renderThrottleMs = 0,
}) => {
  const { t } = useTranslation('workbench');
  const { ref, sizeClass } = useWbSysSize();

  useEffect(() => {
    onTitleChange(t('workbench:apps.settings'));
  }, [onTitleChange, t]);

  // ⌘/Ctrl+F → 聚焦侧栏设置搜索。门禁：本窗聚焦（data-focused）且事件发生在窗内；
  // capture 阶段消费，抢在 WebView 原生查找 / 其他全局监听之前。
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'f') return;
      const host = ref.current;
      if (!host) return;
      const windowShell = host.closest<HTMLElement>('[data-wb-window]');
      if (windowShell && !windowShell.hasAttribute('data-focused')) return;
      const scope = windowShell ?? host;
      const target = e.target as HTMLElement | null;
      if (!target || !scope.contains(target)) return;
      const input = host.querySelector<HTMLInputElement>('[data-settings-search]');
      if (!input) return;
      e.preventDefault();
      e.stopPropagation();
      input.focus();
      input.select();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [ref]);

  return (
    <div
      ref={ref}
      className="h-full min-h-0 w-full min-w-0 overflow-hidden bg-background"
      style={SHELL_VAR_RESET}
      data-wb-sys-app="settings"
      data-wb-settings-host
    >
      <div data-wb-settings-layer>
        <Suspense fallback={<WbSysSkeleton variant="sidebar" />}>
          <WbSysFade>
            <WorkbenchSidebarLayout
              sizeClass={sizeClass}
              navLabel={t('workbench:apps.system.settingsNav')}
              sidebar={
                <SettingsShellSidebar isSmallScreen={false} globalLeftPanelCollapsed={false} />
              }
            >
              <div className="relative h-full min-h-0 min-w-0">
                <Settings onBack={requestClose} />
              </div>
            </WorkbenchSidebarLayout>
          </WbSysFade>
        </Suspense>
      </div>
    </div>
  );
};

export default SettingsAppWindow;
