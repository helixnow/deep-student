import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { CDPSession, Locator, Page } from '@playwright/test';
import type { InkObject, InkPage } from '@/features/ink/types';
import { InkEditorHarness } from './InkEditorHarness';
import { inkEditorPageId } from './fixtures';

const PAGE_WIDTH = 1200;
const FIXTURE_STROKE_ID = 'fixture-blue-stroke';

type StrokeContent = Extract<InkObject['content'], { kind: 'stroke' }>;

interface DiagnosticData {
  pointerId?: number;
  pointerType?: string;
  phase?: string;
  isTrusted?: boolean;
  cancelled?: boolean;
  cancelSampled?: boolean;
  batchCount?: number;
  terminal?: boolean;
  first?: { x: number; y: number } | null;
  last?: { x: number; y: number } | null;
  context?: {
    touchAction?: string;
    touchDrawing?: boolean;
    panActive?: boolean;
    scrollLeft?: number;
    scrollTop?: number;
    ignored?: string | null;
    area?: string;
    cancelSampled?: boolean;
  };
}

interface DiagnosticRecord {
  event: string;
  data?: DiagnosticData;
}

interface DiagnosticsSnapshot {
  enabled: boolean;
  retainedCount: number;
  records: DiagnosticRecord[];
}

interface BackendSnapshot {
  saveCalls: number;
  pendingSaveCalls: number;
  objects: number;
}

interface Point {
  x: number;
  y: number;
}

interface VisibleRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

async function readPage(page: Page): Promise<InkPage | undefined> {
  return page.evaluate((id) => window.__INK_EDITOR_CT_BACKEND__?.readPage(id), inkEditorPageId);
}

async function readBackend(page: Page): Promise<BackendSnapshot> {
  return page.evaluate((id) => {
    const backend = window.__INK_EDITOR_CT_BACKEND__;
    if (!backend) throw new Error('Ink CT backend is unavailable');
    return {
      saveCalls: backend.saveCalls,
      pendingSaveCalls: backend.pendingSaveCalls,
      objects: backend.readPage(id)?.objects.length ?? -1,
    };
  }, inkEditorPageId);
}

async function setInitialSaveGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__INK_EDITOR_CT_INITIAL_GATES__ = { saves: true };
  });
}

async function enableDiagnostics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const diagnostics = window.__INK_DIAGNOSTICS_API__;
    if (!diagnostics) throw new Error('Ink diagnostics API is unavailable');
    diagnostics.clearInkDiagnostics();
    diagnostics.setInkDiagnosticsEnabled(true);
  });
}

async function readDiagnostics(page: Page): Promise<DiagnosticsSnapshot> {
  return page.evaluate(() => {
    const diagnostics = window.__INK_DIAGNOSTICS_API__;
    if (!diagnostics) throw new Error('Ink diagnostics API is unavailable');
    const snapshot = diagnostics.getInkDiagnosticsSnapshot();
    return {
      enabled: snapshot.enabled,
      retainedCount: snapshot.retainedCount,
      records: snapshot.records.map((record) => ({ event: record.event, data: record.data })),
    };
  });
}

function strokeObjects(pageValue: InkPage | undefined): InkObject[] {
  return pageValue?.objects.filter((object) => object.content.kind === 'stroke' && object.id !== FIXTURE_STROKE_ID) ?? [];
}

function lastStroke(pageValue: InkPage | undefined): StrokeContent | undefined {
  const strokes = strokeObjects(pageValue);
  const content = strokes[strokes.length - 1]?.content;
  return content?.kind === 'stroke' ? content : undefined;
}

async function getViewportScroll(viewport: Locator): Promise<{ left: number; top: number }> {
  return viewport.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }));
}

async function setViewportScroll(viewport: Locator, left: number, top: number): Promise<void> {
  await viewport.evaluate((element, next) => {
    element.scrollLeft = next.left;
    element.scrollTop = next.top;
  }, { left, top });
}

async function visibleCanvasRect(viewport: Locator, canvas: Locator): Promise<VisibleRect> {
  const [viewportBox, canvasBox] = await Promise.all([viewport.boundingBox(), canvas.boundingBox()]);
  if (!viewportBox || !canvasBox) throw new Error('Ink viewport or canvas has no visible bounds');
  const left = Math.max(viewportBox.x, canvasBox.x);
  const top = Math.max(viewportBox.y, canvasBox.y);
  const right = Math.min(viewportBox.x + viewportBox.width, canvasBox.x + canvasBox.width);
  const bottom = Math.min(viewportBox.y + viewportBox.height, canvasBox.y + canvasBox.height);
  if (right <= left || bottom <= top) throw new Error('Ink canvas is not visible inside the viewport');
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function pointInVisibleRect(rect: VisibleRect, xRatio: number, yRatio: number): Point {
  return {
    x: rect.left + rect.width * xRatio,
    y: rect.top + rect.height * yRatio,
  };
}

async function logicalToClient(canvas: Locator, point: Point): Promise<Point> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Ink canvas has no visible bounds');
  const scale = box.width / PAGE_WIDTH;
  return { x: box.x + point.x * scale, y: box.y + point.y * scale };
}

async function clientToLogical(canvas: Locator, point: Point): Promise<Point> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Ink canvas has no visible bounds');
  const scale = box.width / PAGE_WIDTH;
  return { x: (point.x - box.x) / scale, y: (point.y - box.y) / scale };
}

async function mouseStroke(page: Page, canvas: Locator, from: Point, to: Point): Promise<void> {
  const start = await logicalToClient(canvas, from);
  const end = await logicalToClient(canvas, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
}

interface DispatchPenOptions {
  pressure?: number;
}

async function dispatchPen(
  cdp: CDPSession,
  type: 'mousePressed' | 'mouseMoved' | 'mouseReleased',
  point: Point,
  options: DispatchPenOptions = {},
): Promise<void> {
  const pressed = type !== 'mouseReleased';
  await cdp.send('Input.dispatchMouseEvent', {
    type,
    x: point.x,
    y: point.y,
    button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: pressed ? 1 : 0,
    clickCount: type === 'mouseMoved' ? 0 : 1,
    pointerType: 'pen',
    force: type === 'mouseReleased' ? 0 : (options.pressure ?? 0.5),
  });
}

async function penDown(cdp: CDPSession, point: Point): Promise<void> {
  await dispatchPen(cdp, 'mousePressed', point);
}

async function penMove(cdp: CDPSession, point: Point): Promise<void> {
  await dispatchPen(cdp, 'mouseMoved', point);
}

async function penUp(cdp: CDPSession, point: Point): Promise<void> {
  await dispatchPen(cdp, 'mouseReleased', point);
}

interface TouchPoint extends Point {
  id: number;
}

async function dispatchTouch(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
  points: TouchPoint[],
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' || type === 'touchCancel'
      ? []
      : points.map((point) => ({
        x: point.x,
        y: point.y,
        id: point.id,
        radiusX: 6,
        radiusY: 6,
        force: 0.5,
      })),
  });
}

interface InkPixelBounds {
  count: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  topLeftDark: number;
  scale: number;
}

async function readInkPixelBounds(canvas: Locator): Promise<InkPixelBounds> {
  return canvas.evaluate((element, pageWidth) => {
    const target = element as HTMLCanvasElement;
    const context = target.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    const { width, height } = target;
    const pixels = context.getImageData(0, 0, width, height).data;
    let count = 0;
    let topLeftDark = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    const scale = width / pageWidth;
    const topLeftLimitX = Math.ceil(20 * scale);
    const topLeftLimitY = Math.ceil(20 * scale);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const dark = pixels[index] < 48 && pixels[index + 1] < 48 && pixels[index + 2] < 48 && pixels[index + 3] > 240;
        if (!dark) continue;
        count += 1;
        if (x < topLeftLimitX && y < topLeftLimitY) topLeftDark += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return { count, minX, minY, maxX, maxY, topLeftDark, scale };
  }, PAGE_WIDTH);
}

function sampleBatches(diagnostics: DiagnosticsSnapshot, pointerId?: number): DiagnosticRecord[] {
  return diagnostics.records.filter((record) => record.event === 'page.stroke.samples'
    && (pointerId === undefined || record.data?.pointerId === pointerId));
}

function pointerRecords(diagnostics: DiagnosticsSnapshot, pointerType?: string): DiagnosticRecord[] {
  return diagnostics.records.filter((record) => record.event === 'pointer'
    && (pointerType === undefined || record.data?.pointerType === pointerType));
}

test('pointercancel at (0,0) adds no origin sample, ray pixels, or scroll jump', async ({ mount, page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const component = await mount(<InkEditorHarness saveMode="success" largePage fullHeight />);
  const canvas = component.getByTestId('ink-page-canvas');
  const overlay = component.getByTestId('ink-active-stroke-canvas');
  const viewport = component.getByTestId('ink-page-viewport');
  await expect(canvas).toBeVisible();
  await enableDiagnostics(page);

  const scrollBefore = await viewport.evaluate((element) => {
    element.scrollLeft = 0;
    element.scrollTop = 180;
    return { left: element.scrollLeft, top: element.scrollTop };
  });
  expect(scrollBefore.top).toBeGreaterThan(0);

  const box = await overlay.boundingBox();
  if (!box) throw new Error('Ink overlay has no visible bounds');
  const scale = box.width / PAGE_WIDTH;
  await page.evaluate(({ left, top, scale }) => {
    const target = document.querySelector('[data-testid="ink-active-stroke-canvas"]');
    if (!target) throw new Error('Ink overlay is missing');
    const fire = (type: string, logicalX: number, logicalY: number, buttons: number) => target.dispatchEvent(new PointerEvent(type, {
      pointerId: 501,
      pointerType: 'pen',
      isPrimary: true,
      pressure: 0.6,
      buttons,
      clientX: left + logicalX * scale,
      clientY: top + logicalY * scale,
      bubbles: true,
      cancelable: true,
    }));
    fire('pointerdown', 200, 300, 1);
    fire('pointermove', 280, 312, 1);
    fire('pointermove', 360, 324, 1);
    // Real UA cancels can report (0,0); dispatch the exact malformed coordinate.
    target.dispatchEvent(new PointerEvent('pointercancel', {
      pointerId: 501,
      pointerType: 'pen',
      isPrimary: true,
      pressure: 0,
      buttons: 0,
      clientX: 0,
      clientY: 0,
      bubbles: true,
      cancelable: true,
    }));
  }, { left: box.x, top: box.y, scale });

  await expect.poll(async () => (await readPage(page))?.objects.length).toBe(2);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');

  const pageValue = await readPage(page);
  const strokes = strokeObjects(pageValue);
  expect(strokes).toHaveLength(1);
  const content = strokes[0].content as StrokeContent;
  expect(content.samples).toHaveLength(3);
  expect(content.samples.some((sample) => sample.x === 0 && sample.y === 0)).toBe(false);
  const xs = content.samples.map((sample) => sample.x);
  const ys = content.samples.map((sample) => sample.y);
  expect(Math.min(...xs)).toBeGreaterThan(190);
  expect(Math.max(...xs)).toBeLessThan(370);
  expect(Math.min(...ys)).toBeGreaterThan(290);
  expect(Math.max(...ys)).toBeLessThan(335);
  expect(content.samples[content.samples.length - 1].x).toBeCloseTo(360, 0);
  expect(content.samples[content.samples.length - 1].y).toBeCloseTo(324, 0);

  const pixelBounds = await readInkPixelBounds(canvas);
  expect(pixelBounds.count).toBeGreaterThan(100);
  expect(pixelBounds.topLeftDark, 'cancel must not paint a ray into the page origin').toBe(0);
  expect(pixelBounds.minX / pixelBounds.scale).toBeGreaterThan(180);
  expect(pixelBounds.minY / pixelBounds.scale).toBeGreaterThan(280);
  expect(pixelBounds.maxX / pixelBounds.scale).toBeLessThan(380);
  expect(pixelBounds.maxY / pixelBounds.scale).toBeLessThan(340);

  const scrollAfter = await getViewportScroll(viewport);
  expect(scrollAfter).toEqual(scrollBefore);

  const diagnostics = await readDiagnostics(page);
  const cancelPointers = pointerRecords(diagnostics, 'pen').filter((record) => record.data?.phase === 'cancel');
  expect(cancelPointers).toHaveLength(1);
  const cancelContext = cancelPointers[0].data?.context;
  expect(cancelContext?.cancelSampled ?? cancelPointers[0].data?.cancelSampled).toBe(false);
  expect(cancelContext?.touchAction).toBe('none');
  expect(cancelContext?.touchDrawing).toBe(false);
  expect(cancelContext?.panActive).toBe(false);
  expect(typeof cancelContext?.scrollLeft).toBe('number');
  expect(typeof cancelContext?.scrollTop).toBe('number');

  const batches = sampleBatches(diagnostics, 501);
  const cancelledBatch = batches.find((record) => record.data?.cancelled === true);
  expect(cancelledBatch, 'cancel must be diagnosed as an empty sample batch').toBeTruthy();
  expect(cancelledBatch?.data?.phase).toBe('cancel');
  expect(cancelledBatch?.data?.cancelSampled).toBe(false);
  expect(cancelledBatch?.data?.batchCount).toBe(0);
  expect(cancelledBatch?.data?.first).toBeNull();
  expect(cancelledBatch?.data?.last).toBeNull();
  expect(batches.every((record) => {
    const first = record.data?.first;
    return !first || (first.x !== 0 || first.y !== 0);
  })).toBe(true);
});

test('a stroke after pointercancel saves normally and leaves the cancelled stroke unchanged', async ({ mount, page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const component = await mount(<InkEditorHarness saveMode="success" largePage fullHeight />);
  const canvas = component.getByTestId('ink-page-canvas');
  const overlay = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toBeVisible();

  const box = await overlay.boundingBox();
  if (!box) throw new Error('Ink overlay has no visible bounds');
  const scale = box.width / PAGE_WIDTH;
  const send = (type: string, pointerId: number, x: number, y: number, buttons: number) => page.evaluate(({ type, pointerId, x, y, buttons, left, top, scale }) => {
    const target = document.querySelector('[data-testid="ink-active-stroke-canvas"]');
    if (!target) throw new Error('Ink overlay is missing');
    target.dispatchEvent(new PointerEvent(type, {
      pointerId,
      pointerType: 'pen',
      isPrimary: true,
      pressure: type === 'pointercancel' ? 0 : 0.6,
      buttons,
      clientX: type === 'pointercancel' ? 0 : left + x * scale,
      clientY: type === 'pointercancel' ? 0 : top + y * scale,
      bubbles: true,
      cancelable: type !== 'pointercancel',
    }));
  }, { type, pointerId, x, y, buttons, left: box.x, top: box.y, scale });

  await send('pointerdown', 601, 200, 300, 1);
  await send('pointermove', 601, 280, 312, 1);
  await send('pointercancel', 601, 0, 0, 0);
  await expect.poll(async () => (await readPage(page))?.objects.length).toBe(2);
  const first = lastStroke(await readPage(page));
  expect(first?.samples).toHaveLength(2);
  expect(first?.samples.some((sample) => sample.x === 0 && sample.y === 0)).toBe(false);

  await send('pointerdown', 602, 200, 620, 1);
  await send('pointermove', 602, 320, 640, 1);
  await send('pointermove', 602, 440, 660, 1);
  await send('pointerup', 602, 520, 670, 0);
  await expect.poll(async () => (await readPage(page))?.objects.length).toBe(3);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');

  const pageValue = await readPage(page);
  const strokes = strokeObjects(pageValue);
  expect(strokes).toHaveLength(2);
  const cancelledContent = strokes[0].content as StrokeContent;
  const nextContent = strokes[1].content as StrokeContent;
  expect(cancelledContent.samples).toHaveLength(2);
  expect(cancelledContent.samples[cancelledContent.samples.length - 1].x).toBeCloseTo(280, 0);
  expect(nextContent.samples.length).toBeGreaterThanOrEqual(4);
  expect(nextContent.samples[nextContent.samples.length - 1].x).toBeCloseTo(520, 0);
  expect(nextContent.samples[nextContent.samples.length - 1].y).toBeCloseTo(670, 0);
});

for (const touchDrawing of [false, true]) {
  for (const holdMs of [0, 800]) {
    test(`trusted CDP pen keeps the complete stroke after ${holdMs}ms hold (touch drawing ${touchDrawing ? 'on' : 'off'})`, async ({ mount, page }) => {
      await page.setViewportSize({ width: 900, height: 700 });
      await setInitialSaveGate(page);
      const component = await mount(<InkEditorHarness saveMode="success" largePage fullHeight />);
      const canvas = component.getByTestId('ink-page-canvas');
      const overlay = component.getByTestId('ink-active-stroke-canvas');
      const viewport = component.getByTestId('ink-page-viewport');
      const saveState = component.getByTestId('ink-editor-save-state');
      await expect(canvas).toBeVisible();
      if (touchDrawing) await component.getByTestId('ink-touch-draw-toggle').click();
      await expect(component.getByTestId('ink-touch-draw-toggle')).toHaveAttribute('aria-pressed', String(touchDrawing));
      await expect(viewport).toHaveCSS('touch-action', 'none');
      await expect(component.getByTestId('ink-page-surface')).toHaveCSS('touch-action', 'none');
      await expect(overlay).toHaveCSS('touch-action', 'none');
      await enableDiagnostics(page);
      const cdp = await page.context().newCDPSession(page);
      const down = await logicalToClient(overlay, { x: 200, y: 250 });
      const moves = [
        await logicalToClient(overlay, { x: 320, y: 270 }),
        await logicalToClient(overlay, { x: 440, y: 290 }),
        await logicalToClient(overlay, { x: 560, y: 310 }),
      ];
      const up = moves[moves.length - 1];
      await penDown(cdp, down);
      if (holdMs) await page.waitForTimeout(holdMs);
      expect((await readBackend(page)).saveCalls).toBe(0);
      expect(await getViewportScroll(viewport)).toEqual({ left: 0, top: 0 });
      const holdDiagnostics = await readDiagnostics(page);
      const downPointer = pointerRecords(holdDiagnostics, 'pen').find((record) => record.data?.phase === 'down');
      expect(downPointer?.data?.isTrusted).toBe(true);
      expect(holdDiagnostics.records.some((record) => record.event === 'page.stroke.finish.start')).toBe(false);
      for (const point of moves) {
        await penMove(cdp, point);
        await page.waitForTimeout(35);
      }
      expect((await readBackend(page)).saveCalls).toBe(0);
      expect(await getViewportScroll(viewport)).toEqual({ left: 0, top: 0 });
      const moveDiagnostics = await readDiagnostics(page);
      const movePointers = pointerRecords(moveDiagnostics, 'pen').filter((record) => record.data?.phase === 'move');
      expect(movePointers).toHaveLength(3);
      expect(movePointers.every((record) => record.data?.isTrusted === true)).toBe(true);
      expect(moveDiagnostics.records.some((record) => record.event === 'page.stroke.finish.start')).toBe(false);
      await penUp(cdp, up);
      await expect.poll(async () => (await readBackend(page)).pendingSaveCalls).toBe(1);
      await expect(saveState).toHaveAttribute('data-state', 'saving');
      await page.evaluate(() => window.__INK_EDITOR_CT_BACKEND__?.releaseHeldSaves());
      await expect.poll(async () => (await readBackend(page)).objects).toBe(2);
      await expect(saveState).toHaveAttribute('data-state', 'saved');
      expect(await getViewportScroll(viewport)).toEqual({ left: 0, top: 0 });
      const content = lastStroke(await readPage(page));
      if (!content) throw new Error('Pen stroke was not saved');
      const expectedUp = await clientToLogical(overlay, up);
      expect(content.samples.length).toBeGreaterThanOrEqual(5);
      expect(content.samples[0].x).toBeCloseTo(200, 0);
      expect(content.samples[0].y).toBeCloseTo(250, 0);
      expect(content.samples[content.samples.length - 1].x).toBeCloseTo(expectedUp.x, 0);
      expect(content.samples[content.samples.length - 1].y).toBeCloseTo(expectedUp.y, 0);
      const pixelBounds = await readInkPixelBounds(canvas);
      expect(pixelBounds.topLeftDark).toBe(0);
      expect(pixelBounds.maxX / pixelBounds.scale).toBeGreaterThan(555);
      expect(pixelBounds.maxY / pixelBounds.scale).toBeGreaterThan(305);
      expect(pixelBounds.minX / pixelBounds.scale).toBeGreaterThan(190);
      expect(pixelBounds.minY / pixelBounds.scale).toBeGreaterThan(240);
      const finalDiagnostics = await readDiagnostics(page);
      const finalPen = pointerRecords(finalDiagnostics, 'pen');
      expect(finalPen.some((record) => record.data?.phase === 'cancel')).toBe(false);
      const finalUp = finalPen.filter((record) => record.data?.phase === 'up');
      expect(finalUp).toHaveLength(1);
      expect(finalUp[0].data?.isTrusted).toBe(true);
      expect(finalUp[0].data?.context).toMatchObject({ touchDrawing, touchAction: 'none', scrollLeft: 0, scrollTop: 0 });
      const batches = sampleBatches(finalDiagnostics);
      expect(batches.reduce((total, record) => total + (record.data?.batchCount ?? 0), 0)).toBe(content.samples.length);
      expect(batches.find((record) => record.data?.phase === 'up')?.data?.last?.x).toBeCloseTo(expectedUp.x, 0);
      expect(finalDiagnostics.records.some((record) => record.event === 'page.stroke.finish.commit')).toBe(true);
    });
  }
}

test('trusted CDP touch pans both axes when touch drawing is off and draws without scrolling when on', async ({ mount, page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const component = await mount(<InkEditorHarness saveMode="success" largePage fullHeight />);
  const canvas = component.getByTestId('ink-page-canvas');
  const overlay = component.getByTestId('ink-active-stroke-canvas');
  const viewport = component.getByTestId('ink-page-viewport');
  const saveState = component.getByTestId('ink-editor-save-state');
  await expect(canvas).toBeVisible();
  await component.getByTestId('ink-zoom-in').click();
  await page.waitForTimeout(100);
  await setViewportScroll(viewport, 0, 0);
  await enableDiagnostics(page);

  const rect = await visibleCanvasRect(viewport, canvas);
  const start = pointInVisibleRect(rect, 0.68, 0.55);
  const mid = { x: start.x - 70, y: start.y - 55 };
  const end = { x: start.x - 150, y: start.y - 115 };

  await dispatchTouch(cdp, 'touchStart', [{ ...start, id: 11 }]);
  await page.waitForTimeout(40);
  await dispatchTouch(cdp, 'touchMove', [{ ...mid, id: 11 }]);
  await page.waitForTimeout(40);
  await dispatchTouch(cdp, 'touchMove', [{ ...end, id: 11 }]);
  await page.waitForTimeout(40);
  const scrolled = await getViewportScroll(viewport);
  expect(scrolled.left, 'horizontal touch pan must move viewport.scrollLeft').toBeGreaterThan(30);
  expect(scrolled.top, 'vertical touch pan must move viewport.scrollTop').toBeGreaterThan(20);

  const panDiagnostics = await readDiagnostics(page);
  const touchMoves = pointerRecords(panDiagnostics, 'touch').filter((record) => record.data?.phase === 'move');
  expect(touchMoves.length).toBeGreaterThanOrEqual(2);
  expect(touchMoves.every((record) => record.data?.isTrusted === true)).toBe(true);
  expect(touchMoves.some((record) => record.data?.context?.panActive === true)).toBe(true);
  expect(touchMoves.every((record) => record.data?.context?.touchDrawing === false)).toBe(true);
  expect(touchMoves.every((record) => record.data?.context?.touchAction === 'none')).toBe(true);
  expect(touchMoves.some((record) => Number(record.data?.context?.scrollLeft) > 0)).toBe(true);
  expect(touchMoves.some((record) => Number(record.data?.context?.scrollTop) > 0)).toBe(true);

  await overlay.evaluate((element, point) => {
    const fire = (type: string, buttons: number) => element.dispatchEvent(new PointerEvent(type, {
      pointerId: 902,
      pointerType: 'touch',
      isPrimary: false,
      buttons,
      clientX: point.x,
      clientY: point.y,
      bubbles: true,
      cancelable: true,
    }));
    fire('pointerdown', 1);
    fire('pointermove', 1);
    fire('pointerup', 0);
  }, { x: start.x + 40, y: start.y + 40 });
  const panIgnoreDiagnostics = await readDiagnostics(page);
  expect(pointerRecords(panIgnoreDiagnostics, 'touch').some((record) => (
    record.data?.phase === 'down' && record.data?.context?.ignored === 'pan-active'
  )), 'a second touch during a pan must be ignored instead of starting pinch').toBe(true);
  expect((await readBackend(page)).objects).toBe(1);

  await dispatchTouch(cdp, 'touchEnd', []);
  const afterPan = await readBackend(page);
  expect(afterPan.objects).toBe(1);
  expect(afterPan.saveCalls).toBe(0);
  expect(panDiagnostics.records.some((record) => record.event === 'page.stroke.finish.start')).toBe(false);
  const scrollAfterPan = await getViewportScroll(viewport);
  expect(scrollAfterPan.left).toBeGreaterThan(30);

  // A pan pointercancel at (0,0) must only end the pan, never jump the
  // viewport to an origin-derived scroll offset.
  await setViewportScroll(viewport, 0, 0);
  const syntheticStart = pointInVisibleRect(rect, 0.6, 0.6);
  const syntheticEnd = { x: syntheticStart.x - 90, y: syntheticStart.y - 70 };
  await overlay.evaluate((element, points) => {
    const fire = (type: string, x: number, y: number, buttons: number) => element.dispatchEvent(new PointerEvent(type, {
      pointerId: 901,
      pointerType: 'touch',
      isPrimary: true,
      buttons,
      clientX: type === 'pointercancel' ? 0 : x,
      clientY: type === 'pointercancel' ? 0 : y,
      bubbles: true,
      cancelable: true,
    }));
    fire('pointerdown', points.start.x, points.start.y, 1);
    fire('pointermove', points.end.x, points.end.y, 1);
  }, { start: syntheticStart, end: syntheticEnd });
  const syntheticScrolled = await getViewportScroll(viewport);
  expect(syntheticScrolled.left).toBeGreaterThan(0);
  expect(syntheticScrolled.top).toBeGreaterThan(0);
  await overlay.evaluate(() => {
    document.querySelector('[data-testid="ink-active-stroke-canvas"]')?.dispatchEvent(new PointerEvent('pointercancel', {
      pointerId: 901,
      pointerType: 'touch',
      isPrimary: true,
      buttons: 0,
      clientX: 0,
      clientY: 0,
      bubbles: true,
      cancelable: true,
    }));
  });
  expect(await getViewportScroll(viewport)).toEqual(syntheticScrolled);

  await component.getByTestId('ink-touch-draw-toggle').click();
  await expect(component.getByTestId('ink-touch-draw-toggle')).toHaveAttribute('aria-pressed', 'true');
  await setViewportScroll(viewport, 0, 0);
  await enableDiagnostics(page);
  const drawRect = await visibleCanvasRect(viewport, canvas);
  const drawStart = pointInVisibleRect(drawRect, 0.45, 0.45);
  const drawMid = { x: drawStart.x + 70, y: drawStart.y + 40 };
  const drawEnd = { x: drawStart.x + 150, y: drawStart.y + 90 };

  await dispatchTouch(cdp, 'touchStart', [{ ...drawStart, id: 12 }]);
  await page.waitForTimeout(40);
  await dispatchTouch(cdp, 'touchMove', [{ ...drawMid, id: 12 }]);
  await page.waitForTimeout(40);
  await dispatchTouch(cdp, 'touchMove', [{ ...drawEnd, id: 12 }]);
  await page.waitForTimeout(40);
  expect(await getViewportScroll(viewport)).toEqual({ left: 0, top: 0 });
  await dispatchTouch(cdp, 'touchEnd', []);
  await expect.poll(async () => (await readBackend(page)).objects).toBe(2);
  await expect(saveState).toHaveAttribute('data-state', 'saved');
  expect(await getViewportScroll(viewport)).toEqual({ left: 0, top: 0 });

  const content = lastStroke(await readPage(page));
  expect(content).toBeTruthy();
  if (!content) return;
  const expectedStart = await clientToLogical(overlay, drawStart);
  const expectedEnd = await clientToLogical(overlay, drawEnd);
  expect(content.samples.length).toBeGreaterThanOrEqual(4);
  expect(content.samples[0].x).toBeCloseTo(expectedStart.x, 0);
  expect(content.samples[0].y).toBeCloseTo(expectedStart.y, 0);
  expect(content.samples[content.samples.length - 1].x).toBeCloseTo(expectedEnd.x, 0);
  expect(content.samples[content.samples.length - 1].y).toBeCloseTo(expectedEnd.y, 0);

  const drawDiagnostics = await readDiagnostics(page);
  const drawPointers = pointerRecords(drawDiagnostics, 'touch');
  const drawDown = drawPointers.find((record) => record.data?.phase === 'down');
  const drawUp = drawPointers.find((record) => record.data?.phase === 'up');
  expect(drawDown?.data?.isTrusted).toBe(true);
  expect(drawUp?.data?.isTrusted).toBe(true);
  const drawUpContext = drawUp?.data?.context;
  expect(drawUpContext?.touchDrawing).toBe(true);
  expect(drawUpContext?.touchAction).toBe('none');
  expect(drawUpContext?.scrollLeft).toBe(0);
  expect(drawUpContext?.scrollTop).toBe(0);
});

test('pen down takes over a touch pan and palm/second touch cannot steal or restart it', async ({ mount, page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const component = await mount(<InkEditorHarness saveMode="success" largePage fullHeight />);
  const canvas = component.getByTestId('ink-page-canvas');
  const overlay = component.getByTestId('ink-active-stroke-canvas');
  const viewport = component.getByTestId('ink-page-viewport');
  const saveState = component.getByTestId('ink-editor-save-state');
  await expect(canvas).toBeVisible();
  await component.getByTestId('ink-zoom-in').click();
  await page.waitForTimeout(100);
  await setViewportScroll(viewport, 0, 0);
  await enableDiagnostics(page);

  const initialRect = await visibleCanvasRect(viewport, canvas);
  const palmStart = pointInVisibleRect(initialRect, 0.7, 0.55);
  const palmPan = { x: palmStart.x - 120, y: palmStart.y - 80 };
  await dispatchTouch(cdp, 'touchStart', [{ ...palmStart, id: 21 }]);
  await page.waitForTimeout(40);
  await dispatchTouch(cdp, 'touchMove', [{ ...palmPan, id: 21 }]);
  await page.waitForTimeout(60);
  const scrollAfterPan = await getViewportScroll(viewport);
  expect(scrollAfterPan.left).toBeGreaterThan(30);
  expect(scrollAfterPan.top).toBeGreaterThan(20);

  const penRect = await visibleCanvasRect(viewport, canvas);
  const penStart = pointInVisibleRect(penRect, 0.4, 0.35);
  const penPoints = [
    { x: penStart.x + 80, y: penStart.y + 20 },
    { x: penStart.x + 160, y: penStart.y + 40 },
    { x: penStart.x + 240, y: penStart.y + 60 },
  ];
  const penEnd = penPoints[penPoints.length - 1];

  await penDown(cdp, penStart);
  await page.waitForTimeout(60);
  expect(await getViewportScroll(viewport), 'pen down must freeze a touch pan').toEqual(scrollAfterPan);
  for (const point of penPoints) {
    await penMove(cdp, point);
    await page.waitForTimeout(35);
  }

  const palmDuringPen = { x: palmStart.x - 190, y: palmStart.y - 140 };
  await dispatchTouch(cdp, 'touchMove', [{ ...palmDuringPen, id: 21 }]);
  await page.waitForTimeout(60);
  expect(await getViewportScroll(viewport), 'palm movement must not pan while the pen is active').toEqual(scrollAfterPan);

  const secondTouchPoint = await overlay.boundingBox();
  if (!secondTouchPoint) throw new Error('Ink overlay has no visible bounds');
  await overlay.evaluate((element, point) => {
    const fire = (type: string, x: number, y: number, buttons: number) => element.dispatchEvent(new PointerEvent(type, {
      pointerId: 777,
      pointerType: 'touch',
      isPrimary: false,
      buttons,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    }));
    fire('pointerdown', point.x, point.y, 1);
    fire('pointermove', point.x - 80, point.y - 60, 1);
    fire('pointerup', point.x - 80, point.y - 60, 0);
  }, { x: secondTouchPoint.x + secondTouchPoint.width * 0.8, y: secondTouchPoint.y + secondTouchPoint.height * 0.4 });
  expect(await getViewportScroll(viewport), 'a second touch must not pinch or scroll while the pen is active').toEqual(scrollAfterPan);

  await penUp(cdp, penEnd);
  await expect.poll(async () => (await readBackend(page)).objects).toBe(2);
  await expect(saveState).toHaveAttribute('data-state', 'saved');

  const stalePalm = { x: palmStart.x - 260, y: palmStart.y - 200 };
  await dispatchTouch(cdp, 'touchMove', [{ ...stalePalm, id: 21 }]);
  await page.waitForTimeout(60);
  expect(await getViewportScroll(viewport), 'a stale palm move must not restart pan after pen up').toEqual(scrollAfterPan);
  await dispatchTouch(cdp, 'touchEnd', []);

  const content = lastStroke(await readPage(page));
  expect(content).toBeTruthy();
  if (!content) return;
  const expectedEnd = await clientToLogical(overlay, penEnd);
  expect(content.samples.length).toBeGreaterThanOrEqual(5);
  expect(content.samples[content.samples.length - 1].x).toBeCloseTo(expectedEnd.x, 0);
  expect(content.samples[content.samples.length - 1].y).toBeCloseTo(expectedEnd.y, 0);

  const diagnostics = await readDiagnostics(page);
  const penPointers = pointerRecords(diagnostics, 'pen');
  expect(penPointers.some((record) => record.data?.phase === 'cancel')).toBe(false);
  expect(penPointers.find((record) => record.data?.phase === 'down')?.data?.context?.panActive).toBe(false);
  const ignoredTouchDowns = pointerRecords(diagnostics, 'touch').filter((record) => (
    record.data?.phase === 'down' && record.data?.context?.ignored === 'active'
  ));
  expect(ignoredTouchDowns.length, 'the second touch must be diagnosed as ignored during the active pen').toBeGreaterThanOrEqual(1);
});

test('trusted padding touches pan without drawing but cannot move the paper during pen input', async ({ mount, page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const component = await mount(<InkEditorHarness saveMode="success" largePage fullHeight />);
  const canvas = component.getByTestId('ink-page-canvas');
  const overlay = component.getByTestId('ink-active-stroke-canvas');
  const viewport = component.getByTestId('ink-page-viewport');
  await expect(canvas).toBeVisible();
  await expect(viewport).toHaveCSS('touch-action', 'none');
  const box = await viewport.boundingBox();
  if (!box) throw new Error('Ink viewport has no bounds');
  const start = { x: box.x + 8, y: box.y + box.height * 0.7 };
  expect(await page.evaluate((point) => document.elementFromPoint(point.x, point.y)?.getAttribute('data-testid'), start)).toBe('ink-page-viewport');

  for (const touchDrawing of [false, true]) {
    if (touchDrawing) await component.getByTestId('ink-touch-draw-toggle').click();
    await setViewportScroll(viewport, 0, 0);
    await enableDiagnostics(page);
    await dispatchTouch(cdp, 'touchStart', [{ ...start, id: 31 }]);
    await dispatchTouch(cdp, 'touchMove', [{ x: start.x, y: start.y - 70, id: 31 }]);
    await dispatchTouch(cdp, 'touchEnd', []);
    await expect.poll(async () => (await getViewportScroll(viewport)).top).toBeGreaterThan(30);
    expect((await readBackend(page)).saveCalls).toBe(0);
    expect(pointerRecords(await readDiagnostics(page), 'touch').some((record) => (
      record.data?.phase === 'move' && record.data?.isTrusted === true && record.data.context?.area === 'padding'
    ))).toBe(true);
  }

  await enableDiagnostics(page);
  const penStart = await logicalToClient(overlay, { x: 200, y: 350 });
  const penEnd = await logicalToClient(overlay, { x: 520, y: 400 });
  const scrollBefore = await getViewportScroll(viewport);
  await penDown(cdp, penStart);
  await dispatchTouch(cdp, 'touchStart', [{ ...start, id: 32 }]);
  await dispatchTouch(cdp, 'touchMove', [{ x: start.x, y: start.y - 90, id: 32 }]);
  await dispatchTouch(cdp, 'touchEnd', []);
  expect(await getViewportScroll(viewport)).toEqual(scrollBefore);
  const duringPen = await readDiagnostics(page);
  const paddingTouch = pointerRecords(duringPen, 'touch');
  expect(paddingTouch.some((record) => record.data?.phase === 'down' && record.data.context?.ignored === 'active')).toBe(true);
  expect(paddingTouch.some((record) => record.data?.phase === 'move' && record.data?.isTrusted === true && record.data.context?.area === 'padding')).toBe(true);
  await penMove(cdp, penEnd);
  await penUp(cdp, penEnd);
  await expect.poll(async () => (await readBackend(page)).objects).toBe(2);
  const content = lastStroke(await readPage(page));
  if (!content) throw new Error('Pen stroke was not saved');
  expect(content.samples[content.samples.length - 1].x).toBeCloseTo(520, 0);
  expect(content.samples[content.samples.length - 1].y).toBeCloseTo(400, 0);
  expect(pointerRecords(await readDiagnostics(page), 'pen').some((record) => record.data?.phase === 'cancel')).toBe(false);
  expect(await getViewportScroll(viewport)).toEqual(scrollBefore);
});

test('a second stroke is committed independently while the first save is pending', async ({ mount, page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await setInitialSaveGate(page);
  const component = await mount(<InkEditorHarness saveMode="success" largePage fullHeight />);
  const canvas = component.getByTestId('ink-page-canvas');
  const overlay = component.getByTestId('ink-active-stroke-canvas');
  const saveState = component.getByTestId('ink-editor-save-state');
  await expect(canvas).toBeVisible();
  await expect(saveState).toHaveAttribute('data-state', 'saved');

  await mouseStroke(page, overlay, { x: 180, y: 220 }, { x: 500, y: 240 });
  await expect.poll(async () => (await readBackend(page)).pendingSaveCalls).toBe(1);
  await expect(saveState).toHaveAttribute('data-state', 'saving');
  expect((await readBackend(page)).saveCalls).toBe(1);
  expect((await readBackend(page)).objects).toBe(1);

  await mouseStroke(page, overlay, { x: 180, y: 420 }, { x: 500, y: 445 });
  await page.waitForTimeout(150);
  const whilePending = await readBackend(page);
  expect(whilePending.pendingSaveCalls, 'the second stroke must not start a second backend save before the first resolves').toBe(1);
  expect(whilePending.saveCalls).toBe(1);
  expect(whilePending.objects, 'the held first save cannot expose either stroke yet').toBe(1);
  await expect(saveState).toHaveAttribute('data-state', 'saving');

  const released = await page.evaluate(() => window.__INK_EDITOR_CT_BACKEND__?.releaseHeldSaves() ?? 0);
  expect(released).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => (await readBackend(page)).saveCalls).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await readBackend(page)).objects).toBe(3);
  await expect(saveState).toHaveAttribute('data-state', 'saved');

  const strokes = strokeObjects(await readPage(page));
  expect(strokes).toHaveLength(2);
  expect(new Set(strokes.map((stroke) => stroke.id)).size).toBe(2);
  const contents = strokes.map((stroke) => stroke.content as StrokeContent);
  for (const content of contents) expect(content.samples.length).toBeGreaterThan(1);
  const ys = contents.map((content) => Math.min(...content.samples.map((sample) => sample.y))).sort((a, b) => a - b);
  expect(ys[0]).toBeGreaterThan(210);
  expect(ys[0]).toBeLessThan(250);
  expect(ys[1]).toBeGreaterThan(410);
  expect(ys[1]).toBeLessThan(455);
});
