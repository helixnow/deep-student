import { useMemo } from 'react';
import type { TFunction } from 'i18next';
import type { CurrentView } from '@/types/navigation';
import { isCardsHubView } from '../navigation/cardsHub';
import { CardsHubTabs } from '../shell/CardsHubTabs';

/**
 * App 壳层：当前视图的壳层标题（桌面标题栏文字 / 移动端统一顶栏 fallbackTitle；chat-v2 用
 * 当前会话标题）与闪卡中心移动端分区条（MobileHeaderNav.accessory）。从 App.tsx 原样搬出。
 */
export function useShellViewChrome(
  currentView: CurrentView,
  currentChatHeaderTitle: string,
  t: TFunction,
  isSmallScreen: boolean,
  handleMobileAppNavigate: (view: CurrentView) => boolean,
) {
  const desktopShellViewLabel = useMemo(() => {
    if (currentView === 'chat-v2') {
      // 新会话尚未写入标题时，按 Codex 的行为保持标题区域为空。
      return currentChatHeaderTitle;
    }

    const labels: Partial<Record<CurrentView, string>> = {
      'chat-v2': t('sidebar:navigation.chat_v2'),
      'learning-hub': t('sidebar:navigation.learning_hub'),
      'media': t('sidebar:navigation.media'),
      'settings': t('sidebar:navigation.settings'),
      'dashboard': t('common:navigation.dashboard'),
      // 闪卡中心三个分区共用页面标题，分区由标题旁的 CardsHubTabs 指示
      'task-dashboard': t('sidebar:navigation.flashcards'),
      'flashcards': t('sidebar:navigation.flashcards'),
      'skills-management': t('sidebar:navigation.skills_management'),
      'super-agent': t('sidebar:navigation.super_agent', 'Super-agent'),
      'data-management': t('common:navigation.data_management'),
      'template-management': t('sidebar:navigation.flashcards'),
      'ui-lab': t('sidebar:navigation.ui_lab'),
      'pdf-reader': t('common:navigation.pdf_reader'),
      'sandbox-workbench': t('common:navigation.sandbox_workbench'),
      'todo': t('sidebar:navigation.todo'),
      'crepe-demo': t('common:navigation.crepe_demo'),
      'chat-v2-test': t('common:navigation.chat_v2_test'),
      'llm-playground': t('common:navigation.llm_playground'),
    };

    return labels[currentView] ?? t('common:app.default_header');
  }, [currentChatHeaderTitle, currentView, t]);

  // 闪卡中心移动端分区条：经 MobileHeaderNav.accessory 注入各分区页的页内顶栏下方
  const cardsHubMobileTabs = useMemo(() => (
    isSmallScreen && isCardsHubView(currentView) ? (
      <CardsHubTabs
        variant="mobile"
        currentView={currentView}
        onNavigate={handleMobileAppNavigate}
      />
    ) : undefined
  ), [currentView, handleMobileAppNavigate, isSmallScreen]);

  return { desktopShellViewLabel, cardsHubMobileTabs };
}
