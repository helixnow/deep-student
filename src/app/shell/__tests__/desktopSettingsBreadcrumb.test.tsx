import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppShellChrome, type AppShellChromeProps } from '../AppShellChrome';

vi.mock('@/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform')>()),
  isMacOS: () => false,
  isWindows: () => false,
  isMobilePlatform: () => false,
}));

vi.mock('@/components/system-status/MigrationStatusBanner', () => ({
  MigrationStatusBanner: () => null,
}));
vi.mock('@/components/NotificationContainer', () => ({
  NotificationContainer: () => null,
}));
vi.mock('@/features/pomodoro/components/GlobalPomodoroWidget', () => ({
  GlobalPomodoroWidget: () => null,
}));
vi.mock('@/features/learning-today/DueMistakesReviewHost', () => ({
  DueMistakesReviewHost: () => null,
}));
vi.mock('@/components/exam-sprint', () => ({
  DailySprintHost: () => null,
}));
vi.mock('@/features/learning-hub', () => ({
  LearningHubNavigationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/command-palette/CommandPaletteProvider', () => ({
  CommandPaletteProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useCommandPalette: () => ({ isOpen: false, open: vi.fn() }),
}));
vi.mock('@/components/context-menu/TextContextMenu', () => ({
  TextContextMenuProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/layout', () => ({
  MobileLayoutProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MobileHeaderProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MobileHeaderNavProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MobileHeaderActiveViewSync: () => null,
  MobileAppNavigationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function createProps(overrides: Partial<AppShellChromeProps> = {}): AppShellChromeProps {
  return {
    t: ((key: string) => key) as AppShellChromeProps['t'],
    isSmallScreen: false,
    workbenchActive: false,
    leftPanelCollapsed: false,
    currentView: 'settings',
    isDemoShell: false,
    commandPaletteNavigate: vi.fn(),
    toggleDarkMode: vi.fn(),
    isDarkMode: false,
    switchLanguage: vi.fn(),
    handleMobileAppNavigate: vi.fn(() => true),
    mobileHeaderCanGoBack: false,
    handleMobileHeaderBack: vi.fn(),
    unifiedCanGoBack: false,
    unifiedCanGoForward: false,
    unifiedGoBack: vi.fn(),
    unifiedGoForward: vi.fn(),
    desktopShellViewLabel: '设置',
    desktopShellHeaderBreadcrumb: '模型与 AI',
    cardsHubMobileTabs: undefined,
    handleViewChange: vi.fn(),
    setCurrentView: vi.fn(),
    layout: {
      appShellRef: { current: null },
      appShellCustomProperties: {},
      isDesktopSidebarSurfaceVisible: true,
      isDesktopSidebarResizing: false,
      shellTitlebarTopInset: 0,
      shellTitlebarOccupiedHeight: 40,
      desktopNavigationWidth: 260,
      desktopSidebarToggleLabel: 'Toggle sidebar',
      desktopSidebarResizeLabel: 'Resize sidebar',
      handleDesktopSidebarResizeStart: vi.fn(),
      handleDesktopSidebarResize: vi.fn(),
      handleDesktopSidebarResizeEnd: vi.fn(),
      toggleDesktopSidebar: vi.fn(),
    } as unknown as AppShellChromeProps['layout'],
    interactions: {
      navigationShortcuts: { back: 'Alt+Left', forward: 'Alt+Right' },
      commandPaletteTriggerRef: { current: null },
      handleDesktopTitlebarMouseDown: vi.fn(),
      handleHeaderHotzoneMouseDown: vi.fn(),
      handleHeaderHotzoneMouseMove: vi.fn(),
      handleHeaderHotzoneMouseUp: vi.fn(),
      handleHeaderHotzoneMouseLeave: vi.fn(),
      handleCreateChatSession: vi.fn(),
      openCommandPalette: vi.fn(),
    },
    toggleDesktopWindowMaximize: vi.fn(),
    activeShell: {
      sidebarKind: 'settings',
      sidebarOwnsBackNavigation: true,
      hideExpandedSidebarToggle: true,
      contentClass: 'settings-view',
    },
    currentChatHeaderTitle: '',
    currentChatHeaderGroupName: '',
    currentChatHeaderSessionId: null,
    saveCurrentChatHeaderTitle: vi.fn(async () => {}),
    setDesktopPageHeaderTarget: vi.fn(),
    setDesktopChatHeaderTarget: vi.fn(),
    desktopShellSidebarPortalValue: { target: null, currentView: 'settings' },
    desktopShellHeaderPortalValue: { target: null, chatHeaderTarget: null, currentView: 'settings' },
    desktopShellSidebarKind: 'settings',
    desktopShellSidebarLayers: [['settings', null]],
    registeredViewLayers: null,
    contentBodyRef: { current: null },
    maintenanceMode: false,
    maintenanceReason: '',
    maintenanceRequiresRestart: false,
    showCloudStorageSettings: false,
    setShowCloudStorageSettings: vi.fn(),
    debugPanelRequested: false,
    debugPanelOpenRequest: 0,
    welcomeOnboardingOpen: false,
    dismissWelcomeOnboarding: vi.fn(),
    ...overrides,
  };
}

describe('AppShellChrome desktop header breadcrumb', () => {
  it('renders the settings category title in the topbar breadcrumb position', () => {
    const { container, rerender } = render(<AppShellChrome {...createProps()} />);

    const breadcrumb = container.querySelector('[data-shell-header-breadcrumb="true"]');
    expect(breadcrumb).not.toBeNull();
    expect(breadcrumb?.textContent).toBe('设置/模型与 AI');

    rerender(<AppShellChrome {...createProps({ desktopShellHeaderBreadcrumb: null })} />);
    expect(container.querySelector('[data-shell-header-breadcrumb="true"]')).toBeNull();
    expect(container.querySelector('.desktop-shell-header-title')?.textContent).toBe('设置');
  });
});
