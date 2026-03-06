import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sidebarMocks = vi.hoisted(() => ({
  quickAccessNavigate: vi.fn(),
  finderRefresh: vi.fn().mockResolvedValue(undefined),
  addRecent: vi.fn(),
}));

const finderState = {
  currentPath: { viewKind: 'folder', folderId: null, typeFilter: null, breadcrumbs: [] },
  history: [{ viewKind: 'folder', folderId: null, typeFilter: null, breadcrumbs: [] }],
  historyIndex: 0,
  viewMode: 'list',
  selectedIds: new Set<string>(),
  searchQuery: '',
  isSearching: false,
  items: [{ id: 'type_textbooks', type: 'folder', name: '教材', path: '/virtual' }],
  isLoading: false,
  error: null,
  goBack: vi.fn(),
  goForward: vi.fn(),
  jumpToBreadcrumb: vi.fn(),
  setViewMode: vi.fn(),
  select: vi.fn(),
  selectAll: vi.fn(),
  clearSelection: vi.fn(),
  setSelectedIds: vi.fn(),
  setSearchQuery: vi.fn(),
  refresh: sidebarMocks.finderRefresh,
  enterFolder: vi.fn(),
  navigateTo: vi.fn(),
  quickAccessNavigate: sidebarMocks.quickAccessNavigate,
  setCurrentPathWithoutHistory: vi.fn(),
  inlineEdit: { editingId: null, editingType: null, originalName: '' },
  startInlineEdit: vi.fn(),
  cancelInlineEdit: vi.fn(),
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

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@/dstu/adapters/textbookDstuAdapter', () => ({ textbookDstuAdapter: {} }));
vi.mock('@/dstu/adapters/attachmentDstuAdapter', () => ({ attachmentDstuAdapter: {} }));
vi.mock('@/utils/fileManager', () => ({
  extractFileName: vi.fn(),
  extractDisplayFileName: vi.fn(),
  fileManager: {},
}));
vi.mock('@/components/shared/UnifiedDragDropZone', () => ({
  FILE_TYPES: {},
  UnifiedDragDropZone: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/hooks/useDebounce', () => ({ useDebounce: (value: string) => value }));
vi.mock('@/hooks/useViewVisibility', () => ({ useViewVisibility: () => ({ isActive: true }) }));
vi.mock('@/components/ui/app-menu', () => ({
  AppMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AppMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AppMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => <button onClick={onClick}>{children}</button>,
  AppMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => ({ isSmallScreen: false }) }));
vi.mock('@/components/learning-hub/stores/finderStore', () => {
  const useFinderStore = ((selector?: (state: typeof finderState) => unknown) => selector ? selector(finderState) : finderState) as typeof import('@/components/learning-hub/stores/finderStore').useFinderStore;
  (useFinderStore as any).getState = () => finderState;
  return { useFinderStore };
});
vi.mock('@/components/learning-hub/stores/recentStore', () => ({
  useRecentStore: (selector: (state: { addRecent: typeof sidebarMocks.addRecent }) => unknown) => selector({ addRecent: sidebarMocks.addRecent }),
}));
vi.mock('@/components/learning-hub/LearningHubNavigationContext', () => ({ useLearningHubNavigationSafe: () => null }));
vi.mock('@/components/learning-hub/components/finder', () => ({
  DesktopView: () => null,
  FinderToolbar: () => null,
  FinderQuickAccess: () => null,
  FinderBatchToolbar: () => null,
  FolderPickerDialog: () => null,
  FinderFileList: ({ items, onOpen }: { items: any[]; onOpen: (item: any) => void }) => (
    <button onClick={() => onOpen(items[0])}>open-first-item</button>
  ),
}));
vi.mock('@/dstu', () => ({
  dstu: { watch: vi.fn(() => () => {}), get: vi.fn() },
  folderApi: { createFolder: vi.fn(), getFolder: vi.fn(), getBreadcrumbs: vi.fn() },
  createEmpty: vi.fn(),
  trashApi: { restoreItem: vi.fn(), permanentlyDelete: vi.fn(), emptyTrash: vi.fn() },
}));
vi.mock('@/chat-v2/context/vfsRefApi', () => ({ updatePathCacheV2: vi.fn() }));
vi.mock('@/shared/result', () => ({ VfsError: class {}, VfsErrorCode: {}, err: vi.fn(), ok: vi.fn(), reportError: vi.fn() }));
vi.mock('@/components/learning-hub/components/LearningHubContextMenu', () => ({ LearningHubContextMenu: () => null }));
vi.mock('@/components/ui/NotionDialog', () => ({
  NotionDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  NotionDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  NotionDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  NotionDialogBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  NotionDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  NotionAlertDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/ui/shad/Input', () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock('@/components/ui/NotionButton', () => ({ NotionButton: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/debug-panel/hooks/usePageLifecycle', () => ({ usePageMount: vi.fn(), pageLifecycleTracker: { log: vi.fn() } }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({ debugLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/utils/concurrency', () => ({ pLimit: () => async (task: () => Promise<unknown>) => task() }));
vi.mock('@/components/learning-hub/components/ImportProgressModal', () => ({ ImportProgressModal: () => null }));
vi.mock('@/components/learning-hub/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/components/learning-hub/hooks')>('@/components/learning-hub/hooks');
  return {
    ...actual,
    useVfsContextInject: () => ({ injectToChat: vi.fn(), canInject: false, isInjecting: false }),
  };
});
vi.mock('@/command-palette/hooks/useCommandEvents', () => ({ useCommandEvents: vi.fn() }));

import { LearningHubSidebar } from '@/components/learning-hub/LearningHubSidebar';

describe('LearningHubSidebar integration', () => {
  beforeEach(() => {
    sidebarMocks.quickAccessNavigate.mockClear();
    sidebarMocks.finderRefresh.mockClear();
    sidebarMocks.addRecent.mockClear();
  });

  it('routes virtual type folders through the shared quick access map', async () => {
    render(<LearningHubSidebar mode="fullscreen" />);

    await waitFor(() => expect(sidebarMocks.finderRefresh).toHaveBeenCalled());
    fireEvent.click(screen.getByText('open-first-item'));

    expect(sidebarMocks.quickAccessNavigate).toHaveBeenCalledWith('textbooks');
    expect(sidebarMocks.addRecent).not.toHaveBeenCalled();
  });
});
