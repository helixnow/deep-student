import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  LARGE_FORMAT_MAX_CANVAS_EDGE_PX,
  LARGE_FORMAT_MAX_CANVAS_PIXELS,
  SINGLE_COLUMN_ZOOM_SCALE,
  STANDARD_MAX_CANVAS_EDGE_PX,
  STANDARD_MAX_CANVAS_PIXELS,
  buildProgressBarTicks,
  computeColumnDoubleClickZoom,
  computeSafeRenderDpr,
  computeTrimmedPageLayout,
  isLargeFormatPdfPage,
} from '../pdfViewportEnhance';
import {
  cleanExtractedStructuredText,
  extractStructuredFromRegion,
} from '../pdfRegionExtract';

describe('computeTrimmedPageLayout', () => {
  it('preserves full dimensions when trimMargins is disabled', () => {
    const full = computeTrimmedPageLayout(600, 1.4, false);
    expect(full).toEqual({
      renderWidth: 600,
      visibleWidth: 600,
      visibleHeight: 840,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it('enlarges native renderWidth and computes symmetric negative offsets when trimming margins', () => {
    const trimmed = computeTrimmedPageLayout(600, 1.4, true);
    expect(trimmed.visibleWidth).toBe(600);
    expect(trimmed.renderWidth).toBeGreaterThan(700);
    expect(trimmed.offsetX).toBeLessThan(0);
    expect(trimmed.offsetY).toBeLessThan(0);
    // renderWidth + 2 * offsetX ≈ visibleWidth
    expect(Math.abs(trimmed.renderWidth + 2 * trimmed.offsetX - 600)).toBeLessThanOrEqual(2);
  });
});

describe('computeColumnDoubleClickZoom', () => {
  it('zooms into the left or right column and restores baseline on second double-click', () => {
    const zoomLeft = computeColumnDoubleClickZoom({
      currentZoomMode: 'fitWidth',
      currentScale: 1.0,
      currentScrollLeft: 0,
      savedBaseline: null,
      clickClientX: 220,
      pageRect: { left: 100, width: 600 },
      viewportWidth: 640,
    });

    expect(zoomLeft.action).toBe('zoom_in');
    if (zoomLeft.action !== 'zoom_in') return;
    expect(zoomLeft.column).toBe('left');
    expect(zoomLeft.nextScale).toBe(SINGLE_COLUMN_ZOOM_SCALE);
    expect(zoomLeft.baselineToSave).toEqual({
      zoomMode: 'fitWidth',
      scale: 1.0,
      scrollLeft: 0,
    });

    const zoomRight = computeColumnDoubleClickZoom({
      currentZoomMode: 'fitWidth',
      currentScale: 1.0,
      currentScrollLeft: 0,
      savedBaseline: null,
      clickClientX: 560,
      pageRect: { left: 100, width: 600 },
      viewportWidth: 640,
    });
    expect(zoomRight.action).toBe('zoom_in');
    if (zoomRight.action === 'zoom_in') {
      expect(zoomRight.column).toBe('right');
      expect(zoomRight.targetScrollLeft).toBeGreaterThan(zoomLeft.targetScrollLeft);
    }

    const restored = computeColumnDoubleClickZoom({
      currentZoomMode: 'custom',
      currentScale: SINGLE_COLUMN_ZOOM_SCALE,
      currentScrollLeft: zoomLeft.targetScrollLeft,
      savedBaseline: zoomLeft.baselineToSave,
      clickClientX: 220,
      pageRect: { left: 100, width: 1110 },
      viewportWidth: 640,
    });
    expect(restored).toEqual({
      action: 'restore',
      zoomMode: 'fitWidth',
      nextScale: 1.0,
      targetScrollLeft: 0,
    });
  });
});

describe('buildProgressBarTicks', () => {
  it('aggregates 1-based highlight colors and active search matches per page', () => {
    const ticks = buildProgressBarTicks({
      numPages: 10,
      highlights: [
        { pageIndex: 2, color: '#ffeb3b', text: 'Core claim on page 2', comment: 'Important' },
        { pageIndex: 2, color: '#a5d6a7', text: 'Method detail on page 2' },
        { pageIndex: 8, color: '#ce93d8', text: 'BLEU = 28.4' },
      ],
      searchResults: [{ pageIndex: 2 }, { pageIndex: 5 }, { pageIndex: 5 }],
      searchActive: true,
    });

    expect(ticks).toHaveLength(3);
    expect(ticks[0]).toMatchObject({
      page: 2,
      percent: 15,
      color: '#ffeb3b',
      highlightCount: 2,
      searchCount: 1,
    });
    expect(ticks[0]!.previewText).toContain('Important — Core claim');
    expect(ticks[1]).toMatchObject({
      page: 5,
      percent: 45,
      color: null,
      highlightCount: 0,
      searchCount: 2,
    });
    expect(ticks[2]).toMatchObject({
      page: 8,
      percent: 75,
      color: '#ce93d8',
      highlightCount: 1,
      searchCount: 0,
    });
  });
});

describe('pdfRegionExtract structured LaTeX and Markdown table extraction', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('strips code fences and wraps bare formulas in display math delimiters', () => {
    expect(cleanExtractedStructuredText('```latex\nE = mc^2\n```', 'latex')).toBe('$$\nE = mc^2\n$$');
    expect(cleanExtractedStructuredText('$$\\sum_{i=1}^n x_i$$', 'latex')).toBe('$$\\sum_{i=1}^n x_i$$');
    expect(
      cleanExtractedStructuredText('```markdown\n| Model | BLEU |\n|---|---|\n| Base | 27.3 |\n```', 'table'),
    ).toBe('| Model | BLEU |\n|---|---|\n| Base | 27.3 |');
  });

  it('runs OCR + LLM formatting and falls back cleanly when LLM is unavailable', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'chat_v2_perform_ocr') {
        return { ocr_text: 'Attention(Q,K,V) = softmax(QK^T / sqrt(d_k))V' };
      }
      if (cmd === 'call_llm_for_boundary') {
        return {
          assistant_message: '$$\\mathrm{Attention}(Q,K,V) = \\mathrm{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V$$',
        };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const blob = new Blob(['fake-png'], { type: 'image/png' });
    const res = await extractStructuredFromRegion(blob, 'latex');
    expect(res.source).toBe('llm');
    expect(res.content).toContain('\\mathrm{Attention}');

    // LLM 不可用时降级为清洗后的 OCR 公式块
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'chat_v2_perform_ocr') {
        return { ocr_text: 'x_t = W h_{t-1}' };
      }
      throw new Error('LLM offline');
    });
    const fallback = await extractStructuredFromRegion(blob, 'latex');
    expect(fallback).toEqual({
      source: 'ocr',
      content: '$$\nx_t = W h_{t-1}\n$$',
    });
  });
});

describe('computeSafeRenderDpr and large-format A1 CAD pixel caps', () => {
  it('classifies A1/A2 CAD sheets as large-format while keeping A4/Letter standard', () => {
    expect(isLargeFormatPdfPage(595, 842)).toBe(false); // A4
    expect(isLargeFormatPdfPage(612, 792)).toBe(false); // Letter
    expect(isLargeFormatPdfPage(1684, 1191)).toBe(true); // A2
    expect(isLargeFormatPdfPage(2384, 1684)).toBe(true); // A1 CAD blueprint
  });

  it('preserves full 2x Retina DPR for standard A4 reading widths', () => {
    const dpr = computeSafeRenderDpr({
      renderWidth: 800,
      renderHeight: 1131,
      requestedDpr: 2,
      intrinsicWidth: 595,
      intrinsicHeight: 842,
    });
    expect(dpr).toBe(2);
  });

  it('caps both max canvas edge and total canvas pixels on tall or zoomed standard pages', () => {
    const dpr = computeSafeRenderDpr({
      renderWidth: 1600,
      renderHeight: 2800,
      requestedDpr: 2,
      intrinsicWidth: 595,
      intrinsicHeight: 1040,
    });
    expect(1600 * dpr).toBeLessThanOrEqual(STANDARD_MAX_CANVAS_EDGE_PX);
    expect(2800 * dpr).toBeLessThanOrEqual(STANDARD_MAX_CANVAS_EDGE_PX);
    expect(1600 * dpr * 2800 * dpr).toBeLessThanOrEqual(STANDARD_MAX_CANVAS_PIXELS);
  });

  it('aggressively caps DPR below 0.75 on massive 300%-zoomed A1 CAD blueprints to prevent OOM', () => {
    const dpr = computeSafeRenderDpr({
      renderWidth: 3600,
      renderHeight: 2543,
      requestedDpr: 2,
      intrinsicWidth: 2384,
      intrinsicHeight: 1684,
    });
    expect(dpr).toBeLessThan(0.75);
    expect(3600 * dpr).toBeLessThanOrEqual(LARGE_FORMAT_MAX_CANVAS_EDGE_PX);
    expect(2543 * dpr).toBeLessThanOrEqual(LARGE_FORMAT_MAX_CANVAS_EDGE_PX);
    expect(3600 * dpr * 2543 * dpr).toBeLessThanOrEqual(LARGE_FORMAT_MAX_CANVAS_PIXELS);
  });
});
