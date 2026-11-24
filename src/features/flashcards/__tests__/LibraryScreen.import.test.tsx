import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnkiLibraryListResponse, ListAnkiCardsParams } from '@/types';

const mocks = vi.hoisted(() => ({
  listAnkiLibraryCards: vi.fn<(params: ListAnkiCardsParams) => Promise<AnkiLibraryListResponse>>(),
  saveAnkiCards: vi.fn(),
  stageFileForImport: vi.fn(async (file: File) => ({ stagedPath: `/staged/${file.name}`, token: 'tok' })),
  invoke: vi.fn(),
  isWebUiShell: vi.fn(() => true),
  isTauriEnvironment: vi.fn(() => false),
}));

vi.mock('@/utils/chatApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/chatApi')>()),
  listAnkiLibraryCards: mocks.listAnkiLibraryCards,
}));
vi.mock('@/services/ankiApiAdapter', () => ({
  ankiApiAdapter: {
    saveAnkiCards: mocks.saveAnkiCards,
  },
}));
vi.mock('@/utils/stagedUpload', () => ({
  stageBlobUpload: mocks.stageFileForImport,
  abortStagedUpload: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/utils/fileManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/fileManager')>()),
  usesAndroidSaf: () => false,
}));
vi.mock('@/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform')>()),
  isWebUiShell: mocks.isWebUiShell,
}));
vi.mock('@/utils/urlOpener', () => ({
  isTauriEnvironment: mocks.isTauriEnvironment,
  openUrl: vi.fn(),
}));
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));
vi.mock('@/hooks/useEventRegistry', () => ({ useEventRegistry: vi.fn() }));
vi.mock('../useFlashcardsMobileChrome', () => ({ useFlashcardsMobileChrome: () => false }));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('../library/LibraryCardRow', () => ({
  LibraryCardRow: ({ card }: { card: { id: string; front: string } }) => (
    <li data-testid={`card-row-${card.id}`}>{card.front}</li>
  ),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const raw = typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
      if (!opts) return raw;
      return raw.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_, k) => String(opts[k] ?? ''));
    },
    i18n: { language: 'zh-CN' },
  }),
}));

import { LibraryScreen } from '../screens/LibraryScreen';
import { useFlashcardsLibraryStore } from '../store/libraryStore';

describe('LibraryScreen .apkg / .csv import & targetDeck (S2-09)', () => {
  beforeEach(() => {
    cleanup();
    mocks.listAnkiLibraryCards.mockReset();
    mocks.saveAnkiCards.mockReset();
    mocks.invoke.mockReset();
    mocks.stageFileForImport.mockClear();
    mocks.isWebUiShell.mockReturnValue(true);
    mocks.isTauriEnvironment.mockReturnValue(false);

    mocks.listAnkiLibraryCards.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      page_size: 40,
      status_counts: { all: 0, due: 0, new: 0, learning: 0, review: 0, suspended: 0, not_enqueued: 0 },
      decks: [
        { name: 'Biology', all: 5, due: 1, new: 2, learning: 1, review: 1, suspended: 0, not_enqueued: 0 },
      ],
    });

    useFlashcardsLibraryStore.getState().reset();
    useFlashcardsLibraryStore.setState({
      loaded: true,
      loading: false,
      deckFilter: 'Biology',
      decks: [
        { name: 'Biology', all: 5, due: 1, new: 2, learning: 1, review: 1, suspended: 0, not_enqueued: 0 },
      ],
    });
  });

  it('opens inline .apkg import dropzone with visible file input when clicking import .apkg', () => {
    render(<LibraryScreen />);

    fireEvent.click(screen.getByTestId('fc-lib-import-apkg'));
    expect(screen.getByTestId('fc-lib-import-panel')).toBeInTheDocument();
    const apkgInput = screen.getByTestId('fc-lib-apkg-file-input') as HTMLInputElement;
    expect(apkgInput).toHaveAttribute('type', 'file');
    expect(apkgInput.getAttribute('accept')).toContain('.apkg');
  });

  it('shows explicit CSV target deck summary, previews card count & deck before saving, and saves into targetDeck on confirm', async () => {
    mocks.saveAnkiCards.mockResolvedValue({
      savedIds: ['c-csv-1'],
      failed: [],
    });

    render(<LibraryScreen />);

    fireEvent.click(screen.getByTestId('fc-lib-import-csv'));
    expect(screen.getByTestId('fc-lib-import-panel')).toBeInTheDocument();

    const deckInput = screen.getByTestId('fc-lib-csv-target-deck-input') as HTMLInputElement;
    expect(deckInput.value).toBe('Biology');
    expect(screen.getByTestId('fc-lib-csv-target-summary')).toHaveTextContent('Biology');

    fireEvent.change(deckInput, { target: { value: 'Chemistry::Organic' } });
    expect(screen.getByTestId('fc-lib-csv-target-summary')).toHaveTextContent('Chemistry::Organic');

    const csvInput = screen.getByTestId('fc-lib-csv-file-input') as HTMLInputElement;
    const csvFile = {
      name: 'organic.csv',
      text: async () => 'front,back\nBenzene,Aromatic ring\nToluene,Methylbenzene\n',
    } as unknown as File;

    await act(async () => {
      fireEvent.change(csvInput, { target: { files: [csvFile] } });
    });

    const confirmBanner = await screen.findByTestId('fc-lib-csv-confirm-banner');
    expect(confirmBanner).toHaveTextContent('organic.csv');
    expect(confirmBanner).toHaveTextContent('2');
    expect(confirmBanner).toHaveTextContent('Chemistry::Organic');
    // Must wait for explicit confirmation before persisting cards
    expect(mocks.saveAnkiCards).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId('fc-lib-csv-confirm-btn'));
    });

    await waitFor(() => {
      expect(mocks.saveAnkiCards).toHaveBeenCalledWith(
        expect.objectContaining({
          cards: [
            expect.objectContaining({ front: 'Benzene', back: 'Aromatic ring' }),
            expect.objectContaining({ front: 'Toluene', back: 'Methylbenzene' }),
          ],
          options: expect.objectContaining({
            deck_name: 'Chemistry::Organic',
          }),
        }),
      );
    });
  });

  it('allows cancelling pending CSV import preview without saving cards', async () => {
    render(<LibraryScreen />);

    fireEvent.click(screen.getByTestId('fc-lib-import-csv'));
    const csvInput = screen.getByTestId('fc-lib-csv-file-input') as HTMLInputElement;
    const csvFile = {
      name: 'cancel-check.csv',
      text: async () => 'front,back\nCell,Unit of life\n',
    } as unknown as File;

    await act(async () => {
      fireEvent.change(csvInput, { target: { files: [csvFile] } });
    });

    const confirmBanner = await screen.findByTestId('fc-lib-csv-confirm-banner');
    expect(confirmBanner).toHaveTextContent('Biology');
    fireEvent.click(screen.getByTestId('fc-lib-csv-cancel-btn'));

    expect(screen.queryByTestId('fc-lib-csv-confirm-banner')).not.toBeInTheDocument();
    expect(mocks.saveAnkiCards).not.toHaveBeenCalled();
  });
});
