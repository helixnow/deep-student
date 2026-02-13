import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Moon, Sun, Settings, Monitor } from 'lucide-react';
import { createNavItems } from '../config/navigation';
import useTheme from '../hooks/useTheme';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Separator } from '@/components/ui/shad/Separator';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import type { CurrentView } from '@/types/navigation';
import { pageLifecycleTracker } from '@/debug-panel/services/pageLifecycleTracker';
import { CommonTooltip } from '@/components/shared/CommonTooltip';

interface NavigationHistory {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
}

interface ModernSidebarProps {
  currentView: CurrentView;
  onViewChange: (view: CurrentView) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  startDragging?: (e: React.MouseEvent) => void;
  navigationHistory?: NavigationHistory;
  topbarTopMargin?: number;
}

export const ModernSidebar: React.FC<ModernSidebarProps> = ({
  currentView,
  onViewChange,
  topbarTopMargin = 0,
}) => {
  const { t } = useTranslation(['sidebar', 'common']);
  const { mode, setThemeMode } = useTheme();

  const navItems = useMemo(() => createNavItems(t), [t]);

  // 包装 onViewChange，添加点击追踪
  const handleViewChange = useCallback((view: CurrentView) => {
    if (view !== currentView) {
      pageLifecycleTracker.log(
        'sidebar',
        'ModernSidebar',
        'sidebar_click',
        `${currentView} → ${view}`
      );
    }
    onViewChange(view);
  }, [currentView, onViewChange]);

  // 顶部栏基础高度 40px，加上额外的 topbarTopMargin
  const DESKTOP_TITLEBAR_BASE_HEIGHT = 40;
  const headerHeight = DESKTOP_TITLEBAR_BASE_HEIGHT + topbarTopMargin;

  return (
      <aside
        role="navigation"
        aria-label={t('sidebar:aria.sidebar_navigation', '主导航')}
        className={cn(
          'w-[50px] flex flex-col items-center pb-4 z-20 relative h-full border-r border-border bg-background text-foreground transition-colors duration-500'
        )}
        style={{
          paddingTop: `${headerHeight}px`,
        }}
        data-tauri-drag-region
      >

        <CustomScrollArea
          className="flex-1 w-full"
          viewportClassName="h-full w-full"
        >
          <div className="flex flex-col w-full items-center" data-no-drag>
            {/* 第一个图标区域 - Chat V2 */}
            {(() => {
              const chatItem = navItems.find((item) => item.view === 'chat-v2');
              if (!chatItem) return null;
              const ChatIcon = chatItem.icon;
              const isActive = currentView === 'chat-v2';
              return (
                <div
                  className="flex items-center justify-center w-full"
                  style={{ height: 'var(--sidebar-header-height, 65px)' }}
                >
                  <CommonTooltip content={chatItem.name} position="right">
                    <NotionButton
                      variant={isActive ? 'default' : 'ghost'}
                      size="icon"
                      onClick={() => handleViewChange('chat-v2')}
                      aria-label={chatItem.name}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'w-10 h-10 rounded-md transition-all',
                        isActive && 'shadow-sm'
                      )}
                      data-tour-id="nav-chat-v2"
                    >
                      <ChatIcon className="w-5 h-5" strokeWidth={isActive ? 2.5 : 2} />
                    </NotionButton>
                  </CommonTooltip>
                </div>
              );
            })()}

            {/* 其他导航项 */}
            <div className="flex flex-col gap-2 w-full items-center px-2 py-2">
              {navItems
              .filter((item) => item.view !== 'chat-v2' && item.view !== 'settings')
              .map((item) => {
                const isActive = currentView === item.view;
                const Icon = item.icon;
                return (
                  <CommonTooltip key={item.view} content={item.name} position="right">
                    <NotionButton
                      variant={isActive ? 'secondary' : 'ghost'}
                      size="icon"
                      onClick={() => handleViewChange(item.view as CurrentView)}
                      aria-label={item.name}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'w-10 h-10 rounded-md transition-all',
                        isActive && 'bg-accent text-accent-foreground'
                      )}
                      data-tour-id={`nav-${item.view}`}
                    >
                      <Icon className="w-5 h-5" {...(Icon.displayName !== 'LucideIcon' ? {} : { strokeWidth: isActive ? 2.5 : 2 })} />
                    </NotionButton>
                  </CommonTooltip>
                );
              })}
            </div>
          </div>
        </CustomScrollArea>

        <div className="mt-auto flex flex-col gap-2 items-center w-full px-2 pb-2" data-no-drag>
          <Separator className="my-2 w-8" />

          <CommonTooltip
            position="right"
            content={
              mode === 'light'
                ? t('sidebar:theme_toggle.light', '亮色模式')
                : mode === 'dark'
                  ? t('sidebar:theme_toggle.dark', '暗色模式')
                  : t('sidebar:theme_toggle.auto', '自动模式')
            }
          >
            <NotionButton
              variant="ghost"
              size="icon"
              className="w-10 h-10 rounded-md"
              aria-label={
                mode === 'light'
                  ? t('sidebar:theme_toggle.switch_to_dark', '切换到暗色模式')
                  : mode === 'dark'
                    ? t('sidebar:theme_toggle.switch_to_auto', '切换到自动模式')
                    : t('sidebar:theme_toggle.switch_to_light', '切换到亮色模式')
              }
              onClick={() => {
                if (mode === 'light') setThemeMode('dark');
                else if (mode === 'dark') setThemeMode('auto');
                else setThemeMode('light');
              }}
            >
              <Sun
                className={cn(
                  'h-[1.2rem] w-[1.2rem] transition-all',
                  mode === 'light' ? 'rotate-0 scale-100' : '-rotate-90 scale-0 absolute'
                )}
              />
              <Moon
                className={cn(
                  'h-[1.2rem] w-[1.2rem] transition-all',
                  mode === 'dark' ? 'rotate-0 scale-100' : 'rotate-90 scale-0 absolute'
                )}
              />
              <Monitor
                className={cn(
                  'h-[1.2rem] w-[1.2rem] transition-all',
                  mode === 'auto' ? 'rotate-0 scale-100' : 'rotate-90 scale-0 absolute'
                )}
              />
              <span className="sr-only">{t('sidebar:theme_toggle.toggle', '切换主题')}</span>
            </NotionButton>
          </CommonTooltip>

          <CommonTooltip content={t('sidebar:navigation.settings', '设置')} position="right">
            <NotionButton
              variant={currentView === 'settings' ? 'secondary' : 'ghost'}
              size="icon"
              onClick={() => handleViewChange('settings')}
              aria-label={t('sidebar:navigation.settings', '设置')}
              aria-current={currentView === 'settings' ? 'page' : undefined}
              className="w-10 h-10 rounded-md"
              data-tour-id="nav-settings"
            >
              <Settings className="w-5 h-5" strokeWidth={currentView === 'settings' ? 2.5 : 2} />
            </NotionButton>
          </CommonTooltip>
        </div>
      </aside>
  );
};
