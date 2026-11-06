import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import { NotebookPageHarness } from './NotebookPageHarness';

for (const size of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 1280, height: 800 }]) {
  test(`scrolls the complete notebook library at ${size.width}px`, async ({ mount, page }) => {
    await page.setViewportSize(size);
    await mount(<NotebookPageHarness label={`scroll-${size.width}`} />);
    const library = page.getByTestId('notebook-library');
    await expect(library.getByRole('status')).toHaveCount(0);
    await expect(page.getByTestId(/^notebook-card-/)).toHaveCount(24);
    const viewport = page.locator('.notebook-scroll-viewport');
    const geometry = await viewport.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { height: element.clientHeight, scrollHeight: element.scrollHeight, bottom: bounds.bottom, windowHeight: innerHeight };
    });
    expect(geometry.height, JSON.stringify(geometry)).toBeLessThanOrEqual(size.height);
    expect(geometry.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(size.height + 1);
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.height);
    await viewport.hover({ position: { x: 30, y: 100 } });
    await page.mouse.wheel(0, 20000);
    const more = library.getByRole('button', { name: 'notebook.showMore', exact: true });
    await expect(more).toBeInViewport();
    await more.click();
    await expect(page.getByTestId(/^notebook-card-/)).toHaveCount(30);
    await page.mouse.wheel(0, 20000);
    const bottom = page.locator('.notebook-storage-hint');
    await expect(bottom).toBeInViewport();
    const bounds = await bottom.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height);
    const state = await page.evaluate(() => window.__NOTEBOOK_LIBRARY_CT__!.getState());
    const last = page.getByTestId(`notebook-card-${state.seed.boardId}`);
    await expect(last).toBeInViewport();
    await last.click();
    await expect(page.getByTestId('ink-board-editor')).toBeVisible();
  });
}
