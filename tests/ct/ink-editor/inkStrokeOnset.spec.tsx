import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { Locator, Page } from '@playwright/test';
import type { InkPage } from '@/features/ink/types';
import { InkEditorHarness } from './InkEditorHarness';
import { inkEditorPageId } from './fixtures';
import { expectEditorFlush } from './inkTestUtils';

type Point = { x: number; y: number };
type Footprint = { left: number; top: number; right: number; bottom: number };
type PointerType = 'mouse' | 'pen' | 'touch';

interface FrameExpectation {
  pageWidth: number;
  pageHeight: number;
  activeFootprints: Footprint[];
  completedFootprints: Footprint[];
  tip?: Point;
  background?: number[];
}

function footprint(start: Point, end = start): Footprint {
  return {
    left: Math.min(start.x, end.x) - 8,
    top: Math.min(start.y, end.y) - 8,
    right: Math.max(start.x, end.x) + 8,
    bottom: Math.max(start.y, end.y) + 8,
  };
}

async function sendPointer(
  page: Page,
  input: Locator,
  pointerType: PointerType,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  point: Point,
  pageWidth: number,
  pageHeight: number,
  pointerId: number,
) {
  const box = await input.boundingBox();
  if (!box) throw new Error('Ink page input canvas has no visible bounds');
  const clientX = box.x + point.x * box.width / pageWidth;
  const clientY = box.y + point.y * box.height / pageHeight;
  if (pointerType === 'mouse') {
    if (type === 'pointerdown') {
      await page.mouse.move(clientX, clientY);
      await page.mouse.down();
    } else if (type === 'pointermove') {
      await page.mouse.move(clientX, clientY);
    } else {
      await page.mouse.up();
    }
    return;
  }
  await input.evaluate((element, event) => {
    element.dispatchEvent(new PointerEvent(event.type, {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      isPrimary: true,
      button: event.type === 'pointermove' ? -1 : 0,
      buttons: event.type === 'pointerup' ? 0 : 1,
      pressure: event.type === 'pointerup' ? 0 : 0.6,
      clientX: event.clientX,
      clientY: event.clientY,
      bubbles: true,
      cancelable: true,
    }));
  }, { type, pointerType, pointerId, clientX, clientY });
}

async function readStrokeFrames(page: Page, expected: FrameExpectation) {
  return page.evaluate(async (expected) => {
    const sample = () => {
      const canvas = document.querySelector('[data-testid="ink-page-canvas"]') as HTMLCanvasElement | null;
      const active = document.querySelector('[data-testid="ink-active-stroke-canvas"]') as HTMLCanvasElement | null;
      if (!canvas || !active) throw new Error('Ink renderer canvases are missing');
      const pageContext = canvas.getContext('2d');
      const activeContext = active.getContext('2d');
      if (!pageContext || !activeContext) throw new Error('Canvas 2D context is unavailable');
      const inside = (x: number, y: number, regions: Footprint[]) => regions.some((region) => (
        x >= region.left && x <= region.right && y >= region.top && y <= region.bottom
      ));
      const scan = (target: HTMLCanvasElement, context: CanvasRenderingContext2D, regions: Footprint[], transparent: boolean) => {
        const pixels = context.getImageData(0, 0, target.width, target.height).data;
        let inkPixels = 0;
        let strayPixels = 0;
        let tipPixels = 0;
        const strayAt: Point[] = [];
        for (let y = 0; y < target.height; y += 1) {
          for (let x = 0; x < target.width; x += 1) {
            const offset = (y * target.width + x) * 4;
            const painted = pixels[offset + 3] > 0 && (transparent
              || (pixels[offset] < 64 && pixels[offset + 1] < 64 && pixels[offset + 2] < 64));
            if (!painted) continue;
            inkPixels += 1;
            const logicalX = (x + 0.5) * expected.pageWidth / target.width;
            const logicalY = (y + 0.5) * expected.pageHeight / target.height;
            if (!inside(logicalX, logicalY, regions)) {
              strayPixels += 1;
              if (strayAt.length < 8) strayAt.push({ x: logicalX, y: logicalY });
            }
            if (expected.tip && Math.hypot(logicalX - expected.tip.x, logicalY - expected.tip.y) < 3) tipPixels += 1;
          }
        }
        return { inkPixels, strayPixels, strayAt, tipPixels };
      };
      const backgroundPixels = [[5, expected.pageHeight - 5], [expected.pageWidth - 5, expected.pageHeight - 5]].map(([x, y]) => (
        Array.from(pageContext.getImageData(
          Math.min(canvas.width - 1, Math.floor(x * canvas.width / expected.pageWidth)),
          Math.min(canvas.height - 1, Math.floor(y * canvas.height / expected.pageHeight)),
          1, 1,
        ).data)
      ));
      return {
        active: scan(active, activeContext, expected.activeFootprints, true),
        completed: scan(canvas, pageContext, expected.completedFootprints, false),
        backgroundPixels,
      };
    };
    const frames = [sample()];
    for (let index = 0; index < 4; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames.push(sample());
    }
    return frames;
  }, expected);
}

async function expectStrokeFrames(page: Page, expected: FrameExpectation, phase: string) {
  const frames = await readStrokeFrames(page, expected);
  const evidence = `${phase}: ${JSON.stringify(frames)}`;
  expect(frames.map((frame) => frame.active.strayPixels), `${evidence}; active ink must not connect to the origin or a previous stroke`).toEqual([0, 0, 0, 0, 0]);
  expect(frames.map((frame) => frame.completed.strayPixels), `${evidence}; completed ink must stay inside the real pointer path`).toEqual([0, 0, 0, 0, 0]);
  for (const [index, frame] of frames.entries()) {
    const label = `${phase}, frame ${index}: ${JSON.stringify(frame)}`;
    if (expected.tip) {
      expect(frame.active.tipPixels, `${label}; pointerdown must paint the tip before any pointermove`).toBeGreaterThan(0);
    } else {
      expect(frame.active.inkPixels, `${label}; completed strokes must leave no active-layer pixels`).toBe(0);
      expect(frame.completed.inkPixels, `${label}; the completed stroke must be visible`).toBeGreaterThan(10);
    }
    if (expected.background) {
      for (const pixel of frame.backgroundPixels) {
        expect(pixel, `${label}; the source background must not flash white`).toEqual(expected.background);
      }
    }
  }
}

for (const background of ['blank', 'image', 'pdf'] as const) {
  for (const pointerType of ['mouse', 'pen', 'touch'] as const) {
    test(`paints only the ${pointerType} tip on the first frame and keeps later strokes disconnected on ${background} paper`, async ({ mount, page }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      const component = await mount(<InkEditorHarness saveMode="success" imageBackground={background === 'image'} pdfPageBackground={background === 'pdf'} />);
      const canvas = component.getByTestId('ink-page-canvas');
      const input = component.getByTestId('ink-active-stroke-canvas');
      const saveState = component.getByTestId('ink-editor-save-state');
      await expect(canvas).toBeVisible();
      const pageWidth = background === 'pdf' ? 160 : 120;
      const pageHeight = background === 'pdf' ? 120 : 160;
      const backgroundPixel = background === 'image' ? [255, 0, 0, 255] : background === 'pdf' ? [221, 221, 221, 255] : [255, 255, 255, 255];
      await expect.poll(() => canvas.evaluate((element) => {
        const context = (element as HTMLCanvasElement).getContext('2d');
        if (!context) throw new Error('Canvas 2D context is unavailable');
        return Array.from(context.getImageData(5, 5, 1, 1).data);
      })).toEqual(backgroundPixel);
      await component.getByTestId('ink-tool-pen').click();
      await component.getByTestId('ink-color-black').click();
      await component.getByTestId('ink-width-large').click();
      if (pointerType === 'touch') await component.getByTestId('ink-touch-draw-toggle').click();

      const strokes = [
        { start: { x: 66, y: 70 }, end: { x: 100, y: 70 } },
        { start: { x: 30, y: 100 }, end: { x: 82, y: 100 } },
        { start: { x: 102, y: 45 }, end: { x: 102, y: 45 } },
      ];
      const completedFootprints: Footprint[] = [];
      for (const [index, stroke] of strokes.entries()) {
        const pointerId = 121 + index;
        await sendPointer(page, input, pointerType, 'pointerdown', stroke.start, pageWidth, pageHeight, pointerId);
        await expectStrokeFrames(page, {
          pageWidth, pageHeight, activeFootprints: [footprint(stroke.start)], completedFootprints,
          tip: stroke.start, background: backgroundPixel,
        }, `stroke ${index + 1} pointerdown before movement`);
        if (stroke.start.x !== stroke.end.x || stroke.start.y !== stroke.end.y) {
          const midpoint = { x: (stroke.start.x + stroke.end.x) / 2, y: stroke.start.y };
          for (const point of [midpoint, stroke.end]) {
            await sendPointer(page, input, pointerType, 'pointermove', point, pageWidth, pageHeight, pointerId);
            await expectStrokeFrames(page, {
              pageWidth, pageHeight, activeFootprints: [footprint(stroke.start, point)], completedFootprints,
              tip: point, background: backgroundPixel,
            }, `stroke ${index + 1} pointermove to ${point.x},${point.y}`);
          }
        }
        await sendPointer(page, input, pointerType, 'pointerup', stroke.end, pageWidth, pageHeight, pointerId);
        await expect(saveState).toHaveAttribute('data-state', 'pending');
        expect(await page.evaluate(() => window.__INK_EDITOR_CT_BACKEND__?.saveCalls)).toBe(0);
        completedFootprints.push(footprint(stroke.start, stroke.end));
        await expectStrokeFrames(page, {
          pageWidth, pageHeight, activeFootprints: [], completedFootprints, background: backgroundPixel,
        }, `stroke ${index + 1} committed locally`);
      }

      await expectEditorFlush(page);
      const saved = await page.evaluate((pageId) => window.__INK_EDITOR_CT_BACKEND__?.readPage(pageId), inkEditorPageId) as InkPage | undefined;
      const drawn = saved?.objects.filter((object) => object.id !== 'fixture-blue-stroke');
      expect(drawn).toHaveLength(strokes.length);
      for (const [index, object] of drawn!.entries()) {
        if (object.content.kind !== 'stroke') throw new Error('Pointer gesture did not save a stroke');
        const { start, end } = strokes[index];
        expect(object.content.samples.length).toBeGreaterThan(0);
        for (const sample of object.content.samples) {
          expect(sample.x).toBeGreaterThanOrEqual(Math.min(start.x, end.x) - 1);
          expect(sample.x).toBeLessThanOrEqual(Math.max(start.x, end.x) + 1);
          expect(sample.y).toBeCloseTo(start.y, 0);
        }
      }
      expect(errors).toEqual([]);
    });
  }
}

for (const background of ['image', 'pdf'] as const) {
  for (const pointerType of ['pen', 'touch'] as const) {
    test(`never connects a coordinate-less ${pointerType} cancellation to the origin before the next stroke on ${background} paper`, async ({ mount, page }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      const component = await mount(<InkEditorHarness saveMode="success" imageBackground={background === 'image'} pdfPageBackground={background === 'pdf'} />);
      const canvas = component.getByTestId('ink-page-canvas');
      const input = component.getByTestId('ink-active-stroke-canvas');
      const saveState = component.getByTestId('ink-editor-save-state');
      await expect(canvas).toBeVisible();
      const pageWidth = background === 'pdf' ? 160 : 120;
      const pageHeight = background === 'pdf' ? 120 : 160;
      const backgroundPixel = background === 'image' ? [255, 0, 0, 255] : [221, 221, 221, 255];
      await expect.poll(() => canvas.evaluate((element) => {
        const context = (element as HTMLCanvasElement).getContext('2d');
        if (!context) throw new Error('Canvas 2D context is unavailable');
        return Array.from(context.getImageData(5, 5, 1, 1).data);
      })).toEqual(backgroundPixel);
      await component.getByTestId('ink-tool-pen').click();
      await component.getByTestId('ink-color-black').click();
      await component.getByTestId('ink-width-large').click();
      if (pointerType === 'touch') await component.getByTestId('ink-touch-draw-toggle').click();

      const start = { x: 66, y: 70 };
      const end = { x: 100, y: 70 };
      const completedFootprints: Footprint[] = [];
      for (const [index, moved] of [false, true].entries()) {
        const pointerId = 151 + index;
        const last = moved ? end : start;
        await sendPointer(page, input, pointerType, 'pointerdown', start, pageWidth, pageHeight, pointerId);
        await expectStrokeFrames(page, {
          pageWidth, pageHeight, activeFootprints: [footprint(start)], completedFootprints,
          tip: start, background: backgroundPixel,
        }, `cancelled stroke ${index + 1} pointerdown`);
        if (moved) {
          await sendPointer(page, input, pointerType, 'pointermove', end, pageWidth, pageHeight, pointerId);
          await expectStrokeFrames(page, {
            pageWidth, pageHeight, activeFootprints: [footprint(start, end)], completedFootprints,
            tip: end, background: backgroundPixel,
          }, `cancelled stroke ${index + 1} movement`);
        }
        await input.evaluate((element, event) => {
          element.dispatchEvent(new PointerEvent('pointercancel', {
            pointerId: event.pointerId, pointerType: event.pointerType, isPrimary: true,
            bubbles: true, cancelable: true,
          }));
        }, { pointerId, pointerType });
        await expect(saveState).toHaveAttribute('data-state', 'pending');
        expect(await page.evaluate(() => window.__INK_EDITOR_CT_BACKEND__?.saveCalls)).toBe(0);
        completedFootprints.push(footprint(start, last));
        await expectStrokeFrames(page, {
          pageWidth, pageHeight, activeFootprints: [], completedFootprints, background: backgroundPixel,
        }, `cancelled stroke ${index + 1} committed without a terminal position`);
      }

      const next = { x: 30, y: 100 };
      await sendPointer(page, input, pointerType, 'pointerdown', next, pageWidth, pageHeight, 153);
      await expectStrokeFrames(page, {
        pageWidth, pageHeight, activeFootprints: [footprint(next)], completedFootprints,
        tip: next, background: backgroundPixel,
      }, 'the first frame after cancellation');
      await sendPointer(page, input, pointerType, 'pointerup', next, pageWidth, pageHeight, 153);
      await expect(saveState).toHaveAttribute('data-state', 'pending');
      expect(await page.evaluate(() => window.__INK_EDITOR_CT_BACKEND__?.saveCalls)).toBe(0);
      completedFootprints.push(footprint(next));
      await expectStrokeFrames(page, {
        pageWidth, pageHeight, activeFootprints: [], completedFootprints, background: backgroundPixel,
      }, 'the next stroke committed locally');
      await expectEditorFlush(page);
      const saved = await page.evaluate((pageId) => window.__INK_EDITOR_CT_BACKEND__?.readPage(pageId), inkEditorPageId);
      const drawn = saved?.objects.filter((object) => object.id !== 'fixture-blue-stroke');
      expect(drawn).toHaveLength(3);
      for (const [index, object] of drawn!.entries()) {
        if (object.content.kind !== 'stroke') throw new Error('Pointer gesture did not save a stroke');
        const first = index === 2 ? next : start;
        const last = index === 1 ? end : first;
        expect(object.content.samples.length).toBeGreaterThan(0);
        expect(object.content.samples[0]).toMatchObject(first);
        for (const sample of object.content.samples) {
          expect(sample.x).toBeGreaterThanOrEqual(first.x);
          expect(sample.x).toBeLessThanOrEqual(last.x);
          expect(sample.y).toBeCloseTo(first.y, 0);
        }
      }
      expect(errors).toEqual([]);
    });
  }
}
