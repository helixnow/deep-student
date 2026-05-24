import { test, expect } from '@playwright/test';

/**
 * Visual Regression Baseline Capture
 *
 * Run with dev server already started:
 *   pnpm dev &
 *   npx playwright test -c tests/visual/playwright.config.ts
 *
 * Screenshots are saved to tests/visual/screenshots/
 * Compare before/after CSS migration changes.
 */

const SCREENSHOT_DIR = './tests/visual/screenshots';

test.describe('Visual Regression Baseline', () => {
  test('capture default view (chat)', async ({ page }) => {
    await page.goto('/');
    // Wait for app to fully render (loading screen to disappear)
    await page.waitForTimeout(3000);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/default-view.png`,
      fullPage: true,
    });
  });

  test('capture default view - dark mode', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(3000);
    // Toggle dark mode via class on root element
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
    });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/default-view-dark.png`,
      fullPage: true,
    });
  });

  test('capture mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.waitForTimeout(3000);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/mobile-view.png`,
      fullPage: true,
    });
  });
});
