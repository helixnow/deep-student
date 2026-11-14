import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeBase64Standard } from '../../../platform/secrets/crypto-service.ts';
import { ocrExtractText, type OcrExtractRuntime } from '../src/ocr_extract.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';

const files = createNodeFiles({ roots: [{ name: 'temp', path: tmpdir() }] });

describe('translation.rs::ocr_extract_text file lifecycle', () => {
  it('prefers base64 over path, preserves native errors, and drops temporary files after success/failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ocr-extract-'));
    let submitted = '', fail = false;
    const failure = { error_type: 'LLM', message: 'upstream failure', details: null };
    const runtime: OcrExtractRuntime = { platform: 'linux', files: () => files, getTempAppDataDir: () => root, decodeBase64Standard,
      callOcrFreeTextWithFallback: async path => {
        submitted = path;
        expect(readFileSync(path)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        if (fail) throw failure;
        return 'text';
      } };
    try {
      expect(await ocrExtractText(runtime, '/ignored', 'iVBORw0KGgo=')).toBe('text');
      expect(submitted).toMatch(/ocr_temp_[0-9a-f-]{36}\.png$/);
      expect(existsSync(submitted)).toBe(false);
      fail = true;
      await expect(ocrExtractText(runtime, null, 'iVBORw0KGgo=')).rejects.toBe(failure);
      expect(existsSync(submitted)).toBe(false);
      expect(readdirSync(join(root, 'temp'))).toEqual([]);
      const file = join(root, 'existing.png'); writeFileSync(file, Buffer.from('iVBORw0KGgo=', 'base64'));
      fail = false; expect(await ocrExtractText(runtime, file, null)).toBe('text');
      expect(existsSync(file)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('validates before OCR and creates the directory before reporting strict base64 errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ocr-invalid-'));
    const runtime: OcrExtractRuntime = { platform: 'linux', files: () => files, getTempAppDataDir: () => root, decodeBase64Standard,
      callOcrFreeTextWithFallback: async () => { throw new Error('OCR must not run'); } };
    try {
      await expect(ocrExtractText(runtime, null, null)).rejects.toMatchObject({ message: '必须提供image_path或image_base64' });
      expect(existsSync(join(root, 'temp'))).toBe(false);
      await expect(ocrExtractText(runtime, null, '!!!!')).rejects.toMatchObject({ message: 'Base64解码失败: Invalid symbol 33, offset 0.' });
      expect(readdirSync(join(root, 'temp'))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
