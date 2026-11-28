import React, { forwardRef, useImperativeHandle } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImperativePanelHandle } from 'react-resizable-panels';
import type { LearningHubSidebarProps, ResourceListItem } from '../types';

interface MockAppPanelController {
  collapsed: boolean;
  size: number;
  expandCalls: Array<number | undefined>;
  collapseCalls: number;
  onCollapse?: () => void;
  onExpand?: () => void;
  onResize?: (size: number) => void;
  onDragging?: (isDragging: boolean) => void;
  simulateDragResize: (nextSize: number) => void;
  simulateDragCollapse: () => void;
}

const panelController = vi.hoisted<MockAppPanelController>(() => ({
  collapsed: true,
  size: 0,
  expandCalls: [],
  collapseCalls: 0,
  simulateDragResize(nextSize: number) {
    this.onDragging?.(true);
    this.size = nextSize;
    this.collapsed = false;
    this.onResize?.(nextSize);
    this.onDragging?.(false);
  },
  simulateDragCollapse() {
    this.onDragging?.(true);
    // 拖拽折叠过程会先压到 minSize(40)，再触发折叠到 0
    this.size = 40;
    this.onResize?.(40);
    this.size = 0;
    this.collapsed = true;
    this.onResize?.(0);
    this.onCollapse?.();
    this.onDragging?.(false);
  },
}));

const sidebarCapturedProps = vi.hoisted<{ current: LearningHubSidebarProps | null }>(() => ({
  current: null,
}));

const isSmallScreenState = vi.hoisted(() => ({ value: false }));

vi.mock('react-resizable-panels', () => {
  const PanelGroup: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <div data-testid="mock-panel-group">{children}</div>
  );

  const PanelResizeHandle: React.FC<{
    children?: React.ReactNode;
    onDragging?: (isDragging: boolean) => void;
  }> = ({ children, onDragging }) => {
    panelController.onDragging = onDragging;
    return <div data-testid="mock-resize-handle">{children}</div>;
  };

  const Panel = forwardRef<
    ImperativePanelHandle,
    {
      id?: string;
      children?: React.ReactNode;
      onCollapse?: () => void;
      onExpand?: () => void;
      onResize?: (size: number) => void;
    }
  >(({ id, children, onCollapse, onExpand, onResize }, ref) => {
    const isAppPanel = id === 'learning-hub-app';
    if (isAppPanel) {
      panelController.onCollapse = onCollapse;
      panelController.onExpand = onExpand;
      panelController.onResize = onResize;
    }

    useImperativeHandle(ref, () => ({
      collapse: () => {
        if (!isAppPanel) return;
        panelController.collapseCalls += 1;
        panelController.collapsed = true;
        panelController.size = 0;
        panelController.onCollapse?.();
      },
      expand: (minSize?: number) => {
        if (!isAppPanel) return;
        panelController.expandCalls.push(minSize);
        if (panelController.collapsed) {
          panelController.collapsed = false;
          panelController.size = minSize ?? 40;
          panelController.onExpand?.();
        }
      },
      getId: () => id ?? 'panel',
      getSize: () => (isAppPanel ? panelController.size : 100 - panelController.size),
      isCollapsed: () => (isAppPanel ? panelController.collapsed : false),
      isExpanded: () => (isAppPanel ? !panelController.collapsed : true),
      resize: (nextSize: number) => {
        if (!isAppPanel) return;
        panelController.size = nextSize;
        panelController.collapsed = nextSize === 0;
      },
    }));

    return (
      <div data-testid={`mock-panel-${id ?? 'unknown'}`} data-collapsed={isAppPanel ? String(panelController.collapsed) : 'false'}>
        {children}
      </div>
    );
  });

  return { PanelGroup, Panel, PanelResizeHandle };
});

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts && 'count' in opts ? `${key}:${String(opts.count)}` : key,
    }),
  };
});

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: isSmallScreenState.value }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

vi.mock('@/hooks/useViewVisibility', () => ({
  useViewVisibility: () => ({ isActive: true }),
}));

vi.mock('@/debug-panel/hooks/usePageLifecycle', () => ({
  usePageMount: () => {},
}));

vi.mock('@/app/shell/DesktopShellSidebarPortal', () => ({
  useDesktopShellSidebarPortal: () => null,
}));

vi.mock('@/app/shell/DesktopShellHeaderPortal', () => ({
  useDesktopShellHeaderPortal: () => null,
}));

vi.mock('@/stores/uiStore', () => {
  const state = {
    leftPanelCollapsed: false,
    setLeftPanelCollapsed: vi.fn(),
  };
  return {
    useUIStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});

vi.mock('@/components/layout', () => ({
  useMobileHeader: () => {},
  MobileSlidingLayout: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  MobileSubviewChromeProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useMobileSubviewChromeHost: () => ({ activeSubviewChrome: null, subviewChromeHost: {} }),
  DEFAULT_GESTURE_IGNORE_SELECTOR: '',
}));

vi.mock('@/dstu', () => ({
  createEmpty: vi.fn(),
  dstu: {
    get: vi.fn(async () => ({ ok: true, value: { id: 'x', name: 'x', path: '/x' } })),
    watch: vi.fn(() => () => {}),
  },
}));

vi.mock('@/dstu/openResource', () => ({
  registerOpenResourceHandler: vi.fn(() => () => {}),
}));

vi.mock('@/command-palette/hooks/useCommandEvents', () => ({
  COMMAND_EVENTS: {
    NOTES_CREATE_NEW: 'notes:create-new',
    NOTES_CREATE_FOLDER: 'notes:create-folder',
    NOTES_FOCUS_SEARCH: 'notes:focus-search',
    NOTES_TOGGLE_SIDEBAR: 'notes:toggle-sidebar',
    NOTES_EXPORT_CURRENT: 'notes:export-current',
    NOTES_EXPORT_ALL: 'notes:export-all',
  },
  useCommandEvents: () => {},
}));

vi.mock('@/features/workbench/apps/content/ContentCloseConfirmation', () => ({
  ContentCloseConfirmationHost: () => null,
}));

vi.mock('@/features/workbench/apps/content/contentDirtyRegistry', () => ({
  hasContentSaveHandler: () => false,
  isContentDirty: () => false,
  saveContentNow: vi.fn(),
}));

vi.mock('../hooks', () => ({
  useVfsContextInject: () => ({ injectToChat: vi.fn(), canInject: () => false, isInjecting: false }),
  useLearningHubEvents: () => {},
}));

vi.mock('../stores/finderStore', () => {
  const storeState = {
    currentPath: { viewKind: 'folder', folderId: null, breadcrumbs: [] },
    goUp: vi.fn(),
    jumpToBreadcrumb: vi.fn(),
    refresh: vi.fn(),
    quickAccessNavigate: vi.fn(),
    enterFolder: vi.fn(),
    searchQuery: '',
    setSearchQuery: vi.fn(),
  };
  return {
    FINDER_HOST_IDS: { page: 'page', pageMobile: 'pageMobile' },
    useFinderStoreFor: () => (selector: (s: typeof storeState) => unknown) => selector(storeState),
  };
});

vi.mock('../LearningHubSidebar', () => ({
  LearningHubSidebar: (props: LearningHubSidebarProps) => {
    sidebarCapturedProps.current = props;
    return (
      <div
        data-testid="mock-learning-hub-sidebar"
        data-sidebar-collapsed={String(Boolean(props.isCollapsed))}
        data-active-file-id={props.activeFileId ?? ''}
        data-collapsed-tab-count={String(props.collapsedAppTabCount ?? 0)}
      >
        {props.collapsedAppTabCount && props.collapsedAppTabCount > 0 && props.onRestoreAppPanel ? (
          <button
            type="button"
            data-testid="mock-restore-panel-btn"
            onClick={props.onRestoreAppPanel}
          >
            restore
          </button>
        ) : null}
      </div>
    );
  },
}));

const tabBarCapturedProps = vi.hoisted<{
  tabs: Array<{ tabId: string; resourceId: string }>;
  onClose?: (tabId: string) => void;
}>(() => ({ tabs: [] }));

vi.mock('../components/TabBar', () => ({
  TabBar: ({
    tabs,
    activeTabId,
    onClose,
  }: {
    tabs: Array<{ tabId: string; resourceId: string }>;
    activeTabId: string | null;
    onClose?: (tabId: string) => void;
  }) => {
    tabBarCapturedProps.tabs = tabs;
    tabBarCapturedProps.onClose = onClose;
    return (
      <div data-testid="mock-tab-bar" data-tab-count={String(tabs.length)} data-active-tab={activeTabId ?? ''} />
    );
  },
}));

vi.mock('../apps/TabPanelContainer', () => ({
  TabPanelContainer: () => <div data-testid="mock-tab-panel-container" />,
}));

import { LearningHubPage } from '../LearningHubPage';
import { FinderBatchToolbar } from '../components/finder/FinderBatchToolbar';

const makeFile = (id: string, title: string): ResourceListItem => ({
  id,
  title,
  type: 'note',
  path: `/${title}`,
  updatedAt: '2026-11-28T00:00:00Z',
});

describe('LearningHubPage right app panel drag-collapse and reopen', () => {
  beforeEach(() => {
    localStorage.clear();
    isSmallScreenState.value = false;
    panelController.collapsed = true;
    panelController.size = 0;
    panelController.expandCalls = [];
    panelController.collapseCalls = 0;
    panelController.onCollapse = undefined;
    panelController.onExpand = undefined;
    panelController.onResize = undefined;
    panelController.onDragging = undefined;
    sidebarCapturedProps.current = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });

  it('re-expands the right panel to its last settled size when opening another file or the same file after drag-collapsing', async () => {
    render(<LearningHubPage />);

    expect(sidebarCapturedProps.current).not.toBeNull();

    // 1. 打开文件 A → 右侧面板按默认宽度(75)展开
    act(() => {
      sidebarCapturedProps.current!.onOpenApp?.(makeFile('file-a', 'File A'));
    });
    expect(panelController.collapsed).toBe(false);
    expect(panelController.size).toBe(75);
    expect(screen.getByTestId('mock-learning-hub-sidebar')).toHaveAttribute('data-active-file-id', 'file-a');
    expect(screen.getByTestId('mock-learning-hub-sidebar')).toHaveAttribute('data-collapsed-tab-count', '0');

    // 2. 用户拖拽把右侧面板调到 60%，随后一路拖压折叠到 0
    act(() => {
      panelController.simulateDragResize(60);
    });
    act(() => {
      panelController.simulateDragCollapse();
    });

    expect(panelController.collapsed).toBe(true);
    expect(screen.getByTestId('mock-learning-hub-sidebar')).toHaveAttribute('data-sidebar-collapsed', 'false');
    expect(screen.getByTestId('mock-learning-hub-sidebar')).toHaveAttribute('data-active-file-id', '');
    expect(screen.getByTestId('mock-learning-hub-sidebar')).toHaveAttribute('data-collapsed-tab-count', '1');

    // 3. 点击另一个文件 B → 右侧面板必须重新弹开，并恢复到拖拽折叠前的稳定宽度 60（不是拖拽途经的 minSize 40）
    act(() => {
      sidebarCapturedProps.current!.onOpenApp?.(makeFile('file-b', 'File B'));
    });

    expect(panelController.collapsed).toBe(false);
    expect(panelController.size).toBe(60);
    expect(screen.getByTestId('mock-tab-bar')).toHaveAttribute('data-tab-count', '2');
    expect(screen.getByTestId('mock-learning-hub-sidebar')).toHaveAttribute('data-active-file-id', 'file-b');
    expect(screen.getByTestId('mock-learning-hub-sidebar')).toHaveAttribute('data-collapsed-tab-count', '0');

    // 4. 再次拖压折叠，然后重新点击当前已打开的同一个文件 B → 同样必须弹开
    act(() => {
      panelController.simulateDragCollapse();
    });
    expect(panelController.collapsed).toBe(true);
    expect(screen.getByTestId('mock-learning-hub-sidebar')).toHaveAttribute('data-collapsed-tab-count', '2');

    act(() => {
      sidebarCapturedProps.current!.onOpenApp?.(makeFile('file-b', 'File B'));
    });
    expect(panelController.collapsed).toBe(false);
    expect(panelController.size).toBe(60);

    // 5. 再次拖压折叠，点击底栏恢复按钮 → 也能直接恢复展开
    act(() => {
      panelController.simulateDragCollapse();
    });
    fireEvent.click(screen.getByTestId('mock-restore-panel-btn'));
    expect(panelController.collapsed).toBe(false);
    expect(panelController.size).toBe(60);

    // 6. 关闭全部标签 → 右侧面板自动折叠，恢复按钮消失
    for (const tab of [...tabBarCapturedProps.tabs]) {
      await act(async () => {
        tabBarCapturedProps.onClose?.(tab.tabId);
        await Promise.resolve();
      });
    }
    expect(panelController.collapsed).toBe(true);
    expect(screen.getByTestId('mock-learning-hub-sidebar')).toHaveAttribute('data-collapsed-tab-count', '0');
  });

  it('does not re-collapse a manually expanded left sidebar when opening another file while right panel is already open', () => {
    render(<LearningHubPage />);

    act(() => {
      sidebarCapturedProps.current!.onOpenApp?.(makeFile('file-1', 'File 1'));
    });
    expect(screen.getByTestId('mock-learning-hub-sidebar')).toHaveAttribute('data-sidebar-collapsed', 'true');

    // 用户手动展开左侧栏
    act(() => {
      sidebarCapturedProps.current!.onToggleCollapse?.();
    });
    expect(screen.getByTestId('mock-learning-hub-sidebar')).toHaveAttribute('data-sidebar-collapsed', 'false');

    // 右侧栏本就处于展开态，再打开一个文件不应把左侧栏又折回去
    act(() => {
      sidebarCapturedProps.current!.onOpenApp?.(makeFile('file-2', 'File 2'));
    });
    expect(panelController.collapsed).toBe(false);
    expect(screen.getByTestId('mock-learning-hub-sidebar')).toHaveAttribute('data-sidebar-collapsed', 'false');
  });
});

describe('FinderBatchToolbar collapsed right-panel restore button', () => {
  it('shows restore button when no items are selected and collapsed tabs exist, and hides it when selecting items', () => {
    const onRestore = vi.fn();
    const { rerender } = render(
      <FinderBatchToolbar
        selectedCount={0}
        totalCount={3}
        onSelectAll={vi.fn()}
        onClearSelection={vi.fn()}
        collapsedAppTabCount={2}
        onRestoreAppPanel={onRestore}
      />,
    );

    const btn = screen.getByTestId('finder-restore-app-panel');
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onRestore).toHaveBeenCalledTimes(1);

    rerender(
      <FinderBatchToolbar
        selectedCount={1}
        totalCount={3}
        onSelectAll={vi.fn()}
        onClearSelection={vi.fn()}
        collapsedAppTabCount={2}
        onRestoreAppPanel={onRestore}
      />,
    );
    expect(screen.queryByTestId('finder-restore-app-panel')).not.toBeInTheDocument();
  });
});
