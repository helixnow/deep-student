import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { Locator, Page } from '@playwright/test';
import type { InkPage } from '@/features/ink/types';
import { InkEditorHarness } from './InkEditorHarness';
import { inkEditorPageId } from './fixtures';
import { animationFrames, expectEditorFlush, readInkDraftWrites, watchInkDraftWrites } from './inkTestUtils';

type Point = { x: number; y: number };
const pageOneId = 'ink-editor-ct-page-1';

function pathAt(y: number): Point[] {
  return Array.from({ length: 43 }, (_, index) => ({ x: 18 + index * 2, y: y + Math.sin(index / 5) * 3 }));
}

async function pointerPaths(input: Locator, paths: Point[][], pauseWhileActive = false) {
  await input.evaluate(async (element, { paths, pauseWhileActive }) => {
    const rect = element.getBoundingClientRect();
    const send = (type: string, point: Point, pointerId: number) => element.dispatchEvent(new PointerEvent(type, {
      pointerId, pointerType: 'pen', isPrimary: true, button: type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerup' ? 0 : 1, pressure: type === 'pointerup' ? 0 : 0.65,
      clientX: rect.left + point.x * rect.width / 120,
      clientY: rect.top + point.y * rect.height / 160,
      bubbles: true, cancelable: true,
    }));
    for (const [index, points] of paths.entries()) {
      const pointerId = 201 + index;
      send('pointerdown', points[0], pointerId);
      for (let sample = 1; sample < points.length; sample += 1) {
        send('pointermove', points[sample], pointerId);
        if (pauseWhileActive && sample % 7 === 0) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      if (!pauseWhileActive) send('pointerup', points[points.length - 1], pointerId);
    }
  }, { paths, pauseWhileActive });
}

async function finishPointer(input: Locator, point: Point) {
  await input.evaluate((element, point) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 201, pointerType: 'pen', isPrimary: true, button: 0, buttons: 0, pressure: 0,
      clientX: rect.left + point.x * rect.width / 120,
      clientY: rect.top + point.y * rect.height / 160,
      bubbles: true, cancelable: true,
    }));
  }, point);
}

async function pathPixels(page: Page, paths: Point[][]) {
  return page.evaluate((paths) => {
    const completed = document.querySelector('[data-testid="ink-page-canvas"]') as HTMLCanvasElement;
    const active = document.querySelector('[data-testid="ink-active-stroke-canvas"]') as HTMLCanvasElement;
    const composed = document.createElement('canvas');
    composed.width = completed.width;
    composed.height = completed.height;
    const context = composed.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    context.drawImage(completed, 0, 0);
    context.drawImage(active, 0, 0);
    const pixels = context.getImageData(0, 0, composed.width, composed.height).data;
    return paths.map((points) => {
      const missing: Point[] = [];
      let checked = 0;
      for (let index = 1; index < points.length; index += 1) {
        const from = points[index - 1];
        const to = points[index];
        const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) * 2);
        for (let step = 0; step <= steps; step += 1) {
          const point = { x: from.x + (to.x - from.x) * step / steps, y: from.y + (to.y - from.y) * step / steps };
          const x = Math.round(point.x * composed.width / 120);
          const y = Math.round(point.y * composed.height / 160);
          let painted = false;
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              const offset = ((y + dy) * composed.width + x + dx) * 4;
              if (pixels[offset] < 64 && pixels[offset + 1] < 64 && pixels[offset + 2] < 64 && pixels[offset + 3] > 240) painted = true;
            }
          }
          checked += 1;
          if (!painted && missing.length < 12) missing.push(point);
        }
      }
      return { checked, missing };
    });
  }, paths);
}

async function expectContinuousPixels(page: Page, paths: Point[][]) {
  await expect.poll(() => pathPixels(page, paths)).toEqual(paths.map((points) => ({
    checked: points.slice(1).reduce((sum, point, index) => sum + Math.ceil(Math.hypot(point.x - points[index].x, point.y - points[index].y) * 2) + 1, 0),
    missing: [],
  })));
}

async function backendState(page: Page) {
  return page.evaluate(() => {
    const backend = window.__INK_EDITOR_CT_BACKEND__!;
    return {
      saveCalls: backend.saveCalls,
      pendingSaves: backend.pendingSaves,
      saveRequests: backend.saveRequests,
      pageOne: backend.readPage('ink-editor-ct-page-1')!,
      pageTwo: backend.readPage('ink-editor-ct-page-2')!,
    };
  });
}

function drawnObjects(page: InkPage) {
  return page.objects.filter((object) => !object.id.startsWith('fixture-'));
}

for (const saveMode of ['slow', 'hung'] as const) {
  test(`continuous single-stroke samples and rapid strokes stay local across pages until one final flush with ${saveMode} storage`, async ({ mount, page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await watchInkDraftWrites(page);
    const component = await mount(<InkEditorHarness saveMode="success" saveDelayMs={saveMode === 'slow' ? 400 : 0} holdSaves={saveMode === 'hung'} />);
    const canvas = component.getByTestId('ink-page-canvas');
    const input = component.getByTestId('ink-active-stroke-canvas');
    await expect(canvas).toHaveAttribute('data-page-id', inkEditorPageId);
    await component.getByTestId('ink-color-black').click();
    await component.getByTestId('ink-width-medium').click();

    const single = pathAt(64);
    await pointerPaths(input, [single], true);
    await expectContinuousPixels(page, [single]);
    expect((await backendState(page)).saveCalls).toBe(0);
    expect(await readInkDraftWrites(page)).toEqual([]);
    await finishPointer(input, single[single.length - 1]);
    const rapid = [80, 92, 104, 116, 128, 140].map(pathAt);
    await pointerPaths(input, rapid);
    const pageTwoPaths = [single, ...rapid];
    await expectContinuousPixels(page, pageTwoPaths);
    await page.waitForTimeout(1_200);
    const writingState = await backendState(page);
    const writingDrafts = await readInkDraftWrites(page);
    expect({ saveCalls: writingState.saveCalls, draftWrites: writingDrafts }, 'writing must never start canonical saves or per-stroke IndexedDB writes').toEqual({ saveCalls: 0, draftWrites: [] });

    await component.getByTestId('ink-page-previous').click();
    await expect(canvas).toHaveAttribute('data-page-id', pageOneId);
    const pageOnePaths = [64, 88, 112].map(pathAt);
    await pointerPaths(input, pageOnePaths);
    await expectContinuousPixels(page, pageOnePaths);
    await component.getByTestId('ink-page-next').click();
    await expect(canvas).toHaveAttribute('data-page-id', inkEditorPageId);
    await expectContinuousPixels(page, pageTwoPaths);
    await animationFrames(page, 6);
    const beforeFlush = await backendState(page);
    expect(beforeFlush.saveCalls).toBe(0);
    expect(beforeFlush.pendingSaves).toBe(0);
    expect(drawnObjects(beforeFlush.pageOne)).toEqual([]);
    expect(drawnObjects(beforeFlush.pageTwo)).toEqual([]);
    expect(await readInkDraftWrites(page)).toEqual([]);

    await page.getByTestId('ink-editor-flush').evaluate((button) => (button as HTMLButtonElement).click());
    await expect.poll(async () => (await backendState(page)).saveCalls).toBe(1);
    if (saveMode === 'hung') {
      await expect.poll(async () => (await backendState(page)).pendingSaves).toBe(1);
      await animationFrames(page, 8);
      await expectContinuousPixels(page, pageTwoPaths);
      expect(await page.evaluate(() => window.__INK_EDITOR_FLUSH_RESULT__)).toBeUndefined();
      expect(await page.evaluate(() => window.__INK_EDITOR_CT_BACKEND__!.releaseSaves())).toBe(1);
    }
    await expect.poll(() => page.evaluate(() => window.__INK_EDITOR_FLUSH_RESULT__)).toEqual({ ok: true });
    const saved = await backendState(page);
    expect(saved.saveCalls).toBe(2);
    expect(saved.saveRequests.map((request) => request.page.page_id).sort()).toEqual([pageOneId, inkEditorPageId]);
    expect(saved.saveRequests.find((request) => request.page.page_id === pageOneId)?.page).toEqual(saved.pageOne);
    expect(saved.saveRequests.find((request) => request.page.page_id === inkEditorPageId)?.page).toEqual(saved.pageTwo);
    for (const [savedPage, paths] of [[saved.pageOne, pageOnePaths], [saved.pageTwo, pageTwoPaths]] as const) {
      const drawn = drawnObjects(savedPage);
      expect(drawn).toHaveLength(paths.length);
      for (const [index, object] of drawn.entries()) {
        if (object.content.kind !== 'stroke') throw new Error('A writing gesture must remain one stroke');
        for (const point of paths[index]) {
          expect(object.content.samples.some((sample) => Math.hypot(sample.x - point.x, sample.y - point.y) < 0.01)).toBe(true);
        }
      }
    }
    const writes = await readInkDraftWrites(page);
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(writes.every((write) => write.objects === (write.pageId === pageOneId ? 4 : 8))).toBe(true);

    await component.getByTestId('ink-editor-unmount').click();
    await component.getByTestId('ink-editor-remount').click();
    await expect(canvas).toHaveAttribute('data-page-id', inkEditorPageId);
    await expectContinuousPixels(page, pageTwoPaths);
    await component.getByTestId('ink-page-previous').click();
    await expect(canvas).toHaveAttribute('data-page-id', pageOneId);
    await expectContinuousPixels(page, pageOnePaths);
    expect((await backendState(page)).saveRequests).toEqual(saved.saveRequests);
    expect(errors).toEqual([]);
  });
}

for (const cancelTouch of ['before', 'after'] as const) {
  test(`pen takeover removes a palm touch preview without connecting or saving it when touch cancel arrives ${cancelTouch} pen up`, async ({ mount, page }) => {
    const component = await mount(<InkEditorHarness saveMode="success" />);
    const canvas = component.getByTestId('ink-page-canvas');
    const input = component.getByTestId('ink-active-stroke-canvas');
    await expect(canvas).toBeVisible();
    await component.getByTestId('ink-color-black').click();
    await component.getByTestId('ink-width-medium').click();
    await component.getByTestId('ink-touch-draw-toggle').click();
    await watchInkDraftWrites(page);
    const pen = pathAt(64);
    await input.evaluate(async (element, { pen, cancelTouch }) => {
      const rect = element.getBoundingClientRect();
      const send = (type: string, pointerType: string, pointerId: number, point?: Point) => element.dispatchEvent(new PointerEvent(type, {
        pointerId, pointerType, isPrimary: true, button: type === 'pointermove' ? -1 : 0,
        buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
        pressure: type === 'pointerup' || type === 'pointercancel' ? 0 : 0.65,
        ...(point ? { clientX: rect.left + point.x * rect.width / 120, clientY: rect.top + point.y * rect.height / 160 } : {}),
        bubbles: true, cancelable: true,
      }));
      send('pointerdown', 'touch', 411, { x: 30, y: 112 });
      send('pointermove', 'touch', 411, { x: 90, y: 112 });
      send('pointerdown', 'pen', 412, pen[0]);
      if (cancelTouch === 'before') send('pointercancel', 'touch', 411);
      send('lostpointercapture', 'touch', 411);
      for (const point of pen.slice(1)) send('pointermove', 'pen', 412, point);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }, { pen, cancelTouch });
    await expectContinuousPixels(page, [pen]);
    await input.evaluate((element, { point, cancelTouch }) => {
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 412, pointerType: 'pen', isPrimary: true, button: 0, buttons: 0, pressure: 0,
        clientX: rect.left + point.x * rect.width / 120, clientY: rect.top + point.y * rect.height / 160,
        bubbles: true, cancelable: true,
      }));
      if (cancelTouch === 'after') element.dispatchEvent(new PointerEvent('pointercancel', {
        pointerId: 411, pointerType: 'touch', bubbles: true, cancelable: true,
      }));
    }, { point: pen[pen.length - 1], cancelTouch });
    await expectContinuousPixels(page, [pen]);
    const outside = await page.evaluate(() => {
      const targets = ['ink-page-canvas', 'ink-active-stroke-canvas'];
      return targets.map((id) => {
        const target = document.querySelector(`[data-testid="${id}"]`) as HTMLCanvasElement;
        const context = target.getContext('2d')!;
        const pixels = context.getImageData(0, 0, target.width, target.height).data;
        let dark = 0;
        for (let y = 0; y < target.height; y += 1) {
          const logicalY = (y + 0.5) * 160 / target.height;
          for (let x = 0; x < target.width; x += 1) {
            const logicalX = (x + 0.5) * 120 / target.width;
            if (logicalX >= 10 && logicalX <= 110 && logicalY >= 54 && logicalY <= 74) continue;
            const offset = (y * target.width + x) * 4;
            if (pixels[offset] < 64 && pixels[offset + 1] < 64 && pixels[offset + 2] < 64 && pixels[offset + 3] > 0) dark += 1;
          }
        }
        return dark;
      });
    });
    expect(outside, 'palm preview and palm-to-pen connecting rays must be absent from both real canvases').toEqual([0, 0]);
    expect((await backendState(page)).saveCalls).toBe(0);
    expect(await readInkDraftWrites(page)).toEqual([]);
    await expectEditorFlush(page);
    const drawn = drawnObjects((await backendState(page)).pageTwo);
    expect(drawn).toHaveLength(1);
    if (drawn[0].content.kind !== 'stroke') throw new Error('Pen takeover did not commit a stroke');
    expect(drawn[0].content.style.pressure_enabled).toBe(true);
    expect(drawn[0].content.samples.every((sample) => sample.y > 59 && sample.y < 69)).toBe(true);
    await component.getByTestId('ink-editor-unmount').click();
    await component.getByTestId('ink-editor-remount').click();
    await expect(canvas).toBeVisible();
    await expectContinuousPixels(page, [pen]);
  });
}

for (const lifted of [false, true]) {
  test(`same-document key replacement waits for the old exit save before reading the real canvas again with lifted=${lifted}`, async ({ mount, page }) => {
    const component = await mount(<InkEditorHarness saveMode="save-echo" holdSaves />);
    const canvas = component.getByTestId('ink-page-canvas');
    const input = component.getByTestId('ink-active-stroke-canvas');
    await expect(canvas).toBeVisible();
    await component.getByTestId('ink-color-black').click();
    await component.getByTestId('ink-width-medium').click();
    const first = pathAt(64);
    await pointerPaths(input, [first], !lifted);
    await expectContinuousPixels(page, [first]);
    const reads = await page.evaluate(() => window.__INK_EDITOR_CT_BACKEND__!.getCalls);
    await component.getByTestId('ink-editor-remount').click();
    await expect.poll(async () => (await backendState(page)).pendingSaves).toBe(1);
    await expect(component.getByTestId('ink-editor-flush-state')).toHaveText('loading');
    expect(await page.evaluate(() => window.__INK_EDITOR_CT_BACKEND__!.getCalls)).toBe(reads);
    expect(await page.evaluate(() => window.__INK_EDITOR_CT_BACKEND__!.releaseSaves())).toBe(1);
    await expect(component.getByTestId('ink-editor-flush-state')).toHaveText('ready');
    await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
    await expectContinuousPixels(page, [first]);
    const second = pathAt(100);
    await pointerPaths(input, [second]);
    await expectContinuousPixels(page, [first, second]);
    expect((await backendState(page)).saveCalls).toBe(1);
    await expectEditorFlush(page);
    const saved = await backendState(page);
    expect(saved.saveCalls).toBe(2);
    expect(saved.saveRequests.map((request) => request.expected_revision)).toEqual(['revision-1', 'revision-2']);
    expect(drawnObjects(saved.pageTwo)).toHaveLength(2);
    expect((await page.evaluate(() => window.__INK_EDITOR_CT_BACKEND__!.readManifest())).revision).toBe('revision-3');
  });
}

test('a held remote reload cannot replace a new unlifted pen path or its completed local canvas', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="conflict" />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toBeVisible();
  await component.getByTestId('ink-color-black').click();
  await component.getByTestId('ink-width-medium').click();
  const first = pathAt(64);
  await pointerPaths(input, [first]);
  await page.getByTestId('ink-editor-flush').evaluate((button) => (button as HTMLButtonElement).click());
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'conflict');
  await page.evaluate(() => window.__INK_EDITOR_CT_BACKEND__!.holdPageReads(true));
  await component.getByRole('button', { name: 'actions.reloadRemote', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__INK_EDITOR_CT_BACKEND__!.pendingPageReads)).toBe(1);
  const second = pathAt(100);
  await pointerPaths(input, [second], true);
  await expectContinuousPixels(page, [first, second]);
  expect(await page.evaluate(() => window.__INK_EDITOR_CT_BACKEND__!.releasePageReads())).toBe(1);
  await expect(component.getByText('errors.operationFailed')).toBeVisible();
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'conflict');
  await expectContinuousPixels(page, [first, second]);
  await finishPointer(input, second[second.length - 1]);
  await expectContinuousPixels(page, [first, second]);
  expect((await backendState(page)).saveCalls).toBe(1);
  expect(drawnObjects((await backendState(page)).pageTwo)).toEqual([]);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await animationFrames(page, 4);
  await component.getByTestId('ink-editor-unmount').click();
  await component.getByTestId('ink-editor-remount').click();
  await expect(canvas).toBeVisible();
  await expectContinuousPixels(page, [first, second]);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'conflict');
  expect((await backendState(page)).saveCalls).toBe(1);
});
