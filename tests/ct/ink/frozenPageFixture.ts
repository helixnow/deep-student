import type { InkPageRef } from '@/features/ink/types';

export const frozenPreparedPdfBackgroundHash = 'ink-editor-prepared-pdf-page-png';

/** The source PDF page had intrinsic 90° rotation baked into this portrait PNG. */
export const frozenRotatedPdfPageRef: InkPageRef = {
  page_id: 'frozen-rotated-pdf-page',
  width: 120,
  height: 160,
  background: {
    kind: 'pdf_page',
    blob_hash: frozenPreparedPdfBackgroundHash,
    source_page_index: 0,
  },
  page_blob_hash: 'frozen-rotated-pdf-page-body',
};

/** Actual PDF annotation wire shape: normalized coordVersion 2 rect, page index is zero-based. */
export const frozenSourceHighlight = {
  id: 'pdf-highlight-rotated-page-zero',
  pageIndex: 0,
  text: 'rotated source highlight',
  color: '#0000ff80',
  rects: [{ x: 0.1, y: 0.1, width: 0.75, height: 0.5 }],
  createdAt: 42,
  coordVersion: 2,
};

export function makePngDataUrl(width: number, height: number, color: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable');
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return canvas.toDataURL('image/png');
}

export function dataUrlBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Canvas returned an invalid PNG data URL');
  return dataUrl.slice(comma + 1);
}
