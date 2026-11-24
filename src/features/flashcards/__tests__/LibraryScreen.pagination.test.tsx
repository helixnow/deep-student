import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnkiLibraryCard, AnkiLibraryListResponse, ListAnkiCardsParams } from '@/types';

const { listAnkiLibraryCardsMock } = vi.hoisted(() => ({
  listAnkiLibraryCardsMock: vi.fn<(params: ListAnkiCardsParams) => Promise<AnkiLibraryListResponse>>(),
}));

vi.mock('@/utils/chatApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/chatApi')>()),
  listAnkiLibraryCards: listAnkiLibraryCardsMock,
}));
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));
vi.mock('@/hooks/useEventRegistry', () => ({
  useEventRegistry: vi.fn(),
}));
vi.mock('../useFlashcardsMobileChrome', () => ({
  useFlashcardsMobileChrome: () => false,
}));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));
vi.mock('../library/LibraryCardRow', () => ({
  LibraryCardRow: ({ card }: { card: AnkiLibraryCard }) => (
    <li data-testid={`card-row-${card.id}`}>{card.front}</li>
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
      };
      const raw = table[key] ?? (typeof opts?.defaultValue === 'string' ? opts.defaultValue : key);
      if (!opts) return raw;
      return raw.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_, k) => String(opts[k] ?? ''));
    },
    i18n: { language: 'zh-CN' },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { LibraryScreen } from '../screens/LibraryScreen';
import { FLASHCARDS_LIBRARY_PAGE_SIZE, useFlashcardsLibraryStore } from '../store/libraryStore';

const TOTAL_CARDS = 1200;

function makePageResponse(page: number, pageSize: number, total = TOTAL_CARDS): AnkiLibraryListResponse {
  const start = (page - 1) * pageSize;
  const count = Math.max(0, Math.min(pageSize, total - start));
  const items: AnkiLibraryCard[] = Array.from({ length: count }, (_, idx) => ({
    id: `card-${start + idx + 1}`,
    front: `Front #${start + idx + 1}`,
    back: `Back #${start + idx + 1}`,
    tags: [],
    created_at: '2026-01-01T00:00:00.000Z',
    enqueued: true,
    suspended: false,
    isDue: false,
    state: 2,
    reps: 1,
    lapses: 0,
    stateId: `state-${start + idx + 1}`,
  }));
  return {
    items,
    total,
    page,
    pageSize,
  };
}

describe('LibraryScreen pagination: page jump, first/last buttons, and page-size selector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFlashcardsLibraryStore.getState().reset();
    listAnkiLibraryCardsMock.mockImplementation(async (params) => {
      const page = params.page ?? 1;
      const pageSize = params.page_size ?? FLASHCARDS_LIBRARY_PAGE_SIZE;
      return makePageResponse(page, pageSize);
    });
  });

  it('jumps directly to a valid page via Jump button and Enter key, and clamps out-of-range values', async () => {
    render(<LibraryScreen />);

    await waitFor(() => {
      expect(screen.getByText('第 1 / 60 页')).toBeInTheDocument();
    });

    const jumpInput = screen.getByTestId('library-page-jump-input') as HTMLInputElement;
    const jumpBtn = screen.getByTestId('library-page-jump-btn');
    expect(jumpInput.value).toBe('1');

    // Direct jump to valid page via Jump button
    fireEvent.change(jumpInput, { target: { value: '25' } });
    fireEvent.click(jumpBtn);

    await waitFor(() => {
      expect(screen.getByText('第 25 / 60 页')).toBeInTheDocument();
    });
    expect(listAnkiLibraryCardsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 25, page_size: 20 }),
    );
    expect(jumpInput.value).toBe('25');

    // Direct jump via Enter key
    fireEvent.change(jumpInput, { target: { value: '42' } });
    fireEvent.keyDown(jumpInput, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText('第 42 / 60 页')).toBeInTheDocument();
    });
    expect(listAnkiLibraryCardsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 42, page_size: 20 }),
    );
    expect(jumpInput.value).toBe('42');

    // Upper out-of-range clamps to totalPages (60)
    fireEvent.change(jumpInput, { target: { value: '999' } });
    fireEvent.click(jumpBtn);

    await waitFor(() => {
      expect(screen.getByText('第 60 / 60 页')).toBeInTheDocument();
    });
    expect(listAnkiLibraryCardsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 60, page_size: 20 }),
    );
    expect(jumpInput.value).toBe('60');

    // Lower out-of-range clamps to 1
    fireEvent.change(jumpInput, { target: { value: '0' } });
    fireEvent.keyDown(jumpInput, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText('第 1 / 60 页')).toBeInTheDocument();
    });
    expect(listAnkiLibraryCardsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, page_size: 20 }),
    );
    expect(jumpInput.value).toBe('1');
  });

  it('supports First and Last page buttons with proper disabled states and input sync', async () => {
    render(<LibraryScreen />);

    await waitFor(() => {
      expect(screen.getByText('第 1 / 60 页')).toBeInTheDocument();
    });

    const firstBtn = screen.getByTestId('library-page-first-btn');
    const prevBtn = screen.getByRole('button', { name: '上一页' });
    const nextBtn = screen.getByRole('button', { name: '下一页' });
    const lastBtn = screen.getByTestId('library-page-last-btn');
    const jumpInput = screen.getByTestId('library-page-jump-input') as HTMLInputElement;

    // At page 1: First & Prev disabled, Next & Last enabled
    expect(firstBtn).toBeDisabled();
    expect(prevBtn).toBeDisabled();
    expect(nextBtn).toBeEnabled();
    expect(lastBtn).toBeEnabled();

    // Jump to Last page (60)
    fireEvent.click(lastBtn);
    await waitFor(() => {
      expect(screen.getByText('第 60 / 60 页')).toBeInTheDocument();
    });
    expect(listAnkiLibraryCardsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 60, page_size: 20 }),
    );
    expect(jumpInput.value).toBe('60');
    expect(firstBtn).toBeEnabled();
    expect(prevBtn).toBeEnabled();
    expect(nextBtn).toBeDisabled();
    expect(lastBtn).toBeDisabled();

    // Jump back to First page (1)
    fireEvent.click(firstBtn);
    await waitFor(() => {
      expect(screen.getByText('第 1 / 60 页')).toBeInTheDocument();
    });
    expect(listAnkiLibraryCardsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, page_size: 20 }),
    );
    expect(jumpInput.value).toBe('1');
    expect(firstBtn).toBeDisabled();
    expect(prevBtn).toBeDisabled();
    expect(nextBtn).toBeEnabled();
    expect(lastBtn).toBeEnabled();
  });

  it('changes page size (20 -> 50 -> 100), resets cleanly to page 1, and passes new page_size limit', async () => {
    render(<LibraryScreen />);

    await waitFor(() => {
      expect(screen.getByText('第 1 / 60 页')).toBeInTheDocument();
    });

    const pageSizeSelect = screen.getByTestId('library-page-size-select') as HTMLSelectElement;
    const jumpInput = screen.getByTestId('library-page-jump-input') as HTMLInputElement;

    // Default page size remains 20 with options 20 / 50 / 100
    expect(pageSizeSelect.value).toBe('20');
    expect(Array.from(pageSizeSelect.options).map((o) => o.value)).toEqual(['20', '50', '100']);

    // Navigate away from page 1 first (to page 12)
    fireEvent.change(jumpInput, { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('library-page-jump-btn'));
    await waitFor(() => {
      expect(screen.getByText('第 12 / 60 页')).toBeInTheDocument();
    });

    // Switch page size to 50 -> resets to page 1 and reloads with page_size: 50
    fireEvent.change(pageSizeSelect, { target: { value: '50' } });
    await waitFor(() => {
      expect(screen.getByText('第 1 / 24 页')).toBeInTheDocument();
    });
    expect(listAnkiLibraryCardsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, page_size: 50 }),
    );
    expect(useFlashcardsLibraryStore.getState().page).toBe(1);
    expect(useFlashcardsLibraryStore.getState().pageSize).toBe(50);
    expect(jumpInput.value).toBe('1');

    // Switch page size to 100 -> resets to page 1 and reloads with page_size: 100
    fireEvent.change(pageSizeSelect, { target: { value: '100' } });
    await waitFor(() => {
      expect(screen.getByText('第 1 / 12 页')).toBeInTheDocument();
    });
    expect(listAnkiLibraryCardsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, page_size: 100 }),
    );
    expect(useFlashcardsLibraryStore.getState().page).toBe(1);
    expect(useFlashcardsLibraryStore.getState().pageSize).toBe(100);
  });

  it('ignores unsupported page sizes in libraryStore.setPageSize', async () => {
    const ok = await useFlashcardsLibraryStore.getState().setPageSize(33);
    expect(ok).toBe(false);
    expect(useFlashcardsLibraryStore.getState().pageSize).toBe(20);
    expect(listAnkiLibraryCardsMock).not.toHaveBeenCalled();
  });
});
