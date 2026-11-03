import React, { useEffect, useMemo, useState } from 'react';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { exportInkPdf, exportInkPng, type InkExportPage } from '@/features/ink/export';
import { PDF_OPTIONS } from '@/utils/pdfConfig';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type ExportMode = 'png' | 'crop' | 'pdf' | 'cancel';

const pageA: InkExportPage = {
  page_ref: {
    page_id: 'portrait-page', width: 120, height: 160,
    background: { kind: 'image', blob_hash: 'fixture-gray' }, page_blob_hash: 'fixture-portrait',
  },
  page: {
    schema_version: 1, page_id: 'portrait-page', objects: [{
      id: 'red-pen', author: 'user', created_at: 1,
      content: {
        kind: 'stroke', samples: [{ x: 18, y: 25, pressure: 0.5 }, { x: 50, y: 25, pressure: 0.5 }],
        style: { tool: 'pen', color: '#ff0000', width: 8, pressure_enabled: false },
      },
    }],
  },
};

const pageB: InkExportPage = {
  page_ref: {
    page_id: 'landscape-page', width: 180, height: 90,
    background: { kind: 'image', blob_hash: 'fixture-gray' }, page_blob_hash: 'fixture-landscape',
  },
  page: {
    schema_version: 1, page_id: 'landscape-page', objects: [{
      id: 'blue-arrow', author: 'user', created_at: 2,
      content: { kind: 'arrow', from: { x: 18, y: 70 }, to: { x: 65, y: 70 }, color: '#0000ff', width: 5 },
    }],
  },
};

function makeBackground(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable');
  context.fillStyle = '#eeeeee';
  context.fillRect(0, 0, width, height);
  return canvas;
}

function countBluePixels(pixels: ImageData): number {
  let blue = 0;
  for (let index = 0; index < pixels.data.length; index += 4) {
    if (pixels.data[index] < 80 && pixels.data[index + 1] < 80 && pixels.data[index + 2] > 150) blue += 1;
  }
  return blue;
}

async function renderPdf(
  blob: Blob,
  setPdfPages: (pages: { width: number; height: number; pixels: ImageData }[]) => void,
  setPdfBlue: (counts: number[]) => void,
): Promise<void> {
  const pdf: PDFDocumentProxy = await getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    ...PDF_OPTIONS,
  }).promise;
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
  setPdfBlue(pages.map((page) => countBluePixels(page.pixels)));
}

export function InkExportHarness({ mode }: { mode: ExportMode }) {
  const [status, setStatus] = useState('running');
  const [artifactUrl, setArtifactUrl] = useState('');
  const [pdfPages, setPdfPages] = useState<{ width: number; height: number; pixels: ImageData }[]>([]);
  const [pdfBlueCounts, setPdfBlueCounts] = useState<number[]>([]);
  const [pngBlueCount, setPngBlueCount] = useState<number | null>(null);
  const [sourceUnchanged, setSourceUnchanged] = useState(false);
  const backgrounds = useMemo(() => ({
    portrait: makeBackground(pageA.page_ref.width, pageA.page_ref.height),
    landscape: makeBackground(pageB.page_ref.width, pageB.page_ref.height),
  }), []);

  useEffect(() => {
    let url = '';
    void (async () => {
      try {
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
          const pages = [
            { ...pageA, background: backgrounds.portrait },
            { ...pageB, background: backgrounds.landscape },
          ];
          const sourceBefore = JSON.stringify(pages.map(({ page, page_ref }) => ({ page, page_ref })));
          let cancelled = false;
          try {
            await exportInkPdf(pages, { signal: controller.signal });
          } catch (error) {
            if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
            cancelled = true;
          } finally {
            HTMLCanvasElement.prototype.toBlob = originalToBlob;
          }
          if (!cancelled) throw new Error('Expected mid-export cancellation');
          setSourceUnchanged(JSON.stringify(pages.map(({ page, page_ref }) => ({ page, page_ref }))) === sourceBefore);
          setStatus('cancelled');
          return;
        }
        if (mode === 'pdf') {
          const referencePng = await exportInkPng({ ...pageB, background: backgrounds.landscape });
          const bitmap = await createImageBitmap(referencePng);
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Canvas 2D context is unavailable');
          context.drawImage(bitmap, 0, 0);
          setPngBlueCount(countBluePixels(context.getImageData(0, 0, canvas.width, canvas.height)));
          bitmap.close();
        }
        let blob: Blob;
        if (mode === 'pdf') {
          const pages = [
            { ...pageA, background: backgrounds.portrait },
            { ...pageB, background: backgrounds.landscape },
          ];
          const sourceBefore = JSON.stringify(pages.map(({ page, page_ref }) => ({ page, page_ref })));
          blob = await exportInkPdf(pages, { page_ids: ['landscape-page', 'portrait-page'] });
          setSourceUnchanged(JSON.stringify(pages.map(({ page, page_ref }) => ({ page, page_ref }))) === sourceBefore);
        } else {
          blob = await exportInkPng({ ...pageA, background: backgrounds.portrait,
            ...(mode === 'crop' ? { crop: { x: 10, y: 15, width: 80, height: 60 } } : {}) });
        }
        url = URL.createObjectURL(blob);
        setArtifactUrl(url);
        if (mode === 'pdf') await renderPdf(blob, setPdfPages, setPdfBlueCounts);
        else {
          const bitmap = await createImageBitmap(blob);
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Canvas 2D context is unavailable');
          context.drawImage(bitmap, 0, 0);
          setPngBlueCount(countBluePixels(context.getImageData(0, 0, canvas.width, canvas.height)));
          bitmap.close();
        }
        setStatus('done');
      } catch (error) {
        setStatus(`error: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [backgrounds, mode]);

  return <div data-testid="ink-export-harness">
    <output data-testid="ink-export-status">{status}</output>
    <output data-testid="ink-export-png-blue-count">{pngBlueCount ?? 'pending'}</output>
    <output data-testid="ink-export-pdf-blue-counts">{pdfBlueCounts.join(',')}</output>
    <output data-testid="ink-export-source-unchanged">{String(sourceUnchanged)}</output>
    {artifactUrl && <a data-testid="ink-export-artifact" href={artifactUrl} data-mime={mode === 'pdf' ? 'application/pdf' : 'image/png'} />}
    {artifactUrl && mode !== 'pdf' && <img data-testid="ink-export-image" src={artifactUrl} alt="Exported ink page" />}
    {pdfPages.map((page, index) => <canvas
      key={index}
      data-testid={`ink-export-pdf-page-${index + 1}`}
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
