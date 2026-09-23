import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MobileLayoutProvider } from '@/components/layout/MobileLayoutContext';
import { MobileHeaderActiveViewSync, MobileHeaderProvider } from '@/components/layout/MobileHeaderContext';
import { MobileAppNavigationProvider } from '@/components/layout/MobileSidebarNavigation';
import { useFsrsReviewStore } from '@/features/flashcards/store/fsrsReviewStore';
import { FlashcardsApp } from '@/features/flashcards/FlashcardsApp';
import { useFlashcardsLibraryStore } from '@/features/flashcards/store/libraryStore';
import { handleAndroidBack } from '@/app/navigation/androidBackCoordinator';

const initialReview = useFsrsReviewStore.getState();
const initialLibrary = useFlashcardsLibraryStore.getState();

const mocks = vi.hoisted(() => ({
  isSmallScreen: true,
  navigate: vi.fn(),
  t: (key: string) => key,
  refreshLibrary: vi.fn().mockResolvedValue(undefined),
  createCard: vi.fn().mockResolvedValue(true),
  updateCard: vi.fn().mockResolvedValue(true),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: mocks.isSmallScreen }),
}));
vi.mock('@/features/flashcards/screens/TodayScreen', () => ({
  TodayScreen: () => <div>Today content</div>,
}));
vi.mock('@/features/flashcards/screens/StatisticsScreen', () => ({
  StatisticsScreen: () => <div>Statistics content</div>,
}));
vi.mock('@/hooks/useAnkiTemplateLoader', () => ({
  useAnkiTemplateLoader: () => ({ template: null, loading: false }),
}));
vi.mock('@/components/anki/AnkiTemplateCardFace', () => ({
  AnkiTemplateCardFace: ({ fallbackText }: { fallbackText: string }) => <div>{fallbackText}</div>,
}));

function renderApp(isActive = true) {
  return render(
    <MobileLayoutProvider>
      <MobileHeaderProvider>
        <MobileHeaderActiveViewSync activeView="flashcards" />
        <MobileAppNavigationProvider navigate={mocks.navigate}>
          <FlashcardsApp isActive={isActive} />
        </MobileAppNavigationProvider>
      </MobileHeaderProvider>
    </MobileLayoutProvider>,
  );
}

describe('Flashcards mobile navigation', () => {
  beforeEach(() => {
    mocks.isSmallScreen = true;
    mocks.navigate.mockReset();
    mocks.refreshLibrary.mockReset().mockResolvedValue(undefined);
    mocks.createCard.mockReset().mockResolvedValue(true);
    mocks.updateCard.mockReset().mockResolvedValue(true);
    useFsrsReviewStore.setState({ ...initialReview, screen: 'today', dueTotal: 0, loadDue: vi.fn().mockResolvedValue(true), updateCurrentCard: mocks.updateCard });
    useFlashcardsLibraryStore.setState({ ...initialLibrary, items: [], loaded: true, refresh: mocks.refreshLibrary, createCard: mocks.createCard });
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 844,
      width: 390, height: 844, toJSON: () => ({}),
    });
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
  });

  afterEach(() => {
    cleanup();
    useFsrsReviewStore.setState(initialReview, true);
    useFlashcardsLibraryStore.setState(initialLibrary, true);
    vi.restoreAllMocks();
  });

  it('opens the shared drawer from the header and closes it after switching screens', async () => {
    const { container } = renderApp();
    expect(screen.getByRole('heading', { name: 'today.title' })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-mobile-shell="header"]')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'tabs.library' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'common:mobile_header.open_sidebar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'tabs.library' }));
    expect(useFsrsReviewStore.getState().screen).toBe('library');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'tabs.library' })).not.toBeInTheDocument());
    expect(screen.getAllByRole('heading', { name: 'library.title' })).toHaveLength(1);
    const header = container.querySelector('[data-mobile-shell="header"]') as HTMLElement;
    expect(within(header).getByRole('button', { name: 'library.create.new' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'library.create.new' })).toHaveLength(1);
    fireEvent.click(within(header).getByRole('button', { name: 'common:more' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'library.refresh' }));
    expect(mocks.refreshLibrary).toHaveBeenCalledTimes(2);
  });

  it('publishes composer save/back and restores the library after saving or system back', async () => {
    useFsrsReviewStore.setState({ screen: 'library' });
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'library.create.new' }));
    expect(screen.getByRole('heading', { name: 'library.create.new' })).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'library.create.save' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'library.create.frontLabel' }), { target: { value: 'Question' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'library.create.backLabel' }), { target: { value: 'Answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'library.create.save' }));
    await screen.findByRole('heading', { name: 'library.title' });
    expect(mocks.createCard).toHaveBeenCalledWith({ front: 'Question', back: 'Answer' });
    fireEvent.click(screen.getByRole('button', { name: 'library.create.new' }));
    act(() => { expect(handleAndroidBack()).toBe(true); });
    expect(screen.getByRole('heading', { name: 'library.title' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'library.create.save' })).not.toBeInTheDocument();
  });

  it('returns from edit to review, then from review to the originating library', async () => {
    useFsrsReviewStore.setState({ screen: 'library' });
    const { container } = renderApp();
    act(() => useFsrsReviewStore.setState({
      screen: 'session', queue: [{ id: 'state-1', ankiCardId: 'card-1', front: 'Question', back: 'Answer' }], queueIndex: 0,
    }));
    expect(screen.getByRole('heading', { name: 'session.title' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'session.exit' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common:more' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'session.edit' }));
    expect(screen.getByRole('heading', { name: 'session.edit' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'session.saveEdit' })).toHaveLength(1);
    fireEvent.change(screen.getByRole('textbox', { name: 'session.front' }), { target: { value: 'Revised question' } });
    fireEvent.click(screen.getByRole('button', { name: 'session.saveEdit' }));
    await screen.findByRole('heading', { name: 'session.title' });
    expect(mocks.updateCard).toHaveBeenCalledWith('Revised question', 'Answer', null);
    fireEvent.click(screen.getByRole('button', { name: 'common:more' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'session.edit' }));
    act(() => { expect(handleAndroidBack()).toBe(true); });
    expect(screen.getByRole('heading', { name: 'session.title' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common:mobile_header.back' }));
    expect(screen.getByRole('heading', { name: 'library.title' })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-mobile-shell="header"]')).toHaveLength(1);
  });

  it('provides the same global app navigation as other mobile drawers', async () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'common:mobile_header.open_sidebar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'sidebar:navigation.learning_hub' }));
    expect(mocks.navigate).toHaveBeenCalledWith('learning-hub');
  });

  it('keeps desktop tabs without adding a mobile header', () => {
    mocks.isSmallScreen = false;
    const { container } = renderApp();
    expect(container.querySelector('[data-mobile-shell="header"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'tabs.statistics' }));
    expect(screen.getByText('Statistics content')).toBeInTheDocument();
  });
});
