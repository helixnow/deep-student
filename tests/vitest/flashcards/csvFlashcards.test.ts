import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  parseFlashcardsFromCsv,
  serializeFlashcardsToCsv,
} from '@/features/flashcards/library/csvFlashcards';

const exportMocks = vi.hoisted(() => ({
  listAnkiLibraryCards: vi.fn(),
  saveTextFile: vi.fn(),
}));

vi.mock('@/utils/chatApi', () => ({
  listAnkiLibraryCards: exportMocks.listAnkiLibraryCards,
}));

vi.mock('@/utils/fileManager', () => ({
  fileManager: {
    saveTextFile: exportMocks.saveTextFile,
  },
}));

import { exportLibraryCsv } from '@/features/flashcards/library/exportLibrary';

describe('csvFlashcards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serializes UTF-8 BOM + RFC 4180 CRLF with quotes, newlines, and Cloze cards, and round-trips cleanly', () => {
    const csv = serializeFlashcardsToCsv(
      [
        {
          front: 'What is "OS", really?\nLine 2',
          back: 'Operating, System\nCore layer',
          tags: ['os', 'core'],
          deckName: 'CS::Systems',
        },
        {
          front: 'Mitochondria is the powerhouse',
          back: 'Produces ATP',
          text: '{{c1::Mitochondria}} is the powerhouse',
          extra_fields: {
            Text: '{{c1::Mitochondria}} is the powerhouse',
            Extra: 'Produces ATP',
          },
          tags: ['bio'],
          deckName: 'Biology',
        },
      ],
      { defaultDeck: 'Fallback' },
    );

    expect(csv.startsWith('\uFEFFFront,Back,Tags,Deck,Type\r\n')).toBe(true);
    expect(csv).toContain('"What is ""OS"", really?\nLine 2","Operating, System\nCore layer",os core,CS::Systems,Basic\r\n');
    expect(csv).toContain('{{c1::Mitochondria}} is the powerhouse,Produces ATP,bio,Biology,Cloze\r\n');

    const parsed = parseFlashcardsFromCsv(csv);
    expect(parsed.headerDetected).toBe(true);
    expect(parsed.delimiter).toBe(',');
    expect(parsed.skippedRows).toBe(0);
    expect(parsed.cards).toEqual([
      {
        front: 'What is "OS", really?\nLine 2',
        back: 'Operating, System\nCore layer',
        tags: ['os', 'core'],
        deck: 'CS::Systems',
        noteType: 'Basic',
      },
      {
        front: '{{c1::Mitochondria}} is the powerhouse',
        back: 'Produces ATP',
        tags: ['bio'],
        deck: 'Biology',
        noteType: 'Cloze',
      },
    ]);
  });

  it('parses Anki #separator:, #deck:, #notetype:, and #columns: directives', () => {
    const tsv = [
      '\uFEFF#separator:tab',
      '#html:true',
      '#deck:Medicine::Anatomy',
      '#notetype:Cloze',
      '#columns:Front\tBack\tTags',
      'The {{c1::femur}} is the thigh bone\tLongest bone\tanatomy high-yield',
      'What is the {{c1::aorta}}?\t\tcardio;vascular',
    ].join('\n');

    const parsed = parseFlashcardsFromCsv(tsv);
    expect(parsed.delimiter).toBe('\t');
    expect(parsed.headerDetected).toBe(false);
    expect(parsed.skippedRows).toBe(0);
    expect(parsed.cards).toEqual([
      {
        front: 'The {{c1::femur}} is the thigh bone',
        back: 'Longest bone',
        tags: ['anatomy', 'high-yield'],
        deck: 'Medicine::Anatomy',
        noteType: 'Cloze',
      },
      {
        front: 'What is the {{c1::aorta}}?',
        back: '',
        tags: ['cardio', 'vascular'],
        deck: 'Medicine::Anatomy',
        noteType: 'Cloze',
      },
    ]);
  });

  it('auto-detects tab vs comma delimiter even when commas appear inside quoted TSV cells', () => {
    const tsv = [
      'Question\tAnswer\tTags',
      '"A, B, or C?"\t"A, because X"\ttag1 tag2',
    ].join('\n');

    const parsed = parseFlashcardsFromCsv(tsv);
    expect(parsed.delimiter).toBe('\t');
    expect(parsed.headerDetected).toBe(true);
    expect(parsed.cards).toEqual([
      {
        front: 'A, B, or C?',
        back: 'A, because X',
        tags: ['tag1', 'tag2'],
        deck: '',
        noteType: 'Basic',
      },
    ]);
  });

  it('supports Chinese column headers, positional fallback, and tracks skipped invalid rows', () => {
    const zhCsv = [
      '标签,背面,正面,类型,牌组',
      '高数,函数在某点极限存在,什么是连续函数？,Basic,数学::微积分',
      ',,,Basic,数学',
      '生物,,{{c1::叶绿体}}进行光合作用,填空,生物',
    ].join('\r\n');

    const parsed = parseFlashcardsFromCsv(zhCsv);
    expect(parsed.headerDetected).toBe(true);
    expect(parsed.skippedRows).toBe(1);
    expect(parsed.cards).toEqual([
      {
        front: '什么是连续函数？',
        back: '函数在某点极限存在',
        tags: ['高数'],
        deck: '数学::微积分',
        noteType: 'Basic',
      },
      {
        front: '{{c1::叶绿体}}进行光合作用',
        back: '',
        tags: ['生物'],
        deck: '生物',
        noteType: 'Cloze',
      },
    ]);

    const headless = parseFlashcardsFromCsv('Apple,苹果,fruit\nInvalidOnlyFront,');
    expect(headless.headerDetected).toBe(false);
    expect(headless.skippedRows).toBe(1);
    expect(headless.cards).toEqual([
      {
        front: 'Apple',
        back: '苹果',
        tags: ['fruit'],
        deck: '',
        noteType: 'Basic',
      },
    ]);
  });

  it('exports whole library via exportLibraryCsv when nothing is selected and skips backend APKG calls', async () => {
    exportMocks.listAnkiLibraryCards.mockResolvedValue({
      items: [
        {
          id: 'c-1',
          task_id: 't-1',
          front: 'F1',
          back: 'B1',
          tags: ['tag1'],
          images: [],
          created_at: '2026-07-14T00:00:00Z',
          updated_at: '2026-07-14T00:00:00Z',
          suspended: false,
          enqueued: true,
          isDue: false,
        },
      ],
      total: 1,
    });
    exportMocks.saveTextFile.mockResolvedValue({ canceled: false, path: '/tmp/library.csv' });

    const outcome = await exportLibraryCsv([], {
      defaultDeck: 'DeepStudent',
      fileName: 'flashcards.csv',
      title: 'Export Flashcards as CSV',
    });

    expect(exportMocks.listAnkiLibraryCards).toHaveBeenCalledWith({ page: 1, page_size: 200 });
    expect(exportMocks.saveTextFile).toHaveBeenCalledWith({
      title: 'Export Flashcards as CSV',
      defaultFileName: 'flashcards.csv',
      content: '\uFEFFFront,Back,Tags,Deck,Type\r\nF1,B1,tag1,DeepStudent,Basic\r\n',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    expect(outcome).toEqual({
      status: 'exported',
      count: 1,
      filePath: '/tmp/library.csv',
      missingMedia: 0,
    });
  });
});
