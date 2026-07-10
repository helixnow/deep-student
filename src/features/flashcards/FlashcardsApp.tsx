/**
 * 闪卡应用主界面 — 今日 / 库 / 设置 三屏 + 复习会话
 */
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Books, GearSix, Lightning } from '@phosphor-icons/react';
import { TodayScreen } from './screens/TodayScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { ReviewSessionScreen } from './screens/ReviewSessionScreen';
import {
  useFsrsReviewStore,
  type FlashcardsScreen,
} from './store/fsrsReviewStore';
import './flashcards.css';

const TABS: Array<{
  id: Exclude<FlashcardsScreen, 'session'>;
  icon: React.ReactNode;
  labelKey: string;
  fallback: string;
}> = [
  { id: 'today', icon: <Lightning size={16} weight="duotone" />, labelKey: 'tabs.today', fallback: '今日' },
  { id: 'library', icon: <Books size={16} weight="duotone" />, labelKey: 'tabs.library', fallback: '库' },
  { id: 'settings', icon: <GearSix size={16} weight="duotone" />, labelKey: 'tabs.settings', fallback: '设置' },
];

const SettingsScreen: React.FC = () => {
  const { t } = useTranslation('flashcards');
  return (
    <div className="wb-fc-screen">
      <header>
        <h2 className="wb-fc-title">
          {t('settings.title', '闪卡设置')}
        </h2>
        <p className="wb-fc-subtitle">
          {t('settings.subtitle', '调度参数后续开放。')}
        </p>
      </header>
      <div className="wb-fc-panel space-y-2">
        <p>{t('settings.schedulingNote', '复习节奏由智能调度管理，高级参数将在后续版本开放调整。')}</p>
        <p className="text-xs">
          {t(
            'settings.demoNote',
            '若暂时无法加载真实复习队列，今日页会以演示模式展示示例卡片，便于预览流程。',
          )}
        </p>
      </div>
    </div>
  );
};

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
      <nav className="wb-fc-nav" aria-label={t('tabs.nav', '闪卡导航')}>
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
              {t(tab.labelKey, tab.fallback)}
            </button>
          );
        })}
      </nav>
      <div className="wb-fc-body">
        {screen === 'today' ? <TodayScreen /> : null}
        {screen === 'library' ? <LibraryScreen /> : null}
        {screen === 'settings' ? <SettingsScreen /> : null}
      </div>
    </div>
  );
};

export default FlashcardsApp;
