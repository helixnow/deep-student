import { afterEach, describe, expect, it } from 'vitest';
import {
  OcrError, SystemOcrAdapter, isSystemOcrPlatformSupported, performSystemOcr, setSystemOcrBinding,
} from '../api.ts';

afterEach(() => setSystemOcrBinding(null));

describe('system OCR adapter', () => {
  it('only supports free_ocr and wraps plain text', () => {
    const adapter = new SystemOcrAdapter();
    expect(adapter.engineType()).toBe('system_ocr');
    expect(adapter.displayName()).toBe('系统 OCR');
    expect(adapter.supportsMode('free_ocr')).toBe(true);
    expect(adapter.supportsMode('grounding')).toBe(false);
    expect(adapter.buildPrompt('free_ocr')).toBe('');
    expect(adapter.recommendedMaxTokens('free_ocr')).toBe(0);
    expect(adapter.requiresHighDetail()).toBe(false);

    const result = adapter.parseResponse('  hello\n', 100, 200, 3, '/tmp/a.png', 'free_ocr');
    expect(result).toMatchObject({
      page_index: 3, image_path: '/tmp/a.png', image_width: 100, image_height: 200,
      markdown_text: 'hello', engine: 'system_ocr', mode: 'free_ocr',
    });
    expect(result.regions).toEqual([{ label: 'document', text: 'hello' }]);
  });

  // Rust system_ocr/mod.rs:63：非 macOS/Windows 平台在调用 binding 之前即报 unsupported，委托只在受支持平台发生。
  it.skipIf(!isSystemOcrPlatformSupported())('delegates OCR to the injected native binding', async () => {
    setSystemOcrBinding({ performSystemOcr: async data => `bytes:${data.length}` });
    expect(await performSystemOcr(new Uint8Array([1, 2, 3]))).toBe('bytes:3');
  });

  it('reports unsupported instead of fabricating text when no binding exists', async () => {
    await expect(performSystemOcr(new Uint8Array([1]))).rejects.toBeInstanceOf(OcrError);
    await expect(performSystemOcr(new Uint8Array([1]))).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('exposes platform detection for the factory', () => {
    expect(isSystemOcrPlatformSupported()).toBe(process.platform === 'darwin' || process.platform === 'win32');
  });
});
