import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Moon, Sun, Settings, Monitor } from 'lucide-react';
import { createNavItems } from '../config/navigation';
import useTheme from '../hooks/useTheme';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import type { CurrentView } from '@/types/navigation';
import { pageLifecycleTracker } from '@/debug-panel/services/pageLifecycleTracker';

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
}) => {
  const { t } = useTranslation(['sidebar', 'common']);
  const { mode, setThemeMode } = useTheme();

  const navItems = useMemo(() => createNavItems(t), [t]);
  const workspaceItems = useMemo(
    () => navItems.filter((item) => ['chat-v2', 'learning-hub', 'skills-management'].includes(item.view)),
    [navItems]
  );
  const libraryItems = useMemo(
    () => navItems.filter((item) => ['task-dashboard', 'template-management'].includes(item.view)),
    [navItems]
  );
  const modeLabel = useMemo(() => {
    if (mode === 'light') return t('sidebar:theme_toggle.light', '亮色模式');
    if (mode === 'dark') return t('sidebar:theme_toggle.dark', '暗色模式');
    return t('sidebar:theme_toggle.auto', '自动模式');
  }, [mode, t]);

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

  const cycleThemeMode = useCallback(() => {
    if (mode === 'light') setThemeMode('dark');
    else if (mode === 'dark') setThemeMode('auto');
    else setThemeMode('light');
  }, [mode, setThemeMode]);

  const renderNavRow = useCallback((view: CurrentView, label: string, Icon: React.ComponentType<any>, meta: string) => {
    const isActive = currentView === view;

    return (
      <NotionButton
        key={view}
        variant="ghost"
        size="md"
        onClick={() => handleViewChange(view)}
        aria-label={label}
        aria-current={isActive ? 'page' : undefined}
        className={cn(
          'desktop-shell-nav-row !w-full !justify-start !px-3 !py-3 text-left',
          isActive && 'desktop-shell-nav-row--active'
        )}
        data-tour-id={`nav-${view}`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[color:var(--shell-control-surface)] text-[color:var(--shell-navigation-foreground)]">
            <Icon className="size-5" strokeWidth={isActive ? 2.3 : 2} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-[color:inherit]">{label}</span>
            <span className="desktop-shell-nav-meta block truncate">{meta}</span>
          </span>
        </span>
      </NotionButton>
    );
  }, [currentView, handleViewChange]);

  return (
    <aside
      role="navigation"
      aria-label={t('sidebar:aria.sidebar_navigation', '主导航')}
      data-shell-layer="navigation"
      data-shell-surface="navigation"
      className="relative z-20 flex h-full w-[var(--shell-navigation-width)] shrink-0 flex-col text-[color:var(--shell-navigation-foreground)] transition-colors duration-500"
      style={{ paddingTop: 'calc(var(--shell-titlebar-height) + var(--shell-layout-gap))' }}
    >
      <div className="px-3 pb-3" data-no-drag>
        <div className="desktop-shell-sidebar-panel px-3 py-3">
          <p className="desktop-shell-kicker">DeepStudent</p>
          <div className="mt-1 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-[color:var(--shell-navigation-foreground)]">
                {t('common:app.workspace_shell', '桌面工作区')}
              </p>
              <p className="desktop-shell-nav-meta mt-1 truncate">
                {t('common:app.workspace_shell_hint', '先导航，再进入任务内容')}
              </p>
            </div>
          </div>
        </div>
      </div>

      <CustomScrollArea className="flex-1 w-full" viewportClassName="h-full w-full">
        <div className="flex flex-col gap-[var(--shell-section-gap)] px-3 pb-4" data-no-drag>
          <section className="space-y-2">
            <p className="desktop-shell-nav-section-label">{t('sidebar:sections.workspace', '核心工作区')}</p>
            <div className="space-y-1.5">
              {workspaceItems.map((item) =>
                renderNavRow(
                  item.view as CurrentView,
                  item.name,
                  item.icon,
                  item.view === 'chat-v2'
                    ? t('sidebar:section_hints.chat_v2', '默认 landing view')
                    : item.view === 'learning-hub'
                      ? t('sidebar:section_hints.learning_hub', '资料与文件入口')
                      : t('sidebar:section_hints.skills_management', '管理技能与自动化')
                )
              )}
            </div>
          </section>

          <section className="space-y-2">
            <p className="desktop-shell-nav-section-label">{t('sidebar:sections.library', '任务与资产')}</p>
            <div className="space-y-1.5">
              {libraryItems.map((item) =>
                renderNavRow(
                  item.view as CurrentView,
                  item.name,
                  item.icon,
                  item.view === 'task-dashboard'
                    ? t('sidebar:section_hints.task_dashboard', '查看制卡队列与任务状态')
                    : t('sidebar:section_hints.template_management', '模板与资源编排')
                )
              )}
            </div>
          </section>
        </div>
      </CustomScrollArea>

      <div className="mt-auto px-3 pb-4" data-no-drag>
        <div className="desktop-shell-sidebar-panel p-2">
          <NotionButton
            variant="ghost"
            size="md"
            className="desktop-shell-nav-row !w-full !justify-start !px-3"
            aria-label={t('sidebar:theme_toggle.toggle', '切换主题')}
            onClick={cycleThemeMode}
          >
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[color:var(--shell-control-surface)] text-[color:var(--shell-navigation-foreground)]">
                <Sun
                  className={cn(
                    'absolute size-5 transition-all',
                    mode === 'light' ? 'rotate-0 scale-100' : '-rotate-90 scale-0'
                  )}
                />
                <Moon
                  className={cn(
                    'absolute size-5 transition-all',
                    mode === 'dark' ? 'rotate-0 scale-100' : 'rotate-90 scale-0'
                  )}
                />
                <Monitor
                  className={cn(
                    'absolute size-5 transition-all',
                    mode === 'auto' ? 'rotate-0 scale-100' : 'rotate-90 scale-0'
                  )}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{t('sidebar:theme_toggle.toggle', '切换主题')}</span>
                <span className="desktop-shell-nav-meta block truncate">{modeLabel}</span>
              </span>
            </span>
          </NotionButton>

          <NotionButton
            variant="ghost"
            size="md"
            onClick={() => handleViewChange('settings')}
            aria-label={t('sidebar:navigation.settings', '系统')}
            aria-current={currentView === 'settings' ? 'page' : undefined}
            className={cn(
              'desktop-shell-nav-row mt-1 !w-full !justify-start !px-3',
              currentView === 'settings' && 'desktop-shell-nav-row--active'
            )}
            data-tour-id="nav-settings"
          >
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[color:var(--shell-control-surface)] text-[color:var(--shell-navigation-foreground)]">
                <Settings className="size-5" strokeWidth={currentView === 'settings' ? 2.3 : 2} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{t('sidebar:navigation.settings', '系统')}</span>
                <span className="desktop-shell-nav-meta block truncate">
                  {t('sidebar:section_hints.settings', '偏好、同步与环境设置')}
                </span>
              </span>
            </span>
          </NotionButton>
        </div>
      </div>
    </aside>
  );
};
