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
      // 真实 i18next 支持 t(key, 'fallback') 与 t(key, { defaultValue })
      // 两种签名；Sidebar 内组件两种都会用到。
      t: (key: string, fallback?: string | { defaultValue?: string }) => {
        if (typeof fallback === 'string') return fallback;
        if (fallback && typeof fallback === 'object' && typeof fallback.defaultValue === 'string') {
          return fallback.defaultValue;
        }
        return key;
      },
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
vi.mock('@/features/learning-hub/stores/finderStore', () => {
  const useFinderStore = ((selector?: (state: typeof finderState) => unknown) => selector ? selector(finderState) : finderState) as typeof import('@/features/learning-hub/stores/finderStore').useFinderStore;
  (useFinderStore as any).getState = () => finderState;
  return {
    useFinderStore,
    // LH-HOST：宿主分桶后组件通过 useFinderStoreFor(hostId) 取 store；
    // 本测试只关心单宿主行为，所有 hostId 都回同一个 mock。
    useFinderStoreFor: () => useFinderStore,
    getFinderStore: () => useFinderStore,
    resolveFinderHostId: (hostId?: string | null) => hostId ?? 'default',
    setActiveFinderHostId: vi.fn(),
    getActiveFinderHostId: () => 'default',
    DEFAULT_FINDER_HOST_ID: 'default',
  };
});
vi.mock('@/features/learning-hub/stores/recentStore', () => ({
  useRecentStore: (selector: (state: { addRecent: typeof sidebarMocks.addRecent }) => unknown) => selector({ addRecent: sidebarMocks.addRecent }),
}));
vi.mock('@/features/learning-hub/LearningHubNavigationContext', () => ({ useLearningHubNavigationSafe: () => null }));
vi.mock('@/features/learning-hub/components/finder', () => ({
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
  // list：收藏徽标挂载即查询（fetchFavoriteCount），缺失会抛未处理拒绝
  dstu: { watch: vi.fn(() => () => {}), get: vi.fn(), list: vi.fn(async () => ({ ok: true, value: [] })) },
  folderApi: { createFolder: vi.fn(), getFolder: vi.fn(), getBreadcrumbs: vi.fn() },
  createEmpty: vi.fn(),
  trashApi: { restoreItem: vi.fn(), permanentlyDelete: vi.fn(), emptyTrash: vi.fn() },
}));
vi.mock('@/features/chat/context/vfsRefApi', () => ({ updatePathCacheV2: vi.fn() }));
vi.mock('@/shared/result', () => ({ VfsError: class {}, VfsErrorCode: {}, err: vi.fn(), ok: vi.fn(), reportError: vi.fn() }));
vi.mock('@/features/learning-hub/components/LearningHubContextMenu', () => ({ LearningHubContextMenu: () => null }));
vi.mock('@/components/ui/DsDialog', () => ({
  DsDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DsDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DsDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DsDialogBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DsDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DsAlertDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/ui/shad/Input', () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock('@/components/ui/DsButton', () => ({ DsButton: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/debug-panel/hooks/usePageLifecycle', () => ({ usePageMount: vi.fn(), pageLifecycleTracker: { log: vi.fn() } }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({ debugLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/utils/concurrency', () => ({ pLimit: () => async (task: () => Promise<unknown>) => task() }));
vi.mock('@/features/learning-hub/components/ImportProgressModal', () => ({ ImportProgressModal: () => null }));
vi.mock('@/features/learning-hub/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/features/learning-hub/hooks')>('@/features/learning-hub/hooks');
  return {
    ...actual,
    useVfsContextInject: () => ({ injectToChat: vi.fn(), canInject: () => false, isInjecting: false }),
  };
});
vi.mock('@/command-palette/hooks/useCommandEvents', () => ({ useCommandEvents: vi.fn() }));

import { LearningHubSidebar } from '@/features/learning-hub/LearningHubSidebar';

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
