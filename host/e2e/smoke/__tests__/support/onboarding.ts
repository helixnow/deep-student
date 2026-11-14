import { expect, type Page } from '@playwright/test';

/**
 * First run on an empty data root: accept the agreement through the visible button, then dismiss the welcome
 * dialog ("先随便看看") and the desktop tour. Both appear asynchronously and in either order, so keep
 * dismissing until neither has been visible for a while.
 */
/** Accessible name of the first-run agreement button. */
export const AGREEMENT_BUTTON = /我已阅读并同意|I have read and agree/;

export async function passFirstRun(page: Page): Promise<void> {
  await page.getByRole('button', { name: AGREEMENT_BUTTON }).click({ timeout: 60_000 });
  await dismissWelcome(page);
}

/** Dismiss the welcome dialog and the desktop tour (shown while no AI service is configured). */
export async function dismissWelcome(page: Page): Promise<void> {
  await expect(page.getByTestId('wb-dock')).toBeVisible({ timeout: 30_000 });
  const browse = page.getByRole('button', { name: /先随便看看|Just look around first/ });
  const skip = page.getByTestId('wb-empty-tour-skip');
  const deadline = Date.now() + 45_000;
  let quietSince = 0;
  while (Date.now() < deadline) {
    if (await browse.isVisible().catch(() => false)) {
      await browse.click({ timeout: 3_000 }).catch(() => undefined);
      quietSince = 0;
    } else if (await skip.isVisible().catch(() => false)) {
      await skip.click({ timeout: 3_000 }).catch(() => undefined);
      quietSince = 0;
    } else if (quietSince === 0) {
      quietSince = Date.now();
    } else if (Date.now() - quietSince > 2_500) {
      return;
    }
    await page.waitForTimeout(200);
  }
  throw new Error('first-run dialogs did not settle within 45s');
}

/** Wait until the preload bridge exists. */
export async function waitForBridge(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__), null, { timeout: 60_000 });
}
