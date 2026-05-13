/**
 * TodoShellSidebar - 待办 Shell 侧边栏包装器
 *
 * 当 currentView === 'todo' 时，替换主导航 ModernSidebar，
 * 提供"返回主页"按钮 + TodoSidebar 导航内容。
 * 模式与 SettingsShellSidebar 完全一致。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { TodoSidebar } from './TodoSidebar';

interface TodoShellSidebarProps {
  isSmallScreen: boolean;
  globalLeftPanelCollapsed: boolean;
  onBack?: () => void;
}

export const TodoShellSidebar: React.FC<TodoShellSidebarProps> = ({
  isSmallScreen,
  globalLeftPanelCollapsed,
  onBack,
}) => {
  const { t } = useTranslation(['todo', 'common']);
  const isCollapsed = !isSmallScreen && globalLeftPanelCollapsed;
  const desktopShellPaddingStyle: React.CSSProperties | undefined = isSmallScreen
    ? undefined
    : { paddingTop: 'calc(var(--shell-titlebar-height) + var(--shell-layout-gap))' };

  return (
    <div
      data-shell-layer={!isSmallScreen ? 'navigation' : undefined}
      data-shell-surface={!isSmallScreen ? 'navigation' : undefined}
      className={cn(
        'study-shell-sidebar-frame font-sidebar-study-ui h-full w-full min-w-0 flex flex-col overflow-hidden bg-[color:var(--shell-navigation-panel)] text-[color:var(--shell-navigation-foreground)]',
        !isSmallScreen && 'border-r border-[color:var(--shell-navigation-border)]',
      )}
      style={desktopShellPaddingStyle}
    >
      {/* 返回按钮 */}
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
              {t('common:actions.backToHome', { defaultValue: '返回主页' })}
            </span>
          </NotionButton>
        ) : null}
      </div>

      {/* Todo 导航内容 */}
      <div className={cn('flex-1 min-h-0 overflow-hidden', isCollapsed && 'pointer-events-none opacity-0')}>
        <TodoSidebar />
      </div>
    </div>
  );
};
