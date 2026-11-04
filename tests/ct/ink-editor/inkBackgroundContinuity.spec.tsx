import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { Locator, Page } from '@playwright/test';
import type { InkPage } from '@/features/ink/types';
import { InkEditorHarness } from './InkEditorHarness';
import { inkEditorDocumentId, inkEditorPageId } from './fixtures';

interface BackgroundProbeState {
  frames: number;
  whiteFrames: number;
  whiteAt: number[];
  running: boolean;
}

interface InkBackendHandle {
  readPage(pageId: string): InkPage | undefined;
  advanceRemotePage(pageId: string, page: InkPage): void;
  updatePdfSourceHighlights(highlights: Array<Record<string, unknown>>): void;
  holdBackgroundReads(hold: boolean): void;
  releaseHeldBackgroundReads(): number;
  holdRenderInputReads(hold: boolean): void;
  releaseHeldRenderInputReads(): number;
  readonly backgroundReadCalls: number;
  readonly pendingBackgroundReads: number;
  readonly renderInputReadCalls: number;
  readonly pendingRenderInputReads: number;
  readonly saveCalls: number;
  readManifest(): { revision: string; source: Record<string, unknown> & { kind: string } };
}

type FixtureWindow = Window & {
  __INK_EDITOR_CT_BACKEND__?: InkBackendHandle;
  __INK_EDITOR_EMIT_CHANGED__?: (documentId: string, revision: string) => Promise<void>;
  __INK_BG_PROBE__?: BackgroundProbeState;
  __INK_CT_CANVAS__?: HTMLCanvasElement;
};

const IMAGE_BACKGROUND = [255, 0, 0, 255];
const PDF_BACKGROUND = [221, 221, 221, 255];
const PDF_HIGHLIGHT_BLUE = [110, 110, 221, 255];

async function drawStroke(page: Page, canvas: Locator, localY = 72) {
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Ink page input canvas has no visible bounds');
  await page.mouse.move(bounds.x + 18, bounds.y + localY);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 48, bounds.y + localY, { steps: 4 });
  await page.mouse.move(bounds.x + 96, bounds.y + localY, { steps: 4 });
  await page.mouse.up();
}

async function readCanvasPixel(canvas: Locator, x: number, y: number): Promise<number[]> {
  return canvas.evaluate((element, point) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    return Array.from(context.getImageData(point.x, point.y, 1, 1).data);
  }, { x, y });
}

async function readFixturePage(page: Page, pageId = inkEditorPageId): Promise<InkPage | undefined> {
  return page.evaluate(({ documentId, pageId }) => {
    const backend = (window as unknown as FixtureWindow).__INK_EDITOR_CT_BACKEND__;
    if (!backend || documentId !== 'ink-editor-ct-document') return undefined;
    return backend.readPage(pageId);
  }, { documentId: inkEditorDocumentId, pageId });
}

async function readBackend(page: Page) {
  return page.evaluate(() => {
    const backend = (window as unknown as FixtureWindow).__INK_EDITOR_CT_BACKEND__;
    if (!backend) throw new Error('Ink CT backend is unavailable');
    return {
      saveCalls: backend.saveCalls,
      backgroundReadCalls: backend.backgroundReadCalls,
      pendingBackgroundReads: backend.pendingBackgroundReads,
      renderInputReadCalls: backend.renderInputReadCalls,
      pendingRenderInputReads: backend.pendingRenderInputReads,
      manifestSource: backend.readManifest().source,
    };
  });
}

async function waitForAnimationFrames(page: Page, frames: number) {
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
 * Records one sample per animation frame. A frame counts as a flash when every
 * background-only probe point turns pure white (the page canvas was redrawn
 * without its frozen background). Real canvas pixels are read, not renderer
 * mocks, so this catches the observable per-stroke white flicker.
 */
async function startBackgroundProbe(
  page: Page,
  options: { points: Array<[number, number]>; pageWidth: number; pageHeight: number },
) {
  await page.evaluate(({ points, pageWidth, pageHeight }) => {
    const fixtureWindow = window as unknown as FixtureWindow;
    const state: BackgroundProbeState = { frames: 0, whiteFrames: 0, whiteAt: [], running: true };
    fixtureWindow.__INK_BG_PROBE__ = state;
    const sample = () => {
      if (!state.running) return;
      const canvas = document.querySelector('[data-testid="ink-page-canvas"]') as HTMLCanvasElement | null;
      const context = canvas?.getContext('2d');
      if (canvas?.isConnected && context && canvas.width > 0 && canvas.height > 0) {
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
          if (state.whiteAt.length < 12) state.whiteAt.push(Math.round(performance.now()));
        }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, options);
}

async function readBackgroundProbe(page: Page): Promise<BackgroundProbeState> {
  return page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).__INK_BG_PROBE__;
    if (!state) throw new Error('Background probe is not running');
    return { ...state, whiteAt: [...state.whiteAt] };
  });
}

async function stopBackgroundProbe(page: Page): Promise<BackgroundProbeState> {
  return page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).__INK_BG_PROBE__;
    if (!state) throw new Error('Background probe is not running');
    state.running = false;
    return { ...state, whiteAt: [...state.whiteAt] };
  });
}

/**
 * Waits for a held save-triggered background read or frozen render-inputs
 * refetch, then lets a few frames pass so a cleared bitmap would stay visible
 * long enough to be sampled. Resolves false when the implementation reused both
 * the decoded bitmap and the highlight signature and never reloaded anything.
 */
async function waitForHeldBackgroundWork(page: Page) {
  const engaged = await page.waitForFunction(() => {
    const backend = (window as unknown as FixtureWindow).__INK_EDITOR_CT_BACKEND__;
    return Boolean(backend && (backend.pendingBackgroundReads > 0 || backend.pendingRenderInputReads > 0));
  }, undefined, { timeout: 1500 }).then(() => true).catch(() => false);
  await waitForAnimationFrames(page, engaged ? 8 : 12);
  return engaged;
}

test('keeps a resource-sourced image background on every animation frame while the save-triggered render inputs are pending', async ({ mount, page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const component = await mount(<InkEditorHarness saveMode="success" imageBackground />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  const saveState = component.getByTestId('ink-editor-save-state');
  await expect(canvas).toBeVisible();
  await expect.poll(() => readCanvasPixel(canvas, 5, 5)).toEqual(IMAGE_BACKGROUND);

  await canvas.evaluate((element) => {
    (window as unknown as FixtureWindow).__INK_CT_CANVAS__ = element as HTMLCanvasElement;
  });
  await startBackgroundProbe(page, { points: [[5, 5], [110, 150]], pageWidth: 120, pageHeight: 160 });
  const before = await readBackend(page);
  expect(before.manifestSource.kind, 'image fixture must use a real resource source').toBe('resource');
  expect(before.renderInputReadCalls, 'initial resource load must fetch frozen render inputs').toBeGreaterThan(0);

  await page.evaluate(() => {
    (window as unknown as FixtureWindow).__INK_EDITOR_CT_BACKEND__?.holdRenderInputReads(true);
  });
  await drawStroke(page, input, 72);
  await expect.poll(() => readBackend(page).then((value) => value.saveCalls)).toBeGreaterThan(before.saveCalls);
  await expect(saveState).toHaveAttribute('data-state', 'saved');
  const heldWhileSaving = await waitForHeldBackgroundWork(page);
  const duringHold = await readBackgroundProbe(page);
  const backendDuringHold = await readBackend(page);
  expect(
    heldWhileSaving && backendDuringHold.pendingRenderInputReads === 1,
    `save must hold one real frozen render-inputs refetch: ${JSON.stringify({ heldWhileSaving, backendDuringHold })}`,
  ).toBe(true);
  const releasedRenderInputs = await page.evaluate(() => (window as unknown as FixtureWindow)
    .__INK_EDITOR_CT_BACKEND__?.releaseHeldRenderInputReads() ?? 0);
  expect(releasedRenderInputs, 'the held render-inputs refetch must be a real pending call').toBe(1);
  await expect.poll(() => readBackend(page).then((value) => value.pendingRenderInputReads)).toBe(0);

  await expect.poll(() => readCanvasPixel(canvas, 5, 5)).toEqual(IMAGE_BACKGROUND);
  expect(duringHold.frames, `probe frames: ${JSON.stringify(duringHold)}`).toBeGreaterThan(10);
  expect(
    duringHold.whiteFrames,
    `white background frames while the save-triggered render-inputs refetch was held: ${JSON.stringify({
      heldWhileSaving,
      releasedRenderInputs,
      duringHold,
      backgroundReadCallsBefore: before.backgroundReadCalls,
      backgroundReadCallsDuring: backendDuringHold.backgroundReadCalls,
      renderInputReadCallsBefore: before.renderInputReadCalls,
      renderInputReadCallsDuring: backendDuringHold.renderInputReadCalls,
      manifestSource: before.manifestSource,
    })}`,
  ).toBe(0);
  expect(
    backendDuringHold.backgroundReadCalls,
    `background blob reads before/after one stroke: ${before.backgroundReadCalls} -> ${backendDuringHold.backgroundReadCalls}`,
  ).toBe(before.backgroundReadCalls);
  expect(
    backendDuringHold.renderInputReadCalls,
    `frozen render-inputs reads before/after one stroke: ${before.renderInputReadCalls} -> ${backendDuringHold.renderInputReadCalls}`,
  ).toBeGreaterThan(before.renderInputReadCalls);

  // Several more strokes and their saves must keep the same painted bitmap and
  // never re-decode it.
  for (const localY of [84, 96]) {
    await drawStroke(page, input, localY);
    await expect(saveState).toHaveAttribute('data-state', 'saved');
    await waitForAnimationFrames(page, 8);
    await expect.poll(() => readCanvasPixel(canvas, 5, 5)).toEqual(IMAGE_BACKGROUND);
  }
  const afterStrokes = await readBackgroundProbe(page);
  const backendAfterStrokes = await readBackend(page);
  expect(
    afterStrokes.whiteFrames,
    `white background frames across three strokes: ${JSON.stringify(afterStrokes)}`,
  ).toBe(0);
  expect(
    backendAfterStrokes.backgroundReadCalls,
    `background blob reads after three strokes: ${before.backgroundReadCalls} -> ${backendAfterStrokes.backgroundReadCalls}`,
  ).toBe(before.backgroundReadCalls);
  expect(
    backendAfterStrokes.renderInputReadCalls,
    `frozen render-inputs reads after three strokes: ${before.renderInputReadCalls} -> ${backendAfterStrokes.renderInputReadCalls}`,
  ).toBeGreaterThan(before.renderInputReadCalls);
  expect(await page.evaluate(() => {
    const marked = (window as unknown as FixtureWindow).__INK_CT_CANVAS__;
    const current = document.querySelector('[data-testid="ink-page-canvas"]');
    return Boolean(marked && current && marked === current && marked.isConnected);
  })).toBe(true);

  // Undo and redo still persist the right page content.
  await expect.poll(async () => (await readFixturePage(page))?.objects.length).toBe(4);
  await component.getByTestId('ink-undo').click();
  await expect(saveState).toHaveAttribute('data-state', 'saved');
  await expect.poll(async () => (await readFixturePage(page))?.objects.length).toBe(3);
  await waitForAnimationFrames(page, 8);
  await expect.poll(() => readCanvasPixel(canvas, 5, 5)).toEqual(IMAGE_BACKGROUND);
  await component.getByTestId('ink-redo').click();
  await expect(saveState).toHaveAttribute('data-state', 'saved');
  await expect.poll(async () => (await readFixturePage(page))?.objects.length).toBe(4);
  await waitForAnimationFrames(page, 8);
  await expect.poll(() => readCanvasPixel(canvas, 5, 5)).toEqual(IMAGE_BACKGROUND);

  const finalProbe = await stopBackgroundProbe(page);
  expect(
    finalProbe.whiteFrames,
    `white background frames through save/undo/redo: ${JSON.stringify(finalProbe)}`,
  ).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('keeps the PDF background and source highlights on every animation frame across a save', async ({ mount, page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const component = await mount(<InkEditorHarness saveMode="success" pdfPageBackground />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  const saveState = component.getByTestId('ink-editor-save-state');
  await expect(canvas).toBeVisible();
  await expect.poll(() => readCanvasPixel(canvas, 5, 5)).toEqual(PDF_BACKGROUND);
  await expect.poll(() => readCanvasPixel(canvas, 40, 30)).toEqual(PDF_HIGHLIGHT_BLUE);

  await canvas.evaluate((element) => {
    (window as unknown as FixtureWindow).__INK_CT_CANVAS__ = element as HTMLCanvasElement;
  });
  await startBackgroundProbe(page, { points: [[5, 5], [40, 30]], pageWidth: 160, pageHeight: 120 });
  const before = await readBackend(page);

  await page.evaluate(() => {
    const backend = (window as unknown as FixtureWindow).__INK_EDITOR_CT_BACKEND__;
    backend?.holdBackgroundReads(true);
    backend?.holdRenderInputReads(true);
  });
  await drawStroke(page, input, 72);
  await expect.poll(() => readBackend(page).then((value) => value.saveCalls)).toBeGreaterThan(before.saveCalls);
  await expect(saveState).toHaveAttribute('data-state', 'saved');
  const heldWhileSaving = await waitForHeldBackgroundWork(page);
  const duringHold = await readBackgroundProbe(page);
  const backendDuringHold = await readBackend(page);
  const releasedBackgroundReads = await page.evaluate(() => (window as unknown as FixtureWindow)
    .__INK_EDITOR_CT_BACKEND__?.releaseHeldBackgroundReads() ?? 0);
  const releasedRenderInputReads = await page.evaluate(() => (window as unknown as FixtureWindow)
    .__INK_EDITOR_CT_BACKEND__?.releaseHeldRenderInputReads() ?? 0);

  await expect.poll(() => readCanvasPixel(canvas, 5, 5)).toEqual(PDF_BACKGROUND);
  await expect.poll(() => readCanvasPixel(canvas, 40, 30)).toEqual(PDF_HIGHLIGHT_BLUE);
  expect(duringHold.frames, `probe frames: ${JSON.stringify(duringHold)}`).toBeGreaterThan(10);
  expect(
    duringHold.whiteFrames,
    `white background/highlight frames while the save-triggered reload was held: ${JSON.stringify({
      heldWhileSaving,
      releasedBackgroundReads,
      releasedRenderInputReads,
      duringHold,
      backgroundReadCallsBefore: before.backgroundReadCalls,
      backgroundReadCallsDuring: backendDuringHold.backgroundReadCalls,
      renderInputReadCallsBefore: before.renderInputReadCalls,
      renderInputReadCallsDuring: backendDuringHold.renderInputReadCalls,
    })}`,
  ).toBe(0);
  expect(
    backendDuringHold.backgroundReadCalls,
    `PDF background blob reads before/after one stroke: ${before.backgroundReadCalls} -> ${backendDuringHold.backgroundReadCalls}`,
  ).toBe(before.backgroundReadCalls);

  const finalProbe = await stopBackgroundProbe(page);
  expect(
    await page.evaluate(() => {
      const marked = (window as unknown as FixtureWindow).__INK_CT_CANVAS__;
      const current = document.querySelector('[data-testid="ink-page-canvas"]');
      return Boolean(marked && current && marked === current && marked.isConnected);
    }),
  ).toBe(true);
  expect(finalProbe.whiteFrames, `white background frames: ${JSON.stringify(finalProbe)}`).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('refreshes PDF source highlights when the source annotations change remotely', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" pdfPageBackground />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => readCanvasPixel(canvas, 40, 30)).toEqual(PDF_HIGHLIGHT_BLUE);

  await page.evaluate(() => {
    const fixtureWindow = window as unknown as FixtureWindow;
    const backend = fixtureWindow.__INK_EDITOR_CT_BACKEND__;
    if (!backend) throw new Error('Ink CT backend is unavailable');
    const current = backend.readPage('ink-editor-ct-page-2');
    if (!current) throw new Error('Fixture page is missing');
    backend.updatePdfSourceHighlights([{
      id: 'pdf-highlight-updated',
      pageIndex: 0,
      color: '#00ff0080',
      rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.3 }],
      createdAt: 43,
      coordVersion: 2,
    }]);
    backend.advanceRemotePage('ink-editor-ct-page-2', current);
  });
  await page.evaluate(async () => {
    const fixtureWindow = window as unknown as FixtureWindow;
    const backend = fixtureWindow.__INK_EDITOR_CT_BACKEND__;
    if (!backend || !fixtureWindow.__INK_EDITOR_EMIT_CHANGED__) throw new Error('Ink changed fixture is unavailable');
    await fixtureWindow.__INK_EDITOR_EMIT_CHANGED__('ink-editor-ct-document', backend.readManifest().revision);
  });

  await expect.poll(() => readCanvasPixel(canvas, 40, 30)).toEqual([110, 221, 110, 255]);
  await expect.poll(() => readCanvasPixel(canvas, 5, 5)).toEqual(PDF_BACKGROUND);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
  expect(await component.getByRole('alert').count()).toBe(0);
});

test('does not paint a page-2 background read held during navigation onto page 1', async ({ mount, page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const component = await mount(<InkEditorHarness saveMode="success" imageBackground />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => readCanvasPixel(canvas, 5, 5)).toEqual(IMAGE_BACKGROUND);

  // Leaving page 2 releases its cached decoded bitmap; returning must issue a
  // fresh background read that this test can hold open.
  await component.getByTestId('ink-page-previous').click();
  await expect(canvas).toHaveAttribute('data-page-id', 'ink-editor-ct-page-1');
  await waitForAnimationFrames(page, 8);
  expect(await readCanvasPixel(canvas, 5, 5)).toEqual([255, 255, 255, 255]);

  await page.evaluate(() => {
    (window as unknown as FixtureWindow).__INK_EDITOR_CT_BACKEND__?.holdBackgroundReads(true);
  });
  await component.getByTestId('ink-page-next').click();
  await expect(canvas).toHaveAttribute('data-page-id', inkEditorPageId);
  await expect.poll(() => readBackend(page).then((value) => value.pendingBackgroundReads)).toBe(1);
  expect(await readCanvasPixel(canvas, 5, 5)).toEqual([255, 255, 255, 255]);

  // Navigate away while the initial page-2 read is still pending, then release
  // it. The late decode must be cancelled instead of painting onto page 1.
  await component.getByTestId('ink-page-previous').click();
  await expect(canvas).toHaveAttribute('data-page-id', 'ink-editor-ct-page-1');
  const released = await page.evaluate(() => (window as unknown as FixtureWindow)
    .__INK_EDITOR_CT_BACKEND__?.releaseHeldBackgroundReads() ?? 0);
  expect(released, 'exactly one real pending page-2 background read must be released').toBe(1);
  await expect.poll(() => readBackend(page).then((value) => value.pendingBackgroundReads)).toBe(0);
  await waitForAnimationFrames(page, 10);

  await expect(canvas).toHaveAttribute('data-page-id', 'ink-editor-ct-page-1');
  expect(await readCanvasPixel(canvas, 5, 5)).toEqual([255, 255, 255, 255]);
  expect(await readCanvasPixel(canvas, 110, 150)).toEqual([255, 255, 255, 255]);
  expect(await readCanvasPixel(canvas, 5, 5)).not.toEqual(IMAGE_BACKGROUND);
  expect(await component.getByRole('alert').count()).toBe(0);

  await component.getByTestId('ink-page-next').click();
  await expect(canvas).toHaveAttribute('data-page-id', inkEditorPageId);
  await expect.poll(() => readCanvasPixel(canvas, 5, 5)).toEqual(IMAGE_BACKGROUND);
  expect(pageErrors).toEqual([]);
});
