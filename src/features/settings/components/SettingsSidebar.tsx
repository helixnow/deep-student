/**
 * 设置页面侧边栏组件
 * 从 Settings.tsx 提取
 *
 * 搜索交互（O 打磨）：
 * - 结果列表支持 ↑/↓ 选择、Enter 跳转（combobox/listbox 语义，IME 组合期不消费）；
 * - 跳转后经 settingsSearchReveal 在内容区滚动定位并高亮命中行；
 * - 空白搜索 / 无结果分别给出空态提示，无结果态附「清空搜索」快捷出口。
 */

import React, { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, MagnifyingGlass, X } from '@phosphor-icons/react';
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
import { revealSettingsSection } from './settingsSearchReveal';

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
  const searchListId = useId();

  // 设置搜索：label 或 keywords 命中即列出，点击/Enter 跳转对应 tab 并定位高亮
  const searchQuery = sidebarSearchQuery.trim().toLowerCase();
  // 只输入了空白字符：不列结果也不无结果报错，给「输入关键词」提示
  const isWhitespaceQuery = sidebarSearchQuery.length > 0 && searchQuery.length === 0;
  const searchResults = useMemo(() => {
    if (!searchQuery) return [];
    return settingsSearchIndex.filter(
      (item) =>
        item.label.toLowerCase().includes(searchQuery) ||
        item.keywords.some((k) => k.toLowerCase().includes(searchQuery))
    );
  }, [searchQuery, settingsSearchIndex]);

  // 键盘选择：↑/↓ 移动高亮项，Enter 跳转（roving active index，随查询重置）
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  useEffect(() => {
    setActiveResultIndex(0);
  }, [searchQuery]);

  const clampedActiveIndex = Math.min(activeResultIndex, Math.max(searchResults.length - 1, 0));
  const optionId = (index: number) => `${searchListId}-option-${index}`;

  // 高亮项变化后保持可见（列表滚动容器内）
  useEffect(() => {
    if (!searchQuery || searchResults.length === 0) return;
    const el = document.getElementById(optionId(clampedActiveIndex));
    el?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clampedActiveIndex, searchQuery, searchResults.length]);

  const tabLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    sidebarNavItems.forEach((item) => map.set(item.value, item.label));
    return map;
  }, [sidebarNavItems]);

  const activateSearchResult = (item: { label: string; tab: string }) => {
    setActiveTab(item.tab);
    // tab 内容 lazy 加载：交给 reveal 轮询定位 + 高亮命中行
    revealSettingsSection(item.label);
    setSidebarSearchQuery('');
    if (isSmallScreen) setSidebarOpen(false);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      if (sidebarSearchQuery) {
        e.preventDefault();
        setSidebarSearchQuery('');
      }
      return;
    }
    if (!searchQuery || searchResults.length === 0) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveResultIndex(Math.min(clampedActiveIndex + 1, searchResults.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveResultIndex(Math.max(clampedActiveIndex - 1, 0));
        break;
      case 'Home':
        e.preventDefault();
        setActiveResultIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveResultIndex(searchResults.length - 1);
        break;
      case 'Enter': {
        e.preventDefault();
        const item = searchResults[clampedActiveIndex];
        if (item) activateSearchResult(item);
        break;
      }
      default:
        break;
    }
  };
  const desktopShellPaddingStyle: React.CSSProperties | undefined = isSmallScreen
    ? undefined
    : { paddingTop: 'calc(var(--shell-titlebar-height) + var(--shell-layout-gap))' };

  const showSearchResults = Boolean(searchQuery) && searchResults.length > 0;

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
            className="desktop-shell-nav-row !w-full !justify-start !px-2.5 !py-1.5 [@media(pointer:coarse)]:!min-h-11 text-left"
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
              onKeyDown={handleSearchKeyDown}
              onFocus={() => setSidebarSearchFocused(true)}
              onBlur={() => setSidebarSearchFocused(false)}
              placeholder={t('sidebar.search_placeholder')}
              aria-label={t('sidebar.search_placeholder')}
              role="combobox"
              aria-expanded={showSearchResults}
              aria-controls={searchListId}
              aria-autocomplete="list"
              aria-activedescendant={showSearchResults ? optionId(clampedActiveIndex) : undefined}
              data-settings-search
              className={cn(
                'h-8 [@media(pointer:coarse)]:h-11 w-full appearance-none rounded-lg border border-transparent bg-[color:var(--interactive-hover)]/60',
                'pl-8 pr-2.5 text-ui [@media(pointer:coarse)]:text-[16px] text-[color:var(--sidebar-foreground)] placeholder:text-[color:var(--sidebar-muted,var(--muted-foreground))] placeholder:opacity-70',
                'outline-none transition-colors focus:border-[color:var(--border)] focus:bg-background',
                'focus-visible:outline-none focus-visible:ring-0 focus-visible:border-[color:var(--border)] focus-visible:bg-background',
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
          {isWhitespaceQuery ? (
            <div
              className="flex flex-col items-center gap-1 px-3 py-6 text-center"
              data-settings-search-empty="prompt"
            >
              <MagnifyingGlass size={20} className="text-[color:var(--sidebar-muted,var(--muted-foreground))] opacity-50" aria-hidden />
              <p className="text-sm text-[color:var(--sidebar-muted,var(--muted-foreground))] opacity-80">
                {t('sidebar.search_empty_prompt')}
              </p>
            </div>
          ) : searchQuery ? (
            searchResults.length > 0 ? (
              <ul id={searchListId} role="listbox" aria-label={t('sidebar.search_placeholder')} className="space-y-0.5">
                {searchResults.map((item, idx) => (
                  <li
                    key={`${item.tab}-${idx}`}
                    id={optionId(idx)}
                    role="option"
                    aria-selected={idx === clampedActiveIndex}
                  >
                    <WorkbenchSidebarRow
                      rowType="nav"
                      isActive={idx === clampedActiveIndex}
                      onClick={() => activateSearchResult(item)}
                      onMouseMove={() => {
                        if (idx !== clampedActiveIndex) setActiveResultIndex(idx);
                      }}
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
              <div
                className="flex flex-col items-center gap-1.5 px-3 py-6 text-center"
                data-settings-search-empty="no-results"
                role="status"
              >
                <MagnifyingGlass size={20} className="text-[color:var(--sidebar-muted,var(--muted-foreground))] opacity-50" aria-hidden />
                <p className="text-sm font-medium text-[color:var(--sidebar-foreground)]">
                  {t('sidebar.no_results')}
                </p>
                <p className="text-xs text-[color:var(--sidebar-muted,var(--muted-foreground))] opacity-80">
                  {t('sidebar.no_results_hint')}
                </p>
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setSidebarSearchQuery('')}
                  className="mt-1 h-7 gap-1 px-2 text-xs"
                >
                  <X size={12} weight="bold" />
                  {t('sidebar.clear_search')}
                </DsButton>
              </div>
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
                    // 收起态（以及任何只剩图标的窄形态）下标签文字不渲染，
                    // 没有 aria-label 读屏就只念「按钮」
                    aria-label={item.label}
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
