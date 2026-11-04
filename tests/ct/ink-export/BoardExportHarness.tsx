import React, { useEffect, useState } from 'react';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { exportInkBoardPdf, exportInkBoardPng } from '@/features/ink/export';
import type { InkBoardObject, InkBoardSurface, InkRect } from '@/features/ink/types';
import { PDF_OPTIONS } from '@/utils/pdfConfig';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type BoardExportMode = 'png' | 'pdf' | 'cancel';

const surface: InkBoardSurface = {
  kind: 'board',
  page_id: 'board-export-surface',
  ruling: 'blank',
  bounds: { x: -100, y: -50, width: 200, height: 100 },
};

const pngRegion: InkRect = { x: 0, y: 0, width: 120, height: 160 };

const pngObjects: InkBoardObject[] = [{
  id: 'png-red-stroke',
  author: 'user',
  created_at: 1,
  z_index: 0,
  content: {
    kind: 'stroke',
    samples: [{ x: 10, y: 15, pressure: 0.5 }, { x: 40, y: 15, pressure: 0.5 }],
    style: { tool: 'pen', color: '#ff0000', width: 8, pressure_enabled: false },
  },
}];

const pdfRegion: InkRect = { x: -10, y: -5, width: 50, height: 15 };
const pdfPages: InkRect[] = [
  { x: -10, y: -5, width: 25, height: 15 },
  { x: 15, y: -5, width: 25, height: 15 },
];

const pdfObjects: InkBoardObject[] = [
  {
    id: 'pdf-red-stroke',
    author: 'user',
    created_at: 1,
    z_index: 0,
    content: {
      kind: 'stroke',
      samples: [{ x: -5, y: 0, pressure: 0.5 }, { x: 5, y: 0, pressure: 0.5 }],
      style: { tool: 'pen', color: '#ff0000', width: 8, pressure_enabled: false },
    },
  },
  {
    id: 'pdf-blue-stroke',
    author: 'user',
    created_at: 2,
    z_index: 1,
    content: {
      kind: 'stroke',
      samples: [{ x: 20, y: 0, pressure: 0.5 }, { x: 35, y: 0, pressure: 0.5 }],
      style: { tool: 'pen', color: '#0000ff', width: 8, pressure_enabled: false },
    },
  },
];

async function renderPdf(
  blob: Blob,
  setPdfPages: (pages: { width: number; height: number; pixels: ImageData }[]) => void,
  setPdfPageCount: (count: number) => void,
) {
  const pdf: PDFDocumentProxy = await getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    ...PDF_OPTIONS,
  }).promise;
  setPdfPageCount(pdf.numPages);
  const pages: { width: number; height: number; pixels: ImageData }[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    await page.render({ canvasContext: context, viewport }).promise;
    pages.push({ width: viewport.width, height: viewport.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height) });
  }
  setPdfPages(pages);
}

export function BoardExportHarness({ mode }: { mode: BoardExportMode }) {
  const [status, setStatus] = useState('running');
  const [artifactUrl, setArtifactUrl] = useState('');
  const [pdfPagesRendered, setPdfPagesRendered] = useState<{ width: number; height: number; pixels: ImageData }[]>([]);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [sourceUnchanged, setSourceUnchanged] = useState(false);

  useEffect(() => {
    let url = '';
    void (async () => {
      try {
        const objects = mode === 'png' ? pngObjects : pdfObjects;
        const sourceBefore = JSON.stringify({ surface, objects });
        if (mode === 'cancel') {
          const controller = new AbortController();
          const originalToBlob = HTMLCanvasElement.prototype.toBlob;
          let encodes = 0;
          HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
            encodes += 1;
            const result = originalToBlob.call(this, callback, type, quality);
            if (encodes === 2) controller.abort();
            return result;
          };
          try {
            await exportInkBoardPdf({ surface, objects, pages: pdfPages }, { signal: controller.signal });
            throw new Error('Expected board export cancellation');
          } catch (error) {
            if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
          } finally {
            HTMLCanvasElement.prototype.toBlob = originalToBlob;
          }
          setSourceUnchanged(JSON.stringify({ surface, objects }) === sourceBefore);
          setStatus('cancelled');
          return;
        }
        const blob = mode === 'png'
          ? await exportInkBoardPng({ surface, objects, region: pngRegion })
          : await exportInkBoardPdf({ surface, objects, pages: pdfPages });
        setSourceUnchanged(JSON.stringify({ surface, objects }) === sourceBefore);
        url = URL.createObjectURL(blob);
        setArtifactUrl(url);
        if (mode === 'pdf') await renderPdf(blob, setPdfPagesRendered, setPdfPageCount);
        setStatus('done');
      } catch (error) {
        setStatus(`error: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [mode]);

  return <div data-testid="ink-board-export-harness">
    <output data-testid="ink-board-export-status">{status}</output>
    <output data-testid="ink-board-export-region">{JSON.stringify(mode === 'png' ? pngRegion : pdfRegion)}</output>
    <output data-testid="ink-board-export-pdf-page-count">{pdfPageCount}</output>
    <output data-testid="ink-board-export-source-unchanged">{String(sourceUnchanged)}</output>
    {artifactUrl && <a
      data-testid="ink-board-export-artifact"
      href={artifactUrl}
      data-mime={mode === 'png' ? 'image/png' : 'application/pdf'}
    />}
    {artifactUrl && mode === 'png' && <img data-testid="ink-board-export-image" src={artifactUrl} alt="Exported board frame" />}
    {pdfPagesRendered.map((page, index) => <canvas
      key={index}
      data-testid={`ink-board-export-pdf-page-${index + 1}`}
      data-page-ratio={page.width / page.height}
      width={page.pixels.width}
      height={page.pixels.height}
      ref={(canvas) => {
        if (!canvas) return;
        const context = canvas.getContext('2d');
        if (context) context.putImageData(page.pixels, 0, 0);
      }}
    />)}
  </div>;
}
