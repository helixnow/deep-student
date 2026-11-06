/**
 * Isolated native-E2E entry for the production prepare/job and render bridges.
 * Source conversion, canvas rendering, and PNG staging all use production code;
 * this entry contains no converter, renderer, or pre-encoded converted image.
 */
import '../../../src/polyfills/promiseWithResolvers';
import { emit } from '@tauri-apps/api/event';
import { pdfjs } from 'react-pdf';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import { registerInkJobBridge } from '../../../src/features/ink/jobBridge';
import { registerInkRenderBridge } from '../../../src/features/ink/renderBridge';

declare global {
  interface Window {
    __INK_E2E_READY__?: boolean;
    __INK_E2E_BOOT_ERROR__?: string;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ''}`;
  return String(error);
}

void (async () => {
  const worker = new PdfWorker();
  pdfjs.GlobalWorkerOptions.workerPort = worker;
  const unregisterRender = await registerInkRenderBridge();
  try {
    const unregisterJobs = await registerInkJobBridge();
    window.__INK_E2E_READY__ = true;
    await emit('ink-e2e-ready', {
      renderer: 'shared-renderInkBoard',
      prepare: 'production-registerInkJobBridge',
      pdfjsVersion: pdfjs.version,
    });
    window.addEventListener('beforeunload', () => {
      unregisterJobs();
      unregisterRender();
      worker.terminate();
    }, { once: true });
  } catch (error) {
    unregisterRender();
    worker.terminate();
    throw error;
  }
})().catch(async (error: unknown) => {
  const message = describe(error);
  window.__INK_E2E_BOOT_ERROR__ = message;
  await emit('ink-e2e-boot-error', { error: message });
});
