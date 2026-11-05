import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { Locator, Page } from '@playwright/test';
import { InkWorkspaceHarness } from '../ink-workspace/InkWorkspaceHarness';
import { animationFrames, readInkDraftWrites, watchInkDraftWrites } from '../ink-editor/inkTestUtils';
import { InkBoardEditorHarness } from './InkBoardEditorHarness';
import { INK_BOARD_CT_BASE_OBJECT_ID } from './fixtures';

type Point = { x: number; y: number };

function pathAt(y: number): Point[] {
  return Array.from({ length: 49 }, (_, index) => ({ x: 40 + index * 4, y: y + Math.sin(index / 6) * 4 }));
}

async function writePaths(canvas: Locator, paths: Point[][], keepActive = false) {
  await canvas.evaluate(async (element, { paths, keepActive }) => {
    const rect = element.getBoundingClientRect();
    for (const [index, points] of paths.entries()) {
      const send = (type: string, point: Point) => element.dispatchEvent(new PointerEvent(type, {
        pointerId: 301 + index, pointerType: 'pen', isPrimary: true, button: type === 'pointermove' ? -1 : 0,
        buttons: type === 'pointerup' ? 0 : 1, pressure: type === 'pointerup' ? 0 : 0.65,
        clientX: rect.left + point.x, clientY: rect.top + point.y, bubbles: true, cancelable: true,
      }));
      send('pointerdown', points[0]);
      for (let sample = 1; sample < points.length; sample += 1) {
        send('pointermove', points[sample]);
        if (keepActive && sample % 8 === 0) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      if (!keepActive) send('pointerup', points[points.length - 1]);
    }
  }, { paths, keepActive });
}

async function expectContinuousPixels(page: Page, paths: Point[][]) {
  await expect.poll(() => page.evaluate((paths) => {
    const canvas = document.querySelector('[data-testid="ink-board-canvas"]') as HTMLCanvasElement;
    const active = document.querySelector('[data-testid="ink-board-active-stroke-canvas"]') as HTMLCanvasElement;
    const composed = document.createElement('canvas');
    composed.width = canvas.width;
    composed.height = canvas.height;
    const context = composed.getContext('2d');
    if (!context) throw new Error('Board canvas 2D context is unavailable');
    context.drawImage(canvas, 0, 0);
    context.drawImage(active, 0, 0);
    const pixels = context.getImageData(0, 0, composed.width, composed.height).data;
    const scaleX = canvas.width / canvas.clientWidth;
    const scaleY = canvas.height / canvas.clientHeight;
    return paths.map((points) => {
      const missing: Point[] = [];
      for (let index = 1; index < points.length; index += 1) {
        const from = points[index - 1];
        const to = points[index];
        const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) * 2);
        for (let step = 0; step <= steps; step += 1) {
          const point = { x: from.x + (to.x - from.x) * step / steps, y: from.y + (to.y - from.y) * step / steps };
          const x = Math.round(point.x * scaleX);
          const y = Math.round(point.y * scaleY);
          let painted = false;
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              const offset = ((y + dy) * composed.width + x + dx) * 4;
              if (pixels[offset] < 64 && pixels[offset + 1] < 64 && pixels[offset + 2] < 64 && pixels[offset + 3] > 240) painted = true;
            }
          }
          if (!painted && missing.length < 12) missing.push(point);
        }
      }
      return missing;
    });
  }, paths)).toEqual(paths.map(() => []));
}

test('board continuous and rapid pen strokes survive a hung exit save with no per-stroke journal or canonical writes', async ({ mount, page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(String(error));
    console.error('Board CT page error:', String(error));
  });
  await mount(<InkWorkspaceHarness host="file-content" mode="board-v2" label="board-continuity" holdSaves />);
  const workspace = page.locator('[data-ink-workspace-page]');
  await expect(page.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready');
  const canvas = page.getByTestId('ink-board-canvas');
  await expect(canvas).toBeVisible();
  await page.getByTestId('ink-board-tool-pen').click();
  await page.getByTestId('ink-board-settings-toggle').click();
  await page.getByTestId('ink-board-color-black').click();
  await page.getByTestId('ink-board-width-8').click();
  await page.getByTestId('ink-board-settings-toggle').click();
  await watchInkDraftWrites(page);
  const single = pathAt(52);
  await writePaths(canvas, [single], true);
  await expectContinuousPixels(page, [single]);
  expect(await readInkDraftWrites(page)).toEqual([]);
  expect(await page.evaluate(() => window.__INK_WORKSPACE_CT__!.getState().saveAttempts)).toBe(0);
  await canvas.evaluate((element, point) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 301, pointerType: 'pen', isPrimary: true, button: 0, buttons: 0, pressure: 0,
      clientX: rect.left + point.x, clientY: rect.top + point.y, bubbles: true, cancelable: true,
    }));
  }, single[single.length - 1]);
  const rapid = [78, 104, 130, 156, 182, 208].map(pathAt);
  await writePaths(canvas, rapid);
  const paths = [single, ...rapid];
  await expectContinuousPixels(page, paths);
  await page.waitForTimeout(1_200);
  const beforeExit = await page.evaluate(() => window.__INK_WORKSPACE_CT__!.getState());
  expect(beforeExit.saveAttempts).toBe(0);
  expect(beforeExit.saveChunkCalls).toBe(0);
  expect(await readInkDraftWrites(page)).toEqual([]);

  const labels = await page.evaluate(() => window.__INK_WORKSPACE_CT__!.getLabels());
  const back = workspace.getByRole('button', { name: labels.back, exact: true });
  await back.click();
  await expect(back).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.__INK_WORKSPACE_CT__!.getState().pendingSaves)).toBe(1);
  await expectContinuousPixels(page, paths);
  const pending = await page.evaluate(() => window.__INK_WORKSPACE_CT__!.getState());
  expect(pending.saveAttempts).toBe(1);
  expect(pending.saveChunkCalls).toBe(0);
  expect(await readInkDraftWrites(page)).not.toEqual([]);
  await page.evaluate(() => window.__INK_WORKSPACE_CT__!.releaseSaves());
  await expect(workspace).toHaveCount(0);
  const saved = await page.evaluate(() => window.__INK_WORKSPACE_CT__!.getState());
  expect(saved.saveChunkCalls).toBe(1);
  const drawn = saved.objects.filter((object) => object.id !== INK_BOARD_CT_BASE_OBJECT_ID);
  expect(drawn).toHaveLength(paths.length);
  for (const [index, object] of drawn.entries()) {
    if (object.content.kind !== 'stroke') throw new Error('Board writing must preserve one object per gesture');
    expect(object.content.samples.length).toBeGreaterThanOrEqual(paths[index].length);
  }
  const savedIds = new Set(drawn.map((object) => object.id));
  expect(saved.saveChunkRequests[0].changed.flatMap((chunk) => chunk.objects).filter((object) => savedIds.has(object.id))).toEqual(drawn);
  await page.getByRole('button', { name: labels.reopen, exact: true }).click();
  await expect(page.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready');
  await expectContinuousPixels(page, paths);
  expect(await page.evaluate(() => window.__INK_WORKSPACE_CT__!.getState().saveAttempts)).toBe(1);
  expect(errors).toEqual([]);
});

for (const backgroundEvent of ['pagehide', 'visibilitychange'] as const) {
  test(`board ${backgroundEvent} protects the first unlifted pen path despite unrelated palm touches without a canonical save`, async ({ mount, page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await mount(<InkBoardEditorHarness mode="board-v2" label={`background-${backgroundEvent}`} />);
    const workspace = page.locator('[data-ink-workspace-page]');
    await expect(page.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready');
    const canvas = page.getByTestId('ink-board-canvas');
    await page.getByTestId('ink-board-settings-toggle').click();
    await page.getByTestId('ink-board-color-black').click();
    await page.getByTestId('ink-board-width-8').click();
    await page.getByTestId('ink-board-settings-toggle').click();
    await watchInkDraftWrites(page);
    const first = pathAt(52);
    await writePaths(canvas, [first], true);
    await canvas.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      for (const pointerId of [601, 602]) {
        element.dispatchEvent(new PointerEvent('pointerdown', {
          pointerId, pointerType: 'touch', isPrimary: pointerId === 601,
          button: 0, buttons: 1, clientX: rect.left + 300 + (pointerId - 601) * 30, clientY: rect.top + 180,
          bubbles: true, cancelable: true,
        }));
      }
    });
    await expectContinuousPixels(page, [first]);
    expect(await readInkDraftWrites(page)).toEqual([]);
    expect(await page.evaluate(() => window.__INK_BOARD_CT__!.getState().saveChunkCalls)).toBe(0);
    await page.evaluate((event) => {
      if (event === 'visibilitychange') {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      } else {
        window.dispatchEvent(new PageTransitionEvent('pagehide'));
      }
    }, backgroundEvent);
    await expect.poll(() => page.evaluate(async () => {
      const draft = await window.__INK_BOARD_CT__!.readDraft();
      return draft?.changed.flatMap((chunk) => chunk.objects).length ?? 0;
    })).toBe(1);
    const protectedDraft = await page.evaluate(() => window.__INK_BOARD_CT__!.readDraft());
    const protectedStroke = protectedDraft!.changed.flatMap((chunk) => chunk.objects)[0];
    if (protectedStroke.content.kind !== 'stroke') throw new Error('Background protection dropped the unlifted pen path');
    expect(protectedStroke.content.samples.length).toBeGreaterThanOrEqual(first.length);
    expect(await page.evaluate(() => window.__INK_BOARD_CT__!.getState().saveChunkCalls)).toBe(0);
    await expectContinuousPixels(page, [first]);
    if (backgroundEvent === 'visibilitychange') {
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    }
    await canvas.evaluate((element, point) => {
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 301, pointerType: 'pen', button: 0, buttons: 0, pressure: 0,
        clientX: rect.left + point.x, clientY: rect.top + point.y, bubbles: true, cancelable: true,
      }));
      for (const pointerId of [601, 602]) element.dispatchEvent(new PointerEvent('pointercancel', {
        pointerId, pointerType: 'touch', bubbles: true, cancelable: true,
      }));
    }, first[first.length - 1]);
    await animationFrames(page, 3);
    const second = pathAt(104);
    await writePaths(canvas, [second]);
    await expectContinuousPixels(page, [first, second]);
    expect(await page.evaluate(() => window.__INK_BOARD_CT__!.getState().saveChunkCalls)).toBe(0);
    await workspace.locator('header').getByRole('button').click();
    await expect(workspace).toHaveCount(0);
    const saved = await page.evaluate(() => window.__INK_BOARD_CT__!.getState());
    expect(saved.saveChunkCalls).toBe(1);
    const drawn = saved.objects.filter((object) => object.id !== INK_BOARD_CT_BASE_OBJECT_ID);
    expect(drawn).toHaveLength(2);
    expect(drawn[0]).toEqual(protectedStroke);
    await page.getByTestId('ink-board-ct-unmount').click();
    await expect(page.getByTestId('ink-board-ct-remount')).toBeEnabled();
    await page.getByTestId('ink-board-ct-remount').click();
    await expect(page.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready');
    await expectContinuousPixels(page, [first, second]);
    expect(await page.evaluate(() => window.__INK_BOARD_CT__!.getState().saveChunkCalls)).toBe(1);
  });
}
