import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: true }),
}));
vi.mock('@/components/layout/MobileHeaderContext', () => ({
  useMobileHeader: () => undefined,
}));
vi.mock('@/components/layout/MobileSlidingLayout', () => ({
  MobileSlidingLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mobile-sliding-layout">{children}</div>
  ),
}));
vi.mock('@/ui-kernel/bootstrap', () => ({
  getAppKernel: () => null,
}));
vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  BACK_PRIORITY: { view: 1 },
  registerVisibilityGuardedBackHandler: () => () => undefined,
}));
vi.mock('../screens/TodayScreen', () => ({
  TodayScreen: () => <div data-testid="today-screen">today</div>,
}));
vi.mock('../screens/LibraryScreen', () => ({
  LibraryScreen: () => <div data-testid="library-screen">library</div>,
}));
vi.mock('../screens/StatisticsScreen', () => ({
  StatisticsScreen: () => <div data-testid="statistics-screen">statistics</div>,
}));
vi.mock('../screens/ReviewSessionScreen', () => ({
  ReviewSessionScreen: () => <div data-testid="session-screen">session</div>,
}));
vi.mock('../occlusion/ImageOcclusionBuilderModal', () => ({
  ImageOcclusionBuilderModal: () => null,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'tabs.nav': '闪卡视图',
      'tabs.today': '今日',
      'tabs.library': '库',
      'tabs.statistics': '统计',
      'today.title': '今日复习',
      'library.title': '卡片库',
      'statistics.title': '统计',
      'sidebar:navigation.flashcards': '闪卡',
    }[key] ?? key),
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { FlashcardsApp } from '../FlashcardsApp';
import { useFsrsReviewStore } from '../store/fsrsReviewStore';

describe('FlashcardsApp 360px mobile navigation tabs', () => {
  beforeEach(() => {
    useFsrsReviewStore.setState({
      screen: 'today',
      dueCards: [],
      dueTotal: 0,
      queue: [],
      queueIndex: 0,
      loading: false,
      error: null,
      errorKind: null,
    });
  });

  it('hides the desktop top tab bar on mobile so navigation stays in the sliding drawer', () => {
    render(<FlashcardsApp />);

    expect(screen.queryByTestId('fc-tab-today')).toBeNull();
    expect(screen.queryByTestId('fc-tab-library')).toBeNull();
    expect(screen.queryByTestId('fc-tab-settings')).toBeNull();
    expect(screen.getByTestId('today-screen')).toBeInTheDocument();
  });
});
