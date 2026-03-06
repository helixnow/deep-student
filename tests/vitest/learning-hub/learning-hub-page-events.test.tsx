import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DSTU_NAVIGATE_TO_KNOWLEDGE_BASE_EVENT } from '@/components/learning-hub/learningHubContracts';

const pageMocks = vi.hoisted(() => ({
  dstuGet: vi.fn(),
  finderQuickAccessNavigate: vi.fn(),
  setPendingMemoryLocate: vi.fn(),
}));

const finderState = {
  currentPath: { viewKind: 'folder', folderId: null, typeFilter: null, breadcrumbs: [] },
  goUp: vi.fn(),
  jumpToBreadcrumb: vi.fn(),
  refresh: vi.fn(),
  quickAccessNavigate: pageMocks.finderQuickAccessNavigate,
};

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: string) => fallback ?? key,
    }),
  };
});
vi.mock('react-resizable-panels', () => ({
  PanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PanelResizeHandle: () => null,
}));
vi.mock('@/dstu/openResource', () => ({ registerOpenResourceHandler: vi.fn(() => () => {}), type: {} }));
vi.mock('@/dstu', () => ({
  createEmpty: vi.fn(),
  dstu: {
    watch: vi.fn(() => () => {}),
    get: pageMocks.dstuGet,
  },
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/utils/pendingMemoryLocate', () => ({ setPendingMemoryLocate: pageMocks.setPendingMemoryLocate }));
vi.mock('@/components/learning-hub/LearningHubSidebar', () => ({ LearningHubSidebar: () => <div>sidebar</div> }));
vi.mock('@/stores/uiStore', () => ({ useUIStore: (selector: (state: { leftPanelCollapsed: boolean; setLeftPanelCollapsed: () => void }) => unknown) => selector({ leftPanelCollapsed: false, setLeftPanelCollapsed: vi.fn() }) }));
vi.mock('@/components/layout', () => ({ useMobileHeader: vi.fn() }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => ({ isSmallScreen: false }) }));
vi.mock('@/components/learning-hub/stores/finderStore', () => ({
  useFinderStore: (selector: (state: typeof finderState) => unknown) => selector(finderState),
}));
vi.mock('@/components/learning-hub/components/DstuAppLauncher', () => ({ DstuAppLauncher: () => null }));
vi.mock('@/components/learning-hub/components/TabBar', () => ({ TabBar: () => null }));
vi.mock('@/components/learning-hub/apps/TabPanelContainer', () => ({
  TabPanelContainer: ({ tabs }: { tabs: Array<{ title: string }> }) => <div data-testid="tab-count">{tabs.length}:{tabs[0]?.title ?? ''}</div>,
}));
vi.mock('@/components/learning-hub/activeTabAccessor', () => ({ setActiveTabForExternal: vi.fn() }));
vi.mock('@/command-palette/hooks/useCommandEvents', () => ({ COMMAND_EVENTS: {}, useCommandEvents: vi.fn() }));
vi.mock('@/debug-panel/hooks/usePageLifecycle', () => ({ usePageMount: vi.fn() }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({ debugLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/learning-hub/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/components/learning-hub/hooks')>('@/components/learning-hub/hooks');
  return {
    ...actual,
    useVfsContextInject: () => ({ injectToChat: vi.fn(), canInject: false, isInjecting: false }),
  };
});

import LearningHubPage from '@/components/learning-hub/LearningHubPage';

describe('LearningHubPage events', () => {
  beforeEach(() => {
    pageMocks.dstuGet.mockReset();
    pageMocks.finderQuickAccessNavigate.mockReset();
    pageMocks.setPendingMemoryLocate.mockReset();
    pageMocks.dstuGet.mockResolvedValue({ ok: true, value: { id: 'tb_1', type: 'textbook', name: '代数.pdf' } });
  });

  it('opens a document tab for manage locator events instead of routing to memory', async () => {
    render(<LearningHubPage />);

    window.dispatchEvent(new CustomEvent(DSTU_NAVIGATE_TO_KNOWLEDGE_BASE_EVENT, {
      detail: {
        preferTab: 'manage',
        locator: {
          resourceId: 'tb_1',
          resourceType: 'textbook',
          title: '代数.pdf',
        },
      },
    }));

    await waitFor(() => expect(screen.getByTestId('tab-count')).toHaveTextContent('1:代数.pdf'));
    expect(pageMocks.dstuGet).toHaveBeenCalledWith('/tb_1');
    expect(pageMocks.finderQuickAccessNavigate).not.toHaveBeenCalledWith('memory');
    expect(pageMocks.setPendingMemoryLocate).not.toHaveBeenCalled();
  });
});
