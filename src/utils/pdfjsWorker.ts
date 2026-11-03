import { pdfjs } from 'react-pdf';

export function initializePdfWorker(): void {
  pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.wrapper.mjs`;
}
