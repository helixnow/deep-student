import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { Locator, Page } from '@playwright/test';
import { NotebookPageHarness } from './NotebookPageHarness';
import {
  NOTEBOOK_CT_LIST_ERROR,
  NOTEBOOK_CT_PDF_COUNT,
  NOTEBOOK_CT_TEXT_COUNT,
  type NotebookCtCanonical,
  type NotebookCtDocumentState,
  type NotebookCtSnapshot,
} from './fixtures';

const workspace = (page: Page) => page.locator('body > [data-ink-workspace-portal] > [data-ink-workspace-page]');
const cards = (page: Page) => page.getByTestId(/^notebook-card-/);

async function readState(page: Page): Promise<NotebookCtSnapshot> {
  return page.evaluate(() => {
    if (!window.__NOTEBOOK_LIBRARY_CT__) throw new Error('Missing Notebook library CT bridge');
    return window.__NOTEBOOK_LIBRARY_CT__.getState();
  });
}

async function readCanonical(page: Page, documentId: string): Promise<NotebookCtCanonical> {
  return page.evaluate((id) => {
    if (!window.__NOTEBOOK_LIBRARY_CT__) throw new Error('Missing Notebook library CT bridge');
    return window.__NOTEBOOK_LIBRARY_CT__.readCanonical(id);
  }, documentId);
}

async function documentState(page: Page, documentId: string): Promise<NotebookCtDocumentState> {
  const document = (await readState(page)).documents.find((entry) => entry.documentId === documentId);
  if (!document) throw new Error(`Missing Notebook CT document: ${documentId}`);
  return document;
}

async function expectLibrary(page: Page) {
  const library = page.getByTestId('notebook-library');
  await expect(library).toBeVisible();
  await expect(library.getByRole('status')).toHaveCount(0);
  return library;
}

async function expectCreateChoices(page: Page) {
  for (const id of ['notebook-create-paged', 'notebook-create-board']) {
    const button = page.getByTestId(id);
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).toBeInViewport();
  }
}

async function expectFullViewport(page: Page, documentId: string) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Notebook CT needs a fixed viewport');
  const view = workspace(page);
  await expect(view).toHaveAttribute('data-ink-workspace-page', documentId);
  await expect(view).toBeVisible();
  await expect(page.getByTestId('notebook-library')).toHaveCount(0);
  const layout = await view.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      bodyPortal: element.parentElement?.parentElement === document.body,
      position: getComputedStyle(element).position,
      bodyOverflow: document.body.style.overflow,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
  expect(layout.bodyPortal).toBe(true);
  expect(layout.position).toBe('fixed');
  expect(layout.left).toBeCloseTo(0, 0);
  expect(layout.top).toBeCloseTo(0, 0);
  expect(layout.width).toBeCloseTo(viewport.width, 0);
  expect(layout.height).toBeCloseTo(viewport.height, 0);
  expect(layout.bodyOverflow).toBe('hidden');
  expect(layout.horizontalOverflow).toBe(false);
  await expect(view.locator('header h1')).toBeVisible();
}

async function expectEditor(page: Page, documentId: string, board: boolean) {
  const editor = page.getByTestId(board ? 'ink-board-editor' : 'ink-editor');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute('data-document-id', documentId);
  await expect(page.getByTestId(board ? 'ink-editor' : 'ink-board-editor')).toHaveCount(0);
  if (board) await expect(page.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready');
  else await expect(page.getByTestId('ink-editor-flush-state')).toHaveText('ready');
  await expectFullViewport(page, documentId);
  await expect(page.getByTestId(board ? 'ink-board-canvas' : 'ink-active-stroke-canvas')).toBeVisible();
}

async function drawStroke(page: Page, board: boolean) {
  const canvas = page.getByTestId(board ? 'ink-board-canvas' : 'ink-active-stroke-canvas');
  const viewport = page.getByTestId(board ? 'ink-board-viewport' : 'ink-page-viewport');
  const [canvasBox, viewportBox] = await Promise.all([canvas.boundingBox(), viewport.boundingBox()]);
  if (!canvasBox || !viewportBox) throw new Error('Notebook writing surface is not mounted');
  const left = Math.max(canvasBox.x, viewportBox.x);
  const top = Math.max(canvasBox.y, viewportBox.y);
  const width = Math.min(canvasBox.x + canvasBox.width, viewportBox.x + viewportBox.width) - left;
  const height = Math.min(canvasBox.y + canvasBox.height, viewportBox.y + viewportBox.height) - top;
  expect(width).toBeGreaterThan(200);
  expect(height).toBeGreaterThan(80);
  const start = { x: left + width * 0.2, y: top + Math.min(80, height * 0.25) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(left + width * 0.45, start.y + 10, { steps: 4 });
  await page.mouse.move(left + width * 0.7, start.y + 30, { steps: 4 });
  await page.mouse.up();
}

async function darkPixels(canvas: Locator) {
  return canvas.evaluate((element) => {
    const target = element as HTMLCanvasElement;
    const context = target.getContext('2d');
    if (!context) throw new Error('Notebook canvas has no 2D context');
    const pixels = context.getImageData(0, 0, target.width, target.height).data;
    let count = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset] < 48 && pixels[offset + 1] < 48 && pixels[offset + 2] < 48 && pixels[offset + 3] > 240) count += 1;
    }
    return count;
  });
}

function expectNoAiOrExport(state: NotebookCtSnapshot) {
  expect(state.commands.filter((command) => (
    ['vfs_ink_render', 'vfs_ink_export', 'vfs_ink_prepare'].includes(command)
    || /^chat_v2_(send|continue|retry|stream)/.test(command)
  ))).toEqual([]);
}

async function drawReturnAndReopen(page: Page, documentId: string, board: boolean) {
  await expectEditor(page, documentId, board);
  const baseline = await readCanonical(page, documentId);
  const objectIds = new Set(baseline.objects.map((object) => object.id));
  const renderCanvas = () => page.getByTestId(board ? 'ink-board-canvas' : 'ink-page-canvas');
  const pixelsBefore = await darkPixels(renderCanvas());
  await page.getByTestId(board ? 'ink-board-tool-pen' : 'ink-tool-pen').click();
  await drawStroke(page, board);
  await expect.poll(async () => (await readState(page)).pendingSaves).toBe(1);
  expect((await readCanonical(page, documentId)).objects).toEqual(baseline.objects);

  const back = workspace(page).locator('header').getByRole('button').first();
  await back.click();
  await expect(back).toBeDisabled();
  await expect(workspace(page)).toBeVisible();
  await expect(page.getByTestId('notebook-library')).toHaveCount(0);
  const pendingDocument = await documentState(page, documentId);
  expect(pendingDocument.saveAttempts).toBeGreaterThan(0);
  expect(pendingDocument.savePageCalls + pendingDocument.saveChunkCalls).toBe(0);
  await page.evaluate(() => {
    if (!window.__NOTEBOOK_LIBRARY_CT__) throw new Error('Missing Notebook library CT bridge');
    window.__NOTEBOOK_LIBRARY_CT__.releaseSaves();
  });

  await expect(workspace(page)).toHaveCount(0);
  await expectLibrary(page);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
  const card = page.getByTestId(`notebook-card-${documentId}`);
  await expect(card).toBeVisible();
  const saved = await readCanonical(page, documentId);
  expect(saved.manifest.revision).not.toBe(baseline.manifest.revision);
  const stroke = saved.objects.find((object) => !objectIds.has(object.id));
  expect(stroke?.content.kind).toBe('stroke');
  if (!stroke || stroke.content.kind !== 'stroke') throw new Error('The real pointer gesture did not reach canonical storage');
  expect(stroke.content.samples.length).toBeGreaterThan(1);
  const savedState = await documentState(page, documentId);
  expect(board ? savedState.saveChunkCalls : savedState.savePageCalls).toBeGreaterThan(0);
  expect(board ? savedState.savePageCalls : savedState.saveChunkCalls).toBe(0);
  const createCount = (await readState(page)).createCalls.length;

  await card.click();
  await expectEditor(page, documentId, board);
  await expect.poll(async () => {
    const current = await documentState(page, documentId);
    return board ? current.chunkReads : current.pageReads;
  }).toBeGreaterThan(board ? savedState.chunkReads : savedState.pageReads);
  const reopened = await readCanonical(page, documentId);
  expect(reopened.objects.find((object) => object.id === stroke.id)).toEqual(stroke);
  await expect.poll(() => darkPixels(renderCanvas())).toBeGreaterThan(pixelsBefore + 10);
  const state = await readState(page);
  expect(state.createCalls).toHaveLength(createCount);
  expectNoAiOrExport(state);
  const route = await documentState(page, documentId);
  expect(board ? route.pageReads : route.chunkReads + route.overviewReads).toBe(0);

  await workspace(page).locator('header').getByRole('button').first().click();
  await expect(workspace(page)).toHaveCount(0);
  await expectLibrary(page);
  await expect(page.getByTestId(`notebook-card-${documentId}`)).toBeVisible();
}

for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test.describe(`Notebook library at ${size.width}px`, () => {
    test.use({ viewport: size, isMobile: size.width === 390, hasTouch: size.width === 390 });

    test('scans real raw pages, discovers nested dsink files, and searches only notebook cards', async ({ mount, page }) => {
      await mount(<NotebookPageHarness label={`search-${size.width}`} />);
      const library = await expectLibrary(page);
      await expectCreateChoices(page);
      await expect(cards(page)).toHaveCount(24);
      const initial = await readState(page);
      const filePages = initial.listCalls.filter((call) => call.options.typeFilter === 'file');
      expect(filePages.map((call) => call.options.offset)).toEqual([0, 100, 200]);
      expect(filePages.map((call) => call.returnedIds.length)).toEqual([100, NOTEBOOK_CT_PDF_COUNT - 100 + 2, 0]);
      expect(filePages[0].returnedIds.every((id) => initial.seed.pdfIds.includes(id))).toBe(true);
      expect(filePages[1].returnedIds).toEqual(expect.arrayContaining([initial.seed.pagedId, initial.seed.boardId]));
      expect(initial.listCalls.every((call) => (
        call.path === '/' && call.options.limit === 100
        && call.options.sortBy === 'updatedAt' && call.options.sortOrder === 'desc'
        && !call.options.folderId && !call.options.search && !call.options.types && !call.options.recursive
      ))).toBe(true);
      await expect(page.getByTestId(`notebook-card-${initial.seed.pagedId}`)).toHaveCount(0);
      await library.getByRole('button', { name: 'notebook.showMore', exact: true }).click();
      await expect(cards(page)).toHaveCount(NOTEBOOK_CT_TEXT_COUNT + 2);
      for (const id of [initial.seed.pagedId, initial.seed.boardId]) {
        await expect(page.getByTestId(`notebook-card-${id}`)).toContainText('Notebook courses / Term one');
      }
      for (const id of initial.seed.pdfIds) await expect(page.getByTestId(`notebook-card-${id}`)).toHaveCount(0);
      await expect(library.getByText(/\.pdf$/)).toHaveCount(0);

      const search = page.getByTestId('notebook-search');
      await search.fill('archive');
      await expect(cards(page)).toHaveCount(3);
      await expect(page.getByTestId(`notebook-card-${initial.seed.textId}`)).toBeVisible();
      await search.fill(' Archive calculus Term one ');
      await expect(cards(page)).toHaveCount(1);
      await expect(page.getByTestId(`notebook-card-${initial.seed.pagedId}`)).toBeVisible();
      await search.fill('Archive ideas');
      await expect(cards(page)).toHaveCount(1);
      await expect(page.getByTestId(`notebook-card-${initial.seed.boardId}`)).toBeVisible();
      await search.fill('Archive reference');
      await expect(cards(page)).toHaveCount(0);
      await expect(page.getByTestId('notebook-empty')).toBeVisible();
      await search.fill('');
      await expect(cards(page)).toHaveCount(24);
      const final = await readState(page);
      expect(final.listCalls).toEqual(initial.listCalls);
      expect(final.createCalls).toEqual([]);
      expectNoAiOrExport(final);
    });

    for (const board of [false, true]) {
      const mode = board ? 'board' : 'paged';
      test(`creates a ${mode} notebook, draws, waits for return flush, and reopens the same saved card`, async ({ mount, page }) => {
        await mount(<NotebookPageHarness label={`create-${mode}-${size.width}`} holdSaves />);
        await expectLibrary(page);
        await expectCreateChoices(page);
        await page.getByTestId(`notebook-create-${mode}`).click();
        await expect.poll(async () => (await readState(page)).createCalls.filter((call) => Boolean(call.documentId)).length).toBe(1);
        const call = (await readState(page)).createCalls[0];
        const documentId = call.documentId;
        if (!documentId) throw new Error('Notebook create did not return a document id');
        expect(call.command).toBe(board ? 'vfs_ink_create_board' : 'vfs_ink_create');
        expect(call.request).toMatchObject({
          title: board ? 'notebook.untitledBoard' : 'notebook.untitledPaged',
          ruling: 'blank', folder_id: null, operation_id: expect.any(String),
          ...(board ? {} : { width: 794, height: 1123 }),
        });
        expect(call.request.operation_id).toMatch(/\S+/);
        const canonical = await readCanonical(page, documentId);
        expect(canonical.manifest.schema_version).toBe(board ? 2 : 1);
        expect(canonical.objects).toEqual([]);
        if (board) expect(canonical.manifest.pages).toEqual([]);
        else expect(canonical.manifest.pages).toHaveLength(1);
        await drawReturnAndReopen(page, documentId, board);
        expect((await readState(page)).createCalls).toHaveLength(1);
      });

      test(`opens an existing nested ${mode} dsink and persists handwriting without creating or upgrading it`, async ({ mount, page }) => {
        await mount(<NotebookPageHarness label={`existing-${mode}-${size.width}`} holdSaves />);
        await expectLibrary(page);
        const state = await readState(page);
        const documentId = board ? state.seed.boardId : state.seed.pagedId;
        const query = board ? 'Archive ideas' : 'Archive calculus';
        await page.getByTestId('notebook-search').fill(query);
        await expect(cards(page)).toHaveCount(1);
        await page.getByTestId(`notebook-card-${documentId}`).click();
        await drawReturnAndReopen(page, documentId, board);
        await expect(page.getByTestId('notebook-search')).toHaveValue(query);
        expect((await readState(page)).createCalls).toEqual([]);
      });
    }

    test('a later file-list failure stays visible and Retry restores searchable, openable notebooks', async ({ mount, page }) => {
      await mount(<NotebookPageHarness label={`retry-${size.width}`} listFailures={1} />);
      const library = await expectLibrary(page);
      const alert = library.getByRole('alert');
      await expect(alert).toContainText(NOTEBOOK_CT_LIST_ERROR);
      await expect(cards(page)).toHaveCount(24);
      await expect(page.getByTestId('notebook-empty')).toHaveCount(0);
      const failed = await readState(page);
      expect(failed.listCalls.filter((call) => call.error)).toHaveLength(1);
      expect(failed.listCalls.find((call) => call.error)?.options).toMatchObject({ typeFilter: 'file', offset: 100, limit: 100 });
      await page.getByTestId('notebook-search').fill('Archive calculus');
      await expect(cards(page)).toHaveCount(0);
      await expect(page.getByTestId('notebook-empty')).toHaveCount(0);
      await expect(alert).toBeVisible();
      await alert.getByRole('button', { name: 'notebook.retry', exact: true }).click();
      await expectLibrary(page);
      await expect(library.getByRole('alert')).toHaveCount(0);
      await expect(cards(page)).toHaveCount(1);
      const card = page.getByTestId(`notebook-card-${failed.seed.pagedId}`);
      await expect(card).toBeVisible();
      const recovered = await readState(page);
      expect(recovered.listCalls.filter((call) => call.options.typeFilter === 'file' && call.options.offset === 0)).toHaveLength(2);
      expect(recovered.listCalls.some((call) => call.returnedIds.includes(failed.seed.pagedId))).toBe(true);
      await card.click();
      await expectEditor(page, failed.seed.pagedId, false);
      await workspace(page).locator('header').getByRole('button').first().click();
      await expect(workspace(page)).toHaveCount(0);
      await expectLibrary(page);
      await expect(page.getByTestId('notebook-search')).toHaveValue('Archive calculus');
      await expect(page.getByTestId(`notebook-card-${failed.seed.pagedId}`)).toBeVisible();
      const final = await readState(page);
      expect(final.createCalls).toEqual([]);
      expect(final.documents.every((document) => document.saveAttempts === 0)).toBe(true);
      expectNoAiOrExport(final);
    });
  });
}
