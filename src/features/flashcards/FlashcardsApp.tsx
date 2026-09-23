/**
 * 闪卡应用主界面 — 今日 / 库 / 统计 三屏 + 复习会话
 *
 * 屏幕切换带轻量过渡（transform/opacity，尊重 reduced-motion）；
 * 今日 tab 显示到期数 badge。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Books, ChartBar, Lightning } from '@phosphor-icons/react';
import { useMobileHeader } from '@/components/layout/MobileHeaderContext';
import { MobileSlidingLayout } from '@/components/layout/MobileSlidingLayout';
import {
  mobileDrawerNavRowClassName,
  mobileDrawerRowIconWrapClassName,
  mobileDrawerRowTitleClassName,
  mobileDrawerSectionLabelClassName,
} from '@/components/layout/mobileDrawerStyles';
import { DsButton } from '@/components/ui/DsButton';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { BACK_PRIORITY, registerVisibilityGuardedBackHandler } from '@/app/navigation/androidBackCoordinator';
import { FlashcardsMobileChromeContext, type FlashcardsMobileChrome } from './useFlashcardsMobileChrome';
import { TodayScreen } from './screens/TodayScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { ReviewSessionScreen } from './screens/ReviewSessionScreen';
import { StatisticsScreen } from './screens/StatisticsScreen';
import {
  useFsrsReviewStore,
  type FlashcardsScreen,
} from './store/fsrsReviewStore';
import './flashcards.css';
import './flashcards-dashboard.css';

const TABS: Array<{
  id: Exclude<FlashcardsScreen, 'session'>;
  icon: React.ReactNode;
  labelKey: string;
}> = [
  { id: 'today', icon: <Lightning size={16} weight="duotone" />, labelKey: 'tabs.today' },
  { id: 'library', icon: <Books size={16} weight="duotone" />, labelKey: 'tabs.library' },
  { id: 'settings', icon: <ChartBar size={16} weight="duotone" />, labelKey: 'tabs.statistics' },
];

export interface FlashcardsAppProps {
  launchPayload?: unknown;
  /** 工作台窗口/标签页是否处于前台；缺省保持独立宿主兼容。 */
  isActive?: boolean;
}

export const FlashcardsApp: React.FC<FlashcardsAppProps> = ({
  launchPayload,
  isActive = true,
}) => {
  const { t } = useTranslation('flashcards');
  const { isSmallScreen } = useBreakpoint();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileChrome, setMobileChrome] = useState<FlashcardsMobileChrome | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const reviewOrigin = useRef<Exclude<FlashcardsScreen, 'session'>>('today');
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);
  const screen = useFsrsReviewStore((s) => s.screen);
  const setScreen = useFsrsReviewStore((s) => s.setScreen);
  const applyLaunchPayload = useFsrsReviewStore((s) => s.applyLaunchPayload);
  const dueTotal = useFsrsReviewStore((s) => s.dueTotal);
  const endSession = useFsrsReviewStore((s) => s.endSession);

  useEffect(() => {
    if (screen !== 'session') reviewOrigin.current = screen;
  }, [screen]);
  const exitReview = useCallback(() => {
    endSession();
    setScreen(reviewOrigin.current);
  }, [endSession, setScreen]);

  const onBack = mobileChrome?.onBack;
  useMobileHeader('flashcards', {
    title: mobileChrome?.title ?? t(screen === 'settings' ? 'statistics.title' : `${screen}.title`),
    subtitle: mobileChrome?.subtitle,
    rightActions: mobileChrome?.rightActions,
    showMenu: !onBack,
    showBackArrow: Boolean(onBack),
    onMenuClick: onBack ?? toggleSidebar,
  }, [t, screen, mobileChrome, onBack, toggleSidebar, isActive], isActive);

  useEffect(() => {
    if (!isSmallScreen || !isActive || !onBack) return;
    return registerVisibilityGuardedBackHandler(rootRef, () => {
      onBack();
      return true;
    }, BACK_PRIORITY.view);
  }, [isSmallScreen, isActive, onBack]);

  useEffect(() => {
    applyLaunchPayload(launchPayload);
  }, [applyLaunchPayload, launchPayload]);

  const content = screen === 'session' ? (
    <div key="session" className="wb-fcx-screen-anim flex min-h-0 flex-1 flex-col">
      <ReviewSessionScreen isActive={isActive} onExit={isSmallScreen ? exitReview : undefined} />
    </div>
  ) : (
    <>
      {!isSmallScreen && (
        <nav className="wb-fc-nav" aria-label={t('tabs.nav')}>
          {TABS.map((tab) => {
            const active = screen === tab.id;
            const showDueBadge = tab.id === 'today' && dueTotal > 0;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setScreen(tab.id)}
                className="wb-fc-tab wb-fcx-tab"
                data-active={active ? 'true' : undefined}
                aria-current={active ? 'page' : undefined}
              >
                {tab.icon}
                {t(tab.labelKey)}
                {showDueBadge ? (
                  <span className="wb-fcx-tab-badge" aria-hidden="true">
                    {dueTotal > 99 ? '99+' : dueTotal}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>
      )}
      <div className="wb-fc-body">
        <div key={screen} className="wb-fcx-screen-anim">
          {screen === 'today' ? <TodayScreen /> : null}
          {screen === 'library' ? <LibraryScreen /> : null}
          {screen === 'settings' ? <StatisticsScreen /> : null}
        </div>
      </div>
    </>
  );

  const mobileSidebar = (
    <nav className="min-h-0 space-y-0.5 pb-1 pt-1 text-foreground" aria-label={t('tabs.nav')}>
      <span className={mobileDrawerSectionLabelClassName}>{t('sidebar:navigation.flashcards')}</span>
      {TABS.map((tab) => (
        <DsButton
          key={tab.id}
          variant="ghost"
          className={mobileDrawerNavRowClassName(screen === tab.id)}
          aria-current={screen === tab.id ? 'page' : undefined}
          onClick={() => {
            if (screen === 'session') endSession();
            setScreen(tab.id);
            setSidebarOpen(false);
          }}
        >
          <span className={mobileDrawerRowIconWrapClassName}>{tab.icon}</span>
          <span className={mobileDrawerRowTitleClassName}>{t(tab.labelKey)}</span>
          {tab.id === 'today' && dueTotal > 0 ? (
            <span className="text-xs text-muted-foreground" aria-hidden="true">
              {dueTotal > 99 ? '99+' : dueTotal}
            </span>
          ) : null}
        </DsButton>
      ))}
    </nav>
  );

  return (
    <div ref={rootRef} className="wb-fc-root flex flex-col overflow-hidden" data-flashcards-app>
      <FlashcardsMobileChromeContext.Provider value={isSmallScreen && isActive ? setMobileChrome : null}>
        {isSmallScreen ? (
          <MobileSlidingLayout
            sidebar={mobileSidebar}
            sidebarOpen={sidebarOpen}
            onSidebarOpenChange={setSidebarOpen}
            // Subpages own back navigation; review cards own swipe-to-rate gestures.
            enableGesture={screen !== 'session' && !onBack}
            showSidebarAppNavigation
            showContentOverlay
            className="flex-1"
          >
            <div className="flex h-full min-h-0 flex-col">{content}</div>
          </MobileSlidingLayout>
        ) : content}
      </FlashcardsMobileChromeContext.Provider>
    </div>
  );
};

export default FlashcardsApp;
