/**
 * BottomTabBar - 移动端底部导航栏
 *
 * 替代桌面端的 ModernSidebar，提供移动端友好的底部Tab导航
 * 遵循 iOS/Android 设计规范，支持安全区域适配
 *
 * 5个主要Tab：聊天、Anki、学习资源、技能、设置
 */

import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { CurrentView } from '@/types/navigation';
import { createNavItems, type NavItem } from '@/config/navigation';
import { useMobileLayoutSafe } from './MobileLayoutContext';

const BOTTOM_TABS: CurrentView[] = ['chat-v2', 'skills-management', 'learning-hub', 'task-dashboard', 'settings'];

export interface BottomTabBarProps {
  currentView: CurrentView;
  onViewChange: (view: CurrentView) => void;
  className?: string;
  showLabels?: boolean;
}

export const BottomTabBar: React.FC<BottomTabBarProps> = ({
  currentView,
  onViewChange,
  className,
  showLabels = true,
}) => {
  const { t } = useTranslation(['sidebar', 'common']);

  const mobileLayout = useMobileLayoutSafe();
  const isHidden = mobileLayout?.isFullscreenContent ?? false;

  const allNavItems = useMemo(() => createNavItems(t), [t]);

  const tabItems = useMemo(() => {
    const items: NavItem[] = [];

    allNavItems.forEach((item) => {
      if (BOTTOM_TABS.includes(item.view as CurrentView)) {
        items.push(item);
      }
    });

    items.sort((a, b) => {
      const aIndex = BOTTOM_TABS.indexOf(a.view as CurrentView);
      const bIndex = BOTTOM_TABS.indexOf(b.view as CurrentView);
      return aIndex - bIndex;
    });

    return items;
  }, [allNavItems]);

  const handleViewChange = useCallback((view: CurrentView) => {
    onViewChange(view);
  }, [onViewChange]);

  return (
    <nav
      className={cn(
        "fixed bottom-0 left-0 right-0 z-50",
        "flex flex-col",
        "bg-background/95 backdrop-blur-lg",
        "border-t border-border/40",
        "transition-transform duration-300 ease-out",
        isHidden && "translate-y-full",
        className
      )}
      style={{
        boxSizing: 'border-box',
      }}
      role="tablist"
      aria-label={t('common:navigation_label', 'Navigation')}
      aria-hidden={isHidden}
    >
      <div 
        className="flex items-center justify-around w-full"
        style={{
          height: showLabels ? 56 : 48,
          minHeight: showLabels ? 56 : 48,
        }}
      >
        {tabItems.map(({ view, icon: Icon, name }) => {
          const isActive = currentView === view;

          return (
            <button
              key={view}
              role="tab"
              aria-selected={isActive}
              aria-label={name}
              onClick={() => handleViewChange(view as CurrentView)}
              className={cn(
                "flex flex-col items-center justify-center relative",
                "flex-1 h-full",
                showLabels ? "gap-1" : "gap-0.5",
                "transition-colors duration-150",
                "active:scale-95 active:opacity-80",
                "touch-manipulation select-none",
                isActive
                  ? "text-primary"
                  : "text-muted-foreground"
              )}
            >
              <Icon
                className={cn(
                  "transition-transform duration-150",
                  showLabels ? "w-5 h-5" : "w-6 h-6",
                  isActive && "scale-110"
                )}
                strokeWidth={isActive ? 2.5 : 2}
              />
              {showLabels && (
                <span
                  className={cn(
                    "text-[10px] font-medium truncate max-w-[56px]",
                    isActive && "font-semibold"
                  )}
                >
                  {name}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {/* 安全区域占位：与导航栏保持相同的毛玻璃效果 */}
      <div 
        className="w-full"
        style={{
          height: 'var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))',
          minHeight: 'var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))',
        }}
      />
    </nav>
  );
};

export default BottomTabBar;
