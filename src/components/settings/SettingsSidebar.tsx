/**
 * 设置页面侧边栏组件
 * 从 Settings.tsx 提取
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from '@phosphor-icons/react';
import { cn } from '../../lib/utils';
import { NotionButton } from '../ui/NotionButton';
import {
  SETTINGS_BACK_BUTTON_LABEL,
  SETTINGS_NAV_ITEM_LABEL_CLASS_NAME,
} from './sidebarSettings';

export interface SettingsSidebarProps {
  isSmallScreen: boolean;
  globalLeftPanelCollapsed: boolean;
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

  const sidebarContent = (
    <div className={cn(
      'study-shell-sidebar-frame font-sidebar-study-ui h-full flex flex-col bg-[color:var(--shell-navigation-panel)] text-[color:var(--shell-navigation-foreground)]',
      !isSmallScreen && 'border-r border-[color:var(--shell-navigation-border)]'
    )}>
      <div className={cn('shrink-0 px-2 py-1', isCollapsed ? 'flex justify-center' : 'space-y-0.5')}>
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
        className={cn('flex-1 overflow-y-auto py-1', isCollapsed ? 'px-1.5' : 'px-2')}
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
                    isCollapsed 
                      ? '!justify-center !p-2.5'
                      : '!justify-start gap-2.5 !px-2.5 !py-1.5',
                    isActive && 'desktop-shell-nav-row--active cursor-default'
                  )}
                  title={isCollapsed ? item.label : undefined}
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

  // 桌面端直接渲染
  return (
    <div
      className={cn(
        'h-full flex-shrink-0 transition-[width] duration-200',
        globalLeftPanelCollapsed ? 'w-14' : 'w-[17rem]'
      )}
    >
      {sidebarContent}
    </div>
  );
};
