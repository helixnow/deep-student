/**
 * `dstu-docs/src/pdfium_utils.rs:192-238::test_pdfium_status`.
 *
 * Rust diagnoses the bundled native `libpdfium`: it reports the executable
 * paths, every candidate library path, then loads the library and parses a
 * minimal PDF. The Electron Host uses the F7 WASM PDFium adapter instead, so
 * there is no native library candidate list; the executable paths and the
 * real load/parse result still come from the Host provider. The `candidate_N`
 * keys are therefore absent rather than fabricated.
 */
import { dirname } from '../../../platform/util/path.ts';
import type { NativePdfium } from '../../../platform/native/pdfium/api.ts';

/** `pdfium_utils.rs:200-202` minimal PDF used by the Rust diagnostic. */
const MINIMAL_PDF = new TextEncoder().encode(
  '%PDF-1.0\n1 0 obj<</Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>'
  + 'endobj 3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\n'
  + 'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000043 00000 n \n'
  + '0000000098 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n167\n%%EOF',
);

/** Rust formats paths with `{:?}` (quoted); JSON string escaping matches that shape. */
function debugPath(value: string): string {
  return JSON.stringify(value);
}

export async function testPdfiumStatus(
  nativePdfium: NativePdfium | null,
  exePath: string,
): Promise<Record<string, string>> {
  const info: Record<string, string> = {};
  info.exe_path = debugPath(exePath);
  info.exe_dir = debugPath(dirname(exePath));
  if (nativePdfium === null) {
    info.load_result = 'FAIL: nativePdfium service not available';
    return info;
  }
  try {
    const document = await nativePdfium.open(MINIMAL_PDF, null);
    try {
      info.load_result = 'OK';
      info.parse_test = `OK, pages=${document.pageCount}`;
    } finally {
      try { await document.close(); }
      catch (error) {
        // Rust's PdfDocument Drop has no close-result channel; keep the
        // diagnostic successful but expose the Host close error separately.
        info.close_error = error instanceof Error ? error.message : String(error);
      }
    }
  } catch (error) {
    info.load_result = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
  }
  return info;
}
