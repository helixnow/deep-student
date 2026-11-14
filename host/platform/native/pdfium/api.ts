/** pdfium-render 0.9.4, pdfium_7350; page indices are zero based. */
export interface PdfiumPage {
  width: number;
  height: number;
  text(): Promise<string>;
  render(options: { width: number; height: number; annotations: boolean }): Promise<{
    width: number; height: number; rgba: Uint8Array;
  }>;
}
export interface PdfiumDocument {
  pageCount: number;
  page(index: number): Promise<PdfiumPage>;
  close(): Promise<void>;
}
export interface NativePdfium {
  /**
   * test_pdfium_status string map; engine/engine_path disclose the actual WASM backend.
   * Always provided by `dstu.native`; optional only so consumers' existing
   * open/extractText test doubles stay assignable.
   */
  diagnostics?(): Promise<Record<string, string>>;
  open(bytes: Uint8Array, password?: string | null): Promise<PdfiumDocument>;
  extractText(bytes: Uint8Array): Promise<string>;
}
declare module '@deepseek-ai/cordis' {
  interface Context { nativePdfium: NativePdfium }
}
