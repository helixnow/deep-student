import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Books,
  ChartBar,
  FileText,
  Lightning,
  SlidersHorizontal,
  Sparkle,
} from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { APP_EVENTS, dispatchAppEvent } from '@/events';

export type CardsHubReviewScreen = 'today' | 'library' | 'settings' | 'scheduler';
export type CardsHubDesktopSection = CardsHubReviewScreen | 'generate' | 'templates';

/** 跨视图通知闪卡应用切换到指定复习子屏的事件名 */
export const CARDS_HUB_SELECT_SCREEN_EVENT = 'flashcards:select-screen';

export interface CardsHubDesktopNavProps {
  activeSection: CardsHubDesktopSection;
  dueTotal?: number;
  onSelectReviewScreen?: (screen: CardsHubReviewScreen) => void;
  className?: string;
}

/**
 * 闪卡中心桌面端（经典壳）唯一单层导航条：
 * 将「今日 / 库 / 统计 / 制卡 / 模板」拍平在同一行，彻底消除
 * 「顶栏胶囊分段器 + 页内下划线 Tab」的双层导航叠罗汉。
 */
let pendingCardsHubScreen: CardsHubReviewScreen | null = null;

export function consumePendingCardsHubScreen(): CardsHubReviewScreen | null {
  const next = pendingCardsHubScreen;
  pendingCardsHubScreen = null;
  return next;
}

export const CardsHubDesktopNav: React.FC<CardsHubDesktopNavProps> = ({
  activeSection,
  dueTotal = 0,
  onSelectReviewScreen,
  className,
}) => {
  const { t } = useTranslation(['flashcards', 'sidebar']);

  const navigateToReviewScreen = (screen: CardsHubReviewScreen) => {
    if (onSelectReviewScreen) {
      onSelectReviewScreen(screen);
      return;
    }
    pendingCardsHubScreen = screen;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent<{ screen: CardsHubReviewScreen }>(CARDS_HUB_SELECT_SCREEN_EVENT, {
          detail: { screen },
        }),
      );
    }
    dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'flashcards' });
  };

  const items: Array<{
    id: CardsHubDesktopSection;
    testId: string;
    icon: React.ReactNode;
    label: string;
    badge?: string;
    onClick: () => void;
  }> = [
    {
      id: 'today',
      testId: 'fc-tab-today',
      icon: <Lightning size={15} weight="duotone" />,
      label: t('flashcards:tabs.today'),
      badge: dueTotal > 0 ? (dueTotal > 99 ? '99+' : String(dueTotal)) : undefined,
      onClick: () => navigateToReviewScreen('today'),
    },
    {
      id: 'library',
      testId: 'fc-tab-library',
      icon: <Books size={15} weight="duotone" />,
      label: t('flashcards:tabs.library'),
      onClick: () => navigateToReviewScreen('library'),
    },
    {
      id: 'settings',
      testId: 'fc-tab-settings',
      icon: <ChartBar size={15} weight="duotone" />,
      label: t('flashcards:tabs.statistics'),
      onClick: () => navigateToReviewScreen('settings'),
    },
    {
      id: 'generate',
      testId: 'fc-tab-generate',
      icon: <Sparkle size={15} weight="duotone" />,
      label: t('sidebar:navigation.cards_hub.generate', { defaultValue: '制卡' }),
      onClick: () => dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'task-dashboard' }),
    },
    {
      id: 'templates',
      testId: 'fc-tab-templates',
      icon: <FileText size={15} weight="duotone" />,
      label: t('sidebar:navigation.cards_hub.templates', { defaultValue: '模板' }),
      onClick: () => dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'template-management' }),
    },
    {
      id: 'scheduler',
      testId: 'fc-tab-scheduler',
      icon: <SlidersHorizontal size={15} weight="duotone" />,
      label: t('flashcards:tabs.settings'),
      onClick: () => navigateToReviewScreen('scheduler'),
    },
  ];

  return (
    <nav
      className={cn('wb-fc-nav', className)}
      aria-label={t('sidebar:navigation.cards_hub.aria', { defaultValue: '闪卡分区' })}
      data-cards-hub-desktop-nav="true"
    >
      {items.map((item) => {
        const active = activeSection === item.id;
        return (
          <DsButton
            key={item.id}
            variant="ghost"
            size="sm"
            data-testid={item.testId}
            onClick={item.onClick}
            data-active={active ? 'true' : undefined}
            aria-current={active ? 'page' : undefined}
            className="wb-fc-tab wb-fcx-tab !h-auto !min-h-0 !rounded-b-none !border-x-0 !border-t-0 !bg-transparent hover:!bg-transparent"
          >
            {item.icon}
            <span>{item.label}</span>
            {item.badge ? (
              <span className="wb-fcx-tab-badge" aria-hidden="true">
                {item.badge}
              </span>
            ) : null}
          </DsButton>
        );
      })}
    </nav>
  );
};
