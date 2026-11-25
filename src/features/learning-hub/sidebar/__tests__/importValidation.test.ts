import { describe, expect, it } from 'vitest';
import { validateImportFileObject } from '../importActions';

const mockT = ((key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key) as unknown as Parameters<typeof validateImportFileObject>[2];

describe('validateImportFileObject (W2-B08 bad file guard)', () => {
  it('rejects 0-byte files with a clear reason', async () => {
    const emptyPdf = new File([], 'empty.pdf', { type: 'application/pdf' });
    const reason = await validateImportFileObject(emptyPdf, 'pdf', mockT);
    expect(reason).toContain('0 字节');
  });

  it('rejects corrupted / non-PDF header files', async () => {
    const junk = new File(['this is definitely not a pdf document at all '.repeat(4)], 'corrupt-truncated.pdf', {
      type: 'application/pdf',
    });
    const reason = await validateImportFileObject(junk, 'pdf', mockT);
    expect(reason).toContain('PDF');
  });

  it('rejects truncated PDF files with valid %PDF- header but missing %%EOF/startxref trailer', async () => {
    const truncatedPdf = new File(
      [`%PDF-1.5\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${'x'.repeat(2048)}`],
      '71-stress-truncated-corrupt.pdf',
      { type: 'application/pdf' },
    );
    const reason = await validateImportFileObject(truncatedPdf, 'pdf', mockT);
    expect(reason).toContain('PDF');
  });

  it('accepts valid PDF files starting with %PDF- and ending with %%EOF or startxref', async () => {
    const validPdf = new File([`%PDF-1.7\n${'0'.repeat(120)}\n%%EOF`], 'valid.pdf', {
      type: 'application/pdf',
    });
    const reason = await validateImportFileObject(validPdf, 'pdf', mockT);
    expect(reason).toBeNull();
  });
});
