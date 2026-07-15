/**
 * 设置页面侧边栏组件
 * 从 Settings.tsx 提取
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, MagnifyingGlass } from '@phosphor-icons/react';
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
  sidebarSearchQuery,
  setSidebarSearchQuery,
  sidebarSearchFocused: _sidebarSearchFocused,
  setSidebarSearchFocused,
  settingsSearchIndex,
  sidebarNavItems,
  activeTab,
  setActiveTab,
  setSidebarOpen,
  onBack,
}) => {
  const { t } = useTranslation(['settings']);
  const isCollapsed = !isSmallScreen && globalLeftPanelCollapsed;

  // 设置搜索：label 或 keywords 命中即列出，点击跳转对应 tab
  const searchQuery = sidebarSearchQuery.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!searchQuery) return [];
    return settingsSearchIndex.filter(
      (item) =>
        item.label.toLowerCase().includes(searchQuery) ||
        item.keywords.some((k) => k.toLowerCase().includes(searchQuery))
    );
  }, [searchQuery, settingsSearchIndex]);

  const tabLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    sidebarNavItems.forEach((item) => map.set(item.value, item.label));
    return map;
  }, [sidebarNavItems]);

  const handleSearchResultClick = (tab: string) => {
    setActiveTab(tab);
    setSidebarSearchQuery('');
    if (isSmallScreen) setSidebarOpen(false);
  };
  const desktopShellPaddingStyle: React.CSSProperties | undefined = isSmallScreen
    ? undefined
    : { paddingTop: 'calc(var(--shell-titlebar-height) + var(--shell-layout-gap))' };

  const sidebarContent = (
    <div
      data-shell-layer={!isSmallScreen ? 'navigation' : undefined}
      data-shell-surface={!isSmallScreen ? 'navigation' : undefined}
      data-settings-sidebar
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

      {/* 设置搜索入口（11 个 tab / 上千个设置项的快速定位；索引见 useSettingsNavigation） */}
      {!isCollapsed && (
        <div className="shrink-0 px-2 pb-1">
          <div className="relative">
            <MagnifyingGlass
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[color:var(--sidebar-muted,var(--muted-foreground))] opacity-60"
            />
            <input
              type="search"
              value={sidebarSearchQuery}
              onChange={(e) => setSidebarSearchQuery(e.target.value)}
              onFocus={() => setSidebarSearchFocused(true)}
              onBlur={() => setSidebarSearchFocused(false)}
              placeholder={t('sidebar.search_placeholder', '搜索设置...')}
              aria-label={t('sidebar.search_placeholder', '搜索设置...')}
              className={cn(
                'h-8 w-full appearance-none rounded-lg border border-transparent bg-[color:var(--interactive-hover)]/60',
                'pl-8 pr-2.5 text-[13px] text-[color:var(--sidebar-foreground)] placeholder:text-[color:var(--sidebar-muted,var(--muted-foreground))] placeholder:opacity-70',
                'outline-none transition-colors focus:border-[color:var(--border)] focus:bg-background',
                '[&::-webkit-search-cancel-button]:hidden'
              )}
            />
          </div>
        </div>
      )}

      <nav
        aria-label={t('sidebar.navigation_label', { defaultValue: '设置导航' })}
        className={cn('flex-1 overflow-y-auto py-1', isCollapsed ? 'pointer-events-none opacity-0 px-0' : 'px-2')}
      >
        {searchQuery ? (
          searchResults.length > 0 ? (
            <ul className="space-y-0.5">
              {searchResults.map((item, idx) => (
                <li key={`${item.tab}-${idx}`}>
                  <NotionButton
                    variant="nav"
                    size="md"
                    onClick={() => handleSearchResultClick(item.tab)}
                    className="desktop-shell-nav-row !w-full rounded-2xl !justify-start gap-2.5 !px-2.5 !py-1.5"
                  >
                    <span className="flex min-w-0 flex-col items-start text-left">
                      <span className={`truncate ${SETTINGS_NAV_ITEM_LABEL_CLASS_NAME}`}>{item.label}</span>
                      <span className="truncate text-[11px] text-[color:var(--sidebar-muted,var(--muted-foreground))] opacity-70">
                        {tabLabelMap.get(item.tab) ?? item.tab}
                      </span>
                    </span>
                  </NotionButton>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-2 text-[12px] text-[color:var(--sidebar-muted,var(--muted-foreground))] opacity-80">
              {t('sidebar.no_results', '未找到匹配的设置')}
            </p>
          )
        ) : (
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
        )}
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
        'overflow-hidden transition-[width] duration-200 ease-[var(--panel-ease)]',
        globalLeftPanelCollapsed ? 'w-0' : 'w-[var(--shell-navigation-width)]'
      )}
      aria-hidden={globalLeftPanelCollapsed ? 'true' : undefined}
    >
      {sidebarContent}
    </div>
  );
};
