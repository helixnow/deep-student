import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import zhCommon from '@/locales/zh-CN/common.json';
import enCommon from '@/locales/en-US/common.json';

const occlusionMocks = vi.hoisted(() => ({
  openImageOcclusionBuilder: vi.fn(),
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'fsrs_get_due') return [];
    if (cmd === 'fsrs_get_stats') {
      return {
        total: 0,
        due: 0,
        newCount: 0,
        learning: 0,
        review: 0,
        relearning: 0,
        suspended: 0,
        reviewsToday: 0,
      };
    }
    if (cmd === 'list_anki_library_cards') return { items: [], total: 0, decks: [] };
    return null;
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: occlusionMocks.invoke }));
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: true }),
  usePhoneLandscape: () => false,
}));
vi.mock('@/hooks/useEventRegistry', () => ({ useEventRegistry: vi.fn() }));
vi.mock('@/ui-kernel/bootstrap', () => ({ getAppKernel: () => null }));
vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  BACK_PRIORITY: { view: 1, overlay: 2 },
  registerVisibilityGuardedBackHandler: () => () => undefined,
}));
vi.mock('@/components/exam-sprint', () => ({ ExamReadinessHud: () => null }));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));
vi.mock('@/components/layout/MobileSlidingLayout', async () => {
  const { MobileInFlowHeader } = await import('@/components/layout/UnifiedMobileHeader');
  return {
    MobileSlidingLayout: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="mobile-sliding-layout">
        <MobileInFlowHeader />
        {children}
      </div>
    ),
  };
});
vi.mock('../hooks/useReviewActivity', () => ({
  useReviewActivity: () => ({ status: 'ready', dayCounts: new Map(), totalCards: 0, reload: vi.fn() }),
  computeCurrentStreak: () => 0,
}));
vi.mock('../occlusion/ImageOcclusionBuilderModal', () => ({
  ImageOcclusionBuilderModal: () => null,
  openImageOcclusionBuilder: occlusionMocks.openImageOcclusionBuilder,
}));
vi.mock('react-i18next', () => {
  const table: Record<string, string> = {
    'workbench:apps.flashcards': '闪卡',
    'sidebar:navigation.flashcards': '闪卡',
    'tabs.nav': '闪卡导航',
    'tabs.today': '今日',
    'tabs.library': '库',
    'tabs.statistics': '统计',
    'today.title': '今日复习',
    'today.startReview': '开始复习',
    'today.statDue': '待复习',
    'today.statNew': '新卡',
    'today.statLearning': '学习中',
    'today.progressCaption': '今日进度',
    'today.libraryEmpty': '卡片库还是空的',
    'today.libraryEmptyHint': '新建卡片开始学习',
    'today.goLibrary': '打开卡片库',
    'today.goStats': '查看统计',
    'library.title': '卡片库',
    'library.loading': '加载中…',
    'library.total': '共 {{count}} 张',
    'library.create.new': '新建卡片',
    'library.create.save': '保存并入队',
    'library.create.frontLabel': '卡片正面',
    'library.create.backLabel': '卡片背面',
    'library.create.deckLabel': '所属牌组（可选）',
    'library.create.frontPlaceholder': '正面',
    'library.create.backPlaceholder': '背面',
    'library.create.deckPlaceholder': '牌组',
    'library.create.hint': '提示',
    'library.searchPlaceholder': '搜索',
    'library.searchLabel': '搜索卡片',
    'library.search': '搜索',
    'library.filter.label': '筛选',
    'occlusion.newCardButton': '新建图片遮挡卡',
    'common:more': '更多',
    'common:mobile_header.open_sidebar': '打开侧栏',
    'common:mobile_header.back': '返回',
    'common:navigation_label': '导航',
  };
  const mockT = (key: string, opts?: Record<string, unknown> | string) => {
    if (table[key]) return table[key];
    if (typeof opts === 'string') return opts;
    if (opts && typeof opts.defaultValue === 'string') return opts.defaultValue;
    return key;
  };
  const mockI18n = { language: 'zh-CN' };
  const result = { t: mockT, i18n: mockI18n };
  return {
    useTranslation: () => result,
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

import {
  MobileHeaderActiveViewSync,
  MobileHeaderNavProvider,
  MobileHeaderProvider,
  useMobileHeader,
} from '@/components/layout/MobileHeaderContext';
import FlashcardsAppWindow from '@/features/workbench/apps/system/FlashcardsAppWindow';
import { workbenchTypeIdToMobileHeaderViewId } from '@/features/workbench/components/WorkbenchDesktop';
import { useFsrsReviewStore } from '../store/fsrsReviewStore';
import { useFlashcardsLibraryStore } from '../store/libraryStore';

const SimulatedChatHeaderOwner: React.FC = () => {
  useMobileHeader('chat-v2', {
    title: 'LTP 闪卡制作',
    rightActions: <button type="button">+ 新建会话</button>,
    showMenu: true,
    onMenuClick: () => undefined,
  }, []);
  return null;
};

describe('G18 360px Flashcards MobileHeader isolation & New Card / Image Occlusion entry', () => {
  beforeEach(() => {
    occlusionMocks.openImageOcclusionBuilder.mockReset();
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
    useFlashcardsLibraryStore.getState().reset();
  });

  it('maps Workbench window typeIds to MobileHeaderContext viewIds', () => {
    expect(workbenchTypeIdToMobileHeaderViewId('flashcards')).toBe('flashcards');
    expect(workbenchTypeIdToMobileHeaderViewId('chat')).toBe('chat-v2');
    expect(workbenchTypeIdToMobileHeaderViewId('todo')).toBe('todo');
    expect(workbenchTypeIdToMobileHeaderViewId('settings')).toBe('settings');
    expect(workbenchTypeIdToMobileHeaderViewId('files')).toBe('learning-hub');
    expect(workbenchTypeIdToMobileHeaderViewId('unknown-app')).toBeNull();
    expect(workbenchTypeIdToMobileHeaderViewId(null)).toBeNull();
  });

  it('shows Flashcards title + New Card & Image Occlusion actions at 360px without leaking Chat header', async () => {
    render(
      <MobileHeaderProvider>
        <MobileHeaderActiveViewSync activeView="chat-v2" />
        <MobileHeaderNavProvider value={{ fallbackTitle: 'LTP 闪卡制作' }}>
          <SimulatedChatHeaderOwner />
          <FlashcardsAppWindow
            windowId="win-fc-1"
            instanceKey={null}
            isActive={true}
            isVisible={true}
            onTitleChange={() => undefined}
            requestClose={() => undefined}
          />
        </MobileHeaderNavProvider>
      </MobileHeaderProvider>,
    );

    // Header must show Flashcards title and NEVER leak Chat session title or + 新建会话.
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('闪卡');
    expect(screen.queryByText('LTP 闪卡制作')).not.toBeInTheDocument();
    expect(screen.queryByText('+ 新建会话')).not.toBeInTheDocument();

    // Image Occlusion entry is 1-tap reachable on TodayScreen 360px header.
    const occlusionBtn = screen.getByTestId('fc-today-new-occlusion-mobile');
    expect(occlusionBtn).toHaveAttribute('aria-label', '新建图片遮挡卡');
    fireEvent.click(occlusionBtn);
    expect(occlusionMocks.openImageOcclusionBuilder).toHaveBeenCalledTimes(1);

    // + New Card entry switches to Library and immediately opens the mobile card composer.
    const newCardBtn = screen.getByTestId('fc-today-new-card-mobile');
    expect(newCardBtn).toHaveAttribute('aria-label', '新建卡片');
    fireEvent.click(newCardBtn);

    await waitFor(() => {
      expect(useFsrsReviewStore.getState().screen).toBe('library');
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('新建卡片');
    });
  });
});

describe('S7 zh-CN/en-US common.json jargon purge & key parity', () => {
  const collectLeaves = (obj: Record<string, unknown>, prefix = ''): Array<[string, string]> => {
    const entries: Array<[string, string]> = [];
    for (const [key, val] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof val === 'string') entries.push([path, val]);
      else if (val && typeof val === 'object' && !Array.isArray(val)) {
        entries.push(...collectLeaves(val as Record<string, unknown>, path));
      }
    }
    return entries;
  };

  it('keeps 100% key parity and removes English/RAG/Embedding/Vector leaks from audited zh-CN & en-US sections', () => {
    const sections: Array<[(root: typeof zhCommon) => Record<string, unknown>, string]> = [
      [(r) => r.settings.model_assignment_section as unknown as Record<string, unknown>, 'settings.model_assignment_section'],
      [(r) => r.settings.general_settings_section as unknown as Record<string, unknown>, 'settings.general_settings_section'],
      [(r) => r.settings.api_edit_modal as unknown as Record<string, unknown>, 'settings.api_edit_modal'],
      [(r) => r.ui.siliconflow as unknown as Record<string, unknown>, 'ui.siliconflow'],
      [(r) => r.flashcards_import_banner as unknown as Record<string, unknown>, 'flashcards_import_banner'],
    ];

    const jargonRegex = /(?<![-/])\b(RAG|Retrieval Augmented Generation|vector embeddings?|rerank(?:er|ing)?|Top-K)\b(?![-/])/i;

    for (const [pick, label] of sections) {
      const zhLeaves = collectLeaves(pick(zhCommon));
      const enLeaves = collectLeaves(pick(enCommon));
      expect(zhLeaves.map(([k]) => k), `${label} key parity`).toEqual(enLeaves.map(([k]) => k));

      for (const [k, v] of zhLeaves) {
        if (k === 'adapter_options.google') continue;
        expect(/[\u4e00-\u9fff]/.test(v), `zh-CN ${label}.${k} should contain Chinese: "${v}"`).toBe(true);
        expect(jargonRegex.test(v), `zh-CN ${label}.${k} should not expose raw RAG/Vector jargon: "${v}"`).toBe(false);
      }
      for (const [k, v] of enLeaves) {
        expect(jargonRegex.test(v), `en-US ${label}.${k} should not expose raw RAG/Vector jargon: "${v}"`).toBe(false);
      }
    }
  });
});
