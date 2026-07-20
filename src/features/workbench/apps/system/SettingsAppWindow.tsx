/**
 * SettingsAppWindow — 活树合成层跟手（禁止截图冻结）
 *
 * 契约：
 * - 静态 contain：隔离设置子树 layout/paint
 * - 悬停/拖拽预提升 will-change（写在 lift/dragging，禁止起拖才首次创建层）
 * - 跟手期禁止对本宿主 setAttribute / display:none / snapdom（会弄脏合成层）
 * - 动画暂停只靠 `:root[data-wb-dragging]` CSS（禁止对本宿主写 paused attr）
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
  // renderThrottleMs：设置窗故意不挂 data-wb-render-paused（属性翻转会弄脏合成层）
  renderThrottleMs: _renderThrottleMs = 0,
}) => {
  const { t } = useTranslation('workbench');
  const { ref, sizeClass } = useWbSysSize();

  useEffect(() => {
    onTitleChange(t('workbench:apps.settings'));
  }, [onTitleChange, t]);

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
