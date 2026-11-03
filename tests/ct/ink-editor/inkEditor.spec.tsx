import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { Page } from '@playwright/test';
import type { InkPage } from '@/features/ink/types';
import { InkEditorHarness } from './InkEditorHarness';
import { inkEditorDocumentId, inkEditorPageId } from './fixtures';

async function drawStroke(page: Page, canvas: ReturnType<Page['locator']>, localY = 72) {
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Ink page canvas has no visible bounds');
  await page.mouse.move(bounds.x + 18, bounds.y + localY);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 48, bounds.y + localY, { steps: 4 });
  await page.mouse.move(bounds.x + 96, bounds.y + localY, { steps: 4 });
  await page.mouse.up();
}

async function countInkPixels(canvas: ReturnType<Page['locator']>) {
  return canvas.evaluate((element) => {
    const target = element as HTMLCanvasElement;
    const context = target.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    const pixels = context.getImageData(0, 0, target.width, target.height).data;
    let count = 0;
    for (let y = 56; y < 88; y += 1) {
      for (let x = 12; x < 108; x += 1) {
        const offset = (y * target.width + x) * 4;
        if (pixels[offset] < 48 && pixels[offset + 1] < 48 && pixels[offset + 2] < 48 && pixels[offset + 3] > 240) count += 1;
      }
    }
    return count;
  });
}

async function hasBlueFixtureStroke(canvas: ReturnType<Page['locator']>) {
  return canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    const [red, green, blue, alpha] = context.getImageData(48, 20, 1, 1).data;
    return red === 0 && green === 0 && blue === 255 && alpha === 255;
  });
}

async function readFixturePage(page: Page, pageId = inkEditorPageId): Promise<InkPage | undefined> {
  return page.evaluate(({ documentId, pageId }) => {
    const backend = (window as Window & {
      __INK_EDITOR_CT_BACKEND__?: { readPage(id: string): InkPage | undefined };
    }).__INK_EDITOR_CT_BACKEND__;
    if (!backend || documentId !== 'ink-editor-ct-document') return undefined;
    return backend.readPage(pageId);
  }, { documentId: inkEditorDocumentId, pageId });
}

async function hasRedPixelAt(canvas: ReturnType<Page['locator']>, x: number, y: number) {
  return canvas.evaluate((element, point) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    const [red, green, blue] = context.getImageData(point.x, point.y, 1, 1).data;
    return red > 180 && green < 80 && blue < 80;
  }, { x, y });
}

test('loads the requested page, writes one real pointer stroke, saves, and reopens it', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  const saveState = component.getByTestId('ink-editor-save-state');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-document-id', inkEditorDocumentId);
  await expect(canvas).toHaveAttribute('data-page-id', inkEditorPageId);

  await drawStroke(page, canvas);
  await expect.poll(() => hasBlueFixtureStroke(canvas)).toBe(true);
  await expect.poll(() => countInkPixels(canvas)).toBeGreaterThan(10);
  await expect(saveState).toHaveAttribute('data-state', 'saved');
  expect((await readFixturePage(page))?.objects.some((object) => object.content.kind === 'stroke' && object.id !== 'fixture-blue-stroke')).toBe(true);

  await component.getByTestId('ink-editor-unmount').click();
  await component.getByTestId('ink-editor-remount').click();
  const reopenedCanvas = component.getByTestId('ink-page-canvas');
  await expect(reopenedCanvas).toBeVisible();
  await expect.poll(() => countInkPixels(reopenedCanvas)).toBeGreaterThan(10);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
});

test('keeps the local stroke visible and recoverable after a revision conflict', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="conflict" />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await drawStroke(page, canvas);

  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'conflict');
  await expect.poll(() => countInkPixels(canvas)).toBeGreaterThan(10);
  await component.getByTestId('ink-editor-unmount').click();
  await component.getByTestId('ink-editor-remount').click();
  const recoveredCanvas = component.getByTestId('ink-page-canvas');
  await expect(recoveredCanvas).toBeVisible();
  await expect.poll(() => countInkPixels(recoveredCanvas)).toBeGreaterThan(10);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'conflict');
});

test('recovers a persisted unsaved stroke after the page is hidden and the editor remounts', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="offline" />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await drawStroke(page, canvas);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'offline');
  await expect.poll(() => countInkPixels(canvas)).toBeGreaterThan(10);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await component.getByTestId('ink-editor-unmount').click();
  await component.getByTestId('ink-editor-remount').click();

  const recoveredCanvas = component.getByTestId('ink-page-canvas');
  await expect(recoveredCanvas).toBeVisible();
  await expect.poll(() => countInkPixels(recoveredCanvas)).toBeGreaterThan(10);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'offline');
});

test('classifies an offline draft as conflict when the remote page advanced before remount and never overwrites it', async ({ mount, page }) => {
  const documentId = 'ink-editor-ct-remote-drift';
  const component = await mount(<InkEditorHarness saveMode="offline-once" documentId={documentId} />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await drawStroke(page, canvas);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'offline');
  await component.getByTestId('ink-editor-unmount').click();
  await component.getByTestId('ink-editor-advance-remote').click();
  await component.getByTestId('ink-editor-remount').click();

  const recoveredCanvas = component.getByTestId('ink-page-canvas');
  const saveState = component.getByTestId('ink-editor-save-state');
  await expect(recoveredCanvas).toBeVisible();
  await expect.poll(() => countInkPixels(recoveredCanvas)).toBeGreaterThan(10);
  const recoveredStatus = await saveState.getAttribute('data-state');
  await component.getByTestId('ink-editor-flush').click();
  const flushResult = await page.evaluate(() => (window as Window & {
    __INK_EDITOR_FLUSH_RESULT__?: { ok: boolean; code?: string };
  }).__INK_EDITOR_FLUSH_RESULT__);
  const retryButton = component.getByRole('button', { name: 'actions.retrySave' });
  const retryButtonCount = await retryButton.count();
  const reloadButtonCount = await component.getByRole('button', { name: 'actions.reloadRemote' }).count();
  if (retryButtonCount > 0) {
    await retryButton.click();
    await expect.poll(() => page.evaluate(() => (window as Window & {
      __INK_EDITOR_CT_BACKEND__?: { saveCalls: number };
    }).__INK_EDITOR_CT_BACKEND__?.saveCalls)).toBeGreaterThan(1);
  }
  const backendState = await page.evaluate(({ pageId }) => {
    const backend = (window as Window & { __INK_EDITOR_CT_BACKEND__?: {
      readPage(id: string): InkPage | undefined;
      saveCalls: number;
      readManifest(): { revision: string };
    } }).__INK_EDITOR_CT_BACKEND__;
    return {
      page: backend?.readPage(pageId),
      saveCalls: backend?.saveCalls,
      revision: backend?.readManifest().revision,
    };
  }, { pageId: inkEditorPageId });

  expect(recoveredStatus).toBe('conflict');
  expect(flushResult).toMatchObject({ ok: false, code: 'EDITOR_BUSY' });
  expect(retryButtonCount).toBe(0);
  expect(reloadButtonCount).toBe(1);
  expect(backendState.saveCalls).toBe(1);
  expect(backendState.page?.objects.map((object) => object.id)).toEqual(['fixture-blue-stroke', 'human-remote-stroke']);
  expect(backendState.revision).toBe('revision-2');
});

test('applies selected pen color and width to the saved stroke and real canvas pixels', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();

  await component.getByTestId('ink-tool-pen').click();
  await component.getByTestId('ink-color-red').click();
  await component.getByTestId('ink-width-large').click();
  const activeCanvas = component.getByTestId('ink-active-stroke-canvas');
  await drawStroke(page, activeCanvas, 72);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');

  await component.getByTestId('ink-tool-highlighter').click();
  await component.getByTestId('ink-color-blue').click();
  await component.getByTestId('ink-width-medium').click();
  await drawStroke(page, activeCanvas, 102);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');

  const pageValue = await readFixturePage(page);
  const newStrokes = pageValue?.objects.filter((object) => object.content.kind === 'stroke' && object.id !== 'fixture-blue-stroke');
  expect(newStrokes).toHaveLength(2);
  expect(newStrokes?.[0].content).toMatchObject({
    kind: 'stroke',
    style: { tool: 'pen', color: '#ff0000', width: 12 },
  });
  expect(newStrokes?.[1].content).toMatchObject({
    kind: 'stroke',
    style: { tool: 'highlighter', color: '#0000ff80', width: 8 },
  });
  const colorPixels = await canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    const allPixels = context.getImageData(0, 0, 120, 160).data;
    const countInBand = (top: number, bottom: number, matches: (red: number, green: number, blue: number) => boolean) => {
      let count = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = 12; x < 108; x += 1) {
          const index = (y * 120 + x) * 4;
          if (matches(allPixels[index], allPixels[index + 1], allPixels[index + 2])) count += 1;
        }
      }
      return count;
    };
    return {
      redPen: countInBand(60, 84, (red, green, blue) => red > green + 80 && red > blue + 80),
      blueHighlighter: countInBand(90, 114, (red, green, blue) => blue > red + 40 && blue > green + 40),
    };
  });
  expect(colorPixels.redPen).toBeGreaterThan(10);
  expect(colorPixels.blueHighlighter).toBeGreaterThan(10);
});

test('erases a whole stroke and restores/removes it with undo and redo on the real canvas', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  const inputCanvas = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toBeVisible();
  await component.getByTestId('ink-eraser-tool').click();
  await inputCanvas.click({ position: { x: 48, y: 20 } });
  await expect.poll(() => hasBlueFixtureStroke(canvas)).toBe(false);

  await component.getByTestId('ink-undo').click();
  await expect.poll(() => hasBlueFixtureStroke(canvas)).toBe(true);
  await component.getByTestId('ink-redo').click();
  await expect.poll(() => hasBlueFixtureStroke(canvas)).toBe(false);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
  await expect.poll(async () => (await readFixturePage(page))?.objects.map((object) => object.id)).toEqual([]);

  const savedPage = await readFixturePage(page);
  expect(savedPage?.objects.some((object) => object.id === 'fixture-blue-stroke')).toBe(false);
});

test('navigates pages and appends/renames through revisioned API requests', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await component.getByTestId('ink-page-previous').click();
  await expect(canvas).toHaveAttribute('data-page-id', 'ink-editor-ct-page-1');
  await component.getByTestId('ink-page-next').click();
  await expect(canvas).toHaveAttribute('data-page-id', inkEditorPageId);

  await component.getByTestId('ink-page-append').click();
  await expect(canvas).toHaveAttribute('data-page-id', 'ink-editor-ct-page-3');
  await component.getByTestId('ink-rename-title').fill('Renamed CT page');
  await component.getByTestId('ink-rename-submit').click();
  await expect(component.getByTestId('ink-editor-title')).toHaveText('Renamed CT page');

  const apiWrites = await page.evaluate(() => {
    const backend = (window as Window & { __INK_EDITOR_CT_BACKEND__?: {
      appendCalls: number;
      appendRequest?: { document_id?: string; expected_revision?: string; operation_id?: string; width?: number; height?: number; ruling?: string };
      renameCalls: number;
      renameRequest?: { document_id?: string; expected_revision?: string; operation_id?: string; title?: string };
      readManifest(): { revision: string; pages: Array<{ page_id: string }> };
    } }).__INK_EDITOR_CT_BACKEND__;
    return backend ? {
      appendCalls: backend.appendCalls,
      appendRequest: backend.appendRequest,
      renameCalls: backend.renameCalls,
      renameRequest: backend.renameRequest,
      manifest: backend.readManifest(),
    } : undefined;
  });

  expect(apiWrites?.appendCalls).toBe(1);
  expect(apiWrites?.appendRequest).toMatchObject({
    document_id: inkEditorDocumentId,
    expected_revision: 'revision-1',
    width: 120,
    height: 160,
    ruling: 'blank',
  });
  expect(apiWrites?.appendRequest?.operation_id).toBeTruthy();
  expect(apiWrites?.renameCalls).toBe(1);
  expect(apiWrites?.renameRequest).toMatchObject({ title: 'Renamed CT page' });
  expect(apiWrites?.renameRequest?.operation_id).toBeTruthy();
  expect(apiWrites?.renameRequest?.expected_revision).toBe('revision-2');
  expect(apiWrites?.manifest.pages.map((pageRef) => pageRef.page_id)).toContain('ink-editor-ct-page-3');
});

test('zooms the rendered page while keeping pointer samples in page coordinates', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await component.getByTestId('ink-zoom-in').click();
  await expect(component.getByTestId('ink-zoom-level')).toHaveText('125%');
  const cssWidth = await canvas.evaluate((element) => element.getBoundingClientRect().width);
  expect(cssWidth).toBeGreaterThan(120);

  await drawStroke(page, component.getByTestId('ink-active-stroke-canvas'), 90);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
  const saved = await readFixturePage(page);
  const stroke = saved?.objects.find((object) => object.content.kind === 'stroke' && object.id !== 'fixture-blue-stroke');
  expect(stroke?.content.kind).toBe('stroke');
  if (stroke?.content.kind === 'stroke') {
    expect(stroke.content.samples[0].x).toBeGreaterThanOrEqual(0);
    expect(stroke.content.samples[0].x).toBeLessThan(30);
    expect(stroke.content.samples[0].y).toBeGreaterThan(60);
    expect(stroke.content.samples[0].y).toBeLessThan(84);
  }
});

test('requires explicit touch drawing and uses the shared page input surface', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  const activeCanvas = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toBeVisible();

  await page.evaluate(() => {
    const canvasElement = document.querySelector('[data-testid="ink-active-stroke-canvas"]');
    if (!canvasElement) throw new Error('Ink page input canvas is missing');
    const event = (type: string, pointerId: number) => new PointerEvent(type, {
      pointerId, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
      clientX: 20, clientY: 72, pressure: 0.5,
    });
    canvasElement.dispatchEvent(event('pointerdown', 11));
    canvasElement.dispatchEvent(event('pointerup', 11));
  });
  expect((await readFixturePage(page))?.objects).toHaveLength(1);

  await component.getByTestId('ink-touch-draw-toggle').click();
  const bounds = await activeCanvas.boundingBox();
  if (!bounds) throw new Error('Ink page input canvas has no visible bounds');
  await page.evaluate(({ left, top }) => {
    const canvasElement = document.querySelector('[data-testid="ink-active-stroke-canvas"]');
    if (!canvasElement) throw new Error('Ink page input canvas is missing');
    const send = (type: string, x: number, y: number, pointerId: number) => canvasElement.dispatchEvent(new PointerEvent(type, {
      pointerId, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
      clientX: left + x, clientY: top + y, pressure: 0.5,
    }));
    send('pointerdown', 18, 72, 12);
    send('pointermove', 70, 72, 12);
    send('pointerup', 96, 72, 12);
  }, { left: bounds.x, top: bounds.y });
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
  const drawnPage = await readFixturePage(page);
  expect(drawnPage?.objects.some((object) => object.content.kind === 'stroke' && object.id !== 'fixture-blue-stroke')).toBe(true);
});

test('composites active highlighter over cached page with final pixels and keeps completed pixels off the active layer', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const pageCanvas = component.getByTestId('ink-page-canvas');
  const activeCanvas = component.getByTestId('ink-active-stroke-canvas');
  await expect(pageCanvas).toBeVisible();
  await component.getByTestId('ink-tool-highlighter').click();
  await component.getByTestId('ink-color-blue').click();
  await component.getByTestId('ink-width-large').click();
  const bounds = await activeCanvas.boundingBox();
  if (!bounds) throw new Error('Ink page input canvas has no visible bounds');

  const dispatch = async (type: string, x: number, y: number, pressure: number) => page.evaluate(({ type, x, y, pressure, left, top }) => {
    const target = document.querySelector('[data-testid="ink-active-stroke-canvas"]');
    if (!target) throw new Error('Ink page input canvas is missing');
    target.dispatchEvent(new PointerEvent(type, {
      pointerId: 84,
      pointerType: 'pen',
      isPrimary: true,
      pressure,
      clientX: left + x,
      clientY: top + y,
      bubbles: true,
      cancelable: true,
    }));
  }, { type, x, y, pressure, left: bounds.x, top: bounds.y });

  await dispatch('pointerdown', 24, 20, 0.2);
  await dispatch('pointermove', 48, 20, 0.8);
  await dispatch('pointermove', 96, 20, 0.5);
  await dispatch('pointermove', 24, 50, 0.5);
  await dispatch('pointermove', 48, 50, 0.5);
  await dispatch('pointermove', 96, 50, 0.45);
  const preview = await page.evaluate(() => {
    const pageCanvasElement = document.querySelector('[data-testid="ink-page-canvas"]') as HTMLCanvasElement | null;
    const overlay = document.querySelector('[data-testid="ink-active-stroke-canvas"]') as HTMLCanvasElement | null;
    if (!pageCanvasElement || !overlay) throw new Error('Ink renderer canvases are missing');
    const composed = document.createElement('canvas');
    composed.width = pageCanvasElement.width;
    composed.height = pageCanvasElement.height;
    const context = composed.getContext('2d');
    const overlayContext = overlay.getContext('2d');
    if (!context || !overlayContext) throw new Error('Canvas 2D context is unavailable');
    context.drawImage(pageCanvasElement, 0, 0);
    context.globalCompositeOperation = getComputedStyle(overlay).mixBlendMode === 'multiply' ? 'multiply' : 'source-over';
    context.drawImage(overlay, 0, 0);
    const completedFixturePixel = Array.from(context.getImageData(48, 20, 1, 1).data);
    const blueOnBlue = Array.from(context.getImageData(48, 20, 1, 1).data);
    const activeHighlighterPixel = Array.from(context.getImageData(48, 50, 1, 1).data);
    const completedOnlyPixel = Array.from(overlayContext.getImageData(110, 50, 1, 1).data);
    const overlayStrokePixels = (() => {
      const pixels = overlayContext.getImageData(0, 0, overlay.width, overlay.height).data;
      let count = 0;
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) count += 1;
      return count;
    })();
    const completedPagePixels = (() => {
      const pixels = context.getImageData(0, 0, composed.width, composed.height).data;
      let count = 0;
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) count += 1;
      return count;
    })();
    return {
      blendMode: getComputedStyle(overlay).mixBlendMode,
      completedFixturePixel,
      blueOnBlue,
      activeHighlighterPixel,
      completedOnlyPixel,
      overlayStrokePixels,
      completedPagePixels,
      pixels: Array.from(context.getImageData(0, 0, composed.width, composed.height).data),
    };
  });
  expect(preview.blendMode).toBe('multiply');
  expect(preview.overlayStrokePixels).toBeGreaterThan(10);
  expect(preview.completedPagePixels).toBeGreaterThan(preview.overlayStrokePixels);
  expect(preview.completedOnlyPixel[3]).toBe(0);
  expect(preview.completedFixturePixel.slice(0, 3)).toEqual([0, 0, 255]);
  expect(preview.blueOnBlue).toEqual([0, 0, 255, 255]);
  expect(preview.activeHighlighterPixel).toEqual([127, 127, 255, 255]);

  await dispatch('pointerup', 96, 50, 0.45);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
  const finalPixels = await pageCanvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
  });
  expect(finalPixels).toEqual(preview.pixels);
});

test('does not conflict on native ink:changed events emitted before successive save responses resolve', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="save-echo" />);
  const input = component.getByTestId('ink-active-stroke-canvas');
  await expect(component.getByTestId('ink-page-canvas')).toBeVisible();
  await drawStroke(page, input, 72);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
  await drawStroke(page, input, 96);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
  const savedPage = await readFixturePage(page);
  expect(savedPage?.objects.filter((object) => object.content.kind === 'stroke')).toHaveLength(3);
  await component.getByTestId('ink-editor-flush').click();
  const flushResult = await page.evaluate(() => (window as Window & {
    __INK_EDITOR_FLUSH_RESULT__?: { ok: boolean; code?: string };
  }).__INK_EDITOR_FLUSH_RESULT__);
  expect(flushResult).toEqual({ ok: true });
});

test('keeps an active pointer stroke dirty during a remote ink:changed event', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const input = component.getByTestId('ink-active-stroke-canvas');
  await expect(component.getByTestId('ink-page-canvas')).toBeVisible();
  const bounds = await input.boundingBox();
  if (!bounds) throw new Error('Ink page input canvas has no visible bounds');
  await page.evaluate(({ left, top }) => {
    const target = document.querySelector('[data-testid="ink-active-stroke-canvas"]');
    if (!target) throw new Error('Ink page input canvas is missing');
    const send = (type: string, x: number) => target.dispatchEvent(new PointerEvent(type, {
      pointerId: 94, pointerType: 'pen', isPrimary: true, pressure: 0.5,
      clientX: left + x, clientY: top + 72, bubbles: true, cancelable: true,
    }));
    send('pointerdown', 18);
    send('pointermove', 56);
    document.querySelector('[data-testid="ink-editor-advance-remote-external"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, { left: bounds.x, top: bounds.y });
  await expect.poll(() => countInkPixels(input)).toBeGreaterThan(5);
  await page.evaluate(async () => {
    const fixtureWindow = window as Window & {
      __INK_EDITOR_CT_BACKEND__?: { readManifest(): { revision: string } };
      __INK_EDITOR_EMIT_CHANGED__?: (documentId: string, revision: string) => Promise<void>;
    };
    const revision = fixtureWindow.__INK_EDITOR_CT_BACKEND__?.readManifest().revision;
    if (!revision || !fixtureWindow.__INK_EDITOR_EMIT_CHANGED__) throw new Error('Ink event test fixture is unavailable');
    await fixtureWindow.__INK_EDITOR_EMIT_CHANGED__('ink-editor-ct-document', revision);
  });
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'conflict');
  await component.getByTestId('ink-editor-flush').click();
  await expect.poll(() => page.evaluate(() => (window as Window & {
    __INK_EDITOR_FLUSH_RESULT__?: { ok: boolean; code?: string };
  }).__INK_EDITOR_FLUSH_RESULT__)).toMatchObject({ ok: false, code: 'EDITOR_BUSY' });
  await expect.poll(async () => (await readFixturePage(page))?.objects.map((object) => object.id)).toEqual(['fixture-blue-stroke', 'external-remote-stroke']);
  await page.evaluate(() => {
    document.querySelector('[data-testid="ink-active-stroke-canvas"]')?.dispatchEvent(new PointerEvent('pointercancel', {
      pointerId: 94, pointerType: 'pen', bubbles: true, cancelable: true,
    }));
  });
});

test('keeps pointer-down pen style frozen while toolbar changes before pointerup', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toBeVisible();
  await component.getByTestId('ink-color-red').click();
  await component.getByTestId('ink-width-large').click();
  const bounds = await input.boundingBox();
  if (!bounds) throw new Error('Ink page input canvas has no visible bounds');
  const send = (type: string, x: number) => page.evaluate(({ type, x, left, top }) => {
    const target = document.querySelector('[data-testid="ink-active-stroke-canvas"]');
    if (!target) throw new Error('Ink page input canvas is missing');
    target.dispatchEvent(new PointerEvent(type, {
      pointerId: 77, pointerType: 'pen', isPrimary: true, pressure: 0.6,
      clientX: left + x, clientY: top + 76, bubbles: true, cancelable: true,
    }));
  }, { type, x, left: bounds.x, top: bounds.y });
  await send('pointerdown', 24);
  await component.getByTestId('ink-tool-highlighter').click();
  await component.getByTestId('ink-color-blue').click();
  await component.getByTestId('ink-width-small').click();
  await send('pointermove', 64);
  await send('pointerup', 96);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
  const pageValue = await readFixturePage(page);
  const stroke = pageValue?.objects.find((object) => object.content.kind === 'stroke' && object.id !== 'fixture-blue-stroke');
  expect(stroke?.content).toMatchObject({ kind: 'stroke', style: { tool: 'pen', color: '#ff0000', width: 12 } });
});

test('preserves an active unsaved stroke as dirty when ink:changed refetches a remote page', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toBeVisible();
  const bounds = await input.boundingBox();
  if (!bounds) throw new Error('Ink page input canvas has no visible bounds');
  await page.evaluate(({ left, top }) => {
    const target = document.querySelector('[data-testid="ink-active-stroke-canvas"]');
    if (!target) throw new Error('Ink page input canvas is missing');
    const send = (type: string, x: number) => target.dispatchEvent(new PointerEvent(type, {
      pointerId: 93, pointerType: 'pen', isPrimary: true, pressure: 0.5,
      clientX: left + x, clientY: top + 72, bubbles: true, cancelable: true,
    }));
    send('pointerdown', 18);
    send('pointermove', 56);
  }, { left: bounds.x, top: bounds.y });
  await expect.poll(() => countInkPixels(input)).toBeGreaterThan(5);
  await page.evaluate(async () => {
    const fixtureWindow = window as Window & {
      __INK_EDITOR_CT_BACKEND__?: { readManifest(): { revision: string } };
      __INK_EDITOR_ADVANCE_REMOTE__?: () => void;
      __INK_EDITOR_EMIT_CHANGED__?: (documentId: string, revision: string) => Promise<void>;
    };
    fixtureWindow.__INK_EDITOR_ADVANCE_REMOTE__?.();
    const revision = fixtureWindow.__INK_EDITOR_CT_BACKEND__?.readManifest().revision;
    if (!revision || !fixtureWindow.__INK_EDITOR_EMIT_CHANGED__) throw new Error('Ink event test fixture is unavailable');
    await fixtureWindow.__INK_EDITOR_EMIT_CHANGED__('ink-editor-ct-document', revision);
  });
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'conflict');
  await expect.poll(() => countInkPixels(input)).toBeGreaterThan(5);
  await component.getByTestId('ink-editor-flush').click();
  await expect.poll(async () => (await readFixturePage(page))?.objects.map((object) => object.id)).toEqual(['fixture-blue-stroke', 'external-remote-stroke']);
  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="ink-active-stroke-canvas"]');
    target?.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 93, pointerType: 'pen', bubbles: true, cancelable: true }));
  });
});

test('persists an active pointer stroke on pagehide while document visibility remains visible', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-active-stroke-canvas');
  await expect(component.getByTestId('ink-page-canvas')).toBeVisible();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Ink page input canvas has no visible bounds');

  await page.mouse.move(bounds.x + 18, bounds.y + 72);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 56, bounds.y + 72, { steps: 4 });
  await expect.poll(() => countInkPixels(canvas)).toBeGreaterThan(10);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
  });

  await expect.poll(async () => (await readFixturePage(page))?.objects.length).toBe(2);
  await component.getByTestId('ink-editor-unmount').click();
  await component.getByTestId('ink-editor-remount').click();
  const reopenedCanvas = component.getByTestId('ink-page-canvas');
  await expect(reopenedCanvas).toBeVisible();
  await expect.poll(() => countInkPixels(reopenedCanvas)).toBeGreaterThan(10);
});

test('reports draft-store failure without claiming a durable draft was kept', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  await expect(component.getByTestId('ink-page-canvas')).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(indexedDB, 'open', { configurable: true, value: () => { throw new Error('quota exceeded'); } });
  });
  await drawStroke(page, component.getByTestId('ink-active-stroke-canvas'));
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'storage-error');
  await expect(component.getByTestId('ink-editor-save-state')).not.toContainText(/draft is kept|draft kept/i);
  const saveCalls = await page.evaluate(() => (window as Window & {
    __INK_EDITOR_CT_BACKEND__?: { saveCalls: number };
  }).__INK_EDITOR_CT_BACKEND__?.saveCalls);
  expect(saveCalls).toBe(0);
});

test('loads image page backgrounds through the existing VFS blob boundary', async ({ mount }) => {
  const component = await mount(<InkEditorHarness saveMode="success" imageBackground />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    const [red, green, blue] = context.getImageData(60, 80, 1, 1).data;
    return red > 200 && green < 50 && blue < 50;
  })).toBe(true);
});

test('uses prepared PNG bytes for PDF-page backgrounds and paints normalized source highlights before Ink', async ({ mount }) => {
  const component = await mount(<InkEditorHarness saveMode="success" pdfPageBackground />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await expect(component.getByRole('alert')).toHaveCount(0);

  const pixels = await canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    return {
      background: Array.from(context.getImageData(5, 5, 1, 1).data),
      sourceHighlight: Array.from(context.getImageData(40, 30, 1, 1).data),
      inkOverSource: Array.from(context.getImageData(20, 20, 1, 1).data),
    };
  });
  expect(pixels.background).toEqual([221, 221, 221, 255]);
  expect(pixels.sourceHighlight).toEqual([110, 110, 221, 255]);
  expect(pixels.inkOverSource).toEqual([0, 0, 255, 255]);
});

test('refetches the loaded page on a matching ink:changed event instead of trusting payload content', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await component.getByTestId('ink-editor-advance-remote-external').click();
  const before = await page.evaluate(() => {
    const backend = (window as Window & { __INK_EDITOR_CT_BACKEND__?: { getCalls: number; getPageCalls: number } }).__INK_EDITOR_CT_BACKEND__;
    return backend ? [backend.getCalls, backend.getPageCalls] : [0, 0];
  });
  await component.getByTestId('ink-editor-emit-changed').click();
  await expect.poll(() => page.evaluate(() => {
    const backend = (window as Window & { __INK_EDITOR_CT_BACKEND__?: { getCalls: number; getPageCalls: number } }).__INK_EDITOR_CT_BACKEND__;
    return backend ? [backend.getCalls, backend.getPageCalls] : [];
  })).toEqual([before[0] + 1, before[1] + 1]);
  await expect.poll(() => canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    const [red, green, blue] = context.getImageData(48, 130, 1, 1).data;
    return red > 180 && green < 80 && blue < 80;
  })).toBe(true);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
});

test('does not overwrite a dirty page after an ink:changed event and marks the refreshed document conflicted', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="offline" />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await drawStroke(page, component.getByTestId('ink-active-stroke-canvas'), 72);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'offline');

  await component.getByTestId('ink-editor-advance-remote-external').click();
  await component.getByTestId('ink-editor-emit-changed').click();
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'conflict');
  await expect.poll(() => countInkPixels(canvas)).toBeGreaterThan(10);
  await component.getByTestId('ink-editor-flush').click();
  const flushResult = await page.evaluate(() => (window as Window & {
    __INK_EDITOR_FLUSH_RESULT__?: { ok: boolean; code?: string };
  }).__INK_EDITOR_FLUSH_RESULT__);
  const backendState = await page.evaluate(({ pageId }) => {
    const backend = (window as Window & { __INK_EDITOR_CT_BACKEND__?: {
      getCalls: number;
      getPageCalls: number;
      saveCalls: number;
      readPage(id: string): InkPage | undefined;
      readManifest(): { revision: string };
    } }).__INK_EDITOR_CT_BACKEND__;
    return backend && {
      getCalls: backend.getCalls,
      getPageCalls: backend.getPageCalls,
      saveCalls: backend.saveCalls,
      remotePage: backend.readPage(pageId),
      revision: backend.readManifest().revision,
    };
  }, { pageId: inkEditorPageId });

  expect(flushResult).toMatchObject({ ok: false, code: 'EDITOR_BUSY' });
  expect(backendState?.saveCalls).toBe(1);
  expect(backendState?.remotePage?.objects.some((object) => object.id === 'external-remote-stroke')).toBe(true);
  expect(backendState?.revision).toBe('revision-2');
});

test('invalidates page undo history after a clean external ink:changed reload', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  await expect(component.getByTestId('ink-page-canvas')).toBeVisible();
  await drawStroke(page, component.getByTestId('ink-active-stroke-canvas'), 72);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
  await expect(component.getByTestId('ink-undo')).toBeEnabled();

  await component.getByTestId('ink-editor-advance-remote-external').click();
  await component.getByTestId('ink-editor-emit-changed').click();
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
  await expect(component.getByTestId('ink-undo')).toBeDisabled();

  const remotePage = await readFixturePage(page);
  expect(remotePage?.objects.some((object) => object.id === 'external-remote-stroke')).toBe(true);
  expect(remotePage?.objects.some((object) => object.content.kind === 'stroke' && object.id !== 'fixture-blue-stroke' && object.id !== 'external-remote-stroke')).toBe(true);
});

test('ignores changed events from other documents without reading or changing this page', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  const before = await page.evaluate(() => {
    const backend = (window as Window & { __INK_EDITOR_CT_BACKEND__?: { getCalls: number; getPageCalls: number; readManifest(): { revision: string } } }).__INK_EDITOR_CT_BACKEND__;
    return backend ? [backend.getCalls, backend.getPageCalls, backend.readManifest().revision] : [];
  });
  await component.getByTestId('ink-editor-emit-wrong-document').click();
  await page.waitForTimeout(0);
  const after = await page.evaluate(() => {
    const backend = (window as Window & { __INK_EDITOR_CT_BACKEND__?: { getCalls: number; getPageCalls: number; readManifest(): { revision: string } } }).__INK_EDITOR_CT_BACKEND__;
    return backend ? [backend.getCalls, backend.getPageCalls, backend.readManifest().revision] : [];
  });
  expect(after).toEqual(before);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
});

test('refetches revision and page rather than trusting ink:changed payload revision', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await component.getByTestId('ink-editor-advance-remote-external').click();
  const before = await page.evaluate(() => {
    const backend = (window as Window & { __INK_EDITOR_CT_BACKEND__?: { getCalls: number; getPageCalls: number; readManifest(): { revision: string } } }).__INK_EDITOR_CT_BACKEND__;
    return backend ? [backend.getCalls, backend.getPageCalls, backend.readManifest().revision] : [];
  });
  await component.getByTestId('ink-editor-emit-forged-changed').click();
  await expect.poll(() => page.evaluate(() => {
    const backend = (window as Window & { __INK_EDITOR_CT_BACKEND__?: { getCalls: number; getPageCalls: number } }).__INK_EDITOR_CT_BACKEND__;
    return backend ? [backend.getCalls, backend.getPageCalls] : [];
  })).toEqual([before[0] + 1, before[1] + 1]);
  await expect.poll(() => canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    const [red, green, blue] = context.getImageData(48, 130, 1, 1).data;
    return red > 180 && green < 80 && blue < 80;
  })).toBe(true);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
});

test('treats OPERATION_STATE_UNKNOWN as a read-required conflict instead of offering retry', async ({ mount, page }) => {
  const documentId = 'ink-editor-ct-operation-unknown';
  const component = await mount(<InkEditorHarness saveMode="operation-unknown" documentId={documentId} />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await drawStroke(page, canvas);
  const saveState = component.getByTestId('ink-editor-save-state');
  await expect(saveState).toHaveAttribute('data-state', 'conflict');
  await component.getByTestId('ink-editor-flush').click();
  const flushResult = await page.evaluate(() => (window as Window & {
    __INK_EDITOR_FLUSH_RESULT__?: { ok: boolean; code?: string };
  }).__INK_EDITOR_FLUSH_RESULT__);
  const retryButtonCount = await component.getByRole('button', { name: 'actions.retrySave' }).count();
  const backendSaveCalls = await page.evaluate(() => (window as Window & {
    __INK_EDITOR_CT_BACKEND__?: { saveCalls: number };
  }).__INK_EDITOR_CT_BACKEND__?.saveCalls);

  expect(flushResult).toMatchObject({ ok: false, code: 'EDITOR_BUSY' });
  expect(retryButtonCount).toBe(0);
  expect(backendSaveCalls).toBe(1);
});

test('does not let a page-1 undo stack replace a remote AI change made while page 2 is open', async ({ mount, page }) => {
  const pageOneId = 'ink-editor-ct-page-1';
  const remotePageOneStrokeId = 'remote-page1-stroke';
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  const undo = component.getByTestId('ink-undo');
  await expect(canvas).toBeVisible();

  // Build a local undo stack on page 1, then leave that page.
  await component.getByTestId('ink-page-previous').click();
  await expect(canvas).toHaveAttribute('data-page-id', pageOneId);
  await drawStroke(page, component.getByTestId('ink-active-stroke-canvas'), 72);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
  await expect(undo).toBeEnabled();
  expect((await readFixturePage(page, pageOneId))?.objects).toHaveLength(2);

  await component.getByTestId('ink-page-next').click();
  await expect(canvas).toHaveAttribute('data-page-id', inkEditorPageId);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');

  // A remote AI writer changes page 1 while the editor is cleanly showing page 2.
  const readsBeforeRemoteChange = await page.evaluate(() => {
    const backend = (window as Window & { __INK_EDITOR_CT_BACKEND__?: { getCalls: number; getPageCalls: number } }).__INK_EDITOR_CT_BACKEND__;
    return backend ? [backend.getCalls, backend.getPageCalls] : [];
  });
  await page.evaluate(async ({ pageId, remoteStrokeId }) => {
    const fixtureWindow = window as Window & {
      __INK_EDITOR_CT_BACKEND__?: {
        readPage(id: string): InkPage | undefined;
        advanceRemotePage(id: string, value: InkPage): void;
        readManifest(): { revision: string };
      };
      __INK_EDITOR_EMIT_CHANGED__?: (documentId: string, revision: string) => Promise<void>;
    };
    const backend = fixtureWindow.__INK_EDITOR_CT_BACKEND__;
    const current = backend?.readPage(pageId);
    if (!backend || !current || !fixtureWindow.__INK_EDITOR_EMIT_CHANGED__) throw new Error('Ink cross-page fixture is unavailable');
    backend.advanceRemotePage(pageId, {
      ...current,
      objects: [...current.objects, {
        id: remoteStrokeId,
        author: 'ai',
        created_at: 120,
        content: {
          kind: 'stroke',
          samples: [{ x: 16, y: 130, pressure: 0.5 }, { x: 96, y: 130, pressure: 0.5 }],
          style: { tool: 'pen', color: '#ff0000', width: 4, pressure_enabled: false },
        },
      }],
    });
    await fixtureWindow.__INK_EDITOR_EMIT_CHANGED__('ink-editor-ct-document', backend.readManifest().revision);
  }, { pageId: pageOneId, remoteStrokeId: remotePageOneStrokeId });
  await expect.poll(() => page.evaluate(() => {
    const backend = (window as Window & { __INK_EDITOR_CT_BACKEND__?: { getCalls: number; getPageCalls: number } }).__INK_EDITOR_CT_BACKEND__;
    return backend ? [backend.getCalls, backend.getPageCalls] : [];
  })).toEqual([readsBeforeRemoteChange[0] + 1, readsBeforeRemoteChange[1] + 1]);
  await expect(canvas).toHaveAttribute('data-page-id', inkEditorPageId);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');

  // Returning to page 1 must load the remote object without allowing the stale
  // page-1 history to replace it. Either invalidate the history (undo disabled)
  // or make undo object-safe (remote object survives a click).
  await component.getByTestId('ink-page-previous').click();
  await expect(canvas).toHaveAttribute('data-page-id', pageOneId);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
  await expect.poll(async () => (await readFixturePage(page, pageOneId))?.objects.some((object) => object.id === remotePageOneStrokeId)).toBe(true);
  await expect.poll(() => hasRedPixelAt(canvas, 48, 130)).toBe(true);

  if (await undo.isEnabled()) {
    await undo.click();
    await expect.poll(async () => (await readFixturePage(page, pageOneId))?.objects.some((object) => object.id === remotePageOneStrokeId)).toBe(true);
    await expect.poll(() => hasRedPixelAt(canvas, 48, 130)).toBe(true);
  }
});
