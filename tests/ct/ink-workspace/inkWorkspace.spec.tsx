import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { Locator, Page } from '@playwright/test';
import { INK_BOARD_CT_BASE_OBJECT_ID } from '../ink-board/fixtures';
import { InkWorkspaceHarness, type InkWorkspaceCtSnapshot } from './InkWorkspaceHarness';

const workspace = (page: Page) => page.locator('[data-ink-workspace-page]');

async function readLabels(page: Page) {
  return page.evaluate(() => {
    if (!window.__INK_WORKSPACE_CT__) throw new Error('Missing InkWorkspace CT bridge');
    return window.__INK_WORKSPACE_CT__.getLabels();
  });
}

async function readState(page: Page): Promise<InkWorkspaceCtSnapshot> {
  return page.evaluate(() => {
    if (!window.__INK_WORKSPACE_CT__) throw new Error('Missing InkWorkspace CT bridge');
    return window.__INK_WORKSPACE_CT__.getState();
  });
}

async function expectFullViewport(page: Page, width: number, height: number) {
  const view = workspace(page);
  await expect(view).toBeVisible();
  const layout = await view.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      bodyPortal: element.parentElement?.parentElement === document.body,
      position: getComputedStyle(element).position,
      bodyOverflow: document.body.style.overflow,
    };
  });
  expect(layout.bodyPortal).toBe(true);
  expect(layout.position).toBe('fixed');
  expect(layout.left).toBeCloseTo(0, 0);
  expect(layout.top).toBeCloseTo(0, 0);
  expect(layout.width).toBeCloseTo(width, 0);
  expect(layout.height).toBeCloseTo(height, 0);
  expect(layout.bodyOverflow).toBe('hidden');
  await expect(page.locator('[data-ink-workspace-page] h1')).toBeVisible();
  const header = await view.locator('header').boundingBox();
  expect(header?.height ?? 0).toBeGreaterThan(40);
  expect((header?.y ?? -1) + (header?.height ?? 0)).toBeLessThan(height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

async function drawStroke(page: Page, canvas: Locator) {
  const bounds = await canvas.boundingBox();
  if (!bounds || bounds.width < 100 || bounds.height < 80) throw new Error('Ink input is not a usable viewport');
  const from = { x: bounds.x + bounds.width * 0.2, y: bounds.y + Math.min(80, bounds.height * 0.25) };
  const to = { x: bounds.x + bounds.width * 0.65, y: from.y + 25 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

async function darkPixels(canvas: Locator, region?: { x: number; y: number; width: number; height: number }) {
  return canvas.evaluate((element, area) => {
    const target = element as HTMLCanvasElement;
    const context = target.getContext('2d');
    if (!context) throw new Error('Canvas 2D context unavailable');
    const x = Math.max(0, Math.floor((area?.x ?? 0) * target.width));
    const y = Math.max(0, Math.floor((area?.y ?? 0) * target.height));
    const width = Math.min(target.width - x, Math.ceil((area?.width ?? 1) * target.width));
    const height = Math.min(target.height - y, Math.ceil((area?.height ?? 1) * target.height));
    const pixels = context.getImageData(x, y, width, height).data;
    let count = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset] < 48 && pixels[offset + 1] < 48 && pixels[offset + 2] < 48 && pixels[offset + 3] > 240) count += 1;
    }
    return count;
  }, region);
}

for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  for (const host of ['workspace', 'dstu', 'file-content'] as const) {
    for (const mode of ['paged-v1', 'board-v2'] as const) {
      test(`${host} ${mode} opens a body fullscreen page rather than its embedded 280px host at ${size.width}px`, async ({ mount, page }) => {
        await page.setViewportSize(size);
        await mount(<InkWorkspaceHarness host={host} mode={mode} label={`layout-${host}-${mode}-${size.width}`} />);
        const board = mode === 'board-v2';
        const editor = page.getByTestId(board ? 'ink-board-editor' : 'ink-editor');
        await expect(editor).toBeVisible();
        await expect(page.getByTestId(board ? 'ink-editor' : 'ink-board-editor')).toHaveCount(0);
        await expectFullViewport(page, size.width, size.height);
        const input = page.getByTestId(board ? 'ink-board-canvas' : 'ink-active-stroke-canvas');
        await expect(input).toBeVisible();
        const canvasBounds = await input.boundingBox();
        expect(canvasBounds?.width ?? 0).toBeGreaterThan(200);
        expect(canvasBounds?.height ?? 0).toBeGreaterThan(100);
        expect((canvasBounds?.y ?? 0) + (canvasBounds?.height ?? 0)).toBeLessThanOrEqual(size.height + 1);
        const state = await readState(page);
        expect(state.manifest.schema_version).toBe(board ? 2 : 1);
        expect(state.createCalls).toEqual([]);
        expect(state.saveAttempts).toBe(0);
        if (board) expect(state.pageReads).toBe(0);
        else expect(state.chunkReads).toBe(0);
      });
    }
  }
}

for (const [host, mode] of [['dstu', 'paged-v1'], ['file-content', 'board-v2']] as const) {
  test(`${host} ${mode} waits for a real stroke CAS before returning, then reopens the saved ink at 390px`, async ({ mount, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(<InkWorkspaceHarness host={host} mode={mode} label={`save-${host}`} holdSaves />);
    const labels = await readLabels(page);
    const board = mode === 'board-v2';
    const editor = page.getByTestId(board ? 'ink-board-editor' : 'ink-editor');
    await expect(editor).toBeVisible();
    if (board) await expect(page.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready');
    else await expect(page.getByTestId('ink-editor-flush-state')).toHaveText('ready');
    await page.getByTestId(board ? 'ink-board-tool-pen' : 'ink-tool-pen').click();
    const input = page.getByTestId(board ? 'ink-board-canvas' : 'ink-active-stroke-canvas');
    const rendered = page.getByTestId(board ? 'ink-board-canvas' : 'ink-page-canvas');
    const initialPixels = await darkPixels(rendered, { x: 0.15, y: 0, width: 0.6, height: 0.6 });
    await drawStroke(page, input);
    if (board) await expect(page.getByTestId('ink-board-save-state')).toHaveAttribute('data-state', 'saving');
    else await expect.poll(async () => (await readState(page)).pendingSaves).toBe(1);

    const back = workspace(page).getByRole('button', { name: labels.back, exact: true });
    await back.click();
    await expect(back).toBeDisabled();
    await expect(workspace(page)).toBeVisible();
    await expect(page.getByRole('button', { name: labels.reopen })).toHaveCount(0);
    await expect.poll(async () => (await readState(page)).pendingSaves).toBe(1);
    const pending = await readState(page);
    expect(pending.saveChunkCalls + pending.savePageCalls).toBe(0);
    await page.evaluate(() => window.__INK_WORKSPACE_CT__?.releaseSaves());
    await expect(workspace(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    const saved = await readState(page);
    const stroke = board
      ? saved.objects.find((object) => object.id !== INK_BOARD_CT_BASE_OBJECT_ID)
      : saved.pages[0]?.objects[0];
    expect(stroke?.content.kind).toBe('stroke');
    expect(saved.saveChunkCalls + saved.savePageCalls).toBeGreaterThan(0);

    const reads = saved.chunkReads + saved.pageReads;
    await page.getByRole('button', { name: labels.reopen }).click();
    await expect(editor).toBeVisible();
    await expect.poll(async () => (await readState(page)).chunkReads + (await readState(page)).pageReads).toBeGreaterThan(reads);
    const reopened = await readState(page);
    const objects = board ? reopened.objects : reopened.pages[0]?.objects ?? [];
    expect(objects.some((object) => object.id === stroke?.id)).toBe(true);
    await expect.poll(() => darkPixels(rendered, { x: 0.15, y: 0, width: 0.6, height: 0.6 })).toBeGreaterThan(initialPixels + 10);
    expect(reopened.createCalls).toEqual([]);
  });
}

test('a failed canonical page save keeps the real editor and draft open until the user retries', async ({ mount, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(<InkWorkspaceHarness mode="paged-v1" label="save-failure" holdSaves />);
  const labels = await readLabels(page);
  await expect(page.getByTestId('ink-editor-flush-state')).toHaveText('ready');
  const editor = page.getByTestId('ink-editor');
  await page.getByTestId('ink-tool-pen').click();
  await drawStroke(page, page.getByTestId('ink-active-stroke-canvas'));
  await expect.poll(async () => (await readState(page)).pendingSaves).toBe(1);
  const back = workspace(page).getByRole('button', { name: labels.back, exact: true });
  await back.click();
  await expect(back).toBeDisabled();
  await page.evaluate(() => window.__INK_WORKSPACE_CT__?.rejectSaves());
  await expect(workspace(page).getByRole('alert').filter({ hasText: labels.exitBlocked })).toBeVisible();
  await expect(editor).toBeVisible();
  await expect(back).toBeEnabled();
  await expect(page.getByRole('button', { name: labels.reopen })).toHaveCount(0);
  await expect(page.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'offline');
  await page.getByTestId('ink-page-controls').getByRole('button', { name: labels.retrySave, exact: true }).click();
  await expect(page.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
  await back.click();
  await expect(workspace(page)).toHaveCount(0);
  expect((await readState(page)).pages[0]?.objects[0]?.content.kind).toBe('stroke');
});

for (const host of ['workspace', 'dstu', 'file-content'] as const) {
  test(`${host} inactive keep-alive does not cover the page or consume Android back`, async ({ mount, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(<InkWorkspaceHarness host={host} mode="board-v2" label={`inactive-${host}`} isActive={false} />);
    await expect(workspace(page)).toHaveCount(0);
    await page.getByTestId('ink-workspace-background-action').click();
    expect((await readState(page)).manifestAttempts).toBe(0);
    expect(await page.evaluate(() => window.__INK_WORKSPACE_CT__?.androidBack())).toBe(false);
    await page.evaluate(() => window.__INK_WORKSPACE_CT__?.setActive(true));
    await expect(page.getByTestId('ink-board-editor')).toBeVisible();
    await page.evaluate(() => window.__INK_WORKSPACE_CT__?.setActive(false));
    await expect(workspace(page)).toHaveCount(0);
    await page.getByTestId('ink-workspace-background-action').click();
    expect(await page.evaluate(() => window.__INK_WORKSPACE_CT__?.androidBack())).toBe(false);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    await page.evaluate(() => window.__INK_WORKSPACE_CT__?.setActive(true));
    await expect(page.getByTestId('ink-board-editor')).toBeVisible();
    await expect.poll(async () => (await readState(page)).manifestAttempts).toBe(2);
  });
}

for (const host of ['workspace', 'dstu', 'file-content'] as const) {
  test(`${host} shows a failed v2 probe and retries without ever loading a paged editor`, async ({ mount, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(<InkWorkspaceHarness host={host} mode="board-v2" label={`retry-${host}`} manifestFailures={1} />);
    const labels = await readLabels(page);
    await expect(page.getByText('Workspace manifest probe unavailable', { exact: true })).toBeVisible();
    await expect(page.getByTestId('ink-editor')).toHaveCount(0);
    await expect(page.getByTestId('ink-board-editor')).toHaveCount(0);
    const failed = await readState(page);
    expect(failed.manifestAttempts).toBe(1);
    expect(failed.pageReads).toBe(0);
    await workspace(page).getByRole('button', { name: labels.retry, exact: true }).click();
    await expect(page.getByTestId('ink-board-editor')).toBeVisible();
    await expect(page.getByTestId('ink-editor')).toHaveCount(0);
    const recovered = await readState(page);
    expect(recovered.manifestAttempts).toBe(3);
    expect(recovered.pageReads).toBe(0);
    expect(recovered.createCalls).toEqual([]);
  });
}
