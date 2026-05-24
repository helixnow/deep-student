// Public API for pdf feature
export { PdfReader } from './components/PdfReader';
export { EnhancedPdfViewer } from './components/EnhancedPdfViewer';
export { TextbookPdfViewer } from './components/TextbookPdfViewer';
export { usePdfProcessingStore } from './stores/pdfProcessingStore';
export { usePdfSettingsStore } from './stores/pdfSettingsStore';

// Re-export types
export type { Bookmark } from './components/EnhancedPdfViewer';
export type { ReadingProgress } from './components/TextbookPdfViewer';
export type { PdfProcessingStatus, MediaType, ProcessingStage } from './stores/pdfProcessingStore';
export type { PdfSettings } from './stores/pdfSettingsStore';
