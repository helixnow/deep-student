import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';
import { pdfiumCandidatePaths, pushExistingPdfiumInChildDirs } from '../pdfium/diagnostics.ts';

describe('pdfium_utils.rs diagnostics', () => {
  it('linux_candidate_scan_finds_product_name_dir_with_spaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f7-pdfium-'));
    try {
      const lib = join(root, 'lib');
      await mkdir(join(lib, 'Deep Student'), { recursive: true });
      await mkdir(join(lib, 'empty-dir'));
      const expected = join(lib, 'Deep Student', 'libpdfium.so');
      await writeFile(expected, 'library fixture');
      await writeFile(join(lib, 'libpdfium.so'), 'not in a child directory');
      const paths: string[] = [];
      pushExistingPdfiumInChildDirs(paths, lib);
      pushExistingPdfiumInChildDirs(paths, lib);
      expect(paths).toEqual([expected]);
      expect(pdfiumCandidatePaths({ platform: 'linux', exePath: join(root, 'bin', 'app'), appDir: root }))
        .toEqual([
          join(root, 'bin', 'libpdfium.so'), expected,
          `${root}/bin/../Resources/libpdfium.so`, `${root}/usr/lib/deep-student/libpdfium.so`,
        ]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('linux_candidate_scan_skips_missing_root', () => {
    const paths = ['/nonexistent/libpdfium.so'];
    pushExistingPdfiumInChildDirs(paths, '/nonexistent-dsw-480');
    expect(paths).toHaveLength(1);
  });

  it('preserves macOS/Windows candidate priority without requiring either platform', () => {
    expect(pdfiumCandidatePaths({ platform: 'darwin', exePath: '/bundle/MacOS/app' })).toEqual([
      '/bundle/MacOS/libpdfium.dylib', '/bundle/MacOS/../Resources/libpdfium.dylib',
      '/bundle/MacOS/../Frameworks/libpdfium.dylib',
    ]);
    expect(pdfiumCandidatePaths({ platform: 'win32', exePath: 'C:\\app\\app.exe' })).toEqual([
      'C:\\app\\pdfium.dll', 'C:\\app\\..\\Resources\\pdfium.dll',
    ]);
  });

  it('test_pdfium_status reports the actual engine and parses the Rust minimal PDF through the provided service', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const result = await host.ctx.nativePdfium.diagnostics?.();
      if (result === undefined) throw new Error('dstu.native did not provide nativePdfium.diagnostics');
      expect(result.load_result).toBe('OK');
      expect(result.parse_test).toBe('OK, pages=1');
      expect(result.exe_path).toBe(JSON.stringify(process.execPath));
      expect(result.candidate_0).toMatch(/libpdfium|pdfium\.dll/);
      expect(result.engine).toBe('@embedpdf/pdfium@2.15.1 (chromium/7689; wasm)');
      expect(result.engine_path).toContain('pdfium.wasm');
    } finally { await host.dispose(); }
  });
});
