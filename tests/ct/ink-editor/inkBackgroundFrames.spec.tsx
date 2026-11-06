import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { Locator, Page } from '@playwright/test';
import type { InkPage } from '@/features/ink/types';
import { InkEditorHarness } from './InkEditorHarness';
import { inkEditorDocumentId, inkEditorPageId, type InkEditorBackend } from './fixtures';

type Rgba = [number, number, number, number];
type CreateImageBitmapLike = (source: ImageBitmapSource, options?: ImageBitmapOptions) => Promise<ImageBitmap>;

interface FrameProbeState {
  frames: number;
  whiteFrames: number;
  whiteAt: number[];
  running: boolean;
}

interface BitmapProbeState {
  created: number;
  closed: number;
  doubleClose: number;
  drawAfterClose: number;
  open: number;
  wrapFailures: number;
}

interface DiagnosticsApi {
  isInkDiagnosticsEnabled(): boolean;
  setInkDiagnosticsEnabled(enabled: boolean): void;
  getInkDiagnosticsSnapshot(): {
    retainedCount: number;
    capacity: number;
    dropped: number;
    records: ReadonlyArray<{ event: string; data?: Record<string, unknown> }>;
  };
  clearInkDiagnostics(): void;
}

type FixtureWindow = Window & {
  __INK_EDITOR_CT_BACKEND__?: InkEditorBackend;
  __INK_EDITOR_EMIT_CHANGED__?: (documentId: string, revision: string) => Promise<void>;
  __INK_CT_FRAME_PROBE__?: FrameProbeState;
  __INK_CT_DECODE_CALLS__?: number;
  __INK_CT_DECODE_WRAPPER_INSTALLED__?: boolean;
  __INK_CT_ORIGINAL_CREATE_IMAGE_BITMAP__?: CreateImageBitmapLike;
  __INK_CT_BITMAP_PROBE__?: BitmapProbeState;
  __INK_CT_CLOSED_BITMAPS__?: WeakSet<object>;
  __INK_DIAGNOSTICS_API__?: DiagnosticsApi;
};

const IMAGE_RED: Rgba = [255, 0, 0, 255];
const PDF_GRAY: Rgba = [221, 221, 221, 255];
const PDF_HIGHLIGHT_BLUE: Rgba = [110, 110, 221, 255];
const PDF_HIGHLIGHT_GREEN: Rgba = [110, 221, 110, 255];
const BLANK_WHITE: Rgba = [255, 255, 255, 255];

const SOURCE_BLUE_HIGHLIGHT = {
  id: 'pdf-highlight-left',
  pageIndex: 0,
  color: '#0000ff80',
  rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.3 }],
  createdAt: 42,
  coordVersion: 2,
};

const SOURCE_GREEN_HIGHLIGHT = {
  id: 'pdf-highlight-right',
  pageIndex: 0,
  color: '#00ff0080',
  rects: [{ x: 0.6, y: 0.1, width: 0.3, height: 0.3 }],
  createdAt: 43,
  coordVersion: 2,
};

async function drawStroke(page: Page, canvas: Locator, localY = 72) {
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Ink page input canvas has no visible bounds');
  await page.mouse.move(bounds.x + 18, bounds.y + localY);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 48, bounds.y + localY, { steps: 4 });
  await page.mouse.move(bounds.x + 96, bounds.y + localY, { steps: 4 });
  await page.mouse.up();
}

async function readPixel(canvas: Locator, x: number, y: number): Promise<number[]> {
  return canvas.evaluate((element, point) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    return Array.from(context.getImageData(point.x, point.y, 1, 1).data);
  }, { x, y });
}

async function readFixturePage(page: Page, pageId = inkEditorPageId): Promise<InkPage | undefined> {
  return page.evaluate(({ documentId, pageId }) => {
    const backend = (window as FixtureWindow).__INK_EDITOR_CT_BACKEND__;
    if (!backend || documentId !== 'ink-editor-ct-document') return undefined;
    return backend.readPage(pageId);
  }, { documentId: inkEditorDocumentId, pageId });
}

/** Replaces source annotations, advances the remote page, then emits `ink:changed`. */
async function applySourceHighlights(page: Page, highlights: Array<Record<string, unknown>>) {
  await page.evaluate(async ({ documentId, nextHighlights }) => {
    const fixtureWindow = window as FixtureWindow;
    const backend = fixtureWindow.__INK_EDITOR_CT_BACKEND__;
    if (!backend || !fixtureWindow.__INK_EDITOR_EMIT_CHANGED__) {
      throw new Error('Ink changed fixture is unavailable');
    }
    const current = backend.readPage('ink-editor-ct-page-2');
    if (!current) throw new Error('Fixture page is missing');
    backend.updateSourceHighlights(nextHighlights);
    backend.advanceRemotePage('ink-editor-ct-page-2', current);
    await fixtureWindow.__INK_EDITOR_EMIT_CHANGED__(documentId, backend.readManifest().revision);
  }, { documentId: inkEditorDocumentId, nextHighlights: highlights });
}

async function readBackend(page: Page) {
  return page.evaluate(() => {
    const backend = (window as FixtureWindow).__INK_EDITOR_CT_BACKEND__;
    if (!backend) throw new Error('Ink CT backend is unavailable');
    return {
      saveCalls: backend.saveCalls,
      pendingSaveCalls: backend.pendingSaveCalls,
      backgroundReadCalls: backend.backgroundReadCalls,
      pendingBackgroundReads: backend.pendingBackgroundReads,
      frozenInputReadCalls: backend.frozenInputReadCalls,
      pendingFrozenInputReads: backend.pendingFrozenInputReads,
      revision: backend.readManifest().revision,
    };
  });
}

async function waitForFrames(page: Page, frames: number) {
  await page.evaluate((count) => new Promise<void>((resolve) => {
    let seen = 0;
    const tick = () => {
      seen += 1;
      if (seen >= count) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), frames);
}

/**
 * Samples the real page canvas once per animation frame. A frame counts as a
 * flash only when every background-only probe point is pure opaque white,
 * which is exactly what the canvas paints when its background prop is cleared.
 */
async function startFrameProbe(
  page: Page,
  options: { points: Array<[number, number]>; pageWidth: number; pageHeight: number; pageId?: string },
) {
  await page.evaluate(({ points, pageWidth, pageHeight, pageId }) => {
    const state: FrameProbeState = { frames: 0, whiteFrames: 0, whiteAt: [], running: true };
    (window as FixtureWindow).__INK_CT_FRAME_PROBE__ = state;
    const sample = () => {
      if (!state.running) return;
      const canvas = document.querySelector('[data-testid="ink-page-canvas"]') as HTMLCanvasElement | null;
      const context = canvas?.getContext('2d');
      if (canvas?.isConnected && context && canvas.width > 0 && canvas.height > 0
        && (!pageId || canvas.dataset.pageId === pageId)) {
        state.frames += 1;
        const scaleX = canvas.width / pageWidth;
        const scaleY = canvas.height / pageHeight;
        const allWhite = points.every(([x, y]) => {
          const pixelX = Math.min(canvas.width - 1, Math.max(0, Math.round(x * scaleX)));
          const pixelY = Math.min(canvas.height - 1, Math.max(0, Math.round(y * scaleY)));
          const [red, green, blue, alpha] = context.getImageData(pixelX, pixelY, 1, 1).data;
          return red >= 250 && green >= 250 && blue >= 250 && alpha === 255;
        });
        if (allWhite) {
          state.whiteFrames += 1;
          if (state.whiteAt.length < 20) state.whiteAt.push(Math.round(performance.now()));
        }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, options);
}

async function readFrameProbe(page: Page): Promise<FrameProbeState> {
  return page.evaluate(() => {
    const state = (window as FixtureWindow).__INK_CT_FRAME_PROBE__;
    if (!state) throw new Error('Frame probe is not running');
    return { ...state, whiteAt: [...state.whiteAt] };
  });
}

async function stopFrameProbe(page: Page): Promise<FrameProbeState> {
  return page.evaluate(() => {
    const state = (window as FixtureWindow).__INK_CT_FRAME_PROBE__;
    if (!state) throw new Error('Frame probe is not running');
    state.running = false;
    return { ...state, whiteAt: [...state.whiteAt] };
  });
}

async function beginBitmapDecodeCounting(page: Page) {
  await page.evaluate(() => {
    const target = window as FixtureWindow;
    target.__INK_CT_DECODE_CALLS__ = 0;
    if (target.__INK_CT_DECODE_WRAPPER_INSTALLED__) return;
    target.__INK_CT_DECODE_WRAPPER_INSTALLED__ = true;
    const original = window.createImageBitmap as CreateImageBitmapLike;
    target.__INK_CT_ORIGINAL_CREATE_IMAGE_BITMAP__ = original;
    window.createImageBitmap = ((...args: Parameters<CreateImageBitmapLike>) => {
      target.__INK_CT_DECODE_CALLS__ = (target.__INK_CT_DECODE_CALLS__ ?? 0) + 1;
      return original(...args);
    }) as typeof window.createImageBitmap;
  });
}

async function readBitmapDecodeCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as FixtureWindow).__INK_CT_DECODE_CALLS__ ?? 0);
}

/**
 * Tracks every ImageBitmap created by the production loader and records
 * `close()` and any canvas draw that happens after a close. This observes the
 * real lease lifetime instead of relying on private editor state.
 */
async function beginBitmapTracking(page: Page) {
  await page.evaluate(() => {
    const target = window as FixtureWindow;
    if (target.__INK_CT_BITMAP_PROBE__) return;
    const state: BitmapProbeState = {
      created: 0,
      closed: 0,
      doubleClose: 0,
      drawAfterClose: 0,
      open: 0,
      wrapFailures: 0,
    };
    target.__INK_CT_BITMAP_PROBE__ = state;
    const closedBitmaps = new WeakSet<object>();
    target.__INK_CT_CLOSED_BITMAPS__ = closedBitmaps;

    const originalCreate = window.createImageBitmap.bind(window) as CreateImageBitmapLike;
    window.createImageBitmap = (async (...args: Parameters<CreateImageBitmapLike>) => {
      const bitmap = await originalCreate(...args);
      state.created += 1;
      state.open += 1;
      return bitmap;
    }) as typeof window.createImageBitmap;

    const prototype = ImageBitmap.prototype as unknown as {
      close: () => void;
      __inkProbeClose?: boolean;
    };
    if (!prototype.__inkProbeClose) {
      prototype.__inkProbeClose = true;
      const originalClose = prototype.close;
      prototype.close = function patchedClose(this: ImageBitmap) {
        try {
          if (closedBitmaps.has(this)) {
            state.doubleClose += 1;
          } else {
            closedBitmaps.add(this);
            state.closed += 1;
            state.open -= 1;
          }
        } catch {
          state.wrapFailures += 1;
        }
        return originalClose.call(this);
      };
    }

    const contextPrototype = CanvasRenderingContext2D.prototype as unknown as {
      drawImage: (...args: unknown[]) => void;
      __inkProbeDrawImage?: boolean;
    };
    if (!contextPrototype.__inkProbeDrawImage) {
      contextPrototype.__inkProbeDrawImage = true;
      const originalDrawImage = contextPrototype.drawImage;
      contextPrototype.drawImage = function patchedDrawImage(this: CanvasRenderingContext2D, ...args: unknown[]) {
        const source = args[0];
        if (source && typeof source === 'object' && closedBitmaps.has(source)) {
          state.drawAfterClose += 1;
        }
        return originalDrawImage.apply(this, args);
      };
    }
  });
}

async function readBitmapProbe(page: Page): Promise<BitmapProbeState> {
  return page.evaluate(() => {
    const state = (window as FixtureWindow).__INK_CT_BITMAP_PROBE__;
    if (!state) throw new Error('Bitmap probe is not running');
    return { ...state };
  });
}

async function waitForBackgroundActivity(page: Page, previousReadCalls: number): Promise<boolean> {
  return page.waitForFunction((reads) => {
    const backend = (window as FixtureWindow).__INK_EDITOR_CT_BACKEND__;
    return Boolean(backend && (backend.pendingBackgroundReads > 0 || backend.backgroundReadCalls > reads));
  }, previousReadCalls, { timeout: 2000 }).then(() => true).catch(() => false);
}

async function waitForFrozenInputActivity(page: Page, previousReadCalls: number): Promise<boolean> {
  return page.waitForFunction((reads) => {
    const backend = (window as FixtureWindow).__INK_EDITOR_CT_BACKEND__;
    return Boolean(backend && (backend.pendingFrozenInputReads > 0 || backend.frozenInputReadCalls > reads));
  }, previousReadCalls, { timeout: 2000 }).then(() => true).catch(() => false);
}

async function releaseHeldBackgroundReads(page: Page): Promise<number> {
  return page.evaluate(() => (window as FixtureWindow).__INK_EDITOR_CT_BACKEND__?.releaseHeldBackgroundReads() ?? 0);
}

async function setSaveDialogPath(page: Page, path: string | null): Promise<void> {
  await page.evaluate((nextPath) => {
    (window as FixtureWindow).__INK_EDITOR_CT_BACKEND__?.setSaveDialogPath(nextPath);
  }, path);
}

async function readSavedTextFiles(page: Page): Promise<Array<{ path?: string; content?: string }>> {
  return page.evaluate(() => (window as FixtureWindow).__INK_EDITOR_CT_BACKEND__?.readSavedTextFiles() ?? []);
}

async function readDiagnostics(page: Page) {
  return page.evaluate(() => {
    const diagnostics = (window as FixtureWindow).__INK_DIAGNOSTICS_API__;
    if (!diagnostics) throw new Error('Diagnostics API is unavailable');
    const snapshot = diagnostics.getInkDiagnosticsSnapshot();
    return {
      enabled: diagnostics.isInkDiagnosticsEnabled(),
      retainedCount: snapshot.retainedCount,
      capacity: snapshot.capacity,
      dropped: snapshot.dropped,
      records: snapshot.records.map((record) => ({
        event: record.event,
        data: record.data,
      })),
    };
  });
}

test('image background stays painted on every animation frame across multi-stroke saves and undo/redo without re-decoding', async ({ mount, page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const component = await mount(<InkEditorHarness saveMode="success" imageBackground />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  const saveState = component.getByTestId('ink-editor-save-state');
  await expect(canvas).toBeVisible();
  await expect.poll(() => readPixel(canvas, 5, 5)).toEqual(IMAGE_RED);

  const before = await readBackend(page);
  await beginBitmapDecodeCounting(page);
  await startFrameProbe(page, { points: [[5, 5], [110, 150]], pageWidth: 120, pageHeight: 160, pageId: inkEditorPageId });
  await page.evaluate(() => (window as FixtureWindow).__INK_EDITOR_CT_BACKEND__?.holdBackgroundReads(true));

  // Three complete strokes are drawn back-to-back without awaiting a save.
  for (const localY of [72, 86, 100]) await drawStroke(page, input, localY);
  await expect.poll(async () => (await readBackend(page)).saveCalls).toBeGreaterThanOrEqual(before.saveCalls + 3);
  await expect(saveState).toHaveAttribute('data-state', 'saved');
  const backgroundObserved = await waitForBackgroundActivity(page, before.backgroundReadCalls);
  await waitForFrames(page, backgroundObserved ? 6 : 12);
  const duringSaves = await readFrameProbe(page);
  const duringBackend = await readBackend(page);
  const released = await releaseHeldBackgroundReads(page);
  await expect.poll(() => readPixel(canvas, 5, 5)).toEqual(IMAGE_RED);
  await waitForFrames(page, 4);

  const savedPage = await readFixturePage(page);
  const addedStrokes = savedPage?.objects.filter((object) => object.id !== 'fixture-blue-stroke') ?? [];
  expect(addedStrokes, 'each finished stroke must add exactly one object').toHaveLength(3);
  for (const stroke of addedStrokes) {
    expect(stroke.content.kind).toBe('stroke');
    if (stroke.content.kind === 'stroke') expect(stroke.content.samples.length).toBeGreaterThan(1);
  }

  await component.getByTestId('ink-undo').click();
  await expect(saveState).toHaveAttribute('data-state', 'saved');
  await expect.poll(async () => (await readFixturePage(page))?.objects.length).toBe(3);
  await waitForFrames(page, 6);
  await expect.poll(() => readPixel(canvas, 5, 5)).toEqual(IMAGE_RED);
  await component.getByTestId('ink-redo').click();
  await expect(saveState).toHaveAttribute('data-state', 'saved');
  await expect.poll(async () => (await readFixturePage(page))?.objects.length).toBe(4);
  await waitForFrames(page, 6);
  await expect.poll(() => readPixel(canvas, 5, 5)).toEqual(IMAGE_RED);

  const finalProbe = await stopFrameProbe(page);
  const decodeCalls = await readBitmapDecodeCalls(page);
  const after = await readBackend(page);
  const evidence = {
    duringSaves,
    finalProbe,
    released,
    backgroundReadCallsBefore: before.backgroundReadCalls,
    backgroundReadCallsDuring: duringBackend.backgroundReadCalls,
    backgroundReadCallsAfter: after.backgroundReadCalls,
    decodeCalls,
  };
  expect(duringSaves.frames, `probe frames: ${JSON.stringify(evidence)}`).toBeGreaterThan(8);
  expect(duringSaves.whiteFrames, `white frames while three saves were pending: ${JSON.stringify(evidence)}`).toBe(0);
  expect(finalProbe.whiteFrames, `white frames through save/undo/redo: ${JSON.stringify(evidence)}`).toBe(0);
  expect(after.backgroundReadCalls, `background rebinds after one multi-stroke batch: ${JSON.stringify(evidence)}`).toBe(before.backgroundReadCalls);
  expect(decodeCalls, `bitmap decodes after the initial paint: ${JSON.stringify(evidence)}`).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('PDF background and source highlights stay painted across saves, undo and redo', async ({ mount, page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const component = await mount(<InkEditorHarness saveMode="success" pdfPageBackground />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  const saveState = component.getByTestId('ink-editor-save-state');
  await expect(canvas).toBeVisible();
  await expect.poll(() => readPixel(canvas, 5, 5)).toEqual(PDF_GRAY);
  await expect.poll(() => readPixel(canvas, 40, 30)).toEqual(PDF_HIGHLIGHT_BLUE);

  const before = await readBackend(page);
  await beginBitmapDecodeCounting(page);
  await startFrameProbe(page, { points: [[5, 5], [40, 30]], pageWidth: 160, pageHeight: 120, pageId: inkEditorPageId });
  await page.evaluate(() => {
    const backend = (window as FixtureWindow).__INK_EDITOR_CT_BACKEND__;
    backend?.holdFrozenInputReads(true);
    backend?.holdBackgroundReads(true);
  });

  for (const localY of [72, 88]) await drawStroke(page, input, localY);
  await expect.poll(async () => (await readBackend(page)).saveCalls).toBeGreaterThanOrEqual(before.saveCalls + 2);
  await expect(saveState).toHaveAttribute('data-state', 'saved');
  const frozenObserved = await waitForFrozenInputActivity(page, before.frozenInputReadCalls);
  await waitForFrames(page, frozenObserved ? 6 : 12);
  const duringSaves = await readFrameProbe(page);
  const duringBackend = await readBackend(page);
  const releasedFrozen = await page.evaluate(() => (window as FixtureWindow).__INK_EDITOR_CT_BACKEND__?.releaseHeldFrozenInputReads() ?? 0);
  await waitForFrames(page, 3);
  const releasedBackground = await releaseHeldBackgroundReads(page);
  await expect.poll(() => readPixel(canvas, 5, 5)).toEqual(PDF_GRAY);
  await expect.poll(() => readPixel(canvas, 40, 30)).toEqual(PDF_HIGHLIGHT_BLUE);

  await component.getByTestId('ink-undo').click();
  await expect(saveState).toHaveAttribute('data-state', 'saved');
  await expect.poll(async () => (await readFixturePage(page))?.objects.length).toBe(2);
  await waitForFrames(page, 6);
  await expect.poll(() => readPixel(canvas, 5, 5)).toEqual(PDF_GRAY);
  await expect.poll(() => readPixel(canvas, 40, 30)).toEqual(PDF_HIGHLIGHT_BLUE);
  await component.getByTestId('ink-redo').click();
  await expect(saveState).toHaveAttribute('data-state', 'saved');
  await expect.poll(async () => (await readFixturePage(page))?.objects.length).toBe(3);
  await waitForFrames(page, 6);
  await expect.poll(() => readPixel(canvas, 5, 5)).toEqual(PDF_GRAY);
  await expect.poll(() => readPixel(canvas, 40, 30)).toEqual(PDF_HIGHLIGHT_BLUE);

  const finalProbe = await stopFrameProbe(page);
  const decodeCalls = await readBitmapDecodeCalls(page);
  const after = await readBackend(page);
  const evidence = {
    duringSaves,
    finalProbe,
    releasedFrozen,
    releasedBackground,
    frozenInputReadCallsBefore: before.frozenInputReadCalls,
    frozenInputReadCallsDuring: duringBackend.frozenInputReadCalls,
    backgroundReadCallsBefore: before.backgroundReadCalls,
    backgroundReadCallsDuring: duringBackend.backgroundReadCalls,
    backgroundReadCallsAfter: after.backgroundReadCalls,
    decodeCalls,
  };
  expect(duringSaves.frames, `probe frames: ${JSON.stringify(evidence)}`).toBeGreaterThan(8);
  expect(duringSaves.whiteFrames, `white background/highlight frames while two saves were pending: ${JSON.stringify(evidence)}`).toBe(0);
  expect(finalProbe.whiteFrames, `white frames through save/undo/redo: ${JSON.stringify(evidence)}`).toBe(0);
  expect(after.backgroundReadCalls, `PDF bitmap rebinds after one multi-stroke batch: ${JSON.stringify(evidence)}`)
    .toBe(before.backgroundReadCalls);
  expect(decodeCalls, `bitmap decodes after the initial paint: ${JSON.stringify(evidence)}`).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('refreshes changed and deleted PDF source highlights without a white frame', async ({ mount, page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const component = await mount(<InkEditorHarness saveMode="success" pdfPageBackground />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => readPixel(canvas, 40, 30)).toEqual(PDF_HIGHLIGHT_BLUE);

  const before = await readBackend(page);
  await beginBitmapDecodeCounting(page);
  await startFrameProbe(page, { points: [[5, 5], [40, 30]], pageWidth: 160, pageHeight: 120, pageId: inkEditorPageId });

  const holdFrozen = () => page.evaluate(() => (window as FixtureWindow).__INK_EDITOR_CT_BACKEND__?.holdFrozenInputReads(true));
  const releaseFrozen = () => page.evaluate(() => (window as FixtureWindow).__INK_EDITOR_CT_BACKEND__?.releaseHeldFrozenInputReads() ?? 0);
  const emitChanged = () => page.evaluate(async ({ documentId }) => {
    const fixtureWindow = window as FixtureWindow;
    const backend = fixtureWindow.__INK_EDITOR_CT_BACKEND__;
    if (!backend || !fixtureWindow.__INK_EDITOR_EMIT_CHANGED__) throw new Error('Ink changed fixture is unavailable');
    await fixtureWindow.__INK_EDITOR_EMIT_CHANGED__(documentId, backend.readManifest().revision);
  }, { documentId: inkEditorDocumentId });

  await holdFrozen();
  await page.evaluate(() => {
    const fixtureWindow = window as FixtureWindow;
    const backend = fixtureWindow.__INK_EDITOR_CT_BACKEND__;
    if (!backend) throw new Error('Ink CT backend is unavailable');
    const current = backend.readPage('ink-editor-ct-page-2');
    if (!current) throw new Error('Fixture page is missing');
    backend.updateSourceHighlights([{
      id: 'pdf-highlight-updated',
      pageIndex: 0,
      color: '#00ff0080',
      rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.3 }],
      createdAt: 43,
      coordVersion: 2,
    }]);
    backend.advanceRemotePage('ink-editor-ct-page-2', current);
  });
  await emitChanged();
  const changeActivity = await waitForFrozenInputActivity(page, before.frozenInputReadCalls);
  await waitForFrames(page, changeActivity ? 6 : 12);
  const duringChange = await readFrameProbe(page);
  const releasedChange = await releaseFrozen();
  await expect.poll(() => readPixel(canvas, 40, 30)).toEqual(PDF_HIGHLIGHT_GREEN);
  await expect.poll(() => readPixel(canvas, 5, 5)).toEqual(PDF_GRAY);

  await holdFrozen();
  await page.evaluate(() => {
    const fixtureWindow = window as FixtureWindow;
    const backend = fixtureWindow.__INK_EDITOR_CT_BACKEND__;
    if (!backend) throw new Error('Ink CT backend is unavailable');
    const current = backend.readPage('ink-editor-ct-page-2');
    if (!current) throw new Error('Fixture page is missing');
    backend.updateSourceHighlights([]);
    backend.advanceRemotePage('ink-editor-ct-page-2', current);
  });
  await emitChanged();
  const deletionActivity = await waitForFrozenInputActivity(page, before.frozenInputReadCalls + 1);
  await waitForFrames(page, deletionActivity ? 6 : 12);
  const duringDeletion = await readFrameProbe(page);
  const releasedDeletion = await releaseFrozen();
  await expect.poll(() => readPixel(canvas, 40, 30)).toEqual(PDF_GRAY);
  await expect.poll(() => readPixel(canvas, 5, 5)).toEqual(PDF_GRAY);

  const finalProbe = await stopFrameProbe(page);
  const decodeCalls = await readBitmapDecodeCalls(page);
  const after = await readBackend(page);
  const evidence = {
    duringChange,
    duringDeletion,
    finalProbe,
    releasedChange,
    releasedDeletion,
    backgroundReadCallsBefore: before.backgroundReadCalls,
    backgroundReadCallsAfter: after.backgroundReadCalls,
    decodeCalls,
  };
  expect(duringChange.whiteFrames, `white frames while changed highlights were refreshing: ${JSON.stringify(evidence)}`).toBe(0);
  expect(duringDeletion.whiteFrames, `white frames while deleted highlights were refreshing: ${JSON.stringify(evidence)}`).toBe(0);
  expect(finalProbe.whiteFrames, `white frames through highlight updates: ${JSON.stringify(evidence)}`).toBe(0);
  // A changed highlight signature is allowed to rebuild the composed layer (and
  // therefore decode again); normal saves are the no-redecode contract.
  expect(after.backgroundReadCalls, `highlight refresh must not fail: ${JSON.stringify(evidence)}`)
    .toBeGreaterThanOrEqual(before.backgroundReadCalls);
  await expect(component.getByRole('alert')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('does not let a delayed page-2 background load paint over page 1', async ({ mount, page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await beginBitmapTracking(page);
  await page.evaluate(() => {
    window.__INK_EDITOR_CT_INITIAL_GATES__ = { background: true };
  });
  const component = await mount(<InkEditorHarness saveMode="success" imageBackground />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(async () => (await readBackend(page)).pendingBackgroundReads).toBe(1);
  expect(await readPixel(canvas, 5, 5)).toEqual(BLANK_WHITE);

  await component.getByTestId('ink-page-previous').click();
  await expect(canvas).toHaveAttribute('data-page-id', 'ink-editor-ct-page-1');
  const released = await releaseHeldBackgroundReads(page);
  expect(released, 'exactly the initial page-2 background read must be held').toBe(1);
  await expect.poll(async () => (await readBackend(page)).pendingBackgroundReads).toBe(0);
  await expect.poll(async () => (await readBitmapProbe(page)).closed).toBe(1);
  const cancelledProbe = await readBitmapProbe(page);
  expect(cancelledProbe.created, `bitmap probe after cancelled page-2 load: ${JSON.stringify(cancelledProbe)}`).toBe(1);
  expect(cancelledProbe.open).toBe(0);
  expect(cancelledProbe.drawAfterClose).toBe(0);
  await waitForFrames(page, 10);

  await expect(canvas).toHaveAttribute('data-page-id', 'ink-editor-ct-page-1');
  expect(await readPixel(canvas, 5, 5)).toEqual(BLANK_WHITE);
  expect(await readPixel(canvas, 110, 150)).toEqual(BLANK_WHITE);

  await component.getByTestId('ink-page-next').click();
  await expect(canvas).toHaveAttribute('data-page-id', inkEditorPageId);
  await expect.poll(() => readPixel(canvas, 5, 5)).toEqual(IMAGE_RED);

  await component.getByTestId('ink-page-previous').click();
  await expect(canvas).toHaveAttribute('data-page-id', 'ink-editor-ct-page-1');
  await waitForFrames(page, 4);
  expect(await readPixel(canvas, 5, 5)).toEqual(BLANK_WHITE);
  await component.getByTestId('ink-page-next').click();
  await expect(canvas).toHaveAttribute('data-page-id', inkEditorPageId);
  await expect.poll(() => readPixel(canvas, 5, 5)).toEqual(IMAGE_RED);
  await expect.poll(async () => (await readBitmapProbe(page)).closed).toBe(2);
  const finalBitmapProbe = await readBitmapProbe(page);
  expect(finalBitmapProbe.created, `bitmap probe after page returns: ${JSON.stringify(finalBitmapProbe)}`).toBe(3);
  expect(finalBitmapProbe.open).toBe(1);
  expect(finalBitmapProbe.doubleClose).toBe(0);
  expect(finalBitmapProbe.drawAfterClose).toBe(0);
  await expect(component.getByRole('alert')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('overlaps three queued strokes with a held save without losing samples or white frames', async ({ mount, page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const component = await mount(<InkEditorHarness saveMode="success" imageBackground />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  const saveState = component.getByTestId('ink-editor-save-state');
  await expect(canvas).toBeVisible();
  await expect.poll(() => readPixel(canvas, 5, 5)).toEqual(IMAGE_RED);

  const before = await readBackend(page);
  await beginBitmapDecodeCounting(page);
  await startFrameProbe(page, { points: [[5, 5], [110, 150]], pageWidth: 120, pageHeight: 160, pageId: inkEditorPageId });
  await page.evaluate(() => {
    const backend = (window as FixtureWindow).__INK_EDITOR_CT_BACKEND__;
    backend?.holdSaves(true);
    backend?.holdBackgroundReads(true);
  });

  for (const localY of [68, 84, 100]) await drawStroke(page, input, localY);
  await expect.poll(async () => (await readBackend(page)).saveCalls).toBeGreaterThanOrEqual(before.saveCalls + 1);
  await expect.poll(async () => (await readBackend(page)).pendingSaveCalls).toBeGreaterThanOrEqual(1);
  await expect(saveState).toHaveAttribute('data-state', 'saving');
  await waitForFrames(page, 4);

  const duringHold = await readFrameProbe(page);
  const releasedSaves = await page.evaluate(() => (window as FixtureWindow).__INK_EDITOR_CT_BACKEND__?.releaseHeldSaves() ?? 0);
  expect(releasedSaves).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => (await readBackend(page)).saveCalls).toBeGreaterThanOrEqual(before.saveCalls + 3);
  await expect(saveState).toHaveAttribute('data-state', 'saved');
  const backgroundObserved = await waitForBackgroundActivity(page, before.backgroundReadCalls);
  await waitForFrames(page, backgroundObserved ? 6 : 12);
  const duringSaves = await readFrameProbe(page);
  const releasedBackground = await releaseHeldBackgroundReads(page);
  await expect.poll(() => readPixel(canvas, 5, 5)).toEqual(IMAGE_RED);

  const savedPage = await readFixturePage(page);
  const addedStrokes = savedPage?.objects.filter((object) => object.id !== 'fixture-blue-stroke') ?? [];
  expect(addedStrokes, 'three overlapped strokes must produce three objects').toHaveLength(3);
  for (const stroke of addedStrokes) {
    expect(stroke.content.kind).toBe('stroke');
    if (stroke.content.kind === 'stroke') expect(stroke.content.samples.length).toBeGreaterThan(1);
  }

  const finalProbe = await stopFrameProbe(page);
  const decodeCalls = await readBitmapDecodeCalls(page);
  const after = await readBackend(page);
  const evidence = {
    duringHold,
    duringSaves,
    finalProbe,
    releasedSaves,
    releasedBackground,
    saveCallsBefore: before.saveCalls,
    saveCallsAfter: after.saveCalls,
    backgroundReadCallsBefore: before.backgroundReadCalls,
    backgroundReadCallsAfter: after.backgroundReadCalls,
    decodeCalls,
  };
  expect(duringHold.whiteFrames, `white frames while the first save was held: ${JSON.stringify(evidence)}`).toBe(0);
  expect(duringSaves.whiteFrames, `white frames while queued saves completed: ${JSON.stringify(evidence)}`).toBe(0);
  expect(finalProbe.whiteFrames, `white frames through the overlapped batch: ${JSON.stringify(evidence)}`).toBe(0);
  expect(after.backgroundReadCalls, `background rebinds after overlapped strokes: ${JSON.stringify(evidence)}`)
    .toBe(before.backgroundReadCalls);
  expect(decodeCalls, `bitmap decodes through overlapped strokes: ${JSON.stringify(evidence)}`).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('diagnostics stay opt-in and leave short continuous input untouched', async ({ mount, page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  const saveState = component.getByTestId('ink-editor-save-state');
  await expect(canvas).toBeVisible();

  const readDiagnostics = () => page.evaluate(() => {
    const diagnostics = (window as FixtureWindow).__INK_DIAGNOSTICS_API__;
    if (!diagnostics) throw new Error('Diagnostics API is unavailable');
    const snapshot = diagnostics.getInkDiagnosticsSnapshot();
    return {
      enabled: diagnostics.isInkDiagnosticsEnabled(),
      retainedCount: snapshot.retainedCount,
      capacity: snapshot.capacity,
      dropped: snapshot.dropped,
      events: snapshot.records.slice(-8).map((record) => record.event),
      serialized: JSON.stringify(snapshot),
    };
  });
  const setDiagnostics = (enabled: boolean) => page.evaluate((nextEnabled) => {
    const diagnostics = (window as FixtureWindow).__INK_DIAGNOSTICS_API__;
    if (!diagnostics) throw new Error('Diagnostics API is unavailable');
    diagnostics.setInkDiagnosticsEnabled(nextEnabled);
  }, enabled);
  const clearDiagnostics = () => page.evaluate(() => {
    const diagnostics = (window as FixtureWindow).__INK_DIAGNOSTICS_API__;
    if (!diagnostics) throw new Error('Diagnostics API is unavailable');
    diagnostics.clearInkDiagnostics();
  });

  const initial = await readDiagnostics();
  expect(initial.enabled, 'diagnostics must default to disabled').toBe(false);
  expect(initial.retainedCount).toBe(0);

  for (const localY of [64, 82]) await drawStroke(page, input, localY);
  await expect.poll(async () => (await readFixturePage(page))?.objects.length).toBe(3);
  await expect(saveState).toHaveAttribute('data-state', 'saved');
  const disabledInput = await readDiagnostics();
  expect(disabledInput.retainedCount, 'disabled diagnostics must not collect records').toBe(0);

  await setDiagnostics(true);
  await clearDiagnostics();
  for (const localY of [100, 118]) await drawStroke(page, input, localY);
  await expect.poll(async () => (await readFixturePage(page))?.objects.length).toBe(5);
  await expect(saveState).toHaveAttribute('data-state', 'saved');
  const enabledInput = await readDiagnostics();
  expect(enabledInput.enabled).toBe(true);
  expect(enabledInput.retainedCount).toBeGreaterThan(0);
  expect(enabledInput.capacity).toBeGreaterThan(0);
  expect(enabledInput.retainedCount).toBeLessThanOrEqual(enabledInput.capacity);
  expect(enabledInput.serialized.length).toBeLessThan(2_000_000);
  expect(enabledInput.events.some((event) => event === 'pointer' || event.startsWith('ink.'))).toBe(true);

  await setDiagnostics(false);
  await clearDiagnostics();
  const afterDisableClear = await readDiagnostics();
  expect(afterDisableClear.enabled).toBe(false);
  expect(afterDisableClear.retainedCount).toBe(0);
  expect(afterDisableClear.dropped).toBe(0);
  await drawStroke(page, input, 136);
  await expect.poll(async () => (await readFixturePage(page))?.objects.length).toBe(6);
  await expect(saveState).toHaveAttribute('data-state', 'saved');
  const finalDiagnostics = await readDiagnostics();
  expect(finalDiagnostics.retainedCount, 'records must stay empty after disabling/clearing').toBe(0);

  const savedPage = await readFixturePage(page);
  const addedStrokes = savedPage?.objects.filter((object) => object.id !== 'fixture-blue-stroke') ?? [];
  expect(addedStrokes).toHaveLength(5);
  for (const stroke of addedStrokes) {
    expect(stroke.content.kind).toBe('stroke');
    if (stroke.content.kind === 'stroke') expect(stroke.content.samples.length).toBeGreaterThan(1);
  }
  expect(pageErrors).toEqual([]);
});

test('reloads a changed source highlight, deletes only the removed highlight, and releases superseded bitmaps exactly once', async ({ mount, page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await beginBitmapTracking(page);
  const component = await mount(<InkEditorHarness saveMode="success" pdfPageBackground />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => readPixel(canvas, 5, 5)).toEqual(PDF_GRAY);
  await expect.poll(() => readPixel(canvas, 40, 30)).toEqual(PDF_HIGHLIGHT_BLUE);
  await expect.poll(() => readPixel(canvas, 120, 30)).toEqual(PDF_GRAY);

  await beginBitmapDecodeCounting(page);
  const initialProbe = await readBitmapProbe(page);
  expect(initialProbe.created, `initial bitmap probe: ${JSON.stringify(initialProbe)}`).toBe(1);
  expect(initialProbe.open).toBe(1);
  const before = await readBackend(page);
  await startFrameProbe(page, { points: [[5, 5], [40, 30], [120, 30]], pageWidth: 160, pageHeight: 120, pageId: inkEditorPageId });

  // A genuine highlight change must reload + compose a fresh lease rather than
  // repainting the retained base bitmap in place.
  await page.evaluate(() => {
    (window as FixtureWindow).__INK_EDITOR_CT_BACKEND__?.holdBackgroundReads(true);
  });
  await applySourceHighlights(page, [SOURCE_BLUE_HIGHLIGHT, SOURCE_GREEN_HIGHLIGHT]);
  const changeReadObserved = await waitForBackgroundActivity(page, before.backgroundReadCalls);
  expect(changeReadObserved, 'a changed highlight signature must request a fresh background').toBe(true);
  await expect.poll(() => readPixel(canvas, 40, 30)).toEqual(PDF_HIGHLIGHT_BLUE);
  await expect.poll(() => readPixel(canvas, 120, 30)).toEqual(PDF_GRAY);
  const duringChange = await readFrameProbe(page);
  const releasedChange = await releaseHeldBackgroundReads(page);
  expect(releasedChange, 'exactly the highlight-refresh read must be held').toBe(1);
  await expect.poll(() => readPixel(canvas, 120, 30)).toEqual(PDF_HIGHLIGHT_GREEN);
  await expect.poll(() => readPixel(canvas, 40, 30)).toEqual(PDF_HIGHLIGHT_BLUE);
  await expect.poll(() => readBitmapDecodeCalls(page)).toBeGreaterThan(0);
  await expect.poll(async () => (await readBackend(page)).backgroundReadCalls).toBe(before.backgroundReadCalls + 1);
  await expect.poll(async () => (await readBitmapProbe(page)).closed).toBe(1);
  const afterChangeProbe = await readBitmapProbe(page);
  expect(afterChangeProbe.created, `bitmap probe after change: ${JSON.stringify(afterChangeProbe)}`).toBe(2);
  expect(afterChangeProbe.open).toBe(1);
  expect(afterChangeProbe.doubleClose).toBe(0);
  expect(afterChangeProbe.drawAfterClose).toBe(0);

  // Deleting one of two highlights must remove only that overlay and keep the
  // remaining highlight. The new composition gets its own lease; the previous
  // lease stays alive until the replacement is actually published.
  await page.evaluate(() => {
    (window as FixtureWindow).__INK_EDITOR_CT_BACKEND__?.holdBackgroundReads(true);
  });
  await applySourceHighlights(page, [SOURCE_BLUE_HIGHLIGHT]);
  const deletionReadObserved = await waitForBackgroundActivity(page, before.backgroundReadCalls + 1);
  expect(deletionReadObserved, 'deleting a highlight must request a fresh background').toBe(true);
  await expect.poll(() => readPixel(canvas, 40, 30)).toEqual(PDF_HIGHLIGHT_BLUE);
  await expect.poll(() => readPixel(canvas, 120, 30)).toEqual(PDF_HIGHLIGHT_GREEN);
  const duringDeletion = await readFrameProbe(page);
  const releasedDeletion = await releaseHeldBackgroundReads(page);
  expect(releasedDeletion, 'exactly the deletion-refresh read must be held').toBe(1);
  await expect.poll(() => readPixel(canvas, 120, 30)).toEqual(PDF_GRAY);
  await expect.poll(() => readPixel(canvas, 40, 30)).toEqual(PDF_HIGHLIGHT_BLUE);
  await expect.poll(async () => (await readBitmapProbe(page)).closed).toBe(2);
  const afterDeletionProbe = await readBitmapProbe(page);
  expect(afterDeletionProbe.created, `bitmap probe after deletion: ${JSON.stringify(afterDeletionProbe)}`).toBe(3);
  expect(afterDeletionProbe.open).toBe(1);
  expect(afterDeletionProbe.doubleClose).toBe(0);
  expect(afterDeletionProbe.drawAfterClose).toBe(0);

  const finalProbe = await stopFrameProbe(page);
  const evidence = {
    duringChange,
    duringDeletion,
    finalProbe,
    releasedChange,
    releasedDeletion,
    initialProbe,
    afterChangeProbe,
    afterDeletionProbe,
  };
  expect(duringChange.whiteFrames, `white frames during highlight change: ${JSON.stringify(evidence)}`).toBe(0);
  expect(duringDeletion.whiteFrames, `white frames during highlight deletion: ${JSON.stringify(evidence)}`).toBe(0);
  expect(finalProbe.whiteFrames, `white frames through highlight refresh: ${JSON.stringify(evidence)}`).toBe(0);

  await component.getByTestId('ink-editor-unmount').click();
  await expect.poll(async () => (await readBitmapProbe(page)).closed).toBe(3);
  const unmountedProbe = await readBitmapProbe(page);
  expect(unmountedProbe.open, `bitmap probe after unmount: ${JSON.stringify(unmountedProbe)}`).toBe(0);
  expect(unmountedProbe.doubleClose).toBe(0);
  expect(unmountedProbe.drawAfterClose).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('keeps the last good PDF background when a highlight refresh cannot load, then recovers', async ({ mount, page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await beginBitmapTracking(page);
  const component = await mount(<InkEditorHarness saveMode="success" pdfPageBackground />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => readPixel(canvas, 5, 5)).toEqual(PDF_GRAY);
  await expect.poll(() => readPixel(canvas, 40, 30)).toEqual(PDF_HIGHLIGHT_BLUE);
  const before = await readBackend(page);
  await startFrameProbe(page, { points: [[5, 5], [40, 30]], pageWidth: 160, pageHeight: 120, pageId: inkEditorPageId });

  const greenAtLeft = {
    ...SOURCE_GREEN_HIGHLIGHT,
    id: 'pdf-highlight-left-green',
    rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.3 }],
  };
  await page.evaluate(() => {
    (window as FixtureWindow).__INK_EDITOR_CT_BACKEND__?.failNextBackgroundReads(1);
  });
  await applySourceHighlights(page, [greenAtLeft]);
  await expect.poll(async () => (await readBackend(page)).backgroundReadCalls, {
    message: 'the failed refresh must attempt a real background load',
  }).toBe(before.backgroundReadCalls + 1);
  await waitForFrames(page, 6);

  // The failed reload must not publish a blank or a new partial layer: the
  // last committed bitmap stays on the prop and keeps painting.
  await expect.poll(() => readPixel(canvas, 5, 5)).toEqual(PDF_GRAY);
  await expect.poll(() => readPixel(canvas, 40, 30)).toEqual(PDF_HIGHLIGHT_BLUE);
  const duringFailureProbe = await readBitmapProbe(page);
  expect(duringFailureProbe.created, `bitmap probe during failed refresh: ${JSON.stringify(duringFailureProbe)}`).toBe(1);
  expect(duringFailureProbe.closed).toBe(0);
  expect(duringFailureProbe.open).toBe(1);
  expect(duringFailureProbe.drawAfterClose).toBe(0);
  const duringFailure = await readFrameProbe(page);

  // The next successful change composes the new highlight and only then
  // releases the previously displayed bitmap.
  await applySourceHighlights(page, [greenAtLeft]);
  await expect.poll(() => readPixel(canvas, 40, 30)).toEqual(PDF_HIGHLIGHT_GREEN);
  await expect.poll(async () => (await readBackend(page)).backgroundReadCalls).toBe(before.backgroundReadCalls + 2);
  await expect.poll(async () => (await readBitmapProbe(page)).closed).toBe(1);
  const afterRecoveryProbe = await readBitmapProbe(page);
  expect(afterRecoveryProbe.created, `bitmap probe after recovery: ${JSON.stringify(afterRecoveryProbe)}`).toBe(2);
  expect(afterRecoveryProbe.open).toBe(1);
  expect(afterRecoveryProbe.doubleClose).toBe(0);
  expect(afterRecoveryProbe.drawAfterClose).toBe(0);

  const finalProbe = await stopFrameProbe(page);
  const evidence = {
    duringFailure,
    finalProbe,
    duringFailureProbe,
    afterRecoveryProbe,
  };
  expect(duringFailure.whiteFrames, `white frames during failed refresh: ${JSON.stringify(evidence)}`).toBe(0);
  expect(finalProbe.whiteFrames, `white frames through failed refresh and recovery: ${JSON.stringify(evidence)}`).toBe(0);

  await component.getByTestId('ink-editor-unmount').click();
  await expect.poll(async () => (await readBitmapProbe(page)).closed).toBe(2);
  const unmountedProbe = await readBitmapProbe(page);
  expect(unmountedProbe.open, `bitmap probe after unmount: ${JSON.stringify(unmountedProbe)}`).toBe(0);
  expect(unmountedProbe.drawAfterClose).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('toggles diagnostics in the UI, exports through the save dialog and leaves disabled multi-stroke input untouched', async ({ mount, page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  const saveState = component.getByTestId('ink-editor-save-state');
  await expect(canvas).toBeVisible();
  await expect.poll(async () => (await readFixturePage(page))?.objects.length).toBe(1);

  const settingsPanel = page.getByTestId('ink-tool-settings-panel');
  const openSettings = async () => {
    await component.getByTestId('ink-tool-settings').click();
    await expect(settingsPanel).toBeVisible();
  };
  const closeSettings = async () => {
    await page.keyboard.press('Escape');
    await expect(settingsPanel).not.toBeVisible();
  };

  await openSettings();
  const controls = page.getByTestId('ink-diagnostics-controls');
  const toggle = page.getByTestId('ink-diagnostics-toggle');
  const exportButton = page.getByTestId('ink-diagnostics-export');
  await expect(controls).toHaveAttribute('data-enabled', 'false');
  await expect(exportButton).toBeEnabled();
  await toggle.click();
  await expect(controls).toHaveAttribute('data-enabled', 'true');
  await expect(exportButton).toBeDisabled();
  await closeSettings();

  for (const localY of [64, 82, 100]) await drawStroke(page, input, localY);
  await expect.poll(async () => (await readFixturePage(page))?.objects.length).toBe(4);
  await expect(saveState).toHaveAttribute('data-state', 'saved');

  await openSettings();
  await expect(controls).toHaveAttribute('data-enabled', 'true');
  await toggle.click();
  await expect(controls).toHaveAttribute('data-enabled', 'false');
  const enabledSnapshot = await readDiagnostics(page);
  expect(enabledSnapshot.retainedCount, 'enabled diagnostics must buffer pointer records').toBeGreaterThan(0);
  const pointerMoves = enabledSnapshot.records.filter((record) => record.event === 'pointer' && record.data?.phase === 'move');
  expect(pointerMoves.length, 'real page.mouse strokes must produce pointer move diagnostics').toBeGreaterThan(0);
  const captureEvents = enabledSnapshot.records.map((record) => record.event).filter((event) => event.startsWith('page.pointer.capture.'));
  expect(captureEvents.filter((event) => event === 'page.pointer.capture.got').length,
    'each page.mouse stroke must acquire real pointer capture').toBeGreaterThanOrEqual(3);
  expect(captureEvents.filter((event) => event === 'page.pointer.capture.lost').length,
    'each page.mouse stroke must release real pointer capture').toBeGreaterThanOrEqual(3);
  expect(pointerMoves.some((record) => (
    typeof record.data?.clientX === 'number' && typeof record.data?.clientY === 'number'
  ))).toBe(true);

  await setSaveDialogPath(page, '/tmp/ink-diagnostics-ct.json');
  await expect(exportButton).toBeEnabled();
  await exportButton.click();
  await expect.poll(async () => (await readSavedTextFiles(page)).length).toBe(1);
  const [savedFile] = await readSavedTextFiles(page);
  expect(savedFile.path).toBe('/tmp/ink-diagnostics-ct.json');
  const exported = JSON.parse(savedFile.content ?? '') as {
    format?: string;
    truncated?: boolean;
    eventCount?: number;
    snapshot?: { retainedCount?: number; records?: unknown[] };
  };
  expect(exported.format).toBe('deepstudent.ink-diagnostics');
  expect(exported.truncated).toBe(false);
  expect(exported.eventCount).toBe(enabledSnapshot.retainedCount);
  expect(exported.snapshot?.retainedCount).toBe(enabledSnapshot.retainedCount);
  expect(exported.snapshot?.records?.length).toBe(enabledSnapshot.retainedCount);
  await expect(page.getByTestId('ink-diagnostics-notice')).toHaveAttribute('role', 'status');

  const invokeCalls = await page.evaluate(() => (
    window as unknown as { __CT_INVOKE_CALLS__?: Array<{ command: string; payload?: Record<string, unknown> }> }
  ).__CT_INVOKE_CALLS__ ?? []);
  expect(invokeCalls.some((call) => call.command === 'plugin:dialog|save')).toBe(true);
  expect(invokeCalls.some((call) => call.command === 'save_text_to_file')).toBe(true);

  await page.getByTestId('ink-diagnostics-clear').click();
  const cleared = await readDiagnostics(page);
  expect(cleared.retainedCount).toBe(0);
  expect(cleared.dropped).toBe(0);

  await closeSettings();
  for (const localY of [118, 136]) await drawStroke(page, input, localY);
  await expect.poll(async () => (await readFixturePage(page))?.objects.length).toBe(6);
  await expect(saveState).toHaveAttribute('data-state', 'saved');
  const disabledSnapshot = await readDiagnostics(page);
  expect(disabledSnapshot.enabled).toBe(false);
  expect(disabledSnapshot.retainedCount, 'disabled diagnostics must not collect the later strokes').toBe(0);

  const savedPage = await readFixturePage(page);
  const addedStrokes = savedPage?.objects.filter((object) => object.id !== 'fixture-blue-stroke') ?? [];
  expect(addedStrokes, 'all continuous strokes must save while diagnostics are toggled on and off').toHaveLength(5);
  for (const stroke of addedStrokes) {
    expect(stroke.content.kind).toBe('stroke');
    if (stroke.content.kind === 'stroke') expect(stroke.content.samples.length).toBeGreaterThan(1);
  }
  expect(pageErrors).toEqual([]);
});
