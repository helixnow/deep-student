import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { Page } from '@playwright/test';
import { INK_TOOL_PREFERENCES_STORAGE_KEY } from '@/features/ink/toolSettings';
import { INK_BOARD_CT_BASE_OBJECT_ID } from './fixtures';
import { InkBoardEditorHarness } from './InkBoardEditorHarness';

async function drawStroke(page: Page, y: number) {
  const canvas = page.getByTestId('ink-board-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Board canvas is not visible');
  await page.mouse.move(box.x + 40, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + y + 5, { steps: 8 });
  await page.mouse.up();
  expect((await page.evaluate(() => window.__INK_BOARD_CT__!.flush())).ok).toBe(true);
}

for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
  test(`board uses shared drawing settings and persists styled strokes at ${size.width}px`, async ({ mount, page }) => {
    await page.setViewportSize(size);
    await mount(<InkBoardEditorHarness mode="board-v2" label={`tools-${size.width}`} />);
    await expect(page.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready');
    const tools = page.getByTestId('ink-board-drawing-tools');
    await expect(tools).toHaveAttribute('role', 'toolbar');
    for (const name of ['tool-pen', 'tool-highlighter', 'eraser-tool', 'undo', 'redo', 'settings-toggle', 'touch-draw-toggle', 'select-rectangle', 'select-lasso']) {
      const button = page.getByTestId(`ink-board-${name}`);
      const dimensions = await button.evaluate((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, icon: Boolean(element.querySelector('svg')) }));
      expect(dimensions.width).toBeGreaterThanOrEqual(44);
      expect(dimensions.height).toBeGreaterThanOrEqual(44);
      expect(dimensions.icon).toBe(true);
    }
    const settings = page.getByTestId('ink-board-settings');
    await page.getByTestId('ink-board-settings-toggle').click();
    await expect(settings).toBeVisible();
    await expect(settings).toHaveAttribute('role', 'dialog');
    const colors = settings.locator('[data-testid^="ink-board-color-"]');
    await expect(colors).toHaveCount(12);
    await expect.poll(async () => colors.evaluateAll((elements) => elements.every((element) => {
      const box = element.getBoundingClientRect();
      return box.width >= 44 && box.height >= 44;
    }))).toBe(true);
    await expect.poll(() => settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await settings.getByTestId('ink-board-custom-color').fill('#16a34a');
    await settings.getByTestId('ink-board-custom-color').blur();
    await settings.getByTestId('ink-board-width-value').fill('17.5');
    await settings.getByTestId('ink-board-width-value').blur();
    await settings.getByTestId('ink-board-eraser-size').fill('23');
    await settings.getByTestId('ink-board-eraser-size').blur();
    if (size.width < 768) await settings.getByRole('button', { name: '关闭', exact: true }).click();
    else await settings.getByTestId('ink-board-custom-color').press('Escape');
    await expect(settings).not.toBeVisible();
    await drawStroke(page, 60);

    await page.getByTestId('ink-board-tool-highlighter').click();
    await page.getByTestId('ink-board-settings-toggle').click();
    await expect(settings).toBeVisible();
    await expect(settings.getByTestId('ink-board-opacity')).toBeVisible();
    await settings.getByTestId('ink-board-custom-color').fill('#ffd400');
    await expect(settings.getByTestId('ink-board-custom-color')).toHaveValue('#ffd400');
    await settings.getByTestId('ink-board-custom-color').blur();
    await expect(settings.getByTestId('ink-board-custom-color')).toHaveValue('#ffd400');
    await settings.getByTestId('ink-board-width-value').fill('24');
    await settings.getByTestId('ink-board-width-value').blur();
    await settings.getByTestId('ink-board-opacity').fill('0.25');
    await settings.getByTestId('ink-board-opacity').blur();
    if (size.width < 768) await settings.getByRole('button', { name: '关闭', exact: true }).click();
    else await settings.getByTestId('ink-board-custom-color').press('Escape');
    await expect(settings).not.toBeVisible();
    await drawStroke(page, 100);
    const state = await page.evaluate(() => window.__INK_BOARD_CT__!.getState());
    const strokes = state.objects.filter((object) => object.id !== INK_BOARD_CT_BASE_OBJECT_ID);
    expect(strokes).toHaveLength(2);
    expect(strokes[0].content).toMatchObject({ kind: 'stroke', style: { tool: 'pen', color: '#16a34a', width: 17.5 } });
    expect(strokes[1].content).toMatchObject({ kind: 'stroke', style: { tool: 'highlighter', color: '#ffd40040', width: 24 } });
    await page.getByTestId('ink-board-tool-pen').click();
    await page.getByTestId('ink-board-settings-toggle').click();
    await expect(settings.getByTestId('ink-board-custom-color')).toHaveValue('#16a34a');
    await expect(settings.getByTestId('ink-board-width-value')).toHaveValue('17.5');
    await expect(settings.getByTestId('ink-board-eraser-size')).toHaveValue('23');
    await expect(settings.getByTestId('ink-board-opacity')).toHaveCount(0);
    const preferences = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), INK_TOOL_PREFERENCES_STORAGE_KEY);
    expect(preferences).toMatchObject({ pen: { color: '#16a34a', width: 17.5 }, highlighter: { color: '#ffd400', width: 24, opacity: 0.25 }, eraserSize: 23 });
    if (size.width < 768) await settings.getByRole('button', { name: '关闭', exact: true }).click();
    else await settings.getByTestId('ink-board-custom-color').press('Escape');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    const editorOverflow = await page.getByTestId('ink-board-editor').evaluate((element) => element.scrollWidth > element.clientWidth + 1);
    expect(editorOverflow).toBe(false);
    expect(overflow).toBe(false);
    await expect(settings).not.toBeVisible();
    await page.locator('[data-ink-workspace-page] header').getByRole('button').click();
    await expect(page.locator('[data-ink-workspace-page]')).toHaveCount(0);
    await page.getByTestId('ink-board-ct-unmount').click();
    await expect(page.getByTestId('ink-board-editor')).toHaveCount(0);
    await page.getByTestId('ink-board-ct-remount').click();
    await expect(page.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready');
    expect((await page.evaluate(() => window.__INK_BOARD_CT__!.getState())).objects).toHaveLength(3);
  });
}
