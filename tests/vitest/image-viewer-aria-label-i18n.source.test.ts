import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ImageViewer aria-label i18n contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/components/ImageViewer.tsx'),
    'utf-8'
  );

  it('has no hardcoded English aria-labels on icon buttons', () => {
    const hardcoded = [
      'aria-label="close panel"',
      'aria-label="zoom out"',
      'aria-label="zoom in"',
      'aria-label="rotate ccw"',
      'aria-label="rotate"',
      'aria-label="reset"',
      'aria-label="crop"',
      'aria-label="ocr text"',
      'aria-label="download"',
    ];
    for (const label of hardcoded) {
      expect(source).not.toContain(label);
    }
    // 兜底：不允许任何字符串字面量形式的 aria-label（必须走 t()）
    expect(source).not.toMatch(/aria-label="[^"]/);
  });

  it('reuses the existing title keys for aria-labels', () => {
    const translated = [
      "aria-label={t('a11y.close', { defaultValue: 'Close panel' })}",
      "aria-label={t('common:imageViewer.zoom_out')}",
      "aria-label={t('common:imageViewer.zoom_in')}",
      "aria-label={t('common:imageViewer.rotate_ccw')}",
      "aria-label={t('common:imageViewer.rotate_title')}",
      "aria-label={t('common:imageViewer.reset_title')}",
      "aria-label={t('common:imageViewer.crop')}",
      "aria-label={t('common:imageViewer.ocr_text')}",
      "aria-label={t('common:imageViewer.download')}",
    ];
    for (const label of translated) {
      expect(source).toContain(label);
    }
  });
});
