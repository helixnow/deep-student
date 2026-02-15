/**
 * 设置页面侧边栏组件
 * 从 Settings.tsx 提取
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X, ChevronRight, ChevronLeft } from 'lucide-react';
import { Input } from '../ui/shad/Input';
import { cn } from '../../lib/utils';
import { useUIStore } from '@/stores/uiStore';

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
}

export const SettingsSidebar: React.FC<SettingsSidebarProps> = ({
  isSmallScreen,
  globalLeftPanelCollapsed,
  sidebarSearchQuery,
  setSidebarSearchQuery,
  sidebarSearchFocused,
  setSidebarSearchFocused,
  settingsSearchIndex,
  sidebarNavItems,
  activeTab,
  setActiveTab,
  setSidebarOpen,
}) => {
  const { t } = useTranslation(['settings', 'common']);
  const isCollapsed = !isSmallScreen && globalLeftPanelCollapsed;
  
  // 搜索结果处理
  const searchQuery = sidebarSearchQuery.trim().toLowerCase();
  const hasSearch = searchQuery.length > 0;
  
  // 搜索具体设置项
  const matchedSettingsItems = hasSearch
    ? settingsSearchIndex.filter(item => 
        item.label.toLowerCase().includes(searchQuery) ||
        item.keywords.some(kw => kw.toLowerCase().includes(searchQuery))
      )
    : [];
  
  // 根据搜索过滤导航项（tab级别）
  const filteredNavItems = hasSearch
    ? sidebarNavItems.filter(item => 
        item.label.toLowerCase().includes(searchQuery) ||
        matchedSettingsItems.some(si => si.tab === item.value)
      )
    : sidebarNavItems;
  
  // 按tab分组的设置项搜索结果
  const groupedSettingsResults = hasSearch
    ? matchedSettingsItems.reduce((acc, item) => {
        if (!acc[item.tab]) acc[item.tab] = [];
        acc[item.tab].push(item);
        return acc;
      }, {} as Record<string, typeof matchedSettingsItems>)
    : {};
  
  // 侧边栏内容
  const sidebarContent = (
    <div className={cn(
      'h-full flex flex-col bg-background pt-[5px]',
      !isSmallScreen && 'border-r border-border/40'
    )}>
      {/* 顶部搜索栏 - 仿照学习资源侧栏设计 */}
      <div className={cn(
        'shrink-0 px-2 py-2',
        isCollapsed ? 'flex justify-center' : ''
      )}>
        {!isCollapsed ? (
          <div className="relative">
            <Search className={cn(
              "absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 transition-colors duration-150",
              sidebarSearchFocused ? "text-primary" : "text-muted-foreground/50"
            )} />
            <Input
              type="text"
              placeholder={t('settings:sidebar.search_placeholder')}
              value={sidebarSearchQuery}
              onChange={(e) => setSidebarSearchQuery(e.target.value)}
              onFocus={() => setSidebarSearchFocused(true)}
              onBlur={() => setSidebarSearchFocused(false)}
              className={cn(
                'h-8 pl-8 pr-8 text-[13px] rounded-lg',
                'bg-muted/40 border-transparent',
                'placeholder:text-muted-foreground/40',
                'focus:bg-background focus:border-border/60 focus:ring-1 focus:ring-primary/20',
                'transition-all duration-150'
              )}
            />
            {sidebarSearchQuery && (
              <button
                type="button"
                onClick={() => setSidebarSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded-md hover:bg-muted/60 transition-colors"
              >
                <X className="h-3.5 w-3.5 text-muted-foreground/60" />
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => useUIStore.getState().setLeftPanelCollapsed(false)}
            className="p-2 rounded-md hover:bg-muted/50 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            title={t('settings:sidebar.search_placeholder')}
          >
            <Search className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* 导航菜单 */}
      <nav className={cn(
        'flex-1 overflow-y-auto py-2',
        isCollapsed ? 'px-1.5' : 'px-2'
      )}>
        <ul className="space-y-0.5">
          {filteredNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.value;
            const tabSettingsResults = groupedSettingsResults[item.value] || [];
            const hasSubItems = hasSearch && tabSettingsResults.length > 0;
            
            return (
              <li key={item.value}>
                {/* Tab 按钮 */}
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab(item.value as any);
                    setSidebarSearchQuery('');
                    if (isSmallScreen) setSidebarOpen(false);
                  }}
                  className={cn(
                    'w-full flex items-center rounded-md transition-colors duration-150',
                    isCollapsed 
                      ? 'justify-center p-2' 
                      : 'gap-2.5 px-2.5 py-1.5',
                    isActive
                      ? 'bg-foreground/[0.08] text-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]'
                  )}
                  title={isCollapsed ? item.label : undefined}
                >
                  <Icon className={cn(
                    'flex-shrink-0 transition-colors',
                    'w-4 h-4',
                    isActive && 'text-foreground'
                  )} />
                  {!isCollapsed && (
                    <span className={cn(
                      'text-[13px] truncate',
                      isActive ? 'font-bold' : 'font-semibold'
                    )}>
                      {item.label}
                    </span>
                  )}
                </button>
                {/* 搜索结果：显示匹配的具体设置项 */}
                {hasSubItems && !isCollapsed && (
                  <ul className="ml-6 mt-0.5 space-y-0.5 border-l border-border/30 pl-2">
                    {tabSettingsResults.map((subItem, idx) => (
                      <li key={`${item.value}-${idx}`}>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveTab(item.value as any);
                            setSidebarSearchQuery('');
                            if (isSmallScreen) setSidebarOpen(false);
                          }}
                          className="w-full text-left px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] rounded-md transition-colors truncate"
                        >
                          {subItem.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        {/* 搜索无结果提示 */}
        {hasSearch && filteredNavItems.length === 0 && !isCollapsed && (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground/60">
            {t('settings:sidebar.no_results')}
          </div>
        )}
      </nav>

      {/* 折叠/展开按钮 - 仿照学习资源侧栏设计，移动端不显示 */}
      {!isSmallScreen && (
        <div className="shrink-0 h-11 flex items-center px-2 border-t border-border">
          <button
            type="button"
            onClick={() => useUIStore.getState().toggleLeftPanel()}
            className={cn(
              'w-full flex items-center justify-center py-1.5 rounded-md',
              'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/40',
              'transition-all duration-150'
            )}
            title={isCollapsed 
              ? t('settings:sidebar.expand') 
              : t('settings:sidebar.collapse')
            }
          >
            {isCollapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </button>
        </div>
      )}
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
        globalLeftPanelCollapsed ? 'w-14' : 'w-52'
      )}
    >
      {sidebarContent}
    </div>
  );
};
