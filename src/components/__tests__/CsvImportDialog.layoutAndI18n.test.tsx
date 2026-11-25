import path from 'node:path';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import enExamSheet from '@/locales/en-US/exam_sheet.json';
import enCommon from '@/locales/en-US/common.json';
import zhExamSheet from '@/locales/zh-CN/exam_sheet.json';
import zhCommon from '@/locales/zh-CN/common.json';

const { mocks, i18nInstance } = await vi.hoisted(async () => ({
  mocks: {
    invoke: vi.fn(),
    notify: vi.fn(),
  },
  i18nInstance: (await import('i18next')).createInstance(),
}));

vi.mock('react-i18next', () =>
  vi.importActual<typeof import('react-i18next')>(
    path.resolve(process.cwd(), 'node_modules/react-i18next/dist/es/index.js'),
  ),
);
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mocks.notify,
}));
vi.mock('@/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform')>()),
  isWebUiShell: () => true,
}));
vi.mock('@/utils/urlOpener', () => ({
  isTauriEnvironment: () => false,
}));

const { I18nextProvider } = await import('react-i18next');
const { CsvImportDialog, CsvImportPanel } = await import('@/components/CsvImportDialog');

const CJK_RE = /[\u4e00-\u9fff]/;

function makeCsvFile(name: string, content: string): File {
  return {
    name,
    type: 'text/csv',
    text: async () => content,
  } as unknown as File;
}

describe('CsvImportDialog & CsvImportPanel pinned footer layout and en-US localization', () => {
  beforeAll(async () => {
    await i18nInstance.init({
      lng: 'en-US',
      fallbackLng: false,
      defaultNS: 'exam_sheet',
      ns: ['exam_sheet', 'common'],
      resources: {
        'en-US': { exam_sheet: enExamSheet, common: enCommon },
        'zh-CN': { exam_sheet: zhExamSheet, common: zhCommon },
      },
      interpolation: { escapeValue: false },
    });
  });

  beforeEach(async () => {
    mocks.invoke.mockReset();
    mocks.notify.mockReset();
    await i18nInstance.changeLanguage('en-US');
  });

  afterEach(async () => {
    await i18nInstance.changeLanguage('zh-CN');
  });

  it('uses a strict 3-slot flex column with scrollable body and pinned shrink-0 footer in CsvImportPanel', async () => {
    mocks.invoke.mockResolvedValue([]);
    render(
      <I18nextProvider i18n={i18nInstance}>
        <div className="h-[680px] overflow-hidden">
          <CsvImportPanel examId="exam-layout-1" examName="Calculus" onClose={vi.fn()} />
        </div>
      </I18nextProvider>,
    );

    const panel = screen.getByTestId('csv-import-panel');
    const flow = screen.getByTestId('csv-import-flow');
    const header = screen.getByTestId('csv-import-header');
    const body = screen.getByTestId('csv-import-body');
    const footer = screen.getByTestId('csv-import-footer');

    // Outer panel & flow must bound height and prevent clipping overflow
    expect(panel.className).toContain('flex');
    expect(panel.className).toContain('h-full');
    expect(panel.className).toContain('min-h-0');
    expect(panel.className).toContain('flex-col');
    expect(panel.className).toContain('overflow-hidden');

    expect(flow.className).toContain('flex');
    expect(flow.className).toContain('h-full');
    expect(flow.className).toContain('min-h-0');
    expect(flow.className).toContain('flex-col');
    expect(flow.className).toContain('overflow-hidden');

    // Header and footer are pinned outside the scrolling body
    expect(header.className).toContain('shrink-0');
    expect(body.className).toContain('min-h-0');
    expect(body.className).toContain('flex-1');
    expect(footer.className).toContain('shrink-0');
    expect(footer.className).toContain('border-t');
    expect(body.contains(footer)).toBe(false);
    expect(body.contains(header)).toBe(false);

    // Scrolling viewport must use vertical overflow without flex-col + my-auto clipping trap
    const viewport = body.querySelector('.scroll-area--native');
    expect(viewport).not.toBeNull();
    expect(viewport!.className).toContain('overflow-y-auto');
    expect(viewport!.className).not.toContain('flex-col');
    expect(body.querySelector('.my-auto')).toBeNull();

    // Upload a tall multi-column CSV and verify Back/Next stay pinned in footer & advance cleanly
    const csvHeader = 'content,question_type,options,answer,explanation,difficulty,tags,question_label,extra_1,extra_2';
    const csvRows = Array.from({ length: 6 }, (_, idx) =>
      `Question ${idx + 1},single_choice,"A. Yes|B. No",A,Because ${idx + 1},easy,algebra,Q${idx + 1},v1,v2`,
    ).join('\n');
    const fileInput = screen.getByTestId('qbank-csv-file-input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [makeCsvFile('tall-mapping.csv', `${csvHeader}\n${csvRows}`)] },
      });
    });

    const nextBtn = await screen.findByRole('button', { name: /Next/i });
    const prevBtn = screen.getByRole('button', { name: /Previous/i });
    expect(footer.contains(nextBtn)).toBe(true);
    expect(footer.contains(prevBtn)).toBe(true);
    expect(body.contains(nextBtn)).toBe(false);
    expect(nextBtn).not.toBeDisabled();

    // Advance to Dedup Strategy step and verify Start Import is pinned in footer
    fireEvent.click(nextBtn);
    const startImportBtn = await screen.findByRole('button', { name: /Start Import/i });
    expect(footer.contains(startImportBtn)).toBe(true);
    expect(body.contains(startImportBtn)).toBe(false);

    // Zero Chinese strings anywhere in en-US wizard UI
    expect(panel.textContent ?? '').not.toMatch(CJK_RE);
  });

  it('pins footer in CsvImportDialog overlay and localizes empty CSV & empty row errors in en-US', async () => {
    mocks.invoke.mockResolvedValue([]);
    render(
      <I18nextProvider i18n={i18nInstance}>
        <div className="relative h-[680px] overflow-hidden">
          <CsvImportDialog open onOpenChange={vi.fn()} examId="exam-layout-2" examName="Physics" />
        </div>
      </I18nextProvider>,
    );

    const dialog = screen.getByTestId('csv-import-dialog');
    const body = screen.getByTestId('csv-import-body');
    const footer = screen.getByTestId('csv-import-footer');

    expect(dialog.className).toContain('min-h-0');
    expect(dialog.className).toContain('overflow-hidden');
    expect(footer.className).toContain('shrink-0');
    expect(body.contains(footer)).toBe(false);

    // Empty CSV triggers localized English error (no Chinese defaultValue leak)
    const fileInput = screen.getByTestId('qbank-csv-file-input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [makeCsvFile('empty.csv', 'content,answer\n')] },
      });
    });

    await waitFor(() => {
      expect(dialog.textContent).toContain('CSV file is empty or contains no valid data rows');
    });
    expect(dialog.textContent ?? '').not.toMatch(CJK_RE);

    // CSV with a row missing content reports localized English row error
    await act(async () => {
      fireEvent.change(fileInput, {
        target: {
          files: [
            makeCsvFile(
              'partial.csv',
              'content,answer\nValid stem,A\n,B\n',
            ),
          ],
        },
      });
    });

    const nextBtn = await screen.findByRole('button', { name: /Next/i });
    fireEvent.click(nextBtn);
    const startBtn = await screen.findByRole('button', { name: /Start Import/i });
    fireEvent.click(startBtn);

    await waitFor(() => {
      expect(dialog.textContent).toContain('Question content is empty');
    });
    expect(dialog.textContent ?? '').not.toMatch(CJK_RE);
  });
});
