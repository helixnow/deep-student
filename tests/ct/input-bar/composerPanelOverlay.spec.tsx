import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import {
  InputBarWithConflictingComposerPanels,
  InputBarWithOpenMcpPanel,
} from './ComposerPanelOverlay.story';

test('renders a large composer panel as one viewport anchored overlay', async ({ mount, page }) => {
  await mount(<InputBarWithOpenMcpPanel />);

  const overlay = page.locator('[data-composer-panel-overlay="mcp"]');
  await expect(overlay).toHaveCount(1);
  await expect(overlay.locator('[data-testid="mcp-panel-content"]')).toHaveCount(1);

  const metrics = await page.evaluate(() => {
    const overlayEl = document.querySelector<HTMLElement>('[data-composer-panel-overlay="mcp"]');
    const anchorEl = document.querySelector<HTMLElement>('[data-composer-panel-anchor]');
    if (!overlayEl || !anchorEl) return null;

    const overlayRect = overlayEl.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    return {
      overlayLeft: Math.round(overlayRect.left),
      overlayTop: Math.round(overlayRect.top),
      overlayWidth: Math.round(overlayRect.width),
      overlayHeight: Math.round(overlayRect.height),
      anchorLeft: Math.round(anchorRect.left),
      anchorTop: Math.round(anchorRect.top),
      anchorWidth: Math.round(anchorRect.width),
      overlayCenter: Math.round(overlayRect.left + overlayRect.width / 2),
      anchorCenter: Math.round(anchorRect.left + anchorRect.width / 2),
      viewportHeight: window.innerHeight,
      isInsideComposerRoot: !!overlayEl.closest('[data-testid="input-bar-v2-root"]'),
    };
  });

  expect(metrics).not.toBeNull();
  expect(metrics!.isInsideComposerRoot).toBe(false);
  expect(metrics!.overlayWidth).toBeGreaterThan(metrics!.anchorWidth);
  expect(Math.abs(metrics!.overlayCenter - metrics!.anchorCenter)).toBeLessThanOrEqual(2);
  expect(metrics!.overlayTop).toBeGreaterThanOrEqual(8);
  expect(metrics!.overlayTop).toBeLessThan(metrics!.anchorTop);
  expect(metrics!.overlayHeight).toBeLessThanOrEqual(metrics!.anchorTop - 8);
  expect(metrics!.overlayTop + metrics!.overlayHeight).toBeLessThan(metrics!.viewportHeight);
});

test('renders only one composer overlay when panel state is conflicting', async ({ mount, page }) => {
  await mount(<InputBarWithConflictingComposerPanels />);

  await expect(page.locator('[data-composer-panel-overlay]')).toHaveCount(1);
  await expect(page.locator('[data-composer-panel-overlay="mcp"]')).toHaveCount(1);
  await expect(page.locator('[data-composer-panel-overlay="skill"]')).toHaveCount(0);
});
