import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { Locator, Page } from '@playwright/test';
import type { InkPage } from '@/features/ink/types';
import { InkEditorHarness } from './InkEditorHarness';
import { inkEditorPageId } from './fixtures';
import { expectEditorFlush } from './inkTestUtils';

async function readPage(page: Page, pageId = inkEditorPageId): Promise<InkPage | undefined> {
  return page.evaluate((id) => window.__INK_EDITOR_CT_BACKEND__?.readPage(id), pageId);
}

async function logicalStroke(page: Page, input: Locator, from = { x: 120, y: 200 }, to = { x: 640, y: 200 }) {
  const box = await input.boundingBox();
  if (!box) throw new Error('Ink input surface has no bounds');
  const scale = box.width / 1200;
  await page.mouse.move(box.x + from.x * scale, box.y + from.y * scale);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x * scale, box.y + to.y * scale, { steps: 5 });
  await page.mouse.up();
}

async function resetToolScroll(page: Page) {
  await page.getByRole('toolbar').evaluate((element) => { element.scrollLeft = 0; });
}

for (const size of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
  test(`keeps a fitted full-height paper viewport and saves across pages at ${size.width}px`, async ({ mount, page }) => {
    await page.setViewportSize(size);
    const component = await mount(<InkEditorHarness saveMode="success" largePage fullHeight />);
    const canvas = component.getByTestId('ink-page-canvas');
    const input = component.getByTestId('ink-active-stroke-canvas');
    const viewport = component.getByTestId('ink-page-viewport');
    const toolbar = component.getByTestId('ink-toolbar');
    await expect(canvas).toHaveAttribute('data-page-id', inkEditorPageId);

    await expect.poll(() => viewport.evaluate((element) => {
      const canvas = element.querySelector('[data-testid="ink-page-canvas"]');
      if (!canvas) return false;
      const paper = canvas.getBoundingClientRect();
      const view = element.getBoundingClientRect();
      return paper.left >= view.left && paper.right <= view.right + 1 && element.scrollWidth <= element.clientWidth + 1;
    })).toBe(true);
    const viewportBox = await viewport.boundingBox();
    const toolbarBox = await toolbar.boundingBox();
    expect(viewportBox?.height ?? 0).toBeGreaterThan(size.height - 160);
    expect(toolbarBox?.height ?? Infinity).toBeLessThan(130);
    expect((viewportBox?.y ?? 0) + (viewportBox?.height ?? 0)).toBeLessThanOrEqual(size.height + 1);
    for (const id of ['ink-tool-pen', 'ink-tool-settings', 'ink-page-previous', 'ink-page-append']) {
      const box = await component.getByTestId(id).boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    await logicalStroke(page, input);
    await expectEditorFlush(page);
    await expect.poll(async () => (await readPage(page))?.objects.length).toBe(2);
    const savedStroke = (await readPage(page))?.objects.find((object) => object.id !== 'fixture-blue-stroke');
    expect(savedStroke?.content.kind).toBe('stroke');
    if (savedStroke?.content.kind === 'stroke') {
      expect(savedStroke.content.samples[0].x).toBeCloseTo(120, 0);
      expect(savedStroke.content.samples[0].y).toBeCloseTo(200, 0);
    }
    await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
    await component.getByTestId('ink-undo').click();
    await expectEditorFlush(page);
    await expect.poll(async () => (await readPage(page))?.objects.length).toBe(1);
    await component.getByTestId('ink-redo').click();
    await expectEditorFlush(page);
    await expect.poll(async () => (await readPage(page))?.objects.length).toBe(2);

    await component.getByTestId('ink-zoom-in').click();
    await viewport.evaluate((element) => { element.scrollTop = 180; });
    expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const toolbarTop = (await toolbar.boundingBox())?.y;
    await component.getByTestId('ink-page-previous').click();
    await expect(canvas).toHaveAttribute('data-page-id', 'ink-editor-ct-page-1');
    expect(await viewport.evaluate((element) => element.scrollTop)).toBe(0);
    expect((await toolbar.boundingBox())?.y).toBe(toolbarTop);
    await component.getByTestId('ink-page-next').click();
    await expect(canvas).toHaveAttribute('data-page-id', inkEditorPageId);
    expect((await readPage(page))?.objects.length).toBe(2);
    await component.getByTestId('ink-page-append').click();
    await expect(canvas).toHaveAttribute('data-page-id', 'ink-editor-ct-page-3');
    await logicalStroke(page, input, { x: 140, y: 180 }, { x: 600, y: 180 });
    await expectEditorFlush(page);
    await expect.poll(async () => (await readPage(page, 'ink-editor-ct-page-3'))?.objects.length).toBe(1);
  });
}

test('preserves user zoom and pan on resize and saves touch strokes in logical coordinates', async ({ mount, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const component = await mount(<InkEditorHarness saveMode="success" largePage fullHeight />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(390);
  await component.getByTestId('ink-zoom-in').click();
  await component.getByTestId('ink-pan-right').click();
  const zoomedWidth = await canvas.evaluate((element) => element.getBoundingClientRect().width);
  const zoomLevel = await component.getByTestId('ink-zoom-level').textContent();
  await page.setViewportSize({ width: 360, height: 740 });
  await expect(component.getByTestId('ink-zoom-level')).toHaveText(zoomLevel ?? '');
  await expect.poll(() => canvas.evaluate((element) => element.getBoundingClientRect().width)).toBe(zoomedWidth);
  await expect(component.getByTestId('ink-page-surface')).toHaveCSS('left', '20px');

  await input.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const scale = rect.width / 1200;
    for (const [type, x] of [['pointerdown', 120], ['pointermove', 240], ['pointerup', 360]] as const) {
      element.dispatchEvent(new PointerEvent(type, {
        pointerId: 41, pointerType: 'touch', bubbles: true, cancelable: true,
        clientX: rect.left + x * scale, clientY: rect.top + 200 * scale,
      }));
    }
  });
  expect((await readPage(page))?.objects).toHaveLength(1);
  await resetToolScroll(page);
  await component.getByTestId('ink-touch-draw-toggle').click();
  await input.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const scale = rect.width / 1200;
    for (const [type, x] of [['pointerdown', 120], ['pointermove', 240], ['pointerup', 360]] as const) {
      element.dispatchEvent(new PointerEvent(type, {
        pointerId: 42, pointerType: 'touch', bubbles: true, cancelable: true,
        clientX: rect.left + x * scale, clientY: rect.top + 200 * scale,
      }));
    }
  });
  await expectEditorFlush(page);
  await expect.poll(async () => (await readPage(page))?.objects.length).toBe(2);
  const touchStroke = (await readPage(page))?.objects.find((object) => object.id !== 'fixture-blue-stroke');
  if (touchStroke?.content.kind !== 'stroke') throw new Error('Touch stroke was not saved');
  expect(touchStroke.content.samples[0].x).toBeCloseTo(120, 0);
  expect(touchStroke.content.samples[0].y).toBeCloseTo(200, 0);
});
