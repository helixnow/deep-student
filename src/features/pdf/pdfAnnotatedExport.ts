import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Highlight } from './components/EnhancedPdfViewer';

function pdfColor(value: string): [number, number, number] {
  const hex = /^#([\da-f]{6})(?:[\da-f]{2})?$/i.exec(value)?.[1];
  return hex ? [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number] : [1, 0.82, 0.25];
}

/** Adds standard markup annotations to a copy of the original PDF, with editable comments. */
export async function createAnnotatedPdf(
  original: Pick<PDFDocumentProxy, 'getData' | 'getPage'>,
  highlights: readonly Highlight[],
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(await original.getData(), { updateMetadata: false });
  const viewports = new Map<number, Awaited<ReturnType<PDFDocumentProxy['getPage']>>>();
  let exported = 0;
  for (const highlight of highlights) {
    const n = highlight.pageIndex;
    if (!Number.isInteger(n) || n < 1 || n > pdf.getPageCount()) continue;
    let source = viewports.get(n);
    if (!source) {
      source = await original.getPage(n);
      viewports.set(n, source);
    }
    const viewport = source.getViewport({ scale: 1, rotation: 0 });
    const corners = highlight.rects.flatMap(({ x, y, width, height }) => {
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
      const w = highlight.coordVersion === 2 ? viewport.width : 1;
      const h = highlight.coordVersion === 2 ? viewport.height : 1;
      const points = [
        viewport.convertToPdfPoint(x * w, y * h),
        viewport.convertToPdfPoint((x + width) * w, y * h),
        viewport.convertToPdfPoint(x * w, (y + height) * h),
        viewport.convertToPdfPoint((x + width) * w, (y + height) * h),
      ];
      return [points];
    });
    if (!corners.length) continue;
    const points = corners.flat();
    const xs = points.map(point => point[0]!);
    const ys = points.map(point => point[1]!);
    const annotation = pdf.context.obj({
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of('Highlight'),
      Rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      QuadPoints: points.flat(),
      C: pdfColor(highlight.color),
      CA: 0.45,
      F: 4,
      Contents: PDFHexString.fromText(highlight.comment?.trim() || highlight.text),
      NM: PDFHexString.fromText(highlight.id),
    });
    pdf.getPage(n - 1).node.addAnnot(pdf.context.register(annotation));
    exported += 1;
  }
  if (!exported) throw new Error('No valid PDF markup to export');
  return pdf.save();
}
