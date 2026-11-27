import React from 'react';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enLearningHub from '@/locales/en-US/learningHub.json';

const mocks = vi.hoisted(() => ({
  pptxPreviewFn: vi.fn(),
  pptxDestroyFn: vi.fn(),
  docxRenderAsyncFn: vi.fn(),
  debugWarn: vi.fn(),
}));

function lookupEn(rawKey: string, opts?: Record<string, unknown>): string {
  const key = rawKey.includes(':') ? rawKey.slice(rawKey.indexOf(':') + 1) : rawKey;
  let cursor: unknown = enLearningHub;
  for (const part of key.split('.')) {
    if (cursor && typeof cursor === 'object' && part in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      cursor = undefined;
      break;
    }
  }
  let template = typeof cursor === 'string'
    ? cursor
    : (typeof opts?.defaultValue === 'string' ? opts.defaultValue : rawKey);
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      if (k === 'defaultValue') continue;
      template = template.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
    }
  }
  return template;
}

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => lookupEn(key, opts),
  }),
}));

vi.mock('pptx-preview', () => ({
  init: (container: HTMLElement) => ({
    preview: (buffer: ArrayBuffer) => mocks.pptxPreviewFn(container, buffer),
    destroy: () => mocks.pptxDestroyFn(),
  }),
}));

vi.mock('docx-preview', () => ({
  renderAsync: (
    buffer: ArrayBuffer,
    bodyContainer: HTMLElement,
    styleContainer: HTMLElement | null,
    options?: unknown,
  ) => mocks.docxRenderAsyncFn(buffer, bodyContainer, styleContainer, options),
}));

vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: {
    log: vi.fn(),
    warn: (...args: unknown[]) => mocks.debugWarn(...args),
    error: vi.fn(),
  },
}));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: React.forwardRef(function MockScrollArea(
    {
      children,
      className,
      viewportRef,
    }: {
      children?: React.ReactNode;
      className?: string;
      viewportRef?: React.RefObject<HTMLDivElement>;
    },
    _ref,
  ) {
    return (
      <div className={className} ref={viewportRef}>
        {children}
      </div>
    );
  }),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  BACK_PRIORITY: { overlay: 10 },
  registerBackHandler: () => () => {},
}));

vi.mock('@/shared/selection', () => ({
  useIframeTextSelection: () => null,
}));

vi.mock('@/features/pdf/components/PdfSelectionActions', () => ({
  PdfSelectionActions: () => null,
}));

import { DocxPreview } from '../DocxPreview';
import { PptxPreview } from '../PptxPreview';
import { XlsxPreview } from '../XlsxPreview';
import { XmindPreview } from '../XmindPreview';
import { buildZipManifestFromBytes } from '../archiveManifest';
import EpubPreview from '../EpubPreview';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function createValidZipBase64(entries: Record<string, string | Uint8Array>): Promise<string> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: 'base64' });
}

async function createValidXlsxBase64(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Scores');
  sheet.addRow(['Name', 'Score']);
  sheet.addRow(['Ada', 98]);
  const buffer = await wb.xlsx.writeBuffer();
  return bytesToBase64(new Uint8Array(buffer));
}

async function createMultiChapterEpubWithImagesBase64(): Promise<string> {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`);
  zip.file('OPS/package.opf', `<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>Illustrated Guide</dc:title>
      </metadata>
      <manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
        <item id="img1" href="images/fig1.png" media-type="image/png"/>
        <item id="img2" href="images/fig2.png" media-type="image/png"/>
      </manifest>
      <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
    </package>`);
  zip.file('OPS/nav.xhtml', `<!doctype html><html xmlns:epub="http://www.idpf.org/2007/ops"><body>
    <nav epub:type="toc"><ol>
      <li><a href="text/ch1.xhtml">Chapter One</a></li>
      <li><a href="text/ch2.xhtml">Chapter Two</a></li>
    </ol></nav>
  </body></html>`);
  zip.file('OPS/text/ch1.xhtml', '<html><body><h1>Chapter One</h1><img src="../images/fig1.png" alt="fig1"/></body></html>');
  zip.file('OPS/text/ch2.xhtml', '<html><body><h1>Chapter Two</h1><img src="../images/fig2.png" alt="fig2"/></body></html>');
  zip.file('OPS/images/fig1.png', pngBytes);
  zip.file('OPS/images/fig2.png', pngBytes);
  return zip.generateAsync({ type: 'base64' });
}

describe('G24 PPTX theme background, XLSX truncated guard, and EPUB blob URL lifecycle', () => {
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalScrollTo = HTMLElement.prototype.scrollTo;

  beforeEach(() => {
    vi.clearAllMocks();
    class MockObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.IntersectionObserver = MockObserver as unknown as typeof IntersectionObserver;
    globalThis.ResizeObserver = MockObserver as unknown as typeof ResizeObserver;
    HTMLElement.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    cleanup();
    globalThis.IntersectionObserver = originalIntersectionObserver;
    globalThis.ResizeObserver = originalResizeObserver;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    HTMLElement.prototype.scrollTo = originalScrollTo;
    vi.restoreAllMocks();
  });

  describe('PptxPreview', () => {
    it('preserves dark-blue slide theme background on main canvas without !important white overrides', async () => {
      const validPptxBase64 = await createValidZipBase64({
        '[Content_Types].xml': '<Types/>',
      });

      mocks.pptxPreviewFn.mockImplementationOnce(async (container: HTMLElement) => {
        container.innerHTML = `
          <div class="pptx-preview-wrapper">
            <div class="pptx-preview-slide-wrapper pptx-preview-slide-wrapper-0" style="width:960px;height:540px;position:relative;background:#fff;overflow:hidden">
              <div class="slide-background" style="position:absolute;left:0;top:0;width:100%;height:100%;background:#1b365d"></div>
              <div class="slide-master-wrapper" style="position:absolute;left:0;top:0;width:960px;height:540px"></div>
              <div class="slide-layout-wrapper" style="position:absolute;left:0;top:0;width:960px;height:540px"></div>
              <div class="slide-wrapper" style="position:absolute;left:0;top:0;width:960px;height:540px">
                <p style="color:#ffffff">Dark Theme Title</p>
              </div>
            </div>
          </div>
        `;
      });

      const { container } = render(
        <PptxPreview base64Content={validPptxBase64} fileName="theme-deck.pptx" />,
      );

      await waitFor(() => {
        expect(container.querySelector('.slide-background')).not.toBeNull();
      });

      const slideBg = container.querySelector<HTMLElement>('.slide-background');
      expect(slideBg?.style.background).toMatch(/#1b365d|rgb\(27,\s*54,\s*93\)/i);

      const styleTag = container.querySelector('style')?.textContent ?? '';
      expect(styleTag).not.toContain('background: #ffffff !important');
      expect(styleTag).not.toMatch(/\.slide-wrapper[^}]*background:\s*#ffffff/i);
      expect(styleTag).toContain('.pptx-container .slide-wrapper');
      expect(styleTag).toContain('background: transparent;');
    });

    it('rejects truncated .pptx before invoking pptx-preview with zero console.error', async () => {
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Starts with PK\x03\x04 but truncated before EOCD
      const truncated = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);

      render(<PptxPreview base64Content={bytesToBase64(truncated)} fileName="truncated.pptx" />);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('This file appears truncated or corrupted and cannot be previewed');
      expect(mocks.pptxPreviewFn).not.toHaveBeenCalled();
      expect(consoleErrSpy).not.toHaveBeenCalled();
    });

    it('accepts valid .pptx with benign trailing padding after ZIP EOCD and strips trailing bytes', async () => {
      const validZip = new JSZip();
      validZip.file('[Content_Types].xml', '<Types/>');
      const rawBytes = await validZip.generateAsync({ type: 'uint8array' });
      const paddedBytes = new Uint8Array(rawBytes.length + 1);
      paddedBytes.set(rawBytes, 0);
      paddedBytes[rawBytes.length] = 0x0a; // trailing newline after EOCD

      mocks.pptxPreviewFn.mockImplementationOnce(async (container: HTMLElement, buffer: ArrayBuffer) => {
        expect(buffer.byteLength).toBe(rawBytes.length);
        container.innerHTML = `
          <div class="pptx-preview-wrapper">
            <div class="pptx-preview-slide-wrapper pptx-preview-slide-wrapper-0">
              <div class="slide-wrapper"><p>Lecture 01</p></div>
            </div>
          </div>
        `;
      });

      render(<PptxPreview base64Content={bytesToBase64(paddedBytes)} fileName="lecture.pptx" />);

      await waitFor(() => {
        expect(screen.getByText('Lecture 01')).toBeTruthy();
      });
      expect(mocks.pptxPreviewFn).toHaveBeenCalledTimes(1);
    });

    it('falls back to OOXML slide text extraction when pptx-preview produces an empty slide canvas', async () => {
      const minimalPptxBase64 = await createValidZipBase64({
        '[Content_Types].xml': '<Types/>',
        'ppt/slides/slide1.xml': `<?xml version="1.0" encoding="UTF-8"?>
          <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
            <p:cSld><p:spTree><p:sp><p:txBody>
              <a:p><a:r><a:t>Minimal Deck Title</a:t></a:r></a:p>
              <a:p><a:r><a:t>Key takeaway bullet</a:t></a:r></a:p>
            </p:txBody></p:sp></p:spTree></p:cSld>
          </p:sld>`,
      });

      mocks.pptxPreviewFn.mockImplementationOnce(async (container: HTMLElement) => {
        container.innerHTML = `
          <div class="pptx-preview-wrapper">
            <div class="pptx-preview-slide-wrapper pptx-preview-slide-wrapper-0">
              <div class="slide-wrapper"></div>
            </div>
          </div>
        `;
      });

      render(<PptxPreview base64Content={minimalPptxBase64} fileName="minimal.pptx" />);

      await waitFor(() => {
        expect(screen.getByText('Minimal Deck Title')).toBeTruthy();
        expect(screen.getByText('Key takeaway bullet')).toBeTruthy();
      });
    });
  });

  describe('XlsxPreview', () => {
    it('catches truncated .xlsx before ExcelJS load with friendly error and zero console.error', async () => {
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const validBase64 = await createValidXlsxBase64();
      const rawBinary = atob(validBase64);
      // Cut off the tail so PK\x03\x04 header remains valid while EOCD is missing
      const truncatedBytes = new Uint8Array(Math.floor(rawBinary.length / 2));
      for (let i = 0; i < truncatedBytes.length; i += 1) {
        truncatedBytes[i] = rawBinary.charCodeAt(i);
      }

      render(<XlsxPreview base64Content={bytesToBase64(truncatedBytes)} fileName="truncated.xlsx" />);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('This file appears truncated or corrupted and cannot be previewed');
      expect(alert.textContent).not.toContain("Can't find end of central directory");
      expect(consoleErrSpy).not.toHaveBeenCalled();
    });

    it('handles corrupt ZIP payload inside a structurally complete EOCD archive without console.error or raw stack messages', async () => {
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const validBase64 = await createValidXlsxBase64();
      const rawBinary = atob(validBase64);
      const corruptedBytes = new Uint8Array(rawBinary.length);
      for (let i = 0; i < rawBinary.length; i += 1) {
        corruptedBytes[i] = rawBinary.charCodeAt(i);
      }
      // Keep PK\x03\x04 local header and trailing central directory/EOCD intact,
      // but corrupt the compressed stream inside the first entry so real ExcelJS throws.
      for (let i = 45; i < Math.min(corruptedBytes.length - 250, 200); i += 1) {
        corruptedBytes[i] ^= 0xff;
      }

      render(<XlsxPreview base64Content={bytesToBase64(corruptedBytes)} fileName="bad-stream.xlsx" />);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('This file appears truncated or corrupted and cannot be previewed');
      expect(alert.textContent).not.toContain('invalid');
      expect(consoleErrSpy).not.toHaveBeenCalled();
      expect(mocks.debugWarn).toHaveBeenCalled();
    });

    it('continues to render valid .xlsx workbooks normally', async () => {
      const validBase64 = await createValidXlsxBase64();

      render(<XlsxPreview base64Content={validBase64} fileName="scores.xlsx" />);

      await waitFor(() => {
        expect(screen.getByText('Ada')).toBeTruthy();
        expect(screen.getByText('98')).toBeTruthy();
      });
    });

    it('renders valid .xlsx workbooks with benign trailing newline after ZIP EOCD', async () => {
      const validBase64 = await createValidXlsxBase64();
      const rawBinary = atob(validBase64);
      const padded = new Uint8Array(rawBinary.length + 1);
      for (let i = 0; i < rawBinary.length; i += 1) {
        padded[i] = rawBinary.charCodeAt(i);
      }
      padded[rawBinary.length] = 0x0a;

      render(<XlsxPreview base64Content={bytesToBase64(padded)} fileName="padded-scores.xlsx" />);

      await waitFor(() => {
        expect(screen.getByText('Ada')).toBeTruthy();
        expect(screen.getByText('98')).toBeTruthy();
      });
    });
  });

  describe('XmindPreview', () => {
    it('renders multi-sheet XMind ZEN workbooks with sheet tab switching', async () => {
      const xmindContent = JSON.stringify([
        {
          id: 'sheet-1',
          title: 'Overview',
          rootTopic: {
            id: 'root-1',
            title: 'Course Architecture',
            children: {
              attached: [
                { id: 'c1', title: 'Module A', labels: ['core'] },
                { id: 'c2', title: 'Module B' },
              ],
            },
          },
        },
        {
          id: 'sheet-2',
          title: 'Exam Plan',
          rootTopic: {
            id: 'root-2',
            title: 'Final Review Checklist',
            children: {
              attached: [{ id: 'c3', title: 'Practice Problems' }],
            },
          },
        },
      ]);
      const xmindBase64 = await createValidZipBase64({ 'content.json': xmindContent });

      render(<XmindPreview base64Content={xmindBase64} fileName="syllabus.xmind" />);

      await waitFor(() => {
        expect(screen.getByText('Course Architecture')).toBeTruthy();
        expect(screen.getByText('Module A')).toBeTruthy();
      });

      fireEvent.click(screen.getByRole('tab', { name: 'Exam Plan' }));

      await waitFor(() => {
        expect(screen.getByText('Final Review Checklist')).toBeTruthy();
        expect(screen.getByText('Practice Problems')).toBeTruthy();
      });
    });

    it('shows a friendly error state for corrupted .xmind archives', async () => {
      const corruptBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef]);

      render(<XmindPreview base64Content={bytesToBase64(corruptBytes)} fileName="broken.xmind" />);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBeTruthy();
    });
  });

  describe('EpubPreview', () => {
    it('defers revoking previous chapter blob URLs until the replacement iframe finishes loading and revokes all on unmount', async () => {
      let seq = 0;
      const createdUrls: string[] = [];
      const revokedUrls: string[] = [];
      const timeline: string[] = [];

      URL.createObjectURL = vi.fn(() => {
        const url = `blob:epub-test-${++seq}`;
        createdUrls.push(url);
        timeline.push(`create:${url}:revoked=${revokedUrls.length}`);
        return url;
      });
      URL.revokeObjectURL = vi.fn((url: string) => {
        revokedUrls.push(url);
        timeline.push(`revoke:${url}`);
      });

      const epubBase64 = await createMultiChapterEpubWithImagesBase64();
      const { container, unmount } = render(
        <EpubPreview
          base64Content={epubBase64}
          fileName="guide.epub"
          resourceId="res_epub_blob_test"
        />,
      );

      // Capture-phase load listener fires BEFORE React's iframe onLoad handler.
      const onCaptureLoad = (event: Event) => {
        const target = event.target as HTMLElement | null;
        if (target?.tagName === 'IFRAME') {
          const gen = target.getAttribute('data-frame-generation') ?? '?';
          timeline.push(`iframe-load-enter:gen=${gen}:revoked=${revokedUrls.length}`);
        }
      };
      container.addEventListener('load', onCaptureLoad, true);

      try {
        // Wait for Chapter 1 render & its blob URL creation
        await waitFor(() => {
          expect(createdUrls.length).toBe(1);
          const iframe = container.querySelector<HTMLIFrameElement>('iframe.epub-preview-frame');
          expect(iframe?.getAttribute('srcdoc')).toContain('blob:epub-test-1');
        });
        expect(revokedUrls).toEqual([]);

        // Navigate to Chapter 2 -> creates blob:epub-test-2
        fireEvent.click(screen.getByRole('button', { name: 'Next chapter' }));

        await waitFor(() => {
          expect(createdUrls.length).toBe(2);
          const iframe = container.querySelector<HTMLIFrameElement>('iframe.epub-preview-frame');
          expect(iframe?.getAttribute('srcdoc')).toContain('blob:epub-test-2');
        });

        // If jsdom has not automatically fired load on frame 2 yet, trigger it explicitly.
        const frame2 = container.querySelector<HTMLIFrameElement>('iframe.epub-preview-frame')!;
        if (!revokedUrls.includes('blob:epub-test-1')) {
          fireEvent.load(frame2);
        }

        // Verify exact causal order:
        // 1. Chapter 2 blob URL is created while Chapter 1 blob URL is STILL alive (revoked=0)
        // 2. At the start of Chapter 2 iframe's load event, Chapter 1 blob URL is STILL alive (revoked=0)
        // 3. Chapter 1 blob URL is revoked ONLY inside Chapter 2 iframe's onLoad handler
        expect(timeline).toContain('create:blob:epub-test-2:revoked=0');
        expect(timeline).toContain('iframe-load-enter:gen=2:revoked=0');
        expect(timeline.indexOf('iframe-load-enter:gen=2:revoked=0')).toBeLessThan(
          timeline.indexOf('revoke:blob:epub-test-1'),
        );
        expect(revokedUrls).toEqual(['blob:epub-test-1']);

        // On unmount, remaining active blob URL is cleanly revoked
        unmount();
        expect(revokedUrls).toEqual(['blob:epub-test-1', 'blob:epub-test-2']);
      } finally {
        container.removeEventListener('load', onCaptureLoad, true);
      }
    });

    it('rejects truncated .epub archives with localized friendly error message', async () => {
      const truncated = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
      render(
        <EpubPreview
          base64Content={bytesToBase64(truncated)}
          fileName="broken.epub"
          resourceId="res_epub_truncated"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText(/This file appears truncated or corrupted and cannot be previewed/)).toBeTruthy();
      });
    });
  });

  describe('DocxPreview', () => {
    it('rejects truncated .docx before invoking docx-preview with zero console.error', async () => {
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const truncated = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);

      render(<DocxPreview base64Content={bytesToBase64(truncated)} fileName="truncated.docx" />);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('This file appears truncated or corrupted and cannot be previewed');
      expect(mocks.docxRenderAsyncFn).not.toHaveBeenCalled();
      expect(consoleErrSpy).not.toHaveBeenCalled();
    });

    it('accepts valid .docx with benign trailing newline after ZIP EOCD and strips trailing bytes', async () => {
      const zip = new JSZip();
      zip.file('[Content_Types].xml', '<Types/>');
      const rawBytes = await zip.generateAsync({ type: 'uint8array' });
      const paddedBytes = new Uint8Array(rawBytes.length + 1);
      paddedBytes.set(rawBytes, 0);
      paddedBytes[rawBytes.length] = 0x0a;

      mocks.docxRenderAsyncFn.mockImplementationOnce(
        async (buffer: ArrayBuffer, bodyContainer: HTMLElement) => {
          expect(buffer.byteLength).toBe(rawBytes.length);
          bodyContainer.innerHTML = '<div class="docx-preview-wrapper"><section class="docx-preview"><p>Report Ready</p></section></div>';
        },
      );

      render(<DocxPreview base64Content={bytesToBase64(paddedBytes)} fileName="padded.docx" />);

      await waitFor(() => {
        expect(screen.getByText('Report Ready')).toBeTruthy();
      });
      expect(mocks.docxRenderAsyncFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('buildZipManifestFromBytes', () => {
    it('lists sorted entries and sizes for a valid ZIP (even with trailing newline) and returns null for truncated ZIP', async () => {
      const zip = new JSZip();
      zip.file('notes/b.md', 'hello world');
      zip.file('a.txt', 'abc');
      const rawBytes = await zip.generateAsync({ type: 'uint8array' });
      const padded = new Uint8Array(rawBytes.length + 1);
      padded.set(rawBytes, 0);
      padded[rawBytes.length] = 0x0a;

      const manifest = await buildZipManifestFromBytes(padded.buffer, 'bundle.zip');
      expect(manifest).toContain('bundle.zip (2 files');
      expect(manifest).toContain('a.txt');
      expect(manifest).toContain('notes/b.md');
      expect(manifest!.indexOf('a.txt')).toBeLessThan(manifest!.indexOf('notes/b.md'));

      const truncated = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad]);
      expect(await buildZipManifestFromBytes(truncated.buffer, 'broken.zip')).toBeNull();
    });
  });
});
