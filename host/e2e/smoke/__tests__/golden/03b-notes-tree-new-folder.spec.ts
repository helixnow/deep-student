/**
 * Notes tree context menu › 新建文件夹. Choosing the item mounts the inline folder-name input
 * (`NotesWorkspaceApp.tsx` `resourceDialog` create-folder, `autoFocus`). The input treats a blur with an empty value
 * as cancel, so the menu's `onClose` (`NotesWorkspaceTree.tsx` `closeMenu` → `focusRowDom`) must not pull focus back
 * to the right-clicked row once the menu action moved it (#30, W26 ff587a08: focus returns only when it fell to body).
 */
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../support/app.ts';
import { collectHealth, describeFailures } from '../support/diagnostics.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';
import { openDockApp } from '../support/renderer.ts';

const NOTE_TITLE = 'SMOKE-TREE-NOTE';
const FOLDER_NAME = 'SMOKE-TREE-FOLDER';
const INLINE_INPUT = '[data-notes-inline-create] input';

const focused = (page: Page) => page.locator('[data-wb-window][data-focused="true"]');
const treeRow = (page: Page, name: string) => focused(page).locator('[data-nwt-item]').filter({ hasText: name }).first();

/** The host tsconfig has no DOM lib; these are the renderer's own globals. */
interface RendererGlobals {
  document: { body: unknown; activeElement: { tagName: string; getAttribute(name: string): string | null } | null; querySelector(selector: string): unknown };
  MutationObserver: new (callback: () => void) => { observe(target: unknown, options: { childList: boolean; subtree: boolean }): void };
  requestAnimationFrame(callback: () => void): number;
  __smokeInlineCreateMounted?: boolean;
}

/** Two animation frames: `focusRowDom` runs its focus in the first one after the menu closed. */
const afterNextFrames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => {
  const g = globalThis as unknown as RendererGlobals;
  g.requestAnimationFrame(() => g.requestAnimationFrame(() => resolve()));
}));

const activeElement = (page: Page) => page.evaluate(() => {
  const el = (globalThis as unknown as RendererGlobals).document.activeElement;
  if (el === null) return 'none';
  const id = el.getAttribute('data-nwt-id');
  return id === null ? el.tagName : `${el.tagName}[data-nwt-id=${id}]`;
});

test.describe.serial('③b notes tree › 新建文件夹', () => {
  let app: LaunchedApp;

  test.beforeAll(async () => {
    app = await launchApp({ label: 'notes-tree-folder' });
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await passFirstRun(app.page);
    await app.call('dstu_create', { path: '/', options: { type: 'note', name: NOTE_TITLE } });
    await openDockApp(app.page, 'notes');
    await expect(treeRow(app.page, NOTE_TITLE)).toBeVisible();
  });
  test.afterAll(async () => {
    await app?.close();
  });

  async function chooseNewFolder(page: Page): Promise<void> {
    await treeRow(page, NOTE_TITLE).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '新建文件夹', exact: true }).click();
  }

  test('the tree context menu offers 新建文件夹 and choosing it mounts the folder-name input', async () => {
    const { page } = app;
    await app.mark('tree-menu');
    await page.evaluate((selector) => {
      const g = globalThis as unknown as RendererGlobals;
      g.__smokeInlineCreateMounted = false;
      new g.MutationObserver(() => {
        if (g.document.querySelector(selector) !== null) g.__smokeInlineCreateMounted = true;
      }).observe(g.document.body, { childList: true, subtree: true });
    }, INLINE_INPUT);
    await chooseNewFolder(page);
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as RendererGlobals).__smokeInlineCreateMounted),
      { message: 'choosing 新建文件夹 never mounted the inline folder-name input' }).toBe(true);
    await expect(page.locator('.nwt-context-menu')).toHaveCount(0);
    // The input stays open here (#30); cancel it so the next test starts from a closed input.
    const input = page.locator(INLINE_INPUT);
    if (await input.isVisible()) {
      await input.focus();
      await page.keyboard.press('Escape');
    }
    await expect(input).toHaveCount(0);
    expect(describeFailures(collectHealth(app, ['tree-menu']))).toBe('');
  });

  test('the folder-name input stays focused after the menu closes and Enter creates the typed folder', async () => {
    const { page } = app;
    await app.mark('tree-new-folder');
    await chooseNewFolder(page);
    await afterNextFrames(page);
    test.info().annotations.push({ type: 'focus-after-menu-close', description: await activeElement(page) });
    await expect(page.locator(INLINE_INPUT), 'the folder-name input is still open and focused once the menu closed').toBeFocused();
    await page.keyboard.type(FOLDER_NAME);
    await page.keyboard.press('Enter');
    await expect.poll(() => app.wire().filter((r) => r.phase === 'tree-new-folder' && r.kind === 'renderer-invoke'
      && r.message?.cmd === 'dstu_folder_create').length, { message: 'Enter did not create the folder' }).toBe(1);
    await expect(treeRow(page, FOLDER_NAME)).toBeVisible();
    expect(describeFailures(collectHealth(app, ['tree-new-folder']))).toBe('');
  });
});
