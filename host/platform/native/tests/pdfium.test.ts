import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';
import { pdfium } from '../pdfium/index.ts';

/** Minimal PDF with three pages: text, empty, text; page 1 also paints a blue rectangle. */
function buildPdf(): Uint8Array {
  const contents = [
    'BT /F1 24 Tf 20 40 Td (Hello PDF) Tj ET\n0 0 1 rg 100 10 50 30 re f\n',
    '',
    'BT /F1 12 Tf 10 20 Td (Second page) Tj ET\n',
  ];
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R 6 0 R] /Count 3 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 50] /Contents 8 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 60] /Resources << /Font << /F1 4 0 R >> >> /Contents 9 0 R >>',
  ];
  for (const content of contents) {
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  }
  let output = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, 'latin1');
}

describe('PDFium adapter (pdfium_utils.rs / pdf_preview.rs)', () => {
  it('opens a document, reports page count and page sizes', async () => {
    const document = await pdfium.open(buildPdf());
    try {
      expect(document.pageCount).toBe(3);
      const first = await document.page(0);
      expect(first.width).toBe(200);
      expect(first.height).toBe(100);
      const second = await document.page(1);
      expect([second.width, second.height]).toEqual([100, 50]);
    } finally { await document.close(); }
  });

  it('extracts text in page order using the Rust page separator rules', async () => {
    expect(await pdfium.extractText(buildPdf())).toBe('Hello PDF\f\fSecond page');
    const document = await pdfium.open(buildPdf());
    try {
      expect(await (await document.page(0)).text()).toBe('Hello PDF');
      expect(await (await document.page(1)).text()).toBe('');
      expect(await (await document.page(2)).text()).toBe('Second page');
    } finally { await document.close(); }
  });

  it('renders RGBA at the requested size on a white background', async () => {
    const document = await pdfium.open(buildPdf());
    try {
      const rendered = await (await document.page(0)).render({ width: 200, height: 100, annotations: false });
      expect([rendered.width, rendered.height]).toEqual([200, 100]);
      expect(rendered.rgba).toHaveLength(200 * 100 * 4);
      const pixel = (x: number, y: number) => Array.from(rendered.rgba.subarray((y * 200 + x) * 4, (y * 200 + x) * 4 + 4));
      // PDF rect (100,10)-(150,40) in bottom-left coordinates; RGBA, not BGRA.
      expect(pixel(125, 75)).toEqual([0, 0, 255, 255]);
      expect(pixel(5, 5)).toEqual([255, 255, 255, 255]);
      // The glyphs are drawn on the white background somewhere in the text row.
      let darkest = 255 * 3;
      for (let x = 18; x < 110; x++) {
        for (let y = 55; y < 75; y++) darkest = Math.min(darkest, pixel(x, y).slice(0, 3).reduce((a, b) => a + b, 0));
      }
      expect(darkest).toBeLessThan(255 * 3);
    } finally { await document.close(); }
  });

  it('rejects corrupt input and closed documents', async () => {
    await expect(pdfium.open(new Uint8Array())).rejects.toThrow('PDF document load failed');
    await expect(pdfium.open(Buffer.from('not a pdf'))).rejects.toThrow('PDF document load failed');

    const document = await pdfium.open(buildPdf());
    await document.close();
    await document.close();
    await expect(document.page(0)).rejects.toThrow('PDF document is closed');
  });

  it('is provided by the dstu.native plugin', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      expect(await host.ctx.nativePdfium.extractText(buildPdf())).toBe('Hello PDF\f\fSecond page');
    } finally { await host.dispose(); }
  });
});
