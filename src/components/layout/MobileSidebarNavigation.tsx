/**
 * MobileSidebarNavigation - 移动统一抽屉底部的全局应用导航
 *
 * 由 MobileSlidingLayout 注入到统一滚动抽屉（页内工具下方），行样式与
 * ModernSidebar 同源（mobileDrawerStyles）。导航按「学习 / 管理」分组，
 * 当前视图带 active 高亮。
 */

import React, { createContext, useContext, useMemo, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChartBar, Database, MagnifyingGlass } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { createNavItems, MOBILE_NAV_SECTION_OF_VIEW, type NavItem } from '@/config/navigation';
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
import { APP_EVENTS, dispatchAppEvent } from '@/events';

/** @deprecated 请优先使用 APP_EVENTS.MOBILE_APP_NAVIGATE；保留导出以兼容既有 import */
export const MOBILE_APP_NAVIGATE_EVENT = APP_EVENTS.MOBILE_APP_NAVIGATE;

/**
 * P1-7: 导航直连。App.tsx 通过 Provider 注入 navigate 回调（回调内部自带
 * 键盘弹出期间的屏蔽守卫），抽屉导航优先直接调用；无 Provider 时回退到
 * CustomEvent 全局事件（App.tsx 的 window 监听保留，向后兼容）。
 * 回调可返回 false 表示导航被守卫拦截（此时抽屉保持展开，见 handleNavigate）。
 */
const MobileAppNavigationContext = createContext<((view: CurrentView) => boolean | void) | null>(null);

export const MobileAppNavigationProvider: React.FC<{
  navigate: (view: CurrentView) => boolean | void;
  children: ReactNode;
}> = ({ navigate, children }) => (
  <MobileAppNavigationContext.Provider value={navigate}>
    {children}
  </MobileAppNavigationContext.Provider>
);

interface MobileSidebarNavigationProps {
  onNavigate?: () => void;
  className?: string;
  /**
   * @deprecated 现在只有「嵌在统一滚动抽屉内」这一种形态（旧版 pinned 底栏
   * 分支已删除），该 prop 不再被读取，保留仅为兼容既有调用方。
   */
  embedded?: boolean;
}

export const MobileSidebarNavigation: React.FC<MobileSidebarNavigationProps> = ({
  onNavigate,
  className,
}) => {
  const { t } = useTranslation(['sidebar', 'common']);
  const currentView = useViewStore((state) => state.currentView);
  const navItems = useMemo(() => createNavItems(t), [t]);
  const commandPalette = useCommandPaletteSafe();
  const navigateDirect = useContext(MobileAppNavigationContext);

  const currentCanonicalView = canonicalizeView(currentView);

  // F1（移动端审计）：dashboard / data-management 在桌面侧栏之外没有任何
  // 移动端入口（原本只能靠命令面板输入命令抵达），补进抽屉「管理」分组，
  // 保证这两个页面在移动端可发现、可进可出。仅移动抽屉展示，不影响桌面侧栏。
  const mobileOnlyManageItems = useMemo(() => ([
    {
      view: 'dashboard' as CurrentView,
      name: t('common:navigation.dashboard', '总览'),
      icon: ChartBar,
    },
    {
      view: 'data-management' as CurrentView,
      name: t('common:navigation.data_management', '数据管理'),
      icon: Database,
    },
  ]), [t]);

  const sections = useMemo(() => {
    type DrawerNavItem = Pick<NavItem, 'name' | 'icon'> & { view: CurrentView };
    const study: DrawerNavItem[] = [];
    const manage: DrawerNavItem[] = [];
    for (const item of navItems) {
      (MOBILE_NAV_SECTION_OF_VIEW[item.view] === 'study' ? study : manage).push(item);
    }
    // 移动端专属入口插在设置之前，保持「设置」按惯例收尾
    const settingsIndex = manage.findIndex((item) => item.view === 'settings');
    if (settingsIndex >= 0) {
      manage.splice(settingsIndex, 0, ...mobileOnlyManageItems);
    } else {
      manage.push(...mobileOnlyManageItems);
    }
    return [
      { id: 'study', label: t('sidebar:mobile_drawer.section_study', '学习'), items: study },
      { id: 'manage', label: t('sidebar:mobile_drawer.section_manage', '管理'), items: manage },
    ];
  }, [mobileOnlyManageItems, navItems, t]);

  const handleNavigate = useCallback((view: CurrentView) => {
    if (navigateDirect) {
      // 守卫拦截（如 Android 键盘弹出期）返回 false：不收抽屉，
      // 避免"点了没跳转还把菜单关了"的割裂感
      const accepted = navigateDirect(view);
      if (accepted === false) return;
    } else {
      // 兼容路径：无 Provider（如独立挂载/测试环境）时退回全局事件（无法感知拦截结果）
      dispatchAppEvent(APP_EVENTS.MOBILE_APP_NAVIGATE, { view });
    }
    onNavigate?.();
  }, [navigateDirect, onNavigate]);

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
        <Icon className="size-[18px]" />
      </span>
      <span className={mobileDrawerRowTitleClassName}>{label}</span>
    </button>
  );

  return (
    <div
      data-mobile-shell="sidebar-nav"
      className={cn('mt-3 space-y-0.5 pb-1', className)}
    >
      <nav aria-label={t('common:navigation_label')} className="space-y-0.5">
        {commandPalette && renderRow(
          'command-palette',
          t('sidebar:navigation.command_palette'),
          MagnifyingGlass,
          handleOpenCommandPalette,
        )}
        {sections.map(({ id, label, items }) =>
          items.length > 0 ? (
            <div key={id} className="space-y-0.5">
              <span className={mobileDrawerSectionLabelClassName}>{label}</span>
              {items.map(({ view, icon: Icon, name }) =>
                renderRow(
                  view,
                  name,
                  Icon,
                  () => handleNavigate(view as CurrentView),
                  currentCanonicalView === canonicalizeView(view as CurrentView),
                ),
              )}
            </div>
          ) : null,
        )}
      </nav>
    </div>
  );
};

export default MobileSidebarNavigation;
