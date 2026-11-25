/**
 * Wave-2C OOD PDF Viewer regression suite (G13 + G14):
 * 1. Deep-page jump programmatic lock & anti-drift suppression
 * 2. Zero TextLayer rebuild on Search Next/Prev + throttled scan completion + Enter advance
 * 3. Scanned-PDF banner doc-switch & load-error reset, deduplicated hint, complete en-US/zh-CN i18n
 * 4. More -> Highlight explicit active mode bar (keeps text selection ON) & always-visible More -> Export
 * 5. Intrinsic PDF /Rotate preservation (rotate={undefined} when user rotation === 0)
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enPdfLocale from '@/locales/en-US/pdf.json';
import zhPdfLocale from '@/locales/zh-CN/pdf.json';
import {
  applyActiveSearchMarkInViewport,
  collectPageSearchMatches,
  renderSearchHighlightedText,
  stepSearchMatchIndex,
} from '../pdfSearch';

const mockState = vi.hoisted(() => ({
  saveBinaryFile: vi.fn(async () => ({ canceled: false })),
  showGlobalNotification: vi.fn(),
  scrollToIndex: vi.fn(),
  measure: vi.fn(),
  documentBehavior: {
    mode: 'text' as 'text' | 'scanned' | 'error',
    numPages: 12,
    pageTexts: new Map<number, string>(),
    intrinsicRotate: 0,
  },
  pageRenderLog: [] as Array<{
    pageNumber: number;
    rotate: number | undefined;
    customTextRenderer: unknown;
  }>,
  virtualItemCount: 1,
}));

vi.mock('react-i18next', () => {
  const lookup = (obj: Record<string, unknown>, path: string): string | undefined => {
    let cur: unknown = obj;
    for (const part of path.split('.')) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return typeof cur === 'string' ? cur : undefined;
  };
  return {
    initReactI18next: { type: '3rdParty', init: () => {} },
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        const stripped = key.startsWith('pdf:') ? key.slice(4) : key;
        let resolved = lookup(enPdfLocale as unknown as Record<string, unknown>, stripped);
        if (!resolved && typeof opts?.defaultValue === 'string') {
          resolved = opts.defaultValue;
        }
        if (!resolved) return key;
        if (opts) {
          for (const [k, v] of Object.entries(opts)) {
            if (k === 'defaultValue') continue;
            resolved = resolved.replaceAll(`{{${k}}}`, String(v));
          }
        }
        return resolved;
      },
    }),
  };
});

vi.mock('@/utils/fileManager', () => ({
  fileManager: {
    saveBinaryFile: mockState.saveBinaryFile,
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mockState.showGlobalNotification,
}));

vi.mock('@/ui-kernel/bootstrap', () => ({
  getAppKernel: () => ({
    anchors: {
      queryAnchorEdgesByTarget: vi.fn(async () => []),
      subscribeAnchorEdgesChanged: vi.fn(() => () => {}),
      registerAnchorRevealHandler: vi.fn(() => () => {}),
      reveal: vi.fn(),
    },
  }),
}));

vi.mock('@/dstu', () => ({
  dstu: {
    get: vi.fn(async () => ({ ok: false })),
    update: vi.fn(async () => ({ ok: true })),
  },
}));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: React.forwardRef<
    HTMLDivElement,
    {
      children?: React.ReactNode;
      className?: string;
      viewportClassName?: string;
      viewportRef?: React.Ref<HTMLDivElement>;
    }
  >(({ children, className, viewportClassName, viewportRef }, _ref) => (
    <div className={className}>
      <div
        ref={viewportRef}
        className={viewportClassName}
        data-testid="pdf-scroll-viewport"
        style={{ height: 800, overflow: 'auto' }}
      >
        {children}
      </div>
    </div>
  )),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => {
    const visibleCount = Math.min(count, Math.max(1, mockState.virtualItemCount));
    const items = Array.from({ length: visibleCount }, (_, index) => ({
      key: index,
      index,
      start: index * 1000,
      size: 1000,
      end: (index + 1) * 1000,
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => count * 1000,
      scrollToIndex: mockState.scrollToIndex,
      scrollToOffset: vi.fn(),
      measure: mockState.measure,
      measureElement: () => {},
      measurementsCache: items,
      getVirtualItemForOffset: () => items[0],
    };
  },
}));

vi.mock('react-pdf', () => {
  const Document: React.FC<{
    file: unknown;
    options?: Record<string, unknown>;
    onLoadSuccess?: (doc: unknown) => void;
    onLoadError?: (error: Error) => void;
    children?: React.ReactNode;
  }> = ({ file, onLoadSuccess, onLoadError, children }) => {
    const onLoadSuccessRef = React.useRef(onLoadSuccess);
    const onLoadErrorRef = React.useRef(onLoadError);
    onLoadSuccessRef.current = onLoadSuccess;
    onLoadErrorRef.current = onLoadError;

    React.useEffect(() => {
      if (!file) return;
      const cfg = mockState.documentBehavior;
      if (cfg.mode === 'error') {
        onLoadErrorRef.current?.(new Error('Invalid PDF structure'));
        return;
      }
      const fakeDoc = {
        numPages: cfg.numPages,
        destroy: vi.fn(),
        getOutline: vi.fn(async () => null),
        getData: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])),
        getPage: vi.fn(async (pageNum: number) => ({
          pageNumber: pageNum,
          rotate: cfg.intrinsicRotate,
          getViewport: ({ scale }: { scale: number }) => ({
            width: 600 * scale,
            height: 800 * scale,
          }),
          getTextContent: vi.fn(async () => {
            if (cfg.mode === 'scanned') {
              return { items: [] };
            }
            const text = cfg.pageTexts.get(pageNum) ?? `Body content on page ${pageNum}`;
            return { items: [{ str: text, hasEOL: false }] };
          }),
        })),
      };
      onLoadSuccessRef.current?.(fakeDoc);
    }, [file]);

    return <div data-testid="mock-pdf-document">{children}</div>;
  };

  const Page: React.FC<{
    pageNumber: number;
    rotate?: number;
    customTextRenderer?: (props: { pageNumber: number; itemIndex: number; str: string }) => string;
  }> = ({ pageNumber, rotate, customTextRenderer }) => {
    mockState.pageRenderLog.push({ pageNumber, rotate, customTextRenderer });
    const text = mockState.documentBehavior.pageTexts.get(pageNumber) ?? `Body content on page ${pageNumber}`;
    const renderedHtml = customTextRenderer
      ? customTextRenderer({ pageNumber, itemIndex: 0, str: text })
      : text;
    return (
      <div className="react-pdf__Page" data-mock-page={pageNumber} data-mock-rotate={String(rotate)}>
        <div
          className="react-pdf__Page__textContent"
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      </div>
    );
  };

  return {
    Document,
    Page,
    Thumbnail: () => <div data-testid="mock-thumbnail" />,
    pdfjs: { GlobalWorkerOptions: { workerSrc: '' } },
    PasswordResponses: { INCORRECT_PASSWORD: 2 },
  };
});

import {
  EnhancedPdfViewer,
  createProgrammaticJumpLock,
  getPageSearchTextRenderer,
  shouldSuppressScrollPageSync,
} from '../components/EnhancedPdfViewer';

const CJK_RE = /[\u4E00-\u9FFF]/;

describe('PDF Viewer OOD Regressions (G13 + G14)', () => {
  beforeEach(() => {
    mockState.saveBinaryFile.mockClear();
    mockState.showGlobalNotification.mockClear();
    mockState.scrollToIndex.mockClear();
    mockState.measure.mockClear();
    mockState.pageRenderLog.length = 0;
    mockState.virtualItemCount = 1;
    mockState.documentBehavior = {
      mode: 'text',
      numPages: 12,
      pageTexts: new Map(),
      intrinsicRotate: 0,
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  describe('Pure helpers: jump lock, stable search renderer, match stepping, and i18n parity', () => {
    it('suppresses scroll-back page overwrites while programmatic jump lock is active', () => {
      const lock = createProgrammaticJumpLock(1, 65, 64, 1000, 900);
      expect(shouldSuppressScrollPageSync(lock, 1000)).toBe(true);
      expect(shouldSuppressScrollPageSync(lock, 1899)).toBe(true);
      expect(shouldSuppressScrollPageSync(lock, 1900)).toBe(false);
      expect(shouldSuppressScrollPageSync(null, 1000)).toBe(false);
    });

    it('keeps search customTextRenderer identity stable and toggles .ds-search-mark--current imperatively', () => {
      const { itemRanges } = collectPageSearchMatches(
        [{ str: 'theorem one and theorem two' }],
        'theorem',
      );
      const r1 = getPageSearchTextRenderer(itemRanges);
      const r2 = getPageSearchTextRenderer(itemRanges);
      expect(r1).toBe(r2);

      const html = renderSearchHighlightedText(
        'theorem one and theorem two',
        3,
        itemRanges.get(0),
        (s) => s,
      );
      const host = document.createElement('div');
      host.innerHTML = html;

      // Neither mark bakes --current into HTML
      expect(host.querySelectorAll('mark.ds-search-mark')).toHaveLength(2);
      expect(host.querySelectorAll('mark.ds-search-mark--current')).toHaveLength(0);

      // Step 1/2 -> 2/2 -> 1/2 strictly by 1 without rebuilding HTML
      const first = applyActiveSearchMarkInViewport(host, { pageIndex: 3, matchIndex: 0 });
      expect(first?.getAttribute('data-match-ordinal')).toBe('0');
      expect(host.querySelectorAll('mark.ds-search-mark--current')).toHaveLength(1);

      const idx2 = stepSearchMatchIndex(0, 8, 1);
      expect(idx2).toBe(1);
      const idx3 = stepSearchMatchIndex(idx2, 8, 1);
      expect(idx3).toBe(2);
      expect(stepSearchMatchIndex(0, 8, -1)).toBe(7);
      expect(stepSearchMatchIndex(7, 8, 1)).toBe(0);

      const second = applyActiveSearchMarkInViewport(host, { pageIndex: 3, matchIndex: 1 });
      expect(second?.getAttribute('data-match-ordinal')).toBe('1');
      expect(host.querySelectorAll('mark.ds-search-mark--current')).toHaveLength(1);
      expect(first?.classList.contains('ds-search-mark--current')).toBe(false);
    });

    it('defines all scanned-banner, highlight-mode, and export keys in both en-US and zh-CN with zero CJK leakage in en-US', () => {
      const requiredToolbarKeys = [
        'scanned_no_text_banner',
        'ocr_processing_banner',
        'ocr_failed_banner',
        'scanned_search_hint',
        'ocr_requires_library',
        'dismiss_banner',
        'highlight_mode_active',
        'highlight_mode_exit',
      ] as const;

      for (const key of requiredToolbarKeys) {
        const enVal = enPdfLocale.toolbar[key];
        const zhVal = zhPdfLocale.toolbar[key];
        expect(enVal, `en-US toolbar.${key}`).toBeTruthy();
        expect(zhVal, `zh-CN toolbar.${key}`).toBeTruthy();
        expect(CJK_RE.test(enVal), `en-US toolbar.${key} leaked CJK`).toBe(false);
      }

      const requiredAnnotationKeys = [
        'export_pdf',
        'export_pdf_copy',
        'export_pdf_copy_hint',
        'export_pdf_copy_success',
        'export_pdf_encrypted_unsupported',
      ] as const;

      for (const key of requiredAnnotationKeys) {
        const enVal = enPdfLocale.annotations[key];
        const zhVal = zhPdfLocale.annotations[key];
        expect(enVal, `en-US annotations.${key}`).toBeTruthy();
        expect(zhVal, `zh-CN annotations.${key}`).toBeTruthy();
        expect(CJK_RE.test(enVal), `en-US annotations.${key} leaked CJK`).toBe(false);
      }

      expect(enPdfLocale.page_rendering_slow).toBeTruthy();
      expect(CJK_RE.test(enPdfLocale.page_rendering_slow)).toBe(false);
      expect(zhPdfLocale.page_rendering_slow).toBeTruthy();
    });
  });

  describe('EnhancedPdfViewer interactive regressions', () => {
    it('resets scanned-PDF banner on doc switch and load error, and deduplicates search no-text hint', async () => {
      mockState.documentBehavior = {
        mode: 'scanned',
        numPages: 3,
        pageTexts: new Map(),
        intrinsicRotate: 0,
      };
      const pdfA = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
      const pdfB = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x32]);

      const { rerender } = render(
        <EnhancedPdfViewer data={pdfA} fileName="scan.pdf" resourcePath="/tb_scan" />,
      );

      // Scanned banner appears in en-US
      const banner = await screen.findByTestId('pdf-scanned-banner');
      expect(banner.textContent).toContain('scanned with no native text layer');
      expect(CJK_RE.test(banner.textContent ?? '')).toBe(false);

      // Open search and search -> search bar shows concise "No matches found" rather than duplicating scanned hint
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
      const searchInput = screen.getByRole('searchbox');
      fireEvent.change(searchInput, { target: { value: 'hello' } });
      fireEvent.keyDown(searchInput, { key: 'Enter' });

      await waitFor(() => {
        expect(screen.getByText('No matches found')).toBeInTheDocument();
      });
      expect(screen.queryByText(/run OCR first/i)).toBeNull();

      // Switch to a text-bearing document -> scanned banner MUST clear and stay absent
      mockState.documentBehavior = {
        mode: 'text',
        numPages: 5,
        pageTexts: new Map([[1, 'Real native text content on page 1']]),
        intrinsicRotate: 0,
      };
      rerender(<EnhancedPdfViewer data={pdfB} fileName="text.pdf" resourcePath="/tb_text" />);

      await waitFor(() => {
        expect(screen.queryByTestId('pdf-scanned-banner')).toBeNull();
      });

      // Switch to a broken document (onLoadError) -> banner stays absent
      const pdfC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x33]);
      mockState.documentBehavior = {
        mode: 'error',
        numPages: 0,
        pageTexts: new Map(),
        intrinsicRotate: 0,
      };
      rerender(<EnhancedPdfViewer data={pdfC} fileName="broken.pdf" resourcePath="/tb_broken" />);
      await waitFor(() => {
        expect(screen.queryByTestId('pdf-scanned-banner')).toBeNull();
      });
    });

    it('activates explicit Highlight mode bar (keeping selection enabled) and always exposes Export in More menu', async () => {
      mockState.documentBehavior = {
        mode: 'text',
        numPages: 4,
        pageTexts: new Map([[1, 'Selectable paper paragraph']]),
        intrinsicRotate: 90,
      };
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x34]);

      render(
        <EnhancedPdfViewer
          data={pdfBytes}
          fileName="paper.pdf"
          resourcePath="/tb_paper"
          initialHighlights={[]}
        />,
      );

      await waitFor(() => {
        expect(mockState.pageRenderLog.length).toBeGreaterThan(0);
      });
      // Intrinsic /Rotate preserved: when user rotation === 0, <Page rotate={undefined}>
      expect(mockState.pageRenderLog[0]!.rotate).toBeUndefined();

      // Open More menu -> Export PDF is present and enabled even with 0 highlights!
      fireEvent.click(screen.getByRole('button', { name: 'More' }));
      const exportBtn = screen.getByRole('button', { name: 'Export PDF' });
      expect(exportBtn).not.toBeDisabled();
      fireEvent.click(exportBtn);

      await waitFor(() => {
        expect(mockState.saveBinaryFile).toHaveBeenCalledTimes(1);
      });

      // Open More menu -> Click Highlight -> shows explicit highlight mode bar with 5 color swatches + Done
      fireEvent.click(screen.getByRole('button', { name: 'More' }));
      fireEvent.click(screen.getByRole('button', { name: 'Highlight' }));

      const modeBar = screen.getByTestId('pdf-highlight-mode-bar');
      expect(modeBar).toBeInTheDocument();
      expect(modeBar.textContent).toContain('Highlight mode');
      expect(modeBar.querySelectorAll('.ds-highlight-color')).toHaveLength(5);

      // Click Done exits highlight mode cleanly
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(screen.queryByTestId('pdf-highlight-mode-bar')).toBeNull();
    });

    it('advances search results 1-by-1 on Enter and Next without changing customTextRenderer identity', async () => {
      mockState.documentBehavior = {
        mode: 'text',
        numPages: 3,
        pageTexts: new Map([
          [1, 'alpha beta alpha gamma alpha'],
          [2, 'no match here'],
          [3, 'alpha on page 3'],
        ]),
        intrinsicRotate: 0,
      };
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x35]);

      render(<EnhancedPdfViewer data={pdfBytes} fileName="search.pdf" resourcePath="/tb_search" />);

      await waitFor(() => {
        expect(mockState.pageRenderLog.length).toBeGreaterThan(0);
      });

      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
      const input = screen.getByRole('searchbox');
      fireEvent.change(input, { target: { value: 'alpha' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      // Wait for search to finish scanning all 3 pages -> 4 matches total, progress cleared
      await waitFor(() => {
        expect(screen.getByText('1 / 4')).toBeInTheDocument();
        expect(screen.queryByText(/Scanned/i)).toBeNull();
      });

      // Snapshot customTextRenderer passed to page 1 after matches land
      const page1RendersAfterSearch = mockState.pageRenderLog.filter((r) => r.pageNumber === 1);
      const rendererAfterSearch = page1RendersAfterSearch[page1RendersAfterSearch.length - 1]!.customTextRenderer;

      // Press Enter with unchanged query -> advances 1 / 4 -> 2 / 4 (does NOT restart!)
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(screen.getByText('2 / 4')).toBeInTheDocument();

      // Click Next in search bar -> advances strictly 2 / 4 -> 3 / 4 (never skips to 4 / 4!)
      const searchBar = document.querySelector('.ds-pdf__search-bar') as HTMLElement;
      expect(searchBar).not.toBeNull();
      fireEvent.click(within(searchBar).getByRole('button', { name: 'Next' }));
      expect(screen.getByText('3 / 4')).toBeInTheDocument();

      // Verify customTextRenderer identity on page 1 NEVER changed during Next/Enter!
      const page1RendersAfterNext = mockState.pageRenderLog.filter((r) => r.pageNumber === 1);
      const rendererAfterNext = page1RendersAfterNext[page1RendersAfterNext.length - 1]!.customTextRenderer;
      expect(rendererAfterNext).toBe(rendererAfterSearch);

      // Verify imperative active mark class switched to ordinal 2 (3rd match on page 1)
      const activeMarks = document.querySelectorAll('mark.ds-search-mark--current');
      expect(activeMarks).toHaveLength(1);
      expect(activeMarks[0]!.getAttribute('data-match-ordinal')).toBe('2');
    });

    it('keeps deep-page target locked against scroll bounce during programmatic jump', async () => {
      mockState.documentBehavior = {
        mode: 'text',
        numPages: 139,
        pageTexts: new Map([[1, 'Title page']]),
        intrinsicRotate: 0,
      };
      const onPageChange = vi.fn();
      let registeredCommands: { jumpToPage: (pageIndex: number) => void } | null = null;

      render(
        <EnhancedPdfViewer
          data={new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x36])}
          fileName="book-139p.pdf"
          resourcePath="/tb_book"
          onPageChange={onPageChange}
          onRegisterCommands={(cmds) => {
            registeredCommands = cmds;
          }}
        />,
      );

      await waitFor(() => {
        expect(registeredCommands).not.toBeNull();
        expect(screen.getByText('/ 139')).toBeInTheDocument();
      });

      // Jump to page 65 (0-based index 64)
      act(() => {
        registeredCommands!.jumpToPage(64);
      });

      expect(mockState.scrollToIndex).toHaveBeenCalledWith(64, { align: 'start' });
      expect(onPageChange).toHaveBeenLastCalledWith(64);

      // Simulate virtualizer height-measurement scroll bounce immediately after jump
      const viewport = screen.getByTestId('pdf-scroll-viewport');
      act(() => {
        fireEvent.scroll(viewport);
      });

      // Programmatic jump lock must prevent handleScroll from overwriting currentPage back to 1
      expect(onPageChange).toHaveBeenLastCalledWith(64);
    });

    it('keeps Batch 1 @container (max-width: 540px) CSS rules intact in enhanced-pdf.css', () => {
      const css = readFileSync(
        resolve(process.cwd(), 'src/features/pdf/styles/enhanced-pdf.css'),
        'utf8',
      );
      expect(css).toContain('@container (max-width: 540px)');
      expect(css).toContain('.ds-pdf__highlight-mode-bar');
    });
  });
});
