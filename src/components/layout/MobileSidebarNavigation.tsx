/**
 * MobileSidebarNavigation - 移动统一抽屉的全局应用入口
 *
 * - settingsOnly：抽屉 head 右侧设置齿轮
 * - 默认：head 之下的二行三列入口（会话 / 资源 / 待办 / 技能 / 闪卡 / 数据）
 */

import React, { createContext, useContext, useMemo, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { useSlot } from '@/ui-kernel/react';
import type { ShellNavItem, ShellView } from '@/ui-kernel/contracts/shell';
import { renderNavigationIcon } from '@/ui-plugins/official/shell/renderNavigationIcon';
import { resolveShellView, shellNavigationItems } from '@/ui-plugins/official/shell/navigation';
import type { CurrentView } from '@/types/navigation';
import { useViewStore } from '@/stores/viewStore';
import { isNavEntryActive, resolveNavEntryClick } from '@/app/navigation/cardsHub';
import { useIsUILabEnabled } from '@/utils/uiLabToggle';
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
  onNavigate?: (view?: CurrentView) => void;
  className?: string;
  /** Render only the settings icon used by the mobile drawer header or footer. */
  settingsOnly?: boolean;
  /** Omit settings from the scrollable navigation when it is rendered in the header/footer. */
  hideSettings?: boolean;
  /**
   * @deprecated 现在只有「嵌在统一滚动抽屉内」这一种形态（旧版 pinned 底栏
   * 分支已删除），该 prop 不再被读取，保留仅为兼容既有调用方。
   */
  embedded?: boolean;
}

export const MobileSidebarNavigation: React.FC<MobileSidebarNavigationProps> = ({
  onNavigate,
  className,
  settingsOnly = false,
}) => {
  const { t, i18n } = useTranslation(['sidebar', 'common']);
  const currentView = useViewStore((state) => state.currentView);
  const uiLabEnabled = useIsUILabEnabled();
  const navEntries = useSlot<ShellNavItem>('nav');
  const viewEntries = useSlot<ShellView>('views');
  const navItems = useMemo(() => shellNavigationItems(navEntries, { dev: import.meta.env.DEV, uiLabEnabled }, 'mobile'), [navEntries, uiLabEnabled]);
  const navigateDirect = useContext(MobileAppNavigationContext);

  const currentCanonicalView = resolveShellView(currentView, viewEntries);
  const settingsItem = useMemo(
    () => navItems.find((item) => item.mobile?.placement === 'settings'),
    [navItems],
  );

  const launcherItems = useMemo(() => (
    navItems.filter(item => item.mobile?.placement === 'launcher').map((item) => {
      const resolvedLabelKey = item.owner && !item.labelKey.includes(':') && typeof i18n?.exists === 'function'
        ? (i18n.exists(`${item.owner}:${item.labelKey}`)
            ? `${item.owner}:${item.labelKey}`
            : (i18n.exists(`${item.owner}:title`) ? `${item.owner}:title` : item.labelKey))
        : item.labelKey;
      return {
        id: item.id,
        owner: item.owner,
        origin: item.origin,
        view: item.viewId as CurrentView,
        name: item.mobile?.label ? t(item.mobile.label.key, item.mobile.label.fallback) : t(resolvedLabelKey),
        ariaLabel: item.mobile?.ariaLabel ? t(item.mobile.ariaLabel.key, item.mobile.ariaLabel.fallback) : t(resolvedLabelKey),
        icon: item.mobile?.icon ?? item.icon,
      };
    })
  ), [i18n, navItems, t]);

  const handleNavigate = useCallback((entryView: CurrentView) => {
    // 闪卡中心入口：已在组内保持当前分区，否则回到最近访问的分区
    const view = resolveNavEntryClick(entryView, currentView);
    if (navigateDirect) {
      const accepted = navigateDirect(view);
      if (accepted === false) return;
    } else {
      dispatchAppEvent(APP_EVENTS.MOBILE_APP_NAVIGATE, { view });
    }
    onNavigate?.(view);
  }, [currentView, navigateDirect, onNavigate]);

  if (settingsOnly) {
    if (!settingsItem) return null;
    const SettingsIcon = settingsItem.icon;
    return (
      <DsButton
        variant="ghost"
        size="icon"
        iconOnly
        data-mobile-shell="sidebar-settings"
        className={cn(
          // !h-11 !w-11 = 44px：触控目标底线（同导航格口径）
          'shell-icon-button !h-11 !w-11 !rounded-full shrink-0 text-muted-foreground',
          className,
        )}
        aria-label={settingsItem.fallback === undefined ? t(settingsItem.labelKey) : t(settingsItem.labelKey, settingsItem.fallback)}
        onClick={() => handleNavigate(settingsItem.viewId as CurrentView)}
      >
        {renderNavigationIcon(settingsItem.origin, settingsItem.owner, settingsItem.id, SettingsIcon, { className: 'size-5' })}
      </DsButton>
    );
  }

  return (
    <nav
      data-mobile-shell="sidebar-nav"
      data-mobile-app-launcher=""
      aria-label={t('common:navigation_label')}
      className={cn('grid grid-cols-3 gap-x-0.5 gap-y-0', className)}
    >
      {launcherItems.map(({ id, owner, origin, view, icon: Icon, name, ariaLabel }) => {
        const isActive = isNavEntryActive(resolveShellView(view, viewEntries), currentCanonicalView);
        return (
          <button
            key={`${owner}/${id}`}
            type="button"
            aria-label={ariaLabel}
            aria-current={isActive ? 'page' : undefined}
            onClick={() => handleNavigate(view)}
            className={cn(
              // min-h-11 = 44px：达到 Apple HIG / Material 触控目标底线（移动端 root 16px 下 rem 标称生效）
              // 注意不要用 text-sm：typography.css 把 .text-sm 重定义为 --font-size-sm(12px)
              'flex min-h-11 flex-row items-center gap-1.5 rounded-md px-1.5',
              'text-[14px] leading-none text-[color:var(--shell-navigation-muted)]',
              'outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
              isActive && 'bg-[color:hsl(var(--primary)/0.1)] text-[color:var(--shell-navigation-foreground)]',
            )}
          >
            {renderNavigationIcon(origin, owner, id, Icon, { className: 'size-[25px] shrink-0' })}
            <span className="min-w-0 truncate">{name}</span>
          </button>
        );
      })}
    </nav>
  );
};

export default MobileSidebarNavigation;
