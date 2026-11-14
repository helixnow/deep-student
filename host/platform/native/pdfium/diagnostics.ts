import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, posix, win32 } from 'node:path';
import type { PdfiumDocument } from './api.ts';

/** Rust read_dir errors and unreadable entries are silently omitted. */
export function pushExistingPdfiumInChildDirs(paths: string[], root: string): void {
  let entries: string[];
  try { entries = readdirSync(root); }
  catch (error) {
    // boundary-allow empty-catch: pdfium_utils.rs:341–342 returns on read_dir error, without logging.
    return;
  }
  for (const entry of entries) {
    const candidate = posix.join(root, entry, 'libpdfium.so');
    let file: boolean;
    try { file = statSync(candidate).isFile(); }
    catch (error) {
      // boundary-allow empty-catch: Path::is_file returns false for missing/unreadable candidates.
      continue;
    }
    if (file && !paths.includes(candidate)) paths.push(candidate);
  }
}

export function pdfiumCandidatePaths(options: {
  platform?: NodeJS.Platform; exePath?: string; appDir?: string;
} = {}): string[] {
  const platform = options.platform ?? process.platform;
  const path = platform === 'win32' ? win32 : posix;
  const dir = path.dirname(options.exePath ?? process.execPath);
  const paths: string[] = [];
  if (platform === 'darwin') {
    for (const relative of ['libpdfium.dylib', '../Resources/libpdfium.dylib', '../Frameworks/libpdfium.dylib']) {
      paths.push(`${dir}/${relative}`);
    }
  } else if (platform === 'win32') {
    paths.push(`${dir}\\pdfium.dll`, `${dir}\\..\\Resources\\pdfium.dll`);
  } else if (platform === 'linux') {
    paths.push(posix.join(dir, 'libpdfium.so'));
    pushExistingPdfiumInChildDirs(paths, posix.join(dir, '..', 'lib'));
    paths.push(`${dir}/../Resources/libpdfium.so`);
    const appDir = options.appDir ?? process.env.APPDIR;
    if (appDir !== undefined) {
      pushExistingPdfiumInChildDirs(paths, posix.join(appDir, 'usr/lib'));
      const legacy = posix.join(appDir, 'usr/lib/deep-student/libpdfium.so');
      if (!paths.includes(legacy)) paths.push(legacy);
    }
  }
  return paths;
}

const MINIMAL_PDF = '%PDF-1.0\n1 0 obj<</Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000043 00000 n \n0000000098 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n167\n%%EOF';

export async function pdfiumDiagnostics(
  load: () => Promise<unknown>,
  open: (bytes: Uint8Array) => Promise<PdfiumDocument>,
  enginePath: string,
): Promise<Record<string, string>> {
  const info: Record<string, string> = {
    exe_path: JSON.stringify(process.execPath), exe_dir: JSON.stringify(dirname(process.execPath)),
    engine: '@embedpdf/pdfium@2.15.1 (chromium/7689; wasm)', engine_path: enginePath,
  };
  pdfiumCandidatePaths().forEach((path, index) => {
    info[`candidate_${index}`] = `${JSON.stringify(path)} (exists=${existsSync(path)})`;
  });
  try { await load(); }
  catch (error) {
    info.load_result = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
    return info;
  }
  info.load_result = 'OK';
  try {
    const document = await open(Buffer.from(MINIMAL_PDF));
    try { info.parse_test = `OK, pages=${document.pageCount}`; }
    finally { await document.close(); }
  } catch (error) {
    info.parse_test = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
  }
  return info;
}
