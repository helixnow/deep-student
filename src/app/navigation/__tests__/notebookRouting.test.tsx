import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TFunction } from 'i18next';
import { act, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentView } from '@/types/navigation';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { useViewStore } from '@/stores/viewStore';
import { useViewVisibility } from '@/hooks/useViewVisibility';
import { useFeatureViewContents } from '@/app/hooks/useViewLayerContents';
import { useShellViewChrome } from '@/app/hooks/useShellViewChrome';
import { useShellNavigationEvents } from '@/app/hooks/useShellNavigationEvents';
import { createNavItems, NAV_ITEMS_COUNT } from '@/config/navigation';
import { readAppShellSource } from '@/app/__tests__/appShellSources';

vi.mock('@/lazyComponents', () => ({
  PageLoadingFallback: () => null,
  LazySettings: () => null,
  LazySOTADashboard: () => null,
  LazySkillsManagementPage: () => null,
  LazyTemplateManagementPage: () => null,
  LazyStyleDebugPage: () => null,
  LazyLearningHubPage: () => null,
  LazyNotebookPage: ({ isActive }: { isActive?: boolean }) => (
    <div data-testid="notebook-page" data-active={String(isActive)} />
  ),
  LazySandboxWorkbenchPage: () => null,
  LazyPdfReader: () => null,
  LazyTodoPage: () => null,
  LazyFlashcardsPage: () => null,
  LazyMediaStudioPage: () => null,
  LazyCrepeDemoPage: () => null,
  LazyChatV2IntegrationTest: () => null,
  LazyLLMOutputPlayground: () => null,
  LazyChatV2Page: () => null,
}));
vi.mock('@/components/layout', () => ({
  MobilePageScaffold: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/system-status/FeatureUnavailablePanel', () => ({
  FeatureUnavailablePanel: () => null,
}));
const bus = vi.hoisted(() => ({ enabled: false, launch: vi.fn() }));
vi.mock('@/features/workbench/core/workbenchBus', () => ({
  workbenchBus: { isEnabled: () => bus.enabled, launch: bus.launch },
}));

const t = ((key: string, fallback?: string) => key === 'sidebar:navigation.notes' ? '笔记' : fallback ?? key) as TFunction;
const onTemplateSelected = vi.fn();
const onTemplateSelectionCancel = vi.fn();

function useContents(view: CurrentView) {
  return useFeatureViewContents(view, false, t, false, onTemplateSelected, onTemplateSelectionCancel, 0);
}

function NotebookView({ view }: { view: CurrentView }) {
  return useContents(view).notebookContent;
}

describe('classic notebook navigation', () => {
  beforeEach(() => {
    useViewStore.setState({ currentView: 'chat-v2', previousView: null });
    bus.enabled = false;
    vi.clearAllMocks();
  });

  it('exposes one independent notebook entry and keeps the derived navigation count in sync', () => {
    const items = createNavItems(t);
    const notes = items.filter((item) => item.view === 'notes');
    expect(notes).toHaveLength(1);
    expect(notes[0].name).toBe('笔记');
    expect(notes[0].icon).toBeDefined();
    expect(items.some((item) => item.view === 'learning-hub')).toBe(true);
    expect(NAV_ITEMS_COUNT).toBe(items.length);
  });

  it('opens the dedicated notes page but preserves Markdown and new-Markdown-note navigation', () => {
    const navigate = vi.fn();
    renderHook(() => useShellNavigationEvents(navigate));

    act(() => dispatchAppEvent(APP_EVENTS.OPEN_NOTES));
    expect(navigate).toHaveBeenLastCalledWith('notes');
    act(() => dispatchAppEvent(APP_EVENTS.OPEN_MARKDOWN_EDITOR));
    expect(navigate).toHaveBeenLastCalledWith('learning-hub');
    act(() => dispatchAppEvent(APP_EVENTS.NOTES_CREATE_NEW));
    expect(navigate).toHaveBeenLastCalledWith('learning-hub');
  });

  it('opens the notebook workbench app for OPEN_NOTES when the desktop OS is active', () => {
    bus.enabled = true;
    const navigate = vi.fn();
    renderHook(() => useShellNavigationEvents(navigate));

    act(() => dispatchAppEvent(APP_EVENTS.OPEN_NOTES));
    expect(bus.launch).toHaveBeenCalledWith({ typeId: 'notebook', reason: 'api' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([false, true])('uses the notebook title for desktop/mobile shell (small screen: %s)', (isSmallScreen) => {
    const { result } = renderHook(() => useShellViewChrome('notes', 'Chat title', t, isSmallScreen, () => true));
    expect(result.current.desktopShellViewLabel).toBe('笔记');
    expect(result.current.cardsHubMobileTabs).toBeUndefined();
  });

  it('propagates notebook activity when leaving and returning to the kept-alive page', () => {
    const { rerender } = render(<NotebookView view="notes" />);
    expect(screen.getByTestId('notebook-page')).toHaveAttribute('data-active', 'true');
    rerender(<NotebookView view="learning-hub" />);
    expect(screen.getByTestId('notebook-page')).toHaveAttribute('data-active', 'false');
    rerender(<NotebookView view="notes" />);
    expect(screen.getByTestId('notebook-page')).toHaveAttribute('data-active', 'true');
  });

  it('keeps inactive notebook content stable during unrelated view changes', () => {
    const { result, rerender } = renderHook(({ view }: { view: CurrentView }) => useContents(view), {
      initialProps: { view: 'learning-hub' },
    });
    const content = result.current.notebookContent;
    rerender({ view: 'settings' });
    expect(result.current.notebookContent).toBe(content);
  });

  it('supports notes visibility through the shared view store without treating the library as notes', () => {
    const { result } = renderHook(() => useViewVisibility('notes'));
    expect(result.current.isActive).toBe(false);
    act(() => useViewStore.getState().setCurrentView('notes'));
    expect(result.current.isActive).toBe(true);
    act(() => useViewStore.getState().setCurrentView('learning-hub'));
    expect(result.current.isActive).toBe(false);
  });

  it('mounts the lazy notebook page in its own classic shell view layer', () => {
    const lazySource = readFileSync(resolve(process.cwd(), 'src/lazyComponents.tsx'), 'utf8');
    expect(lazySource).toContain("import('./features/ink/NotebookPage').then(m => ({ default: m.NotebookPage }))");
    expect(readAppShellSource()).toContain("renderViewLayer('notes', notebookContent, 'overflow-hidden')");
  });
});
