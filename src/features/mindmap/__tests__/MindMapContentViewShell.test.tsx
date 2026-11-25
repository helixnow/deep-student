import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { MindMapDocument } from '../types';
import type { MindMapMasterySummary } from '../interop/mindmapCardProjection';

const {
  selectionToChatMock,
  dispatchAppEventMock,
  notifyMock,
  loadMasteryMock,
  lastMindMapViewProps,
  useMobileScreenMock,
  backHandlers,
  registerBackHandlerMock,
  stableT,
} = vi.hoisted(() => {
  const handlers: Array<{ handler: () => boolean; priority: number; seq: number }> = [];
  let seq = 0;
  return {
    selectionToChatMock: vi.fn(async () => ({ success: true })),
    dispatchAppEventMock: vi.fn(),
    notifyMock: vi.fn(),
    loadMasteryMock: vi.fn(async (): Promise<MindMapMasterySummary> => ({})),
    lastMindMapViewProps: {
      current: null as Record<string, unknown> | null,
    },
    useMobileScreenMock: vi.fn(() => false),
    backHandlers: handlers,
    registerBackHandlerMock: vi.fn((handler: () => boolean, priority = 10) => {
      const entry = { handler, priority, seq: ++seq };
      handlers.push(entry);
      return () => {
        const idx = handlers.indexOf(entry);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    }),
    stableT: (key: string, opts?: Record<string, unknown>) => {
      let text = typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          if (k === 'defaultValue') continue;
          text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
        }
      }
      return text;
    },
  };
});

vi.mock('@/features/chat/context/selectionRef', () => ({
  selectionToChat: selectionToChatMock,
}));

vi.mock('@/events/app', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/events/app')>();
  return {
    ...actual,
    dispatchAppEvent: dispatchAppEventMock,
  };
});

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: notifyMock,
}));

vi.mock('@/dstu', () => ({
  dstu: {
    watch: () => () => {},
  },
}));

vi.mock('../interop/mindmapCardProjection', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../interop/mindmapCardProjection')>();
  return {
    ...actual,
    loadMindMapMasterySummary: loadMasteryMock,
  };
});

vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  BACK_PRIORITY: { overlay: 100, view: 50 },
  registerBackHandler: registerBackHandlerMock,
}));

vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
  };
});

vi.mock('../components/toolbar/InlineCollapse', () => ({
  InlineCollapse: ({
    children,
    className,
    role,
  }: {
    children: React.ReactNode;
    className?: string;
    role?: string;
  }) => (
    <div className={className} role={role}>
      {children}
    </div>
  ),
}));

vi.mock('../views/MindMapView', () => ({
  MindMapView: React.forwardRef(function MockMindMapView(
    props: Record<string, unknown>,
    _ref,
  ) {
    lastMindMapViewProps.current = props;
    return (
      <div
        data-testid="mock-mindmap-view"
        data-presentation={String(Boolean(props.presentationMode))}
        data-presentation-branch={String(props.presentationBranchId ?? '')}
        data-mastery={String(Boolean(props.showMasteryOverlay))}
      >
        <input
          data-testid="mock-node-inline-input"
          data-node-editing="true"
          aria-label="mock node editor"
        />
      </div>
    );
  }),
}));

vi.mock('../views/OutlineView', () => ({
  OutlineView: React.forwardRef(function MockOutlineView(_props, _ref) {
    return <div data-testid="mock-outline-view" />;
  }),
}));

vi.mock('../components/agent/MindmapAgentSuggestionBar', () => ({
  MindmapAgentSuggestionBar: () => null,
}));

vi.mock('../components/shared/ReciteStatusBar', () => ({
  ReciteStatusBar: () => null,
}));

vi.mock('../components/toolbar/FormatBar', () => ({
  MindMapFormatBar: () => <div data-testid="mock-format-bar" />,
}));

vi.mock('../components/mindmap/StructureSelector', () => ({
  StructureSelector: ({
    trigger,
    open,
    onOpenChange,
  }: {
    trigger?: React.ReactNode;
    open?: boolean;
    onOpenChange?: (next: boolean) => void;
  }) => (
    <div data-testid="mock-structure-selector" data-open={String(Boolean(open))}>
      <div onClick={() => onOpenChange?.(!open)}>{trigger}</div>
    </div>
  ),
}));

vi.mock('../components/toolbar/StylePanel', () => ({
  StyleSettings: ({
    trigger,
    open,
    onOpenChange,
  }: {
    trigger?: React.ReactNode;
    open?: boolean;
    onOpenChange?: (next: boolean) => void;
  }) => (
    <div data-testid="mock-style-settings" data-open={String(Boolean(open))}>
      <div onClick={() => onOpenChange?.(!open)}>{trigger}</div>
    </div>
  ),
}));

vi.mock('../hooks/useMindMapExcerptBridge', () => ({
  useMindMapExcerptBridge: () => {},
}));

vi.mock('../hooks/useMindMapHandoutSync', () => ({
  useMindMapHandoutSync: () => {},
}));

vi.mock('../hooks/useMindMapClipboard', () => ({
  useMindMapClipboard: () => {},
}));

vi.mock('../hooks/useCoarsePointer', () => ({
  useCoarsePointer: () => false,
  useMobileScreen: () => useMobileScreenMock(),
}));

vi.mock('../api/mindmapApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/mindmapApi')>();
  return {
    ...actual,
    getMindMap: vi.fn(async (id: string) => ({
      id,
      name: '数据结构总览',
      path: `/mindmaps/${id}.json`,
      createdAt: '2026-11-21T00:00:00.000Z',
      updatedAt: '2026-11-21T00:00:00.000Z',
      isFavorite: false,
    })),
    getMindMapContent: vi.fn(async () => JSON.stringify(createSampleDocument())),
    updateMindMap: vi.fn(async () => ({})),
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: stableT,
  }),
}));

import { APP_EVENTS } from '@/events/app';
import { dispatchTypedEvent } from '@/events';
import {
  FLASHCARDS_CHANGED_EVENT,
  FSRS_STATS_REFRESH_EVENT,
  requestFlashcardsDueRefresh,
} from '@/events/flashcards';
import { DS_MINDMAP_FLASHCARD_PROJECTED_EVENT } from '../interop/mindmapCardProjection';
import { createMindMapStore, MindMapStoreContext } from '../store';
import { MindMapContentView } from '../MindMapContentView';
import { MindMapToolbar } from '../components/shell/MindMapToolbar';
import { MindMapSearchBanner } from '../components/shell/MindMapStatusBanners';
import { MindMapPresentationBar } from '../components/shell/MindMapPresentationBar';
import {
  dispatchMindMapAiAction,
  type MindMapAiAction,
} from '../components/shell/dispatchMindMapAiAction';

function createSampleDocument(): MindMapDocument {
  return {
    version: '1.0',
    meta: { createdAt: '2026-11-21T00:00:00.000Z' },
    root: {
      id: 'root',
      text: '数据结构总览',
      children: [
        {
          id: 'b1',
          text: '树与图',
          children: [{ id: 'b1-1', text: '红黑树', children: [] }],
        },
        {
          id: 'b2',
          text: '动态规划',
          children: [],
        },
        {
          id: 'b3',
          text: '贪心算法',
          children: [],
        },
      ],
    },
    stagingExcerpts: [
      {
        id: 'st-1',
        title: '平衡树摘录',
        anchor: { kind: 'pdf', resourceId: 'pdf-1', page: 12 },
        createdAt: '2026-11-21T00:00:00.000Z',
      },
      {
        id: 'st-2',
        title: '最短路摘录',
        anchor: { kind: 'pdf', resourceId: 'pdf-1', page: 18 },
        createdAt: '2026-11-21T00:01:00.000Z',
      },
    ],
  };
}

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  let text = typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      if (k === 'defaultValue') continue;
      text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
    }
  }
  return text;
}) as unknown as TFunction;

describe('MindMapContentView shell modules', () => {
  beforeEach(() => {
    selectionToChatMock.mockReset().mockResolvedValue({ success: true });
    dispatchAppEventMock.mockReset();
    notifyMock.mockReset();
    loadMasteryMock.mockReset().mockResolvedValue({});
    lastMindMapViewProps.current = null;
    useMobileScreenMock.mockReset().mockReturnValue(false);
    backHandlers.splice(0);
    registerBackHandlerMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('dispatchMindMapAiAction', () => {
    const actions: MindMapAiAction[] = ['expand', 'summarize', 'cloze', 'ask'];

    it.each(actions)(
      'attaches node context via selectionToChat and prefills chat input for "%s"',
      async (action) => {
        const doc = createSampleDocument();
        const ok = await dispatchMindMapAiAction({
          action,
          nodeId: 'b1',
          document: doc,
          resourceId: 'mm-101',
          t: mockT,
        });

        expect(ok).toBe(true);
        expect(selectionToChatMock).toHaveBeenCalledTimes(1);
        expect(selectionToChatMock).toHaveBeenCalledWith(
          expect.objectContaining({
            text: expect.stringContaining('树与图'),
            silent: true,
            source: expect.objectContaining({
              kind: 'mindmap',
              sourceId: 'mm-101',
              locator: 'node:b1',
              title: '数据结构总览',
            }),
          }),
        );
        expect(selectionToChatMock.mock.calls[0][0].text).toContain('红黑树');

        expect(dispatchAppEventMock).toHaveBeenCalledTimes(1);
        expect(dispatchAppEventMock).toHaveBeenCalledWith(
          APP_EVENTS.PREFILL_CHAT_INPUT,
          expect.objectContaining({
            autoSend: false,
            content: expect.stringContaining('b1'),
          }),
        );
        const promptContent = dispatchAppEventMock.mock.calls[0][1].content as string;
        expect(promptContent).toContain('数据结构总览');
        expect(promptContent).toContain('树与图');
      },
    );

    it('warns and skips dispatch when nodeId does not exist', async () => {
      const doc = createSampleDocument();
      const ok = await dispatchMindMapAiAction({
        action: 'expand',
        nodeId: 'missing-node',
        document: doc,
        resourceId: 'mm-101',
        t: mockT,
      });

      expect(ok).toBe(false);
      expect(selectionToChatMock).not.toHaveBeenCalled();
      expect(dispatchAppEventMock).not.toHaveBeenCalled();
      expect(notifyMock).toHaveBeenCalledWith('warning', expect.any(String));
    });
  });

  describe('MindMapPresentationBar', () => {
    const branches = [
      { id: 'b1', text: '树与图' },
      { id: 'b2', text: '动态规划' },
      { id: 'b3', text: '贪心算法' },
    ];

    it('renders overview state and disables previous button at stepIndex -1', () => {
      const onPrev = vi.fn();
      const onNext = vi.fn();
      const onOverview = vi.fn();
      const onExit = vi.fn();

      render(
        <MindMapPresentationBar
          rootTitle="数据结构总览"
          branches={branches}
          stepIndex={-1}
          onPrev={onPrev}
          onNext={onNext}
          onOverview={onOverview}
          onExit={onExit}
        />,
      );

      expect(screen.getByTestId('mm-presentation-status').textContent).toContain('总览');
      expect(screen.getByTestId('mm-presentation-status').textContent).toContain('数据结构总览');
      expect(screen.getByTestId('mm-presentation-overview')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByTestId('mm-presentation-prev')).toBeDisabled();
      expect(screen.getByTestId('mm-presentation-next')).not.toBeDisabled();

      fireEvent.click(screen.getByTestId('mm-presentation-next'));
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('renders branch progress and wires prev/next/overview/exit buttons', () => {
      const onPrev = vi.fn();
      const onNext = vi.fn();
      const onOverview = vi.fn();
      const onExit = vi.fn();

      render(
        <MindMapPresentationBar
          rootTitle="数据结构总览"
          branches={branches}
          stepIndex={1}
          onPrev={onPrev}
          onNext={onNext}
          onOverview={onOverview}
          onExit={onExit}
        />,
      );

      expect(screen.getByTestId('mm-presentation-status').textContent).toContain('2 / 3');
      expect(screen.getByTestId('mm-presentation-status').textContent).toContain('动态规划');

      fireEvent.click(screen.getByTestId('mm-presentation-prev'));
      fireEvent.click(screen.getByTestId('mm-presentation-next'));
      fireEvent.click(screen.getByTestId('mm-presentation-overview'));
      fireEvent.click(screen.getByTestId('mm-presentation-exit'));

      expect(onPrev).toHaveBeenCalledTimes(1);
      expect(onNext).toHaveBeenCalledTimes(1);
      expect(onOverview).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('mm-presentation-bar').className).toContain('shadow-[var(--mm-shadow-dock)]');
    });
  });

  describe('MindMapToolbar', () => {
    it('reflects mastery aria-pressed, single hide-completed button, and mobile staging badge', () => {
      const store = createMindMapStore();
      store.setState({ document: createSampleDocument() });

      const onToggleMasteryOverlay = vi.fn();
      const baseProps = {
        currentView: 'mindmap' as const,
        activePanel: null,
        onActivePanelChange: vi.fn(),
        showSearch: false,
        onToggleSearch: vi.fn(),
        showMasteryOverlay: false,
        onToggleMasteryOverlay,
        onSwitchView: vi.fn(),
        onEnterPresentation: vi.fn(),
        onStartAssociation: vi.fn(),
        onOpenVersionHistory: vi.fn(),
        onImport: vi.fn(),
        onExport: vi.fn(),
        onOpenShortcutHelp: vi.fn(),
        onOpenMobileMore: vi.fn(),
      };

      const { rerender } = render(
        <MindMapStoreContext.Provider value={store}>
          <MindMapToolbar {...baseProps} />
        </MindMapStoreContext.Provider>,
      );

      const masteryBtn = screen.getByTestId('mm-mastery-toggle');
      expect(masteryBtn).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(masteryBtn);
      expect(onToggleMasteryOverlay).toHaveBeenCalledTimes(1);

      rerender(
        <MindMapStoreContext.Provider value={store}>
          <MindMapToolbar {...baseProps} showMasteryOverlay />
        </MindMapStoreContext.Provider>,
      );
      expect(screen.getByTestId('mm-mastery-toggle')).toHaveAttribute('aria-pressed', 'true');

      // 隐藏已完成在工具栏仅出现一次
      const hideCompletedButtons = screen.getAllByRole('button', {
        name: 'mindmap:toolbar.hideCompleted',
      });
      expect(hideCompletedButtons).toHaveLength(1);
      fireEvent.click(hideCompletedButtons[0]);
      expect(store.getState().hideCompleted).toBe(true);

      // 移动端暂存盘入口带未处理数量 badge，点击切换 stagingTrayOpen
      expect(screen.getByTestId('mm-mobile-staging-badge').textContent).toBe('2');
      fireEvent.click(screen.getByTestId('mm-mobile-staging-tray-toggle'));
      expect(store.getState().stagingTrayOpen).toBe(true);

      // 顶栏直接暴露「导入思维导图」入口，点击无需翻找溢出菜单
      const importBtn = screen.getByTestId('mm-import-toggle');
      fireEvent.click(importBtn);
      expect(baseProps.onImport).toHaveBeenCalledTimes(1);
    });
  });

  describe('MindMapSearchBanner CJK IME guard', () => {
    it('does not advance search result on Enter during IME composition or post-composition window', () => {
      const store = createMindMapStore();
      const nextSpy = vi.fn();
      const prevSpy = vi.fn();
      store.setState({
        document: createSampleDocument(),
        searchResults: ['b1', 'b2'],
        currentSearchIndex: 0,
        nextSearchResult: nextSpy,
        prevSearchResult: prevSpy,
      });

      const onCloseSearch = vi.fn();
      let nowMs = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => nowMs);

      render(
        <MindMapStoreContext.Provider value={store}>
          <MindMapSearchBanner
            showSearch
            searchInput="树"
            onSearchInputChange={vi.fn()}
            onCloseSearch={onCloseSearch}
          />
        </MindMapStoreContext.Provider>,
      );

      const input = screen.getByPlaceholderText('mindmap:toolbar.searchPlaceholder');

      // 1. 组合输入进行中按 Enter：绝不跳转下一个搜索结果
      fireEvent.compositionStart(input);
      fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
      expect(nextSpy).not.toHaveBeenCalled();

      // 2. Safari/WKWebView compositionend 后 100ms 保护窗内按 Enter：仍不跳转
      fireEvent.compositionEnd(input);
      nowMs = 1040;
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(nextSpy).not.toHaveBeenCalled();

      // 3. 超过保护窗且 rAF 复位后，正常按 Enter 才触发 nextSearchResult
      nowMs = 1200;
      act(() => {
        // 触发一帧复位（jsdom rAF 使用 timer 时兜底）
      });
      // 手动创建非合成期新渲染验证纯 Enter / Shift+Enter
      cleanup();
      render(
        <MindMapStoreContext.Provider value={store}>
          <MindMapSearchBanner
            showSearch
            searchInput="树"
            onSearchInputChange={vi.fn()}
            onCloseSearch={onCloseSearch}
          />
        </MindMapStoreContext.Provider>,
      );
      const freshInput = screen.getByPlaceholderText('mindmap:toolbar.searchPlaceholder');
      fireEvent.keyDown(freshInput, { key: 'Enter' });
      expect(nextSpy).toHaveBeenCalledTimes(1);

      fireEvent.keyDown(freshInput, { key: 'Enter', shiftKey: true });
      expect(prevSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('MindMapContentView shell integration', () => {
    it('yields Escape to inline node editor while in presentation mode, then exits when not editing', () => {
      render(<MindMapContentView isActive />);

      // 点击演示按钮进入演示模式
      fireEvent.click(screen.getByTestId('mm-presentation-toggle'));
      expect(screen.getByTestId('mm-presentation-bar')).toBeInTheDocument();
      expect(screen.getByTestId('mock-mindmap-view')).toHaveAttribute(
        'data-presentation',
        'true',
      );

      // 聚焦节点内联编辑器后按 Escape：演示模式不得被误关
      const inlineInput = screen.getByTestId('mock-node-inline-input');
      inlineInput.focus();
      expect(document.activeElement).toBe(inlineInput);
      fireEvent.keyDown(inlineInput, { key: 'Escape', bubbles: true });
      expect(screen.getByTestId('mm-presentation-bar')).toBeInTheDocument();

      // 退出内联编辑器后按 Escape：正常退出演示模式
      inlineInput.blur();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByTestId('mm-presentation-bar')).not.toBeInTheDocument();
    });

    it('supports Spotlight keyboard stepping (ArrowRight/Space/ArrowLeft/Home) and passes presentationBranchId', async () => {
      const onReady = vi.fn();
      render(<MindMapContentView resourceId="mm-spot-1" isActive onReady={onReady} />);

      await waitFor(() => {
        expect(onReady).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('mock-mindmap-view')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('mm-presentation-toggle'));
      expect(screen.getByTestId('mock-mindmap-view')).toHaveAttribute('data-presentation', 'true');
      expect(screen.getByTestId('mock-mindmap-view')).toHaveAttribute('data-presentation-branch', '');

      // ArrowRight -> 第 1 个一级分支 b1
      fireEvent.keyDown(window, { key: 'ArrowRight' });
      expect(screen.getByTestId('mock-mindmap-view')).toHaveAttribute('data-presentation-branch', 'b1');

      // Space -> 第 2 个一级分支 b2
      fireEvent.keyDown(window, { key: ' ', code: 'Space' });
      expect(screen.getByTestId('mock-mindmap-view')).toHaveAttribute('data-presentation-branch', 'b2');

      // ArrowLeft -> 返回 b1
      fireEvent.keyDown(window, { key: 'ArrowLeft' });
      expect(screen.getByTestId('mock-mindmap-view')).toHaveAttribute('data-presentation-branch', 'b1');

      // Home -> 返回总览
      fireEvent.keyDown(window, { key: 'Home' });
      expect(screen.getByTestId('mock-mindmap-view')).toHaveAttribute('data-presentation-branch', '');

      // 焦点在交互按钮上按 Space 不应步进分支
      const exitBtn = screen.getByTestId('mm-presentation-exit');
      exitBtn.focus();
      fireEvent.keyDown(exitBtn, { key: ' ', code: 'Space', bubbles: true });
      expect(screen.getByTestId('mock-mindmap-view')).toHaveAttribute('data-presentation-branch', '');
      exitBtn.blur();

      // 长按 repeat 事件不应连发步进
      fireEvent.keyDown(window, { key: 'ArrowRight', repeat: true });
      fireEvent.keyDown(window, { key: ' ', code: 'Space', repeat: true });
      expect(screen.getByTestId('mock-mindmap-view')).toHaveAttribute('data-presentation-branch', '');
    });

    it('strictly orders Escape closing: transient overlay -> activePanel -> search -> presentation', () => {
      const { container } = render(<MindMapContentView isActive />);

      // 打开搜索 + 样式面板 + 演示态前的层级验证：先测 activePanel 与 search
      fireEvent.click(screen.getByRole('button', { name: 'mindmap:toolbar.search' }));
      expect(container.querySelector('.mm-content-stage > .mm-search-popover')).not.toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'mindmap:toolbar.styleSettings' }));
      expect(screen.getByTestId('mock-style-settings')).toHaveAttribute('data-open', 'true');

      // 模拟打开中的瞬态浮层（如右键菜单）：Escape 放行，不关样式面板也不关搜索
      const fakeMenu = document.createElement('div');
      fakeMenu.setAttribute('role', 'menu');
      fakeMenu.setAttribute('data-state', 'open');
      document.body.appendChild(fakeMenu);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.getByTestId('mock-style-settings')).toHaveAttribute('data-open', 'true');
      expect(container.querySelector('.mm-search-popover')).not.toBeNull();
      fakeMenu.remove();

      // 下一次 Escape 优先关闭 activePanel(style)，保留搜索条
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.getByTestId('mock-style-settings')).toHaveAttribute('data-open', 'false');
      expect(container.querySelector('.mm-search-popover')).not.toBeNull();

      // 焦点在搜索条内的选项按钮上按 Escape -> 关闭搜索条
      const caseBtn = screen.getByRole('button', { name: 'mindmap:toolbar.searchCaseSensitive' });
      caseBtn.focus();
      fireEvent.keyDown(caseBtn, { key: 'Escape', bubbles: true });
      expect(container.querySelector('.mm-search-popover')).toBeNull();

      // 演示态下打开搜索条：第一次 Escape 先关搜索，第二次 Escape 再退演示
      fireEvent.click(screen.getByTestId('mm-presentation-toggle'));
      fireEvent.keyDown(window, { key: 'f', metaKey: true });
      expect(container.querySelector('.mm-search-popover')).not.toBeNull();
      expect(screen.getByTestId('mm-presentation-bar')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(container.querySelector('.mm-search-popover')).toBeNull();
      expect(screen.getByTestId('mm-presentation-bar')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByTestId('mm-presentation-bar')).not.toBeInTheDocument();
    });

    it('auto-closes mobile search/subview on mobile staging tray open and prioritizes mobile staging in Android back LIFO', () => {
      useMobileScreenMock.mockReturnValue(true);
      const { container } = render(<MindMapContentView isActive />);

      // 先打开搜索条与移动更多子屏（子屏应挂载在 .mm-document-column 层级覆盖横幅）
      fireEvent.keyDown(window, { key: 'f', metaKey: true });
      expect(container.querySelector('.mm-search-popover')).not.toBeNull();
      fireEvent.click(screen.getAllByRole('button', { name: 'mindmap:toolbar.moreActions' }).at(-1)!);
      expect(container.querySelector('.mm-document-column > .mm-mobile-subview')).not.toBeNull();

      const seqBeforeStaging = Math.max(0, ...backHandlers.map((h) => h.seq));

      // 打开移动端暂存盘：自动收起搜索条与子屏，且拿到更新的 LIFO seq 并提权至 max-md:z-overlay
      fireEvent.click(screen.getByTestId('mm-mobile-staging-tray-toggle'));
      const tray = screen.getByTestId('mm-staging-tray');
      expect(tray.className).toContain('max-md:z-overlay');
      expect(container.querySelector('.mm-search-popover')).toBeNull();
      expect(container.querySelector('.mm-mobile-subview')).toBeNull();

      const overlayEntries = backHandlers
        .filter((h) => h.priority === 100)
        .sort((a, b) => b.seq - a.seq);
      expect(overlayEntries[0]?.seq).toBeGreaterThan(seqBeforeStaging);

      // 执行顶层 Android 返回键处理器：优先关闭移动端暂存盘
      act(() => {
        expect(overlayEntries[0].handler()).toBe(true);
      });
      expect(screen.queryByTestId('mm-staging-tray')).not.toBeInTheDocument();
    });

    it('loads mastery summary when mastery toggle is enabled and forwards status map to MindMapView', async () => {
      loadMasteryMock.mockResolvedValue({
        b1: { status: 'struggling', cardId: 'card_mm_mm-mastery-1_b1', lapses: 3 },
        b2: { status: 'mastered', cardId: 'card_mm_mm-mastery-1_b2' },
      });

      const onReady = vi.fn();
      render(<MindMapContentView resourceId="mm-mastery-1" isActive onReady={onReady} />);
      await waitFor(() => {
        expect(onReady).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('mock-mindmap-view')).toBeInTheDocument();
      });
      expect(loadMasteryMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('mm-mastery-toggle'));
      await waitFor(() => {
        expect(loadMasteryMock).toHaveBeenCalledWith('mm-mastery-1');
        expect(lastMindMapViewProps.current?.showMasteryOverlay).toBe(true);
        expect(lastMindMapViewProps.current?.masteryStatusByNodeId).toEqual({
          b1: 'struggling',
          b2: 'mastered',
        });
      });
    });

    it('handles mindmap:ai-action custom event by preventing default and dispatching AI action', async () => {
      const onReady = vi.fn();
      render(<MindMapContentView resourceId="mm-ai-1" isActive onReady={onReady} />);
      await waitFor(() => {
        expect(onReady).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('mock-mindmap-view')).toBeInTheDocument();
      });

      // 不匹配的 mindmapId 不应被本实例消费
      const otherEvent = new CustomEvent('mindmap:ai-action', {
        cancelable: true,
        detail: {
          action: 'ask',
          nodeId: 'b1',
          mindmapId: 'mm-other',
        },
      });
      expect(window.dispatchEvent(otherEvent)).toBe(true);
      expect(selectionToChatMock).not.toHaveBeenCalled();

      // 缺少 mindmapId 的事件不应被已加载具体文档的实例串单消费
      const missingIdEvent = new CustomEvent('mindmap:ai-action', {
        cancelable: true,
        detail: {
          action: 'ask',
          nodeId: 'b1',
        },
      });
      expect(window.dispatchEvent(missingIdEvent)).toBe(true);
      expect(selectionToChatMock).not.toHaveBeenCalled();

      // 匹配的 mindmapId 统一交由 dispatchMindMapAiAction 并 preventDefault
      const event = new CustomEvent('mindmap:ai-action', {
        cancelable: true,
        detail: {
          action: 'ask',
          nodeId: 'b1',
          mindmapId: 'mm-ai-1',
        },
      });
      const notCanceled = window.dispatchEvent(event);
      expect(notCanceled).toBe(false);

      await waitFor(() => {
        expect(selectionToChatMock).toHaveBeenCalledTimes(1);
        expect(dispatchAppEventMock).toHaveBeenCalledWith(
          APP_EVENTS.PREFILL_CHAT_INPUT,
          expect.objectContaining({ autoSend: false }),
        );
      });
    });

    it('prevents duplicate mindmap:ai-action dispatch when multiple active instances share the same resourceId', async () => {
      const onReady1 = vi.fn();
      const onReady2 = vi.fn();
      render(
        <>
          <MindMapContentView resourceId="mm-dup-1" storeInstanceId="pane-1" isActive onReady={onReady1} />
          <MindMapContentView resourceId="mm-dup-1" storeInstanceId="pane-2" isActive onReady={onReady2} />
        </>,
      );

      await waitFor(() => {
        expect(onReady1).toHaveBeenCalledTimes(1);
        expect(onReady2).toHaveBeenCalledTimes(1);
      });

      const event = new CustomEvent('mindmap:ai-action', {
        cancelable: true,
        detail: {
          action: 'expand',
          nodeId: 'b1',
          mindmapId: 'mm-dup-1',
        },
      });
      expect(window.dispatchEvent(event)).toBe(false);

      await waitFor(() => {
        expect(selectionToChatMock).toHaveBeenCalledTimes(1);
      });
    });

    it('yields Escape to active .mm-dragging node drag without closing search', () => {
      const { container } = render(<MindMapContentView isActive />);
      fireEvent.keyDown(window, { key: 'f', metaKey: true });
      expect(container.querySelector('.mm-search-popover')).not.toBeNull();

      const draggingNode = document.createElement('div');
      draggingNode.className = 'react-flow__node mm-dragging';
      container.querySelector('[data-testid="mock-mindmap-view"]')?.appendChild(draggingNode);

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(container.querySelector('.mm-search-popover')).not.toBeNull();
      draggingNode.remove();
    });

    it('refreshes mastery summary live on flashcard events when mastery overlay is active', async () => {
      loadMasteryMock.mockResolvedValue({
        b1: { status: 'learning', cardId: 'card_mm_mm-mastery-live_b1' },
      });

      const onReady = vi.fn();
      render(<MindMapContentView resourceId="mm-mastery-live" isActive onReady={onReady} />);
      await waitFor(() => {
        expect(onReady).toHaveBeenCalledTimes(1);
      });

      fireEvent.click(screen.getByTestId('mm-mastery-toggle'));
      await waitFor(() => {
        expect(loadMasteryMock).toHaveBeenCalledTimes(1);
      });

      // Mismatched mapId on projected event should be ignored
      act(() => {
        dispatchTypedEvent(DS_MINDMAP_FLASHCARD_PROJECTED_EVENT, {
          action: 'upsert',
          mapId: 'mm-other',
        });
      });
      expect(loadMasteryMock).toHaveBeenCalledTimes(1);

      // Matching mapId triggers refresh
      act(() => {
        dispatchTypedEvent(DS_MINDMAP_FLASHCARD_PROJECTED_EVENT, {
          action: 'upsert',
          mapId: 'mm-mastery-live',
        });
      });
      await waitFor(() => {
        expect(loadMasteryMock).toHaveBeenCalledTimes(2);
      });

      act(() => {
        requestFlashcardsDueRefresh();
      });
      await waitFor(() => {
        expect(loadMasteryMock).toHaveBeenCalledTimes(3);
      });

      act(() => {
        dispatchTypedEvent(FSRS_STATS_REFRESH_EVENT, { reason: 'review' });
      });
      await waitFor(() => {
        expect(loadMasteryMock).toHaveBeenCalledTimes(4);
      });

      act(() => {
        dispatchTypedEvent(FLASHCARDS_CHANGED_EVENT, { reason: 'sync' });
      });
      await waitFor(() => {
        expect(loadMasteryMock).toHaveBeenCalledTimes(5);
      });
    });

    it('provides a WebUI file input fallback for import and reports both success and invalid-file errors via toast (W8B-03)', async () => {
      render(<MindMapContentView isActive />);

      const fileInput = screen.getByTestId('mm-webui-import-input') as HTMLInputElement;
      expect(fileInput.type).toBe('file');
      expect(fileInput.accept).toContain('.xmind');
      expect(fileInput.accept).toContain('.json');
      expect(fileInput.accept).toContain('.mm');
      expect(fileInput.accept).toContain('.md');

      // 1. Valid Markdown outline import succeeds and notifies success
      const mdFile = new File(['# Physics\n- Mechanics\n- Optics\n'], 'physics.md', {
        type: 'text/markdown',
      });
      Object.defineProperty(mdFile, 'text', {
        value: async () => '# Physics\n- Mechanics\n- Optics\n',
      });
      fireEvent.change(fileInput, { target: { files: [mdFile] } });

      await waitFor(() => {
        expect(notifyMock).toHaveBeenCalledWith('success', expect.any(String));
      });

      // 2. Invalid JSON file surfaces both inline error and global error toast
      notifyMock.mockClear();
      const badJson = new File(['{broken json'], 'broken.json', {
        type: 'application/json',
      });
      Object.defineProperty(badJson, 'text', {
        value: async () => '{broken json',
      });
      fireEvent.change(fileInput, { target: { files: [badJson] } });

      await waitFor(() => {
        expect(notifyMock).toHaveBeenCalledWith('error', expect.any(String));
      });
    });
  });
});
