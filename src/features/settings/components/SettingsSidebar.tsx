/**
 * 设置页面侧边栏组件
 * 从 Settings.tsx 提取
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, MagnifyingGlass } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  WorkbenchSidebarRow,
  WorkbenchSidebarRowLabel,
  WorkbenchSidebarSurface,
} from '@/features/workbench/components/sidebar';
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
    <WorkbenchSidebarSurface
      ariaLabel={t('sidebar.navigation_label')}
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
          <DsButton
            variant="nav"
            size="md"
            onClick={onBack}
            className="desktop-shell-nav-row !w-full !justify-start !px-2.5 !py-1.5 text-left"
          >
            <ArrowLeft size={18} className="h-[18px] w-[18px]" />
            <span className="truncate">
              {t('sidebar.back_to_home', { defaultValue: SETTINGS_BACK_BUTTON_LABEL })}
            </span>
          </DsButton>
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
              placeholder={t('sidebar.search_placeholder')}
              aria-label={t('sidebar.search_placeholder')}
              className={cn(
                'h-8 w-full appearance-none rounded-lg border border-transparent bg-[color:var(--interactive-hover)]/60',
                'pl-8 pr-2.5 text-ui text-[color:var(--sidebar-foreground)] placeholder:text-[color:var(--sidebar-muted,var(--muted-foreground))] placeholder:opacity-70',
                'outline-none transition-colors focus:border-[color:var(--border)] focus:bg-background',
                '[&::-webkit-search-cancel-button]:hidden'
              )}
            />
          </div>
        </div>
      )}

      <CustomScrollArea
        aria-label={t('sidebar.navigation_label')}
        role="navigation"
        className={cn('min-h-0 flex-1', isCollapsed && 'pointer-events-none opacity-0')}
        // OverlayScrollbars 会把 viewport 的 padding 强制清零，边距必须放在内层
        viewportClassName="h-full w-full min-h-0"
        trackOffsetTop={4}
        trackOffsetBottom={4}
      >
        <div className={cn('py-1', isCollapsed ? 'px-0' : 'px-2')}>
          {searchQuery ? (
            searchResults.length > 0 ? (
              <ul className="space-y-0.5">
                {searchResults.map((item, idx) => (
                  <li key={`${item.tab}-${idx}`}>
                    <WorkbenchSidebarRow
                      rowType="nav"
                      isActive={false}
                      onClick={() => handleSearchResultClick(item.tab)}
                    >
                      <span className="flex min-w-0 flex-col items-start text-left">
                        <span className={`truncate ${SETTINGS_NAV_ITEM_LABEL_CLASS_NAME}`}>{item.label}</span>
                        <span className="truncate text-xs text-[color:var(--sidebar-muted,var(--muted-foreground))] opacity-70">
                          {tabLabelMap.get(item.tab) ?? item.tab}
                        </span>
                      </span>
                    </WorkbenchSidebarRow>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-2 text-sm text-[color:var(--sidebar-muted,var(--muted-foreground))] opacity-80">
                {t('sidebar.no_results')}
              </p>
            )
          ) : (
          <ul className="space-y-0.5">
            {sidebarNavItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.value;

              return (
                <li key={item.value}>
                  <WorkbenchSidebarRow
                    rowType="nav"
                    isActive={isActive}
                    aria-current={isActive ? 'page' : undefined}
                    onClick={isActive ? undefined : () => {
                      setActiveTab(item.value as any);
                      if (isSmallScreen) setSidebarOpen(false);
                    }}
                    className={isActive ? 'cursor-default' : undefined}
                    title={undefined}
                    leftSlot={<Icon className="h-[18px] w-[18px] flex-shrink-0" />}
                  >
                    {!isCollapsed && (
                      <WorkbenchSidebarRowLabel>
                        <span className={SETTINGS_NAV_ITEM_LABEL_CLASS_NAME}>
                        {item.label}
                        </span>
                      </WorkbenchSidebarRowLabel>
                    )}
                  </WorkbenchSidebarRow>
                </li>
              );
            })}
          </ul>
          )}
        </div>
      </CustomScrollArea>
    </WorkbenchSidebarSurface>
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
