import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnkiLibraryCard, AnkiLibraryListResponse, ListAnkiCardsParams } from '@/types';
import type { Question } from '@/api/questionBankApi';

const {
  listAnkiLibraryCardsMock,
  updateAnkiCardMock,
  invokeMock,
  viewportElements,
} = vi.hoisted(() => ({
  listAnkiLibraryCardsMock: vi.fn<(params: ListAnkiCardsParams) => Promise<AnkiLibraryListResponse>>(),
  updateAnkiCardMock: vi.fn(),
  invokeMock: vi.fn(async () => null as unknown),
  viewportElements: {
    flashcards: null as HTMLDivElement | null,
    qbank: null as HTMLDivElement | null,
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@/utils/chatApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/chatApi')>()),
  listAnkiLibraryCards: listAnkiLibraryCardsMock,
  updateAnkiLibraryCard: updateAnkiCardMock,
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
  useIsMobile: () => false,
}));

vi.mock('@/hooks/useEventRegistry', () => ({
  useEventRegistry: vi.fn(),
}));

vi.mock('../../useFlashcardsMobileChrome', () => ({
  useFlashcardsMobileChrome: () => false,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/components/anki/AnkiTemplateCardFace', () => ({
  AnkiTemplateCardFace: () => <div data-testid="card-face" />,
}));

vi.mock('@/hooks/useAnkiTemplateLoader', () => ({
  useAnkiTemplateLoader: () => ({ template: null, loading: false }),
}));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({
    children,
    className,
    viewportRef,
  }: {
    children: React.ReactNode;
    className?: string;
    viewportRef?: React.Ref<HTMLDivElement>;
  }) => {
    const attachRef = (el: HTMLDivElement | null) => {
      if (typeof viewportRef === 'function') {
        viewportRef(el);
      } else if (viewportRef && 'current' in viewportRef) {
        (viewportRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
      }
      if (className?.includes('wb-fc-list')) {
        viewportElements.flashcards = el;
      } else {
        viewportElements.qbank = el;
      }
    };
    return (
      <div
        ref={attachRef}
        data-testid={className?.includes('wb-fc-list') ? 'fc-scroll-viewport' : 'qbank-scroll-viewport'}
        className={className}
      >
        {children}
      </div>
    );
  },
}));

vi.mock('../LibraryCardRow', () => ({
  LibraryCardRow: ({
    card,
    expanded,
    onToggleExpand,
    onSaveEdit,
    onStartReview,
    rowRef,
  }: {
    card: AnkiLibraryCard;
    expanded: boolean;
    onToggleExpand: (id: string) => void;
    onSaveEdit: (id: string, patch: { front?: string; back?: string }) => Promise<boolean>;
    onStartReview: (card: AnkiLibraryCard) => void;
    rowRef?: (el: HTMLLIElement | null) => void;
  }) => (
    <li
      ref={rowRef}
      tabIndex={-1}
      data-testid={`card-row-${card.id}`}
      data-expanded={expanded ? 'true' : 'false'}
    >
      <span>{card.front}</span>
      <button type="button" onClick={() => onToggleExpand(card.id)}>
        Toggle {card.id}
      </button>
      <button type="button" onClick={() => onStartReview(card)}>
        Review {card.id}
      </button>
      {expanded && (
        <div data-testid={`card-editor-${card.id}`}>
          <button
            type="button"
            onClick={() => void onSaveEdit(card.id, { front: `${card.front} (edited)`, back: card.back })}
          >
            Save {card.id}
          </button>
          <button type="button" onClick={() => onToggleExpand(card.id)}>
            Cancel {card.id}
          </button>
        </div>
      )}
    </li>
  ),
}));

vi.mock('@/components/QuestionInlineEditor', () => ({
  QuestionInlineEditor: ({
    question,
    onSave,
    onCancel,
  }: {
    question: Question;
    onSave: (q: Question) => Promise<void>;
    onCancel: () => void;
  }) => (
    <div data-testid={`qbank-inline-editor-${question.id}`}>
      <button
        type="button"
        onClick={() => {
          void onSave({ ...question, content: `${question.content} (saved)` }).then(() => onCancel());
        }}
      >
        Save Question {question.id}
      </button>
      <button type="button" onClick={onCancel}>
        Cancel Question {question.id}
      </button>
    </div>
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const table: Record<string, string> = {
        'library.title': '卡片库',
        'library.loading': '加载中…',
        'library.page': '第 {{page}} / {{pages}} 页',
        'library.previous': '上一页',
        'library.next': '下一页',
        'library.search': '搜索',
        'library.searchLabel': '搜索卡片',
        'library.searchPlaceholder': '搜索正面、背面或标签…',
        'library.total': '共 {{count}} 张',
        'library.deck.label': '牌组',
        'library.deck.all': '全部牌组',
        'library.filtersToggle': '筛选与排序',
        'session.exit': '退出',
        'practice:questionBank.searchPlaceholder': '搜索题目...',
        'practice:questionBank.editQuestion': '编辑题目',
        'practice:questionBank.statusShort.new': '未做',
        'practice:questionBank.statusShort.inProgress': '进行中',
        'practice:questionBank.statusShort.mastered': '已掌握',
        'practice:questionBank.statusShort.review': '待复习',
        'practice:questionBank.status.all': '全部状态',
        'practice:questionBank.status.review': '待复习',
      };
      const raw = table[key] ?? (typeof opts?.defaultValue === 'string' ? opts.defaultValue : key);
      if (!opts) return raw;
      return raw.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_, k) => String(opts[k] ?? ''));
    },
    i18n: { language: 'zh-CN' },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { LibraryScreen } from '../../screens/LibraryScreen';
import { ReviewSessionScreen } from '../../screens/ReviewSessionScreen';
import { useFsrsReviewStore } from '../../store/fsrsReviewStore';
import { FLASHCARDS_LIBRARY_PAGE_SIZE, useFlashcardsLibraryStore } from '../../store/libraryStore';
import {
  peekPendingLibraryCardFocus,
  requestLibraryCardFocus,
  resetLibraryViewState,
} from '../libraryViewState';
import {
  QuestionBankListView,
  clearQuestionBankListViewState,
} from '@/components/QuestionBankListView';

const LARGE_LIBRARY_TOTAL = 5000;

function makeFlashcardsDataset(): AnkiLibraryCard[] {
  return Array.from({ length: LARGE_LIBRARY_TOTAL }, (_, idx) => {
    const n = idx + 1;
    const isBiology = n <= 320;
    const deck = isBiology ? 'Biology::Genetics' : 'Chemistry::Organic';
    const isCrispr = isBiology && n <= 260;
    return {
      id: `fc-${n}`,
      front: isCrispr ? `CRISPR Cas9 locus #${n}` : `General concept #${n}`,
      back: isCrispr ? `Cas9 endonuclease cleavage answer #${n}` : `General answer #${n}`,
      tags: isCrispr ? ['crispr', 'genetics'] : ['general'],
      created_at: '2026-01-01T00:00:00.000Z',
      enqueued: true,
      suspended: false,
      isDue: n % 2 === 0,
      state: 2,
      reps: 3,
      lapses: 0,
      stateId: `state-${n}`,
      deckName: deck,
      extra_fields: { _deck: deck },
    };
  });
}

function makeQBankQuestions(count = 260): Question[] {
  return Array.from({ length: count }, (_, idx) => {
    const n = idx + 1;
    const isGenetics = n <= 130;
    const isCrispr = n <= 90;
    return {
      id: `q_${n}`,
      questionLabel: String(n),
      content: isCrispr
        ? `CRISPR gene editing question #${n}`
        : isGenetics
          ? `Mendelian genetics inheritance question #${n}`
          : `General organic chemistry question #${n}`,
      questionType: 'short_answer',
      options: [],
      answer: `Answer #${n}`,
      explanation: `Explanation #${n}`,
      difficulty: n % 2 === 0 ? 'medium' : 'hard',
      tags: isCrispr ? ['genetics', 'crispr'] : isGenetics ? ['genetics'] : ['chemistry'],
      status: isGenetics ? 'review' : 'new',
      attemptCount: isGenetics ? 1 : 0,
      correctCount: 0,
      isFavorite: n % 5 === 0,
      images: [],
    };
  });
}

describe('U06 Flashcards Library (5,000 cards) & QBank filter/page/scroll return-state memory', () => {
  let cardsDb: AnkiLibraryCard[];

  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    resetLibraryViewState();
    clearQuestionBankListViewState();
    useFlashcardsLibraryStore.getState().reset();
    useFsrsReviewStore.setState({ screen: 'library', queue: [], queueIndex: 0 });
    viewportElements.flashcards = null;
    viewportElements.qbank = null;

    cardsDb = makeFlashcardsDataset();

    listAnkiLibraryCardsMock.mockImplementation(async (params) => {
      const page = params.page ?? 1;
      const pageSize = params.page_size ?? FLASHCARDS_LIBRARY_PAGE_SIZE;
      const search = (params.search ?? '').trim().toLowerCase();
      const deck = params.deck;
      const filtered = cardsDb.filter((card) => {
        if (deck !== undefined && deck !== null && (card.deckName ?? '') !== deck) {
          return false;
        }
        if (search) {
          const hay = `${card.front} ${card.back} ${card.tags.join(' ')}`.toLowerCase();
          if (!hay.includes(search)) return false;
        }
        return true;
      });
      const start = (page - 1) * pageSize;
      return {
        items: filtered.slice(start, start + pageSize),
        total: filtered.length,
        page,
        pageSize,
        decks: [
          { name: 'Biology::Genetics', all: 320, due: 160, new: 0, notEnqueued: 0 },
          { name: 'Chemistry::Organic', all: 4680, due: 2340, new: 0, notEnqueued: 0 },
        ],
      };
    });

    updateAnkiCardMock.mockImplementation(async (card: AnkiLibraryCard, patch: { front?: string; back?: string }) => {
      cardsDb = cardsDb.map((c) => (c.id === card.id ? { ...c, ...patch } : c));
      return true;
    });

    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'fsrs_enqueue_cards') {
        const ids = Array.isArray(args?.ankiCardIds) ? (args.ankiCardIds as string[]) : [];
        return {
          states: ids.map((ankiId) => {
            const found = cardsDb.find((c) => c.id === ankiId);
            return {
              id: found?.stateId ?? `state-${ankiId}`,
              ankiCardId: ankiId,
              front: found?.front ?? ankiId,
              back: found?.back ?? '',
              suspended: false,
            };
          }),
        };
      }
      return null;
    });
  });

  afterEach(() => {
    cleanup();
    clearQuestionBankListViewState();
    resetLibraryViewState();
    window.sessionStorage.clear();
  });

  it('preserves deck, search query, page 4, pageSize 50, expanded card, and scroll position across inline edit and review->return on a 5,000-card library', async () => {
    const view = render(<LibraryScreen />);

    await waitFor(() => {
      expect(screen.getByText('第 1 / 250 页')).toBeInTheDocument();
    });

    // Switch page size to 50
    const pageSizeSelect = screen.getByTestId('library-page-size-select') as HTMLSelectElement;
    fireEvent.change(pageSizeSelect, { target: { value: '50' } });
    await waitFor(() => {
      expect(screen.getByText('第 1 / 100 页')).toBeInTheDocument();
    });

    // Select deck Biology::Genetics (filter bar is always visible on desktop)
    const deckSelect = screen.getByLabelText('牌组') as HTMLSelectElement;
    fireEvent.change(deckSelect, { target: { value: 'Biology::Genetics' } });
    await waitFor(() => {
      expect(useFlashcardsLibraryStore.getState().deckFilter).toBe('Biology::Genetics');
    });

    // Search "CRISPR" (260 matching cards -> 6 pages of 50)
    const searchInput = screen.getByLabelText('搜索卡片') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'CRISPR' } });
    fireEvent.keyDown(searchInput, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText('第 1 / 6 页')).toBeInTheDocument();
    });

    // Jump to Page 4 (cards fc-151 .. fc-200)
    const jumpInput = screen.getByTestId('library-page-jump-input') as HTMLInputElement;
    fireEvent.change(jumpInput, { target: { value: '4' } });
    fireEvent.click(screen.getByTestId('library-page-jump-btn'));

    await waitFor(() => {
      expect(screen.getByText('第 4 / 6 页')).toBeInTheDocument();
      expect(screen.getByTestId('card-row-fc-155')).toBeInTheDocument();
    });

    // Scroll to 420px
    const viewport = screen.getByTestId('fc-scroll-viewport');
    viewport.scrollTop = 420;
    fireEvent.scroll(viewport);

    // Expand card fc-155, save inline edit, verify page 4 + filters + scroll stay intact
    fireEvent.click(screen.getByRole('button', { name: 'Toggle fc-155' }));
    expect(screen.getByTestId('card-editor-fc-155')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save fc-155' }));

    await waitFor(() => {
      expect(screen.getByText('CRISPR Cas9 locus #155 (edited)')).toBeInTheDocument();
    });
    expect(screen.getByText('第 4 / 6 页')).toBeInTheDocument();
    expect(useFlashcardsLibraryStore.getState().page).toBe(4);
    expect(useFlashcardsLibraryStore.getState().query).toBe('CRISPR');
    expect(useFlashcardsLibraryStore.getState().deckFilter).toBe('Biology::Genetics');
    expect(viewport.scrollTop).toBe(420);

    // Launch review from Library card fc-155 -> unmount LibraryScreen -> mount ReviewSessionScreen -> Exit
    fireEvent.click(screen.getByRole('button', { name: 'Review fc-155' }));
    await waitFor(() => {
      expect(useFsrsReviewStore.getState().screen).toBe('session');
      expect(useFsrsReviewStore.getState().queue).toHaveLength(1);
    });

    view.unmount();

    const sessionView = render(<ReviewSessionScreen />);
    fireEvent.click(screen.getByRole('button', { name: '退出' }));
    expect(useFsrsReviewStore.getState().screen).toBe('library');
    sessionView.unmount();

    // Simulate returning to a freshly remounted LibraryScreen (even after non-reset reload)
    useFlashcardsLibraryStore.setState({ loaded: false, items: [] });
    const returnedView = render(<LibraryScreen />);

    await waitFor(() => {
      expect(screen.getByText('第 4 / 6 页')).toBeInTheDocument();
      expect(screen.getByTestId('card-row-fc-155')).toHaveAttribute('data-expanded', 'true');
    });
    expect(listAnkiLibraryCardsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        page: 4,
        page_size: 50,
        search: 'CRISPR',
        deck: 'Biology::Genetics',
      }),
    );
    expect((screen.getByLabelText('搜索卡片') as HTMLInputElement).value).toBe('CRISPR');
    expect(screen.getByTestId('fc-scroll-viewport').scrollTop).toBe(420);

    // Actively changing search query DOES reset page back to 1 and scrollTop to 0
    const returnedSearch = screen.getByLabelText('搜索卡片') as HTMLInputElement;
    fireEvent.change(returnedSearch, { target: { value: 'locus #1' } });
    fireEvent.keyDown(returnedSearch, { key: 'Enter' });

    await waitFor(() => {
      expect(useFlashcardsLibraryStore.getState().page).toBe(1);
    });
    expect(screen.getByTestId('fc-scroll-viewport').scrollTop).toBe(0);
    returnedView.unmount();
  });

  it('preserves QBank search, tag filter, page 3, pageSize 20, and scrollTop across inline edit and detail/practice unmount->return', async () => {
    const initialQuestions = makeQBankQuestions(260);
    const examId = 'exam-crispr-memory-1';
    const onQuestionClick = vi.fn();

    const QBankHarness: React.FC<{ initial: Question[] }> = ({ initial }) => {
      const [items, setItems] = React.useState(initial);
      return (
        <QuestionBankListView
          examId={examId}
          questions={items}
          onQuestionClick={onQuestionClick}
          onUpdateQuestion={async (updated) => {
            setItems((prev) => prev.map((q) => (q.id === updated.id ? updated : q)));
          }}
        />
      );
    };

    const view = render(<QBankHarness initial={initialQuestions} />);

    // Filter by tag "genetics" (130 questions -> 3 pages of 50)
    const tagSelect = screen.getByTestId('qbank-tag-filter-select') as HTMLSelectElement;
    fireEvent.change(tagSelect, { target: { value: 'genetics' } });
    await waitFor(() => {
      expect(screen.getByTestId('qbank-page-indicator')).toHaveTextContent('1 / 3');
    });

    // Type search query "CRISPR" (narrows 130 -> 90 matching questions -> 2 pages of 50 after debounce)
    const searchInput = screen.getByPlaceholderText('搜索题目...') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'CRISPR' } });
    await waitFor(() => {
      expect(screen.getByTestId('qbank-page-indicator')).toHaveTextContent('1 / 2');
    });

    // Switch page size to 20 -> 90 / 20 = 5 pages
    const pageSizeSelect = screen.getByTestId('qbank-page-size-select') as HTMLSelectElement;
    fireEvent.change(pageSizeSelect, { target: { value: '20' } });
    await waitFor(() => {
      expect(screen.getByTestId('qbank-page-indicator')).toHaveTextContent('1 / 5');
    });

    // Jump to Page 3 (questions q_41 .. q_60)
    const jumpInput = screen.getByTestId('qbank-page-jump-input') as HTMLInputElement;
    fireEvent.change(jumpInput, { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('qbank-page-jump-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('qbank-page-indicator')).toHaveTextContent('3 / 5');
      expect(screen.getByText(/#41$/)).toBeInTheDocument();
    });

    // Scroll to 360px
    const viewport = screen.getByTestId('qbank-scroll-viewport');
    viewport.scrollTop = 360;
    fireEvent.scroll(viewport);

    // Inline edit q_41 -> save -> stays on Page 3 with updated content and same filters
    const editButtons = screen.getAllByRole('button', { name: '编辑题目' });
    fireEvent.click(editButtons[0]);
    expect(screen.getByTestId('qbank-inline-editor-q_41')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save Question q_41' }));

    await waitFor(() => {
      expect(screen.getByText(/#41 \(saved\)/)).toBeInTheDocument();
    });
    expect(screen.getByTestId('qbank-page-indicator')).toHaveTextContent('3 / 5');

    // Open inline edit again and cancel -> still on Page 3
    fireEvent.click(screen.getAllByRole('button', { name: '编辑题目' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Question q_41' }));
    expect(screen.getByTestId('qbank-page-indicator')).toHaveTextContent('3 / 5');

    // Click into question detail (navigates away -> unmount list view)
    fireEvent.click(screen.getByText(/#41 \(saved\)/));
    expect(onQuestionClick).toHaveBeenCalledWith(40);
    view.unmount();

    // Return to QBank list (even with transient loading empty array before questions arrive)
    const returned = render(
      <QuestionBankListView
        examId={examId}
        questions={[]}
        onQuestionClick={onQuestionClick}
      />,
    );
    returned.rerender(
      <QuestionBankListView
        examId={examId}
        questions={initialQuestions}
        onQuestionClick={onQuestionClick}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('qbank-page-indicator')).toHaveTextContent('3 / 5');
      expect(screen.getByText(/#41$/)).toBeInTheDocument();
    });
    expect((screen.getByPlaceholderText('搜索题目...') as HTMLInputElement).value).toBe('CRISPR');
    expect((screen.getByTestId('qbank-tag-filter-select') as HTMLSelectElement).value).toBe('genetics');
    expect((screen.getByTestId('qbank-page-size-select') as HTMLSelectElement).value).toBe('20');
    expect(screen.getByTestId('qbank-scroll-viewport').scrollTop).toBe(360);

    // Actively changing tag filter resets page back to 1 and scrollTop to 0
    fireEvent.change(screen.getByTestId('qbank-tag-filter-select'), { target: { value: 'all' } });
    await waitFor(() => {
      expect(screen.getByTestId('qbank-page-indicator')).toHaveTextContent('1 / 5');
    });
    expect(screen.getByTestId('qbank-scroll-viewport').scrollTop).toBe(0);
    returned.unmount();
  });

  it('auto-expands and focuses the exact target card in LibraryScreen after a Cmd+K deep jump', async () => {
    requestLibraryCardFocus({
      cardId: 'fc-42',
      query: 'CRISPR Cas9 locus #42',
      deckFilter: 'Biology::Genetics',
    });
    useFlashcardsLibraryStore.setState({
      statusFilter: 'all',
      deckFilter: 'Biology::Genetics',
      searchInput: 'CRISPR Cas9 locus #42',
      query: 'CRISPR Cas9 locus #42',
      page: 1,
    });

    render(<LibraryScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('card-row-fc-42')).toHaveAttribute('data-expanded', 'true');
    });
    expect(peekPendingLibraryCardFocus()).toBeNull();
    expect((screen.getByLabelText('搜索卡片') as HTMLInputElement).value).toBe('CRISPR Cas9 locus #42');
    expect(listAnkiLibraryCardsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        search: 'CRISPR Cas9 locus #42',
        deck: 'Biology::Genetics',
        page: 1,
      }),
    );
  });
});
