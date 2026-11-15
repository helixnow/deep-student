import type { NativePdfium } from './api.ts';

class CanvasFactory {
  create(width: number, height: number) {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('OffscreenCanvas 2D is unavailable');
    return { canvas, context };
  }

  reset(target: { canvas: OffscreenCanvas }, width: number, height: number) {
    target.canvas.width = width;
    target.canvas.height = height;
  }

  destroy(target: { canvas: OffscreenCanvas }) {
    this.reset(target, 0, 0);
  }
}

export const webPdf: NativePdfium = {
  async diagnostics() { return { status: 'available', engine: 'PDF.js', engine_path: 'pdf.worker.wrapper.mjs' }; },
  async open(bytes, password) {
    const { AnnotationMode, getDocument, PDFWorker } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const origin = globalThis.location.origin;
    const worker = new Worker(`${origin}/pdf.worker.wrapper.mjs`, { type: 'module' });
    const transport = PDFWorker.create({ port: worker });
    const task = getDocument({
      data: Uint8Array.from(bytes),
      password: password ?? undefined,
      worker: transport,
      CanvasFactory,
      disableFontFace: true,
      isEvalSupported: false,
      useWorkerFetch: true,
      cMapUrl: `${origin}/cmaps/`,
      standardFontDataUrl: `${origin}/standard_fonts/`,
      wasmUrl: `${origin}/wasm/`,
      maxImageSize: 24_000_000,
    });
    async function close() {
      try { await task.destroy(); } finally { transport.destroy(); worker.terminate(); }
    }
    try {
      const doc = await task.promise;
      return {
        pageCount: doc.numPages,
        async page(index) {
          const page = await doc.getPage(index + 1);
          const viewport = page.getViewport({ scale: 1 });
          return {
            width: viewport.width,
            height: viewport.height,
            async text() {
              const content = await page.getTextContent();
              return content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join('');
            },
            async render({ width, height, annotations }) {
              if (width * height > 24_000_000) throw new Error('PDF page exceeds the mobile canvas limit');
              const { context } = new CanvasFactory().create(width, height);
              await page.render({
                canvas: null,
                canvasContext: context as unknown as CanvasRenderingContext2D,
                viewport,
                transform: [width / viewport.width, 0, 0, height / viewport.height, 0, 0],
                annotationMode: annotations ? AnnotationMode.ENABLE : AnnotationMode.DISABLE,
              }).promise;
              const data = context.getImageData(0, 0, width, height).data;
              return { width, height, rgba: new Uint8Array(data.buffer) };
            },
          };
        },
        close,
      };
    } catch (error) {
      await close();
      throw error;
    }
  },
  async extractText(bytes) {
    const doc = await webPdf.open(bytes);
    const pages: string[] = [];
    try {
      for (let index = 0; index < doc.pageCount; index++) pages.push(await (await doc.page(index)).text());
      return pages.join('\n\n').trim();
    } finally { await doc.close(); }
  },
};
