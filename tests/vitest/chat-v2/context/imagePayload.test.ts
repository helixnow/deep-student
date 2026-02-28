import { describe, it, expect } from 'vitest';
import { buildImageDataUrl, extractImageOcrText, extractImagePayload } from '@/chat-v2/context/imagePayload';

describe('imagePayload helpers', () => {
  it('extracts base64 and OCR text from mixed data URL payload', () => {
    const payload = 'data:image/png;base64,aGVsbG8=<image_ocr>题目文本</image_ocr>';
    const parsed = extractImagePayload(payload);

    expect(parsed.mediaType).toBe('image/png');
    expect(parsed.base64).toBe('aGVsbG8=');
    expect(parsed.ocrText).toBe('题目文本');
  });

  it('normalizes whitespace in base64 payload', () => {
    const payload = 'aGVs bG8=\n\r';
    const parsed = extractImagePayload(payload);
    expect(parsed.base64).toBe('aGVsbG8=');
  });

  it('builds clean data URL for mixed payload', () => {
    const payload = 'data:image/png;base64,aGVsbG8=<image_ocr>OCR</image_ocr>';
    expect(buildImageDataUrl(payload, 'image/jpeg')).toBe('data:image/png;base64,aGVsbG8=');
  });

  it('returns null when payload contains OCR text only', () => {
    const payload = '<image_ocr>only text</image_ocr>';
    expect(buildImageDataUrl(payload, 'image/png')).toBeNull();
    expect(extractImageOcrText(payload)).toBe('only text');
  });
});
