/**
 * PDF 移动端断点对齐至 768px（与 App shell 一致）及 640–767px 顶栏清爽契约单测。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  Thumbnail: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' }, version: '4.0.0' },
  PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 },
}));

import {
  PDF_SMALL_VIEWPORT_QUERY,
  matchesPdfMediaQuery,
  shouldShowPdfStudyShortcuts,
  subscribePdfMediaQuery,
} from '../EnhancedPdfViewer';

const viewerSource = readFileSync(
  resolve(process.cwd(), 'src/features/pdf/components/EnhancedPdfViewer.tsx'),
  'utf8',
);

describe('EnhancedPdfViewer 768px mobile breakpoint alignment', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });

  it('aligns small viewport query to (max-width: 767.98px) and removes legacy 639.98px query', () => {
    expect(PDF_SMALL_VIEWPORT_QUERY).toBe('(max-width: 767.98px)');
    expect(viewerSource).toContain("'(max-width: 767.98px)'");
    expect(viewerSource).not.toContain('639.98px');
    expect(viewerSource).toContain('!isPreviewToolbar && !isSmallViewport && toolbarWidth >=');
  });

  it('guards against missing window.matchMedia in SSR/test environments', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });

    expect(matchesPdfMediaQuery(PDF_SMALL_VIEWPORT_QUERY)).toBe(false);
    const off = subscribePdfMediaQuery(PDF_SMALL_VIEWPORT_QUERY, () => {});
    expect(() => off()).not.toThrow();
  });

  it('subscribes with modern addEventListener("change") and cleans up on teardown', () => {
    let changeHandler: (() => void) | undefined;
    const removeEventListener = vi.fn();
    const mql = {
      matches: true,
      addEventListener: vi.fn((type: string, cb: () => void) => {
        if (type === 'change') changeHandler = cb;
      }),
      removeEventListener,
    };
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn(() => mql),
    });

    expect(matchesPdfMediaQuery(PDF_SMALL_VIEWPORT_QUERY)).toBe(true);
    const updates: boolean[] = [];
    const off = subscribePdfMediaQuery(PDF_SMALL_VIEWPORT_QUERY, (matches) => updates.push(matches));

    mql.matches = false;
    changeHandler?.();
    expect(updates).toEqual([false]);

    off();
    expect(removeEventListener).toHaveBeenCalledWith('change', changeHandler);
  });

  it('falls back to legacy addListener / removeListener when addEventListener is unavailable', () => {
    let legacyHandler: (() => void) | undefined;
    const removeListener = vi.fn();
    const mql = {
      matches: false,
      addListener: vi.fn((cb: () => void) => {
        legacyHandler = cb;
      }),
      removeListener,
    };
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn(() => mql),
    });

    const updates: boolean[] = [];
    const off = subscribePdfMediaQuery(PDF_SMALL_VIEWPORT_QUERY, (matches) => updates.push(matches));

    mql.matches = true;
    legacyHandler?.();
    expect(updates).toEqual([true]);

    off();
    expect(removeListener).toHaveBeenCalledWith(legacyHandler);
  });

  it('hides inline study shortcuts on 640–767px small viewports even when toolbar width exceeds 520px', () => {
    expect(
      shouldShowPdfStudyShortcuts({
        isPreviewToolbar: false,
        isSmallViewport: true,
        isCoarsePointer: true,
        toolbarWidth: 700,
      }),
    ).toBe(false);

    expect(
      shouldShowPdfStudyShortcuts({
        isPreviewToolbar: false,
        isSmallViewport: false,
        isCoarsePointer: true,
        toolbarWidth: 768,
      }),
    ).toBe(true);
  });
});
