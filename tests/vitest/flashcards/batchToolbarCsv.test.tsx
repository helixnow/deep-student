import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnkiCard } from '@/types';

const mocks = vi.hoisted(() => ({
  batchExportCards: vi.fn(),
  saveTextFile: vi.fn(),
  show: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => {
      if (typeof fallback === 'string') return fallback;
      if (fallback && typeof fallback === 'object' && 'defaultValue' in fallback) {
        return String((fallback as { defaultValue: unknown }).defaultValue);
      }
      return key;
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 64,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 64,
        size: 64,
      })),
  }),
}));

vi.mock('@/services/ankiApiAdapter', () => ({
  ankiApiAdapter: {
    batchExportCards: mocks.batchExportCards,
  },
  notificationAdapter: {
    show: mocks.show,
  },
}));

vi.mock('@/utils/fileManager', () => ({
  fileManager: {
    saveTextFile: mocks.saveTextFile,
    saveFromSource: vi.fn(),
  },
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

import { BatchOperationToolbar } from '@/components/BatchOperationToolbar';

describe('BatchOperationToolbar CSV export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveTextFile.mockResolvedValue({ canceled: false, path: '/tmp/anki_export.csv' });
  });

  afterEach(() => {
    cleanup();
  });

  it('exports selected Basic and Cloze cards locally with RFC 4180 CSV without calling batchExportCards', async () => {
    const cards: AnkiCard[] = [
      {
        id: 'card-1',
        front: 'What is "CSV"?',
        back: 'Comma-separated\nvalues',
        tags: ['format', 'text'],
        images: [],
      },
      {
        id: 'card-2',
        front: 'Hemoglobin binds oxygen',
        back: 'Red blood cells',
        text: '{{c1::Hemoglobin}} binds oxygen',
        extra_fields: { Text: '{{c1::Hemoglobin}} binds oxygen', Extra: 'Red blood cells' },
        tags: ['bio'],
        images: [],
      },
    ];

    render(<BatchOperationToolbar cards={cards} onCardsUpdate={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /select_all/ }));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'export_as_csv' }));

    await waitFor(() => {
      expect(mocks.saveTextFile).toHaveBeenCalledTimes(1);
    });

    expect(mocks.batchExportCards).not.toHaveBeenCalled();
    expect(mocks.saveTextFile).toHaveBeenCalledWith({
      title: 'export_as_csv',
      defaultFileName: 'anki_export.csv',
      content:
        '\uFEFFFront,Back,Tags,Deck,Type\r\n'
        + '"What is ""CSV""?","Comma-separated\nvalues",format text,batch_export_deck_name,Basic\r\n'
        + '{{c1::Hemoglobin}} binds oxygen,Red blood cells,bio,batch_export_deck_name,Cloze\r\n',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    expect(mocks.show).toHaveBeenCalledWith('batch_exported', 'success');
  });
});
