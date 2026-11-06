import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { Page } from '@playwright/test';
import { NotebookPageHarness } from './NotebookPageHarness';

const state = (page: Page) => page.evaluate(() => window.__NOTEBOOK_LIBRARY_CT__!.getState());
const commandCount = async (page: Page, command: string) => (await state(page)).commands.filter((value) => value === command).length;

async function expectLibrary(page: Page) {
  const library = page.getByTestId('notebook-library');
  await expect(library).toBeVisible();
  await expect(library.getByRole('status')).toHaveCount(0);
  return library;
}

for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  for (const kind of ['text', 'paged', 'board'] as const) {
    test(`renames and deletes ${kind} directly from library cards at ${size.width}px`, async ({ mount, page }) => {
      await page.setViewportSize(size);
      await mount(<NotebookPageHarness label={`actions-${kind}-${size.width}`} />);
      const library = await expectLibrary(page);
      const initial = await state(page);
      const id = kind === 'text' ? initial.seed.textId : kind === 'paged' ? initial.seed.pagedId : initial.seed.boardId;
      const card = page.getByTestId(`notebook-card-${id}`);
      await page.getByTestId('notebook-search').fill('Archive');
      await expect(card).toBeVisible();
      const rename = page.getByTestId(`notebook-rename-${id}`);
      const remove = page.getByTestId(`notebook-delete-${id}`);
      expect(await card.locator('button').count()).toBe(0);
      for (const action of [rename, remove]) {
        const box = await action.boundingBox();
        expect(box?.width).toBeGreaterThanOrEqual(44);
        expect(box?.height).toBeGreaterThanOrEqual(44);
        await action.click();
        const dialog = page.getByRole('alertdialog');
        await expect(dialog).toBeVisible();
        await expect(library).toBeVisible();
        await expect(page.locator('[data-ink-workspace-page]')).toHaveCount(0);
        await dialog.getByRole('button', { name: 'notebook.cancel', exact: true }).click();
        await expect(dialog).toHaveCount(0);
      }
      expect(await commandCount(page, 'dstu_rename')).toBe(0);
      expect(await commandCount(page, 'dstu_delete')).toBe(0);

      await rename.click();
      const dialog = page.getByRole('alertdialog');
      const input = dialog.getByTestId('notebook-rename-input');
      const oldName = initial.nodes.find((entry) => entry.id === id)!.name;
      await expect(input).toHaveValue(kind === 'text' ? oldName : oldName.replace(/\.dsink$/i, ''));
      await input.fill('bad/name');
      await expect(dialog.getByRole('button', { name: 'notebook.renameConfirm', exact: true })).toBeDisabled();
      await input.press('Enter');
      expect(await commandCount(page, 'dstu_rename')).toBe(0);
      const title = `Renamed ${kind} ${size.width}`;
      await input.fill(kind === 'text' ? ` ${title} ` : ` ${title}.dsink.dsink `);
      await input.press('Enter');
      await expect(dialog).toHaveCount(0);
      await expectLibrary(page);
      await expect(card).toHaveCount(0);
      await page.getByTestId('notebook-search').fill(title);
      await expect(card).toContainText(title);
      expect(await commandCount(page, 'dstu_rename')).toBe(1);
      expect((await state(page)).nodes.find((entry) => entry.id === id)?.name).toBe(kind === 'text' ? title : `${title}.dsink`);
      await library.getByRole('button', { name: 'notebook.refresh', exact: true }).click();
      await expectLibrary(page);
      await expect(card).toContainText(title);
      if (kind !== 'text') {
        await card.click();
        await expect(page.getByTestId(kind === 'board' ? 'ink-board-title' : 'ink-editor-title')).toHaveText(title);
        await page.locator('[data-ink-workspace-page] header').getByRole('button').first().click();
        await expectLibrary(page);
        await expect(card).toContainText(title);
      }
      await remove.click();
      await expect(page.getByRole('alertdialog')).toHaveAccessibleName('notebook.deleteTitle');
      expect(await commandCount(page, 'dstu_delete')).toBe(0);
      await page.getByRole('alertdialog').getByRole('button', { name: 'notebook.deleteConfirm', exact: true }).click();
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expectLibrary(page);
      await expect(card).toHaveCount(0);
      expect(await commandCount(page, 'dstu_delete')).toBe(1);
      expect((await state(page)).nodes.some((entry) => entry.id === id)).toBe(false);
      await expect(page.getByTestId('notebook-empty')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
    });
  }

  test(`keeps failed card actions retryable at ${size.width}px`, async ({ mount, page }) => {
    await page.setViewportSize(size);
    await mount(<NotebookPageHarness label={`retry-${size.width}`} renameFailures={1} deleteFailures={1} />);
    await expectLibrary(page);
    const id = (await state(page)).seed.boardId;
    await page.getByTestId('notebook-search').fill('Archive ideas');
    await page.getByTestId(`notebook-rename-${id}`).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByTestId('notebook-rename-input').fill('Retry canvas');
    await dialog.getByRole('button', { name: 'notebook.renameConfirm', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByTestId('notebook-rename-input')).toHaveValue('Retry canvas');
    await expect(page.getByTestId(`notebook-card-${id}`)).toBeVisible();
    await dialog.getByRole('button', { name: 'notebook.renameConfirm', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expectLibrary(page);
    await page.getByTestId('notebook-search').fill('Retry canvas');
    await page.getByTestId(`notebook-delete-${id}`).click();
    await dialog.getByRole('button', { name: 'notebook.deleteConfirm', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId(`notebook-card-${id}`)).toBeVisible();
    await dialog.getByRole('button', { name: 'notebook.deleteConfirm', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expectLibrary(page);
    await expect(page.getByTestId(`notebook-card-${id}`)).toHaveCount(0);
    expect(await commandCount(page, 'dstu_rename')).toBe(2);
    expect(await commandCount(page, 'dstu_delete')).toBe(2);
  });
}
