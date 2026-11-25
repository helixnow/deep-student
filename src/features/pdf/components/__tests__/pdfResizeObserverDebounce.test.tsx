/**
 * SOTA03 P0 regression tests: debounced ResizeObserver in EnhancedPdfViewer.
 *
 * Verifies against the real exported `observeDebouncedResize` helper AND a real
 * mounted `<EnhancedPdfViewer>` instance:
 *   (a) Rapid intermediate resize events fired during CSS tiling transitions do
 *       NOT trigger intermediate containerWidth updates / `<Page>` re-renders.
 *   (b) After `PDF_RESIZE_DEBOUNCE_MS` elapses, the final settled size triggers
 *       exactly ONE update / `<Page>` re-render.
 *   (c) Unmount / cleanup cancels any pending debounce timer and disconnects
 *       the ResizeObserver without firing late callbacks.
 */

import React, { useEffect, useRef } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { renderedPageWidths, triggerSourceErrorRef } = vi.hoisted(() => ({
  renderedPageWidths: [] as number[],
  triggerSourceErrorRef: { current: null as Error | null },
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
      i18n: { language: 'en-US' },
    }),
  };
});

vi.mock('react-pdf', () => ({
  Document: ({
    children,
    onLoadSuccess,
    onSourceError,
  }: {
    children?: React.ReactNode;
    onLoadSuccess?: (doc: {
      numPages: number;
      getPage: (n: number) => Promise<{
        getViewport: () => { width: number; height: number };
        getTextContent: () => Promise<{ items: Array<{ str: string }> }>;
      }>;
      getOutline: () => Promise<unknown[]>;
      destroy: () => void;
    }) => void;
    onSourceError?: (err: Error) => void;
  }) => {
    const firedRef = useRef(false);
    useEffect(() => {
      if (firedRef.current) return;
      firedRef.current = true;
      if (triggerSourceErrorRef.current) {
        onSourceError?.(triggerSourceErrorRef.current);
        return;
      }
      onLoadSuccess?.({
        numPages: 1,
        getPage: async () => ({
          getViewport: () => ({ width: 612, height: 792 }),
          getTextContent: async () => ({ items: [{ str: 'sample text' }] }),
        }),
        getOutline: async () => [],
        destroy: () => {},
      });
    }, [onLoadSuccess, onSourceError]);
    return <div data-testid="mock-pdf-document">{children}</div>;
  },
  Page: ({ width, pageNumber }: { width?: number; pageNumber?: number }) => {
    if (typeof width === 'number') {
      renderedPageWidths.push(width);
    }
    return <div data-testid={`mock-pdf-page-${pageNumber ?? 1}`} data-width={width} />;
  },
  Thumbnail: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' }, version: '4.0.0' },
  PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 },
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      count > 0 ? [{ key: 0, index: 0, start: 0, size: 800, end: 800, lane: 0 }] : [],
    getVirtualItemForOffset: () =>
      count > 0 ? { key: 0, index: 0, start: 0, size: 800, end: 800, lane: 0 } : undefined,
    getTotalSize: () => count * 800,
    measure: () => {},
    measureElement: () => {},
    scrollToIndex: () => {},
    scrollToOffset: () => {},
  }),
}));

import {
  EnhancedPdfViewer,
  PDF_RESIZE_DEBOUNCE_MS,
  observeDebouncedResize,
} from '../EnhancedPdfViewer';

interface MockResizeObserverRecord {
  target: Element | null;
  callback: ResizeObserverCallback;
  disconnected: boolean;
  trigger: (width: number, height?: number) => void;
}

function installMockResizeObserver() {
  const instances: MockResizeObserverRecord[] = [];
  class MockResizeObserver implements ResizeObserver {
    private record: MockResizeObserverRecord;

    constructor(callback: ResizeObserverCallback) {
      this.record = {
        target: null,
        callback,
        disconnected: false,
        trigger: (width: number, height = 800) => {
          if (this.record.disconnected || !this.record.target) return;
          const entry = {
            target: this.record.target,
            contentRect: {
              width,
              height,
              x: 0,
              y: 0,
              top: 0,
              left: 0,
              bottom: height,
              right: width,
              toJSON: () => ({}),
            } as DOMRectReadOnly,
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          } as ResizeObserverEntry;
          this.record.callback([entry], this);
        },
      };
      instances.push(this.record);
    }

    observe(target: Element) {
      this.record.target = target;
    }

    unobserve() {}

    disconnect() {
      this.record.disconnected = true;
    }
  }

  const original = globalThis.ResizeObserver;
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: MockResizeObserver,
  });

  return {
    instances,
    restore: () => {
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        writable: true,
        value: original,
      });
    },
  };
}

const viewerSource = readFileSync(
  resolve(process.cwd(), 'src/features/pdf/components/EnhancedPdfViewer.tsx'),
  'utf8',
);

describe('EnhancedPdfViewer — debounced ResizeObserver (SOTA03 P0)', () => {
  let restoreResizeObserver: (() => void) | null = null;

  beforeEach(() => {
    renderedPageWidths.length = 0;
    triggerSourceErrorRef.current = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    restoreResizeObserver?.();
    restoreResizeObserver = null;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('wires both container and toolbar ResizeObservers through observeDebouncedResize', () => {
    expect(PDF_RESIZE_DEBOUNCE_MS).toBeGreaterThanOrEqual(100);
    expect(PDF_RESIZE_DEBOUNCE_MS).toBeLessThanOrEqual(150);
    expect(viewerSource).toContain('observeDebouncedResize(container');
    expect(viewerSource).not.toContain('new ResizeObserver(updateSize)');
  });

  it('(a) observeDebouncedResize does NOT fire on rapid intermediate sizes before debounce settles', () => {
    const mock = installMockResizeObserver();
    restoreResizeObserver = mock.restore;

    const el = document.createElement('div');
    const onResize = vi.fn();
    const stop = observeDebouncedResize(el, onResize);

    expect(mock.instances).toHaveLength(1);
    const observer = mock.instances[0];

    // Simulate CSS tiling transition firing intermediate frames
    observer.trigger(960);
    vi.advanceTimersByTime(16);
    observer.trigger(840);
    vi.advanceTimersByTime(16);
    observer.trigger(720);
    vi.advanceTimersByTime(16);
    observer.trigger(600);

    // Just before the trailing debounce window expires: still zero calls
    vi.advanceTimersByTime(PDF_RESIZE_DEBOUNCE_MS - 1);
    expect(onResize).not.toHaveBeenCalled();

    stop();
  });

  it('(b) observeDebouncedResize fires exactly once with the final settled size', () => {
    const mock = installMockResizeObserver();
    restoreResizeObserver = mock.restore;

    const el = document.createElement('div');
    const onResize = vi.fn();
    const stop = observeDebouncedResize(el, onResize);
    const observer = mock.instances[0];

    observer.trigger(1000);
    vi.advanceTimersByTime(20);
    observer.trigger(850);
    vi.advanceTimersByTime(20);
    observer.trigger(700);
    vi.advanceTimersByTime(20);
    observer.trigger(560);

    vi.advanceTimersByTime(PDF_RESIZE_DEBOUNCE_MS);

    expect(onResize).toHaveBeenCalledTimes(1);
    const entries = onResize.mock.calls[0][0] as ResizeObserverEntry[];
    expect(entries[0].contentRect.width).toBe(560);

    stop();
  });

  it('cleanup cancels a pending debounced resize and disconnects the observer', () => {
    const mock = installMockResizeObserver();
    restoreResizeObserver = mock.restore;

    const el = document.createElement('div');
    const onResize = vi.fn();
    const stop = observeDebouncedResize(el, onResize);
    const observer = mock.instances[0];

    observer.trigger(512);
    stop();

    expect(observer.disconnected).toBe(true);
    vi.advanceTimersByTime(PDF_RESIZE_DEBOUNCE_MS * 2);
    expect(onResize).not.toHaveBeenCalled();
  });

  it('handles missing global ResizeObserver gracefully without throwing', () => {
    const original = globalThis.ResizeObserver;
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    restoreResizeObserver = () => {
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        writable: true,
        value: original,
      });
    };

    const el = document.createElement('div');
    const stop = observeDebouncedResize(el, vi.fn());
    expect(() => stop()).not.toThrow();
  });

  it('mounted EnhancedPdfViewer ignores intermediate resize widths and re-renders Page once on settled width', async () => {
    const mock = installMockResizeObserver();
    restoreResizeObserver = mock.restore;

    let currentViewportWidth = 1000;
    const { container } = render(
      <EnhancedPdfViewer url="https://example.test/sample.pdf" fileName="sample.pdf" />,
    );

    const viewport = container.querySelector('.ds-pdf__content-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    Object.defineProperty(viewport!, 'clientWidth', {
      configurable: true,
      get: () => currentViewportWidth,
    });
    Object.defineProperty(viewport!, 'clientHeight', {
      configurable: true,
      get: () => 800,
    });

    const viewportObserver = mock.instances.find((inst) => inst.target === viewport);
    expect(viewportObserver).toBeDefined();

    // Settle initial mount width = 1000
    act(() => {
      viewportObserver!.trigger(1000, 800);
      vi.advanceTimersByTime(PDF_RESIZE_DEBOUNCE_MS);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Clear initial mount renders so we strictly measure the tiling transition
    renderedPageWidths.length = 0;

    // Simulate tiling transition: 5 intermediate widths 16ms apart, settling at 520
    const transitionWidths = [920, 820, 720, 620, 520];
    act(() => {
      for (const width of transitionWidths) {
        currentViewportWidth = width;
        viewportObserver!.trigger(width, 800);
        vi.advanceTimersByTime(16);
      }
      // Advance to 1ms before trailing debounce fires
      vi.advanceTimersByTime(PDF_RESIZE_DEBOUNCE_MS - 17);
    });

    // (a) No intermediate widths triggered a Page re-render
    expect(renderedPageWidths).toEqual([]);

    // (b) Final 1ms completes debounce → exactly 1 settled Page width update (520)
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(renderedPageWidths).toEqual([520]);
  });

  it('surfaces corrupt/source PDF errors via Document onSourceError (#216/#220)', () => {
    const mock = installMockResizeObserver();
    restoreResizeObserver = mock.restore;

    expect(viewerSource).toContain('onSourceError={handleDocumentLoadError}');
    triggerSourceErrorRef.current = new Error('Invalid PDF structure');

    const { container } = render(
      <EnhancedPdfViewer url="https://example.test/corrupt.pdf" fileName="corrupt.pdf" />,
    );

    expect(container.querySelector('.ds-pdf__error')).not.toBeNull();
  });
});
