import { describe, expect, it } from 'vitest';
import { DEFAULT_PDF_PREVIEW_CONFIG } from '../repository/pdf-preview.ts';

describe('pdf_preview.rs', () => {
  it('test_pdf_preview_config_default', () => {
    const config = DEFAULT_PDF_PREVIEW_CONFIG;
    expect(config.renderDpi).toBe(150);
    expect(config.maxPages).toBe(50);
    expect(config.targetWidth).toBe(1200);
    expect(config.maxHeight).toBe(1600);
    expect(config.jpegQuality).toBe(75);
    expect(config.compressionEnabled).toBe(true);
  });
});
