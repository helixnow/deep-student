import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlass } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { createNavItems } from '@/config/navigation';
import type { CurrentView } from '@/types/navigation';
import { useViewStore } from '@/stores/viewStore';
import { canonicalizeView } from '@/app/navigation/canonicalView';
import { useCommandPaletteSafe } from '@/command-palette';
import {
  mobileDrawerNavRowClassName,
  mobileDrawerRowIconWrapClassName,
  mobileDrawerRowTitleClassName,
  mobileDrawerSectionLabelClassName,
} from './mobileDrawerStyles';

export const MOBILE_APP_NAVIGATE_EVENT = 'deepstudent:mobile-sidebar-navigate';

interface MobileSidebarNavigationProps {
  onNavigate?: () => void;
  className?: string;
  /** 嵌在统一滚动抽屉内：与 ModernSidebar 同源行样式 */
  embedded?: boolean;
}

export const MobileSidebarNavigation: React.FC<MobileSidebarNavigationProps> = ({
  onNavigate,
  className,
  embedded = false,
}) => {
  const { t } = useTranslation(['sidebar', 'common']);
  const currentView = useViewStore((state) => state.currentView);
  const navItems = useMemo(() => createNavItems(t), [t]);
  const commandPalette = useCommandPaletteSafe();

  const visibleNavItems = useMemo(() => {
    if (!embedded) return navItems;
    const current = canonicalizeView(currentView);
    return navItems.filter(({ view }) => canonicalizeView(view as CurrentView) !== current);
  }, [navItems, embedded, currentView]);

  const handleNavigate = useCallback((view: CurrentView) => {
    window.dispatchEvent(new CustomEvent(MOBILE_APP_NAVIGATE_EVENT, { detail: { view } }));
    onNavigate?.();
  }, [onNavigate]);

  const handleOpenCommandPalette = useCallback(() => {
    onNavigate?.();
    commandPalette?.open();
  }, [commandPalette, onNavigate]);

  const renderRow = (
    key: string,
    label: string,
    Icon: React.ElementType,
    onClick: () => void,
    isActive = false,
  ) => (
    <button
      key={key}
      type="button"
      aria-current={isActive ? 'page' : undefined}
      onClick={onClick}
      className={mobileDrawerNavRowClassName(isActive, 'group gap-2.5')}
    >
      <span className={mobileDrawerRowIconWrapClassName}>
        <Icon className="size-[18px]" strokeWidth={2} />
      </span>
      <span className={mobileDrawerRowTitleClassName}>{label}</span>
    </button>
  );

  if (!embedded) {
    // 旧版 pinned 底栏（理论上已不再使用，保留兼容）
    return (
      <div
        data-mobile-shell="sidebar-nav"
        className={cn(
          'shrink-0 border-t border-[color:var(--sidebar-study-border)] px-2 pb-[calc(0.5rem+var(--mobile-safe-area-bottom,0px))] pt-2',
          className,
        )}
      >
        <nav aria-label={t('common:navigation_label')} className="space-y-0.5">
          {commandPalette && renderRow(
            'command-palette',
            t('sidebar:navigation.command_palette'),
            MagnifyingGlass,
            handleOpenCommandPalette,
          )}
          {visibleNavItems.map(({ view, icon: Icon, name }) =>
            renderRow(
              view,
              name,
              Icon,
              () => handleNavigate(view as CurrentView),
              canonicalizeView(currentView) === view,
            ),
          )}
        </nav>
      </div>
    );
  }

  return (
    <div
      data-mobile-shell="sidebar-nav"
      className={cn('mt-3 space-y-0.5 pb-1', className)}
    >
      <span className={mobileDrawerSectionLabelClassName}>
        {t('sidebar:mobile_drawer.section_app')}
      </span>
      <nav aria-label={t('common:navigation_label')} className="space-y-0.5">
        {commandPalette && renderRow(
          'command-palette',
          t('sidebar:navigation.command_palette'),
          MagnifyingGlass,
          handleOpenCommandPalette,
        )}
        {visibleNavItems.map(({ view, icon: Icon, name }) =>
          renderRow(view, name, Icon, () => handleNavigate(view as CurrentView)),
        )}
      </nav>
    </div>
  );
};

export default MobileSidebarNavigation;
