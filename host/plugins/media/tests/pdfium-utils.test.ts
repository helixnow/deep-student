import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFIUM_LIB_NAME, pushExistingPdfiumInChildDirs } from '../src/pdfium-utils.ts';

it('linux_candidate_scan_finds_product_name_dir_with_spaces', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pdfium-'));
  try {
    const libRoot = join(tmp, 'lib');
    // Tauri deb/rpm 资源目录：/usr/lib/Deep Student/
    const productDir = join(libRoot, 'Deep Student');
    mkdirSync(productDir, { recursive: true });
    const expected = join(productDir, PDFIUM_LIB_NAME);
    writeFileSync(expected, 'stub');
    // 干扰项：没有 libpdfium.so 的子目录、根下同名文件都不应进候选
    mkdirSync(join(libRoot, 'empty-dir'), { recursive: true });
    writeFileSync(join(libRoot, PDFIUM_LIB_NAME), 'stub');

    const paths: string[] = [];
    pushExistingPdfiumInChildDirs(paths, libRoot);
    // 重复调用不应追加重复候选
    pushExistingPdfiumInChildDirs(paths, libRoot);

    expect(paths).toEqual([expected]);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

it('linux_candidate_scan_skips_missing_root', () => {
  const paths = ['/nonexistent/libpdfium.so'];
  pushExistingPdfiumInChildDirs(paths, '/nonexistent-dsw-480');
  expect(paths.length).toBe(1);
});
