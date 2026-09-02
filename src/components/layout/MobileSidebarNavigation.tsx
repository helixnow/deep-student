/**
 * MobileSidebarNavigation - 移动统一抽屉的全局应用入口
 *
 * - settingsOnly：抽屉 head 右侧设置齿轮
 * - 默认：head 之下的二行三列入口（会话 / 资源 / 待办 / 技能 / 制卡 / 数据）
 */

import React, { createContext, useContext, useMemo, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Database } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import {
  createNavItems,
  MOBILE_APP_LAUNCHER_VIEWS,
  type MobileAppLauncherView,
} from '@/config/navigation';
import type { CurrentView } from '@/types/navigation';
import { useViewStore } from '@/stores/viewStore';
import { canonicalizeView } from '@/app/navigation/canonicalView';
import { useIsUILabEnabled } from '@/utils/uiLabToggle';
import {
  StudyBooksIcon,
  StudyChatIcon,
  StudyMagicWandIcon,
  StudyStackIcon,
  StudyTodoIcon,
} from '@/components/icons/StudySidebarIcons';
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

const LAUNCHER_ICONS: Record<MobileAppLauncherView, React.ElementType> = {
  'chat-v2': StudyChatIcon,
  'learning-hub': StudyBooksIcon,
  todo: StudyTodoIcon,
  'skills-management': StudyMagicWandIcon,
  'task-dashboard': StudyStackIcon,
  'data-management': Database,
};

const LAUNCHER_SHORT_LABEL: Record<MobileAppLauncherView, { key: string; fallback: string }> = {
  'chat-v2': { key: 'sidebar:navigation.launcher.chat_v2', fallback: '会话' },
  'learning-hub': { key: 'sidebar:navigation.launcher.learning_hub', fallback: '资源' },
  todo: { key: 'sidebar:navigation.launcher.todo', fallback: '待办' },
  'skills-management': { key: 'sidebar:navigation.launcher.skills_management', fallback: '技能' },
  'task-dashboard': { key: 'sidebar:navigation.launcher.task_dashboard', fallback: '制卡' },
  'data-management': { key: 'sidebar:navigation.launcher.data_management', fallback: '数据' },
};

const LAUNCHER_FULL_LABEL: Record<MobileAppLauncherView, { key: string; fallback: string }> = {
  'chat-v2': { key: 'sidebar:navigation.sessions', fallback: '会话' },
  'learning-hub': { key: 'sidebar:navigation.learning_hub', fallback: '学习资源' },
  todo: { key: 'sidebar:navigation.todo', fallback: '待办' },
  'skills-management': { key: 'sidebar:navigation.skills_management', fallback: '技能管理' },
  'task-dashboard': { key: 'sidebar:navigation.anki_generation', fallback: 'Anki制卡' },
  'data-management': { key: 'common:navigation.data_management', fallback: '数据管理' },
};

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
  const { t } = useTranslation(['sidebar', 'common']);
  const currentView = useViewStore((state) => state.currentView);
  const uiLabEnabled = useIsUILabEnabled();
  const navItems = useMemo(() => createNavItems(t, uiLabEnabled), [t, uiLabEnabled]);
  const navigateDirect = useContext(MobileAppNavigationContext);

  const currentCanonicalView = canonicalizeView(currentView);
  const settingsItem = useMemo(
    () => navItems.find((item) => canonicalizeView(item.view) === 'settings'),
    [navItems],
  );

  const launcherItems = useMemo(() => (
    MOBILE_APP_LAUNCHER_VIEWS.map((view) => ({
      view,
      name: t(LAUNCHER_SHORT_LABEL[view].key, LAUNCHER_SHORT_LABEL[view].fallback),
      ariaLabel: t(LAUNCHER_FULL_LABEL[view].key, LAUNCHER_FULL_LABEL[view].fallback),
      icon: LAUNCHER_ICONS[view],
    }))
  ), [t]);

  const handleNavigate = useCallback((view: CurrentView) => {
    if (navigateDirect) {
      const accepted = navigateDirect(view);
      if (accepted === false) return;
    } else {
      dispatchAppEvent(APP_EVENTS.MOBILE_APP_NAVIGATE, { view });
    }
    onNavigate?.(view);
  }, [navigateDirect, onNavigate]);

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
        aria-label={settingsItem.name}
        onClick={() => handleNavigate(settingsItem.view)}
      >
        <SettingsIcon className="size-5" />
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
      {launcherItems.map(({ view, icon: Icon, name, ariaLabel }) => {
        const isActive = currentCanonicalView === canonicalizeView(view);
        return (
          <button
            key={view}
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
            <Icon className="size-[25px] shrink-0" />
            <span className="min-w-0 truncate">{name}</span>
          </button>
        );
      })}
    </nav>
  );
};

export default MobileSidebarNavigation;
