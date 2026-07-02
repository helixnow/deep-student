import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretRight, MagnifyingGlass } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { createNavItems } from '@/config/navigation';
import type { CurrentView } from '@/types/navigation';
import { useViewStore } from '@/stores/viewStore';
import { canonicalizeView } from '@/app/navigation/canonicalView';
import { NotionButton } from '@/components/ui/NotionButton';
import { shellNavButtonClassName } from '@/components/ui/buttonPrimitiveContract';
import { useCommandPaletteSafe } from '@/command-palette';

export const MOBILE_APP_NAVIGATE_EVENT = 'deepstudent:mobile-sidebar-navigate';

interface MobileSidebarNavigationProps {
  onNavigate?: () => void;
  className?: string;
}

export const MobileSidebarNavigation: React.FC<MobileSidebarNavigationProps> = ({
  onNavigate,
  className,
}) => {
  const { t } = useTranslation(['sidebar', 'common']);
  const currentView = useViewStore((state) => state.currentView);
  // 与桌面侧边栏同源同序（A-2/A-3 修复）：移动端不再白名单裁剪导航项
  const navItems = useMemo(() => createNavItems(t), [t]);
  // CP-1: 命令面板移动端入口（桌面靠 Cmd/Ctrl+K 与顶栏按钮，移动端此前完全不可达）
  const commandPalette = useCommandPaletteSafe();

  const handleNavigate = useCallback((view: CurrentView) => {
    window.dispatchEvent(new CustomEvent(MOBILE_APP_NAVIGATE_EVENT, { detail: { view } }));
    onNavigate?.();
  }, [onNavigate]);

  const handleOpenCommandPalette = useCallback(() => {
    // 先收起抽屉再打开面板，避免面板叠在抽屉动画上
    onNavigate?.();
    commandPalette?.open();
  }, [commandPalette, onNavigate]);

  return (
    <div
      data-mobile-shell="sidebar-nav"
      className={cn(
        'shrink-0 border-t border-[color:var(--sidebar-study-border)] px-2 pb-[calc(0.5rem+var(--mobile-safe-area-bottom,0px))] pt-2',
        className
      )}
    >
      <nav aria-label={t('common:navigation_label', 'Navigation')} className="space-y-0.5">
        {commandPalette && (
          <NotionButton
            type="button"
            variant="nav"
            size="sm"
            onClick={handleOpenCommandPalette}
            className={cn(
              shellNavButtonClassName,
              'group px-3 text-[15px] font-medium text-foreground/82 hover:bg-[var(--sidebar-study-hover)] hover:text-foreground'
            )}
          >
            <MagnifyingGlass className="h-[18px] w-[18px] shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
            <span className="min-w-0 flex-1 truncate">
              {t('sidebar:navigation.command_palette', '搜索与命令')}
            </span>
          </NotionButton>
        )}
        {navItems.map(({ view, icon: Icon, name }) => {
          const isActive = canonicalizeView(currentView) === view;

          return (
            <NotionButton
              key={view}
              type="button"
              variant="nav"
              size="sm"
              aria-current={isActive ? 'page' : undefined}
              onClick={() => handleNavigate(view as CurrentView)}
              className={cn(
                shellNavButtonClassName,
                'group px-3 text-[15px] font-medium',
                isActive
                  ? 'bg-[var(--sidebar-study-selected)] text-foreground'
                  : 'text-foreground/82 hover:bg-[var(--sidebar-study-hover)] hover:text-foreground'
              )}
            >
              <Icon
                className={cn(
                  'h-[18px] w-[18px] shrink-0 transition-colors',
                  isActive ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'
                )}
                strokeWidth={isActive ? 2.5 : 2}
/>
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <CaretRight size={16} className="shrink-0 text-muted-foreground/80" weight="regular" />
            </NotionButton>
          );
        })}
      </nav>
    </div>
  );
};

export default MobileSidebarNavigation;
