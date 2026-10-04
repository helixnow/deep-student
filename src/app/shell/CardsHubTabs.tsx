import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { cn } from '@/lib/utils';
import {
  CARDS_HUB_TABS,
  getCardsHubTabForView,
  type CardsHubView,
} from '@/app/navigation/cardsHub';
import type { CurrentView } from '@/types/navigation';

export interface CardsHubTabsProps {
  currentView: CurrentView;
  onNavigate: (view: CardsHubView) => void;
  /**
   * titlebar：桌面标题栏内的紧凑分段控件（紧随页面标题）；
   * mobile：移动端页内顶栏下方的整宽分段条（随主栏一起滑动）。
   */
  variant: 'titlebar' | 'mobile';
  className?: string;
}

/** 闪卡中心分区切换：复习 / 制卡 / 模板 */
export const CardsHubTabs: React.FC<CardsHubTabsProps> = ({
  currentView,
  onNavigate,
  variant,
  className,
}) => {
  const { t } = useTranslation('sidebar');
  const activeTab = getCardsHubTabForView(currentView);

  const options = useMemo(
    () => CARDS_HUB_TABS.map((tab) => ({
      value: tab.view,
      label: t(tab.labelKey, tab.fallbackLabel),
    })),
    [t],
  );

  if (!activeTab) return null;

  const control = (
    <SegmentedControl<CardsHubView>
      ariaLabel={t('sidebar:navigation.cards_hub.aria', '闪卡分区')}
      value={activeTab.view}
      onValueChange={onNavigate}
      options={options}
      size={variant === 'titlebar' ? 'compact' : 'default'}
      stretch={variant === 'mobile'}
      // 本仓 cn 不做 tailwind-merge：覆盖基元的 sm:w-auto / sm:flex-none / flex-wrap 需用 important
      className={variant === 'mobile' ? '!w-full !flex-nowrap' : undefined}
      itemClassName={variant === 'mobile' ? '!flex-1 whitespace-nowrap' : 'whitespace-nowrap'}
    />
  );

  if (variant === 'mobile') {
    return (
      <div
        data-cards-hub-tabs="mobile"
        className={cn('shrink-0 px-3 pb-2', className)}
        style={{
          paddingLeft: 'calc(0.75rem + var(--mobile-safe-area-left, 0px))',
          paddingRight: 'calc(0.75rem + var(--mobile-safe-area-right, 0px))',
        }}
      >
        {control}
      </div>
    );
  }

  return (
    <div
      data-cards-hub-tabs="titlebar"
      data-no-drag
      className={cn('flex shrink-0 items-center', className)}
    >
      {control}
    </div>
  );
};

export default CardsHubTabs;
