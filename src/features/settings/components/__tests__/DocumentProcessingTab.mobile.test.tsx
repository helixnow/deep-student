import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import zhPdf from '@/locales/zh-CN/pdf.json';
import enPdf from '@/locales/en-US/pdf.json';

const platformState = vi.hoisted(() => ({ mobile: false }));

vi.mock('@/utils/platform', () => ({
  isMobilePlatform: () => platformState.mobile,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => {
      if (key === 'pdf:mobile_ocr_notice.title') return zhPdf.mobile_ocr_notice.title;
      if (key === 'pdf:mobile_ocr_notice.description') return zhPdf.mobile_ocr_notice.description;
      return opts?.defaultValue ?? key;
    },
  }),
}));

vi.mock('../PdfSettingsSection', () => ({
  PdfSettingsSection: () => <div data-testid="pdf-settings-section" />,
}));

vi.mock('../OcrSettingsSection', () => ({
  OcrSettingsSection: () => <div data-testid="ocr-settings-section" />,
}));

import { DocumentProcessingTab } from '../DocumentProcessingTab';

afterEach(() => {
  platformState.mobile = false;
  cleanup();
});

describe('DocumentProcessingTab mobile OCR notice', () => {
  it('keeps zh-CN and en-US pdf.json mobile_ocr_notice keys symmetric', () => {
    expect(Object.keys(zhPdf.mobile_ocr_notice).sort()).toEqual(['description', 'title']);
    expect(Object.keys(enPdf.mobile_ocr_notice).sort()).toEqual(['description', 'title']);
    expect(zhPdf.mobile_ocr_notice.title.length).toBeGreaterThan(0);
    expect(enPdf.mobile_ocr_notice.title.length).toBeGreaterThan(0);
  });

  it('does not render mobile OCR notice on desktop platforms', () => {
    platformState.mobile = false;
    render(<DocumentProcessingTab />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.getByTestId('ocr-settings-section')).toBeInTheDocument();
  });

  it('renders role="note" mobile OCR notice above OcrSettingsSection when isMobilePlatform() is true', () => {
    platformState.mobile = true;
    render(<DocumentProcessingTab />);

    const note = screen.getByRole('note');
    const ocrSection = screen.getByTestId('ocr-settings-section');
    expect(note).toHaveTextContent(zhPdf.mobile_ocr_notice.title);
    expect(note).toHaveTextContent(zhPdf.mobile_ocr_notice.description);
    expect(note.compareDocumentPosition(ocrSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
