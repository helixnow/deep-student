/**
 * 闪卡应用主界面 — 今日 / 库 / 设置 三屏 + 复习会话
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
}

export const FlashcardsApp: React.FC<FlashcardsAppProps> = ({ launchPayload }) => {
  const { t } = useTranslation('flashcards');
  const screen = useFsrsReviewStore((s) => s.screen);
  const setScreen = useFsrsReviewStore((s) => s.setScreen);
  const applyLaunchPayload = useFsrsReviewStore((s) => s.applyLaunchPayload);

  useEffect(() => {
    applyLaunchPayload(launchPayload);
  }, [applyLaunchPayload, launchPayload]);

  if (screen === 'session') {
    return (
      <div className="wb-fc-root flex flex-col" data-flashcards-app>
        <ReviewSessionScreen />
      </div>
    );
  }

  return (
    <div className="wb-fc-root flex flex-col" data-flashcards-app>
      <nav className="wb-fc-nav" aria-label={t('tabs.nav')}>
        {TABS.map((tab) => {
          const active = screen === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setScreen(tab.id)}
              className="wb-fc-tab"
              data-active={active ? 'true' : undefined}
              aria-current={active ? 'page' : undefined}
            >
              {tab.icon}
              {t(tab.labelKey)}
            </button>
          );
        })}
      </nav>
      <div className="wb-fc-body">
        {screen === 'today' ? <TodayScreen /> : null}
        {screen === 'library' ? <LibraryScreen /> : null}
        {screen === 'settings' ? <StatisticsScreen /> : null}
      </div>
    </div>
  );
};

export default FlashcardsApp;
