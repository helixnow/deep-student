/**
 * 闪卡应用主界面 — 今日 / 库 / 统计 三屏 + 复习会话
 *
 * 屏幕切换带轻量过渡（transform/opacity，尊重 reduced-motion）；
 * 今日 tab 显示到期数 badge。
 */
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Books, ChartBar, Lightning } from '@phosphor-icons/react';
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
  const screen = useFsrsReviewStore((s) => s.screen);
  const setScreen = useFsrsReviewStore((s) => s.setScreen);
  const applyLaunchPayload = useFsrsReviewStore((s) => s.applyLaunchPayload);
  const dueTotal = useFsrsReviewStore((s) => s.dueTotal);

  useEffect(() => {
    applyLaunchPayload(launchPayload);
  }, [applyLaunchPayload, launchPayload]);

  if (screen === 'session') {
    return (
      <div className="wb-fc-root flex flex-col" data-flashcards-app>
        <div key="session" className="wb-fcx-screen-anim flex min-h-0 flex-1 flex-col">
          <ReviewSessionScreen isActive={isActive} />
        </div>
      </div>
    );
  }

  return (
    <div className="wb-fc-root flex flex-col" data-flashcards-app>
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
      <div className="wb-fc-body">
        <div key={screen} className="wb-fcx-screen-anim">
          {screen === 'today' ? <TodayScreen /> : null}
          {screen === 'library' ? <LibraryScreen /> : null}
          {screen === 'settings' ? <StatisticsScreen /> : null}
        </div>
      </div>
    </div>
  );
};

export default FlashcardsApp;
