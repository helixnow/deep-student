/**
 * 设置页面侧边栏组件
 * 从 Settings.tsx 提取
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  SETTINGS_BACK_BUTTON_LABEL,
  SETTINGS_NAV_ITEM_LABEL_CLASS_NAME,
} from './sidebarSettings';

export interface SettingsSidebarProps {
  isSmallScreen: boolean;
  globalLeftPanelCollapsed: boolean;
  desktopMode?: 'self' | 'slot';
  sidebarSearchQuery: string;
  setSidebarSearchQuery: (v: string) => void;
  sidebarSearchFocused: boolean;
  setSidebarSearchFocused: (v: boolean) => void;
  settingsSearchIndex: Array<{ label: string; keywords: string[]; tab: string }>;
  sidebarNavItems: Array<{ value: string; label: string; icon: React.ComponentType<{ className?: string }> }>;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  setSidebarOpen: (v: boolean) => void;
  onBack?: () => void;
}

export const SettingsSidebar: React.FC<SettingsSidebarProps> = ({
  isSmallScreen,
  globalLeftPanelCollapsed,
  desktopMode = 'self',
  sidebarSearchQuery: _sidebarSearchQuery,
  setSidebarSearchQuery: _setSidebarSearchQuery,
  sidebarSearchFocused: _sidebarSearchFocused,
  setSidebarSearchFocused: _setSidebarSearchFocused,
  settingsSearchIndex: _settingsSearchIndex,
  sidebarNavItems,
  activeTab,
  setActiveTab,
  setSidebarOpen,
  onBack,
}) => {
  const { t } = useTranslation(['settings']);
  const isCollapsed = !isSmallScreen && globalLeftPanelCollapsed;
  const desktopShellPaddingStyle: React.CSSProperties | undefined = isSmallScreen
    ? undefined
    : { paddingTop: 'calc(var(--shell-titlebar-height) + var(--shell-layout-gap))' };

  const sidebarContent = (
    <div
      data-shell-layer={!isSmallScreen ? 'navigation' : undefined}
      data-shell-surface={!isSmallScreen ? 'navigation' : undefined}
      className={cn(
        'study-shell-sidebar-frame font-sidebar-study-ui h-full w-full min-w-0 flex flex-col overflow-hidden bg-[color:var(--shell-navigation-panel)] text-[color:var(--shell-navigation-foreground)]',
        !isSmallScreen && 'border-r border-[color:var(--shell-navigation-border)]'
      )}
      style={desktopShellPaddingStyle}
    >
      <div className={cn('shrink-0 px-2 py-1', isCollapsed ? 'opacity-0' : 'space-y-0.5')}>
        {!isCollapsed && onBack ? (
          <NotionButton
            variant="nav"
            size="md"
            onClick={onBack}
            className="desktop-shell-nav-row !w-full !justify-start !px-2.5 !py-1.5 text-left"
          >
            <ArrowLeft size={18} className="h-[18px] w-[18px]" />
            <span className="truncate">
              {t('sidebar.back_to_home', { defaultValue: SETTINGS_BACK_BUTTON_LABEL })}
            </span>
          </NotionButton>
        ) : null}
      </div>

      <nav
        aria-label={t('sidebar.navigation_label', { defaultValue: '设置导航' })}
        className={cn('flex-1 overflow-y-auto py-1', isCollapsed ? 'pointer-events-none opacity-0 px-0' : 'px-2')}
      >
        <ul className="space-y-0.5">
          {sidebarNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.value;

            return (
              <li key={item.value}>
                <NotionButton
                  variant="nav"
                  size="md"
                  aria-current={isActive ? 'page' : undefined}
                  onClick={isActive ? undefined : () => {
                    setActiveTab(item.value as any);
                    if (isSmallScreen) setSidebarOpen(false);
                  }}
                  className={cn(
                    'desktop-shell-nav-row !w-full rounded-2xl',
                    '!justify-start gap-2.5 !px-2.5 !py-1.5',
                    isActive && 'desktop-shell-nav-row--active cursor-default'
                  )}
                  title={undefined}
                >
                  <Icon className="h-[18px] w-[18px] flex-shrink-0" />
                  {!isCollapsed && (
                    <span className={`truncate ${SETTINGS_NAV_ITEM_LABEL_CLASS_NAME}`}>
                      {item.label}
                    </span>
                  )}
                </NotionButton>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );

  // 移动端直接返回内容（由 MobileSlidingLayout 处理滑动）
  if (isSmallScreen) {
    return sidebarContent;
  }

  if (desktopMode === 'slot') {
    return sidebarContent;
  }

  // 桌面端直接渲染
  return (
    <div
      className={cn(
        'h-full flex-shrink-0',
        'overflow-hidden transition-[width] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]',
        globalLeftPanelCollapsed ? 'w-0' : 'w-[var(--shell-navigation-width)]'
      )}
      aria-hidden={globalLeftPanelCollapsed ? 'true' : undefined}
    >
      {sidebarContent}
    </div>
  );
};
