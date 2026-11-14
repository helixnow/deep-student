import { expect, type Page } from '@playwright/test';

/** Click a dock control; a maximised window auto-hides the dock until its hot zone is hovered. */
export async function clickDock(page: Page, testId: string): Promise<void> {
  const target = page.getByTestId(testId);
  const hotzone = page.getByTestId('wb-dock-hotzone');
  await expect(async () => {
    if (await hotzone.isVisible()) await hotzone.hover();
    await target.click({ timeout: 1_500 });
  }).toPass({ timeout: 15_000 });
}

/** Open an app from the dock's "全部应用" panel. */
export async function openDockApp(page: Page, id: string): Promise<void> {
  await clickDock(page, 'wb-dock-apps-button');
  await page.getByTestId(`wb-apps-item-${id}`).click();
}

/** Dispatch a CustomEvent on the renderer's window (the app's public navigation events). */
export async function dispatchWindowEvent(page: Page, type: string, detail: unknown): Promise<void> {
  await page.evaluate(({ type, detail }) => {
    // The host tsconfig has no DOM lib; these are the renderer's own globals.
    const g = globalThis as unknown as { dispatchEvent(event: unknown): boolean; CustomEvent: new (type: string, init: { detail: unknown }) => unknown };
    g.dispatchEvent(new g.CustomEvent(type, { detail }));
  }, { type, detail });
}

export async function navigateSettingsTab(page: Page, detail: { tab: string; [key: string]: unknown }): Promise<void> {
  await dispatchWindowEvent(page, 'SETTINGS_NAVIGATE_TAB', detail);
}
