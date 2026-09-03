import { describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string) => key,
  },
}));

import { decodeBase64ToArrayBuffer } from '../previewUtils';

describe('previewUtils Base64 解码错误 i18n', () => {
  it('空字符串抛出 pdf:preview.empty_content', () => {
    expect(() => decodeBase64ToArrayBuffer('')).toThrowError('pdf:preview.empty_content');
  });

  it('非法 base64 抛出 pdf:preview.decode_failed', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => decodeBase64ToArrayBuffer('!!!not-base64!!!')).toThrowError('pdf:preview.decode_failed');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
