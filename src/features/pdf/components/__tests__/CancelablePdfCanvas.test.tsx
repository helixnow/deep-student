import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';
import {
  CancelablePdfCanvas,
  type CancelablePdfCanvasPageContext,
} from '../CancelablePdfCanvas';
import {
  LARGE_FORMAT_MAX_CANVAS_EDGE_PX,
  LARGE_FORMAT_MAX_CANVAS_PIXELS,
} from '../../pdfViewportEnhance';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

interface DeferredRenderTask {
  task: RenderTask;
  cancel: ReturnType<typeof vi.fn>;
  resolve: () => void;
  reject: (err: Error) => void;
  params: Parameters<PDFPageProxy['render']>[0];
}

function createMockPage(widthPt: number, heightPt: number) {
  const tasks: DeferredRenderTask[] = [];
  let inFlight = 0;
  let maxConcurrent = 0;

  const page = {
    pageNumber: 1,
    getViewport: ({ scale, rotation = 0 }: { scale: number; rotation?: number }) => {
      const swapped = rotation % 180 !== 0;
      return {
        width: (swapped ? heightPt : widthPt) * scale,
        height: (swapped ? widthPt : heightPt) * scale,
        scale,
        rotation,
      };
    },
    render: vi.fn((params: Parameters<PDFPageProxy['render']>[0]) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      let resolveFn!: () => void;
      let rejectFn!: (err: Error) => void;
      let settled = false;
      const promise = new Promise<void>((res, rej) => {
        resolveFn = () => {
          if (settled) return;
          settled = true;
          inFlight -= 1;
          res();
        };
        rejectFn = (err: Error) => {
          if (settled) return;
          settled = true;
          inFlight -= 1;
          rej(err);
        };
      });
      const cancel = vi.fn(() => {
        const err = new Error('Rendering cancelled');
        err.name = 'RenderingCancelledException';
        // Simulate asynchronous PDF.js cancellation settling on a microtask
        queueMicrotask(() => rejectFn(err));
      });
      const task = { promise, cancel } as unknown as RenderTask;
      const entry: DeferredRenderTask = {
        task,
        cancel,
        resolve: resolveFn,
        reject: rejectFn,
        params,
      };
      tasks.push(entry);
      return task;
    }),
  } as unknown as PDFPageProxy;

  return {
    page,
    tasks,
    getMaxConcurrent: () => maxConcurrent,
  };
}

function makePageContext(
  page: PDFPageProxy,
  overrides: Partial<CancelablePdfCanvasPageContext> = {},
): CancelablePdfCanvasPageContext {
  return {
    _className: 'react-pdf__Page',
    devicePixelRatio: 2,
    page,
    pageNumber: 1,
    rotate: 0,
    scale: 1,
    ...overrides,
  };
}

describe('CancelablePdfCanvas heavy vector / CAD lifecycle', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    vi.useFakeTimers();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      fillRect: vi.fn(),
      clearRect: vi.fn(),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    vi.useRealTimers();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it('cancels stale renderTask on zoom/page change without overlapping renders or stuck spinners', async () => {
    const mock = createMockPage(600, 800);
    const onRenderSuccess = vi.fn();
    const { rerender, unmount } = render(
      <CancelablePdfCanvas
        pageContext={makePageContext(mock.page, { scale: 1, onRenderSuccess })}
        slowRenderDelayMs={300}
      />,
    );

    // Flush startRender microtask
    await act(async () => {
      await Promise.resolve();
    });
    expect(mock.tasks).toHaveLength(1);
    expect(screen.queryByRole('status')).toBeNull();

    // After slowRenderDelayMs, non-blocking slow-page indicator appears
    act(() => {
      vi.advanceTimersByTime(320);
    });
    expect(screen.getByRole('status')).toHaveTextContent('正在渲染复杂页面…');

    // Rapid zoom change (1.0 -> 1.5 -> 2.0): previous task must be cancelled immediately
    // and intermediate stale zoom (1.5) must not overlap on the canvas
    rerender(
      <CancelablePdfCanvas
        pageContext={makePageContext(mock.page, { scale: 1.5, onRenderSuccess })}
        slowRenderDelayMs={300}
      />,
    );
    rerender(
      <CancelablePdfCanvas
        pageContext={makePageContext(mock.page, { scale: 2.0, onRenderSuccess })}
        slowRenderDelayMs={300}
      />,
    );

    expect(mock.tasks[0]!.cancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Only the latest render (scale=2.0) runs after task 0 settled — never overlapping!
    expect(mock.getMaxConcurrent()).toBe(1);
    const latestTask = mock.tasks[mock.tasks.length - 1]!;
    expect(latestTask.params.viewport.width).toBeGreaterThan(600);

    // Finish latest render -> spinner clears and onRenderSuccess fires once
    await act(async () => {
      latestTask.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(onRenderSuccess).toHaveBeenCalledTimes(1);

    // Start another slow render and unmount -> must cancel active task & release canvas
    const mockPage2 = createMockPage(600, 800);
    rerender(
      <CancelablePdfCanvas
        pageContext={makePageContext(mockPage2.page, { scale: 1, pageNumber: 2 })}
        slowRenderDelayMs={300}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockPage2.tasks).toHaveLength(1);

    const canvas = document.querySelector('canvas.react-pdf__Page__canvas') as HTMLCanvasElement;
    expect(canvas).not.toBeNull();
    unmount();
    expect(mockPage2.tasks[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it('clears the loading overlay cleanly when page.render() rejects with a real error', async () => {
    const mock = createMockPage(600, 800);
    const onRenderError = vi.fn();
    render(
      <CancelablePdfCanvas
        pageContext={makePageContext(mock.page, { onRenderError })}
        slowRenderDelayMs={200}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByRole('status')).toBeInTheDocument();

    await act(async () => {
      mock.tasks[0]!.reject(new Error('Corrupt operator stream'));
      await Promise.resolve();
    });

    expect(screen.queryByRole('status')).toBeNull();
    expect(onRenderError).toHaveBeenCalledTimes(1);
  });

  it('caps rendered canvas pixel dimensions on massive A1 CAD blueprints at high zoom', async () => {
    // A1 landscape blueprint: 2384 x 1684 pt, zoomed so viewport is ~2860 x 2020 CSS px
    const mock = createMockPage(2384, 1684);
    render(
      <CancelablePdfCanvas
        pageContext={makePageContext(mock.page, { scale: 1.2, devicePixelRatio: 2 })}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(mock.tasks).toHaveLength(1);
    const canvas = document.querySelector('canvas.react-pdf__Page__canvas') as HTMLCanvasElement;
    expect(canvas.width).toBeLessThanOrEqual(LARGE_FORMAT_MAX_CANVAS_EDGE_PX);
    expect(canvas.height).toBeLessThanOrEqual(LARGE_FORMAT_MAX_CANVAS_EDGE_PX);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(LARGE_FORMAT_MAX_CANVAS_PIXELS);
  });
});

describe('EnhancedPdfViewer narrow 420–560px split-window container CSS contract', () => {
  const cssSource = readFileSync(
    resolve(process.cwd(), 'src/features/pdf/styles/enhanced-pdf.css'),
    'utf8',
  );

  it('defines dedicated @container rules at 560px and 440px for split-window responsiveness', () => {
    expect(cssSource).toContain('@container (max-width: 560px)');
    expect(cssSource).toContain('@container (max-width: 440px)');
    expect(cssSource).toContain('max-width: calc(100cqi - 16px)');
    expect(cssSource).toContain('.ds-pdf__page-rendering-badge');
  });

  it('preserves 44px touch targets in @media (pointer: coarse) after narrow container rules', () => {
    const idx440 = cssSource.indexOf('@container (max-width: 440px)');
    const coarseAfter = cssSource.indexOf('@media (pointer: coarse)', idx440);
    expect(idx440).toBeGreaterThan(-1);
    expect(coarseAfter).toBeGreaterThan(idx440);
    const coarseTail = cssSource.slice(coarseAfter);
    expect(coarseTail).toContain('height: 44px;');
  });
});
