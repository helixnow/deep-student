import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { Locator, Page } from '@playwright/test';
import { CAMERA_MAX_ZOOM, CAMERA_MIN_ZOOM } from '../../../src/features/ink/camera';
import {
  INK_BOARD_CT_CHUNK_ID,
  INK_BOARD_CT_MAX_VIEWPORT_PIXELS,
  INK_BOARD_CT_PAGED_PAGE_ONE,
  type InkBoardCtSnapshot,
} from './fixtures';
import { InkBoardEditorHarness } from './InkBoardEditorHarness';

const workspace = (page: Page) => page.locator('[data-ink-workspace-page]');

interface BoardCamera {
  x: number;
  y: number;
  zoom: number;
}

interface BridgeWindow extends Window {
  __INK_BOARD_CT__?: {
    getState(): InkBoardCtSnapshot;
    readDraft(): Promise<unknown>;
    setClipboard(text: string): void;
    flush(): Promise<{ ok: boolean; code?: string }>;
  };
}

async function readState(page: Page): Promise<InkBoardCtSnapshot> {
  return page.evaluate(() => {
    const bridge = (window as BridgeWindow).__INK_BOARD_CT__;
    if (!bridge) throw new Error('Missing ink board CT bridge.');
    return bridge.getState();
  });
}

async function readDraft(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const bridge = (window as BridgeWindow).__INK_BOARD_CT__;
    if (!bridge) throw new Error('Missing ink board CT bridge.');
    return bridge.readDraft();
  });
}

async function setClipboard(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    const bridge = (window as BridgeWindow).__INK_BOARD_CT__;
    if (!bridge) throw new Error('Missing ink board CT bridge.');
    bridge.setClipboard(value);
  }, text);
}

async function flushBoard(page: Page): Promise<{ ok: boolean; code?: string }> {
  return page.evaluate(() => {
    const bridge = (window as BridgeWindow).__INK_BOARD_CT__;
    if (!bridge) throw new Error('Missing ink board CT bridge.');
    return bridge.flush();
  });
}

async function readCamera(canvas: Locator): Promise<BoardCamera | null> {
  const raw = await canvas.getAttribute('data-camera');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BoardCamera>;
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number' || typeof parsed.zoom !== 'number') {
      return null;
    }
    return { x: parsed.x, y: parsed.y, zoom: parsed.zoom };
  } catch {
    return null;
  }
}

/** Touch navigation is expected while touch drawing is off. */
async function touchPan(page: Page, canvas: Locator, dx: number, dy: number): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Board canvas has no visible bounds.');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await canvas.dispatchEvent('pointerdown', {
    pointerId: 41,
    pointerType: 'touch',
    isPrimary: true,
    clientX: startX,
    clientY: startY,
    buttons: 1,
    button: 0,
  });
  await canvas.dispatchEvent('pointermove', {
    pointerId: 41,
    pointerType: 'touch',
    isPrimary: true,
    clientX: startX + dx,
    clientY: startY + dy,
    buttons: 1,
    button: 0,
  });
  await canvas.dispatchEvent('pointerup', {
    pointerId: 41,
    pointerType: 'touch',
    isPrimary: true,
    clientX: startX + dx,
    clientY: startY + dy,
    buttons: 0,
    button: 0,
  });
}

async function zoomOutAt(page: Page, canvas: Locator, deltaY: number): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Board canvas has no visible bounds.');
  await canvas.dispatchEvent('wheel', {
    deltaY,
    ctrlKey: true,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  });
}

async function drawPenStroke(page: Page, canvas: Locator): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Board canvas has no visible bounds.');
  await page.mouse.move(box.x + 80, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 108, { steps: 4 });
  await page.mouse.move(box.x + 200, box.y + 140, { steps: 4 });
  await page.mouse.up();
}

async function dragCanvasBox(
  page: Page,
  canvas: Locator,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Board canvas has no visible bounds.');
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 6 });
  await page.mouse.up();
}

async function lassoCanvasBox(
  page: Page,
  canvas: Locator,
  box: { left: number; top: number; right: number; bottom: number },
): Promise<void> {
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Board canvas has no visible bounds.');
  await page.mouse.move(bounds.x + box.left, bounds.y + box.top);
  await page.mouse.down();
  await page.mouse.move(bounds.x + box.right, bounds.y + box.top, { steps: 4 });
  await page.mouse.move(bounds.x + box.right, bounds.y + box.bottom, { steps: 4 });
  await page.mouse.move(bounds.x + box.left, bounds.y + box.bottom, { steps: 4 });
  await page.mouse.move(bounds.x + box.left, bounds.y + box.top, { steps: 4 });
  await page.mouse.up();
}

async function dispatchCanvasPointer(
  canvas: Locator,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  pointerId: number,
  point: { x: number; y: number },
  pointerType: 'pen' | 'touch' | 'mouse' = 'pen',
  buttons = type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Board canvas has no visible bounds.');
  await canvas.dispatchEvent(type, {
    pointerId,
    pointerType,
    isPrimary: true,
    clientX: box.x + point.x,
    clientY: box.y + point.y,
    button: 0,
    buttons,
  });
}

async function waitForJournalOrNewCas(page: Page, casCount: number): Promise<void> {
  await expect.poll(async () => {
    const [draft, state] = await Promise.all([readDraft(page), readState(page)]);
    return Boolean(draft) || state.saveChunkRequests.length > casCount;
  }).toBe(true);
}

async function flushAndRead(page: Page): Promise<InkBoardCtSnapshot> {
  expect((await flushBoard(page)).ok).toBe(true);
  return readState(page);
}

async function prepareNegativeBoard(page: Page): Promise<Locator> {
  await expect(workspace(page).getByTestId('ink-board-editor')).toBeVisible();
  await expect(workspace(page).getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready');
  const canvas = workspace(page).getByTestId('ink-board-canvas');
  await expect(canvas).toBeVisible();
  await touchPan(page, canvas, 360, 260);
  await expect.poll(async () => (await readCamera(canvas))?.x ?? 0).toBeLessThan(0);
  await expect(workspace(page).getByTestId('ink-board-editor')).toHaveAttribute('data-loaded-chunks', /[1-9]/);
  return canvas;
}

test('v2 board root shows a finite capped viewport, saves a negative-world pen stroke journal-first, and reopens it', async ({ mount, page }) => {
  await mount(<InkBoardEditorHarness mode="board-v2" label="v2" />);

  await expect(workspace(page).getByTestId('ink-board-editor')).toBeVisible();
  const viewport = workspace(page).getByTestId('ink-board-viewport');
  await expect(viewport).toBeVisible();
  const canvas = workspace(page).getByTestId('ink-board-canvas');
  await expect(canvas).toBeVisible();

  const viewportBox = await viewport.boundingBox();
  expect(viewportBox).not.toBeNull();
  expect(Number.isFinite(viewportBox?.width)).toBe(true);
  expect(Number.isFinite(viewportBox?.height)).toBe(true);
  expect(viewportBox?.width ?? 0).toBeGreaterThan(0);
  expect(viewportBox?.height ?? 0).toBeGreaterThan(0);

  const backingStore = await canvas.evaluate((element) => {
    const target = element as HTMLCanvasElement;
    return { width: target.width, height: target.height };
  });
  expect(backingStore.width).toBeGreaterThan(0);
  expect(backingStore.height).toBeGreaterThan(0);
  expect(backingStore.width * backingStore.height).toBeLessThanOrEqual(INK_BOARD_CT_MAX_VIEWPORT_PIXELS);

  const initialCamera = await readCamera(canvas);
  expect(initialCamera).not.toBeNull();
  await expect(workspace(page).getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready');

  // Pan the world under the viewport into the signed-negative quadrant, then
  // zoom. Both are local camera state; neither may create a canonical write.
  await touchPan(page, canvas, 360, 260);
  await zoomOutAt(page, canvas, -240);
  await expect.poll(async () => (await readCamera(canvas))?.x ?? 0).toBeLessThan(0);
  const pannedCamera = await readCamera(canvas);
  expect(pannedCamera).not.toBeNull();
  expect(pannedCamera?.y ?? 0).toBeLessThan(0);
  expect(pannedCamera?.zoom ?? 1).not.toBe(initialCamera?.zoom);
  await expect(workspace(page).getByTestId('ink-board-editor')).toHaveAttribute('data-loaded-chunks', /[1-9]/);

  await drawPenStroke(page, canvas);
  await expect.poll(async () => {
    const [draft, state] = await Promise.all([readDraft(page), readState(page)]);
    return Boolean(draft) || state.saveChunkRequests.length > 0;
  }).toBe(true);
  expect((await flushBoard(page)).ok).toBe(true);

  const saved = await readState(page);
  const documentId = await workspace(page).getByTestId('ink-board-editor').getAttribute('data-document-id');
  expect(saved.documentId).toBe(documentId);
  expect(saved.saveChunkRequests.length).toBeGreaterThan(0);

  const lastSave = saved.saveChunkRequests[saved.saveChunkRequests.length - 1];
  expect(lastSave.changed).toHaveLength(1);
  expect(lastSave.changed[0].chunk_id).toBe(INK_BOARD_CT_CHUNK_ID);

  const baseObject = lastSave.changed[0].objects.find((object) => object.id === 'board_ct_object0001');
  expect(baseObject).toBeTruthy();
  const newStroke = lastSave.changed[0].objects.find((object) => object.id !== 'board_ct_object0001');
  expect(newStroke).toBeTruthy();
  expect(newStroke?.content.kind).toBe('stroke');

  const newSamples = newStroke && newStroke.content.kind === 'stroke' ? newStroke.content.samples : [];
  expect(newSamples.length).toBeGreaterThan(0);
  for (const sample of newSamples) {
    expect(sample.x).toBeLessThan(0);
    expect(sample.y).toBeLessThan(0);
  }

  // The whole chunk is written, not just the gesture delta, and z-index remains
  // globally strict across the objects in that chunk.
  const zIndexes = lastSave.changed[0].objects.map((object) => object.z_index);
  expect(new Set(zIndexes).size).toBe(zIndexes.length);

  const journalAtCas = saved.journalAtCas.find((record) => (
    record?.changed.some((chunk) => chunk.objects.some((object) => object.id === newStroke?.id))
  ));
  expect(journalAtCas).toBeTruthy();
  expect(journalAtCas?.base_revision).toBe('rev-ct-1');
  expect(journalAtCas?.changed).toHaveLength(1);
  expect(journalAtCas?.changed[0].chunk_id).toBe(INK_BOARD_CT_CHUNK_ID);
  expect(journalAtCas?.changed[0].objects).toHaveLength(2);

  await workspace(page).locator('header').getByRole('button').click();
  await expect(workspace(page)).toHaveCount(0);
  await page.getByTestId('ink-board-ct-unmount').click();
  await expect(page.getByTestId('ink-board-ct-remount')).toBeEnabled();
  await page.getByTestId('ink-board-ct-remount').click();
  await expect(workspace(page).getByTestId('ink-board-viewport')).toBeVisible();
  const reopenedCanvas = workspace(page).getByTestId('ink-board-canvas');
  await expect(reopenedCanvas).toBeVisible();

  const reopened = await readState(page);
  expect(reopened.revision).not.toBe('rev-ct-1');
  expect(reopened.objects.some((object) => object.id === newStroke?.id)).toBe(true);

  await expect.poll(async () => reopenedCanvas.evaluate((element) => {
    const target = element as HTMLCanvasElement;
    const context = target.getContext('2d');
    if (!context) return 0;
    const pixels = context.getImageData(0, 0, target.width, target.height).data;
    let dark = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] < 48 && pixels[index + 1] < 48 && pixels[index + 2] < 48 && pixels[index + 3] > 240) {
        dark += 1;
      }
    }
    return dark;
  })).toBeGreaterThan(0);
});

test('an idle pen stroke reaches the canonical CAS without pressing Save or flushing', async ({ mount, page }) => {
  await mount(<InkBoardEditorHarness mode="board-v2" label="autosave" />);

  await expect(workspace(page).getByTestId('ink-board-editor')).toBeVisible();
  await expect(workspace(page).getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready');
  // A fresh empty board legitimately loads zero chunks; only require a finite
  // mounted viewport so the gesture has real canvas coordinates.
  const viewport = workspace(page).getByTestId('ink-board-viewport');
  await expect(viewport).toBeVisible();
  const viewportBox = await viewport.boundingBox();
  expect(viewportBox).not.toBeNull();
  expect(Number.isFinite(viewportBox?.width)).toBe(true);
  expect(Number.isFinite(viewportBox?.height)).toBe(true);
  expect(viewportBox?.width ?? 0).toBeGreaterThan(0);
  expect(viewportBox?.height ?? 0).toBeGreaterThan(0);
  const canvas = workspace(page).getByTestId('ink-board-canvas');
  await expect(canvas).toBeVisible();

  const baseline = await readState(page);
  expect(baseline.revision).toBe('rev-ct-1');
  expect(baseline.saveChunkCalls).toBe(0);

  await drawPenStroke(page, canvas);

  // No toolbar Save click and no explicit session flush: the host debounce must
  // be the only actor between the journaled gesture and the canonical CAS.
  await expect.poll(async () => {
    const state = await readState(page);
    return state.saveChunkCalls > 0 && state.revision !== baseline.revision;
  }, { timeout: 10_000 }).toBe(true);

  const saved = await readState(page);
  expect(saved.saveChunkCalls).toBeGreaterThanOrEqual(1);
  expect(saved.revision).not.toBe(baseline.revision);
  expect(saved.journalAtCas.some((record) => Boolean(record))).toBe(true);
  expect(saved.objects.some((object) => (
    object.id !== 'board_ct_object0001' && object.content.kind === 'stroke'
  ))).toBe(true);
  expect(saved.calls.filter((call) => call.command === 'vfs_ink_save_page')).toHaveLength(0);
});

test('fixed paged manifest stays on the existing InkEditor route and never creates or upgrades a board', async ({ mount, page }) => {
  await mount(<InkBoardEditorHarness mode="paged-v1" label="paged" />);

  const editor = workspace(page).getByTestId('ink-editor');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute('data-document-id', /ink_paged_ct_paged_/);

  const canvas = workspace(page).getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-page-id', INK_BOARD_CT_PAGED_PAGE_ONE);
  await expect(workspace(page).getByTestId('ink-page-count')).toHaveText('1/2');
  await expect(workspace(page).getByTestId('ink-page-viewport')).toBeVisible();

  expect(await workspace(page).getByTestId('ink-board-editor').count()).toBe(0);
  expect(await workspace(page).getByTestId('ink-board-viewport').count()).toBe(0);

  const state = await readState(page);
  expect(state.mode).toBe('paged-v1');
  expect(state.createCalls).toEqual([]);
  expect(state.savePageCalls).toBe(0);
  expect(state.saveChunkCalls).toBe(0);
  expect(state.calls.filter((call) => (
    call.command === 'vfs_ink_create'
    || call.command === 'vfs_ink_create_board'
    || call.command === 'vfs_ink_append_page'
  ))).toHaveLength(0);
});

test('touch-off navigation pans and zooms the board without advancing the canonical revision or writing a draft', async ({ mount, page }) => {
  await mount(<InkBoardEditorHarness mode="board-v2" label="nav" />);

  await expect(workspace(page).getByTestId('ink-board-editor')).toBeVisible();
  await expect(workspace(page).getByTestId('ink-board-viewport')).toBeVisible();
  const canvas = workspace(page).getByTestId('ink-board-canvas');
  await expect(canvas).toBeVisible();

  const before = await readState(page);
  expect(before.revision).toBe('rev-ct-1');
  const beforeObjects = JSON.stringify(before.objects);
  const beforeCamera = await readCamera(canvas);
  expect(beforeCamera).not.toBeNull();

  await touchPan(page, canvas, 240, 160);
  await expect.poll(async () => (await readCamera(canvas))?.x ?? 0).not.toBe(beforeCamera?.x);
  await zoomOutAt(page, canvas, -240);
  await expect.poll(async () => (await readCamera(canvas))?.zoom ?? 1).not.toBe(beforeCamera?.zoom);

  const movedCamera = await readCamera(canvas);
  expect(movedCamera).not.toBeNull();
  expect(movedCamera?.x ?? 0).not.toBe(beforeCamera?.x);
  expect(movedCamera?.y ?? 0).not.toBe(beforeCamera?.y);
  expect(movedCamera?.zoom ?? 1).not.toBe(beforeCamera?.zoom);

  const after = await readState(page);
  expect(after.revision).toBe(before.revision);
  expect(JSON.stringify(after.objects)).toBe(beforeObjects);
  expect(after.saveChunkRequests).toHaveLength(0);
  expect(after.saveChunkCalls).toBe(0);
  expect(after.savePageCalls).toBe(0);
  expect(after.createCalls).toEqual([]);
  expect(after.journalAtCas).toEqual([]);
  expect(after.calls.filter((call) => (
    call.command === 'vfs_ink_save_chunks'
    || call.command === 'vfs_ink_save_page'
    || call.command === 'vfs_ink_append_page'
    || call.command === 'vfs_ink_create_board'
  ))).toHaveLength(0);
  expect(await readDraft(page)).toBeFalsy();
});

test('root pen gesture, eraser sweep, and undo/redo round-trip through the real board route', async ({ mount, page }) => {
  await mount(<InkBoardEditorHarness mode="board-v2" label="erase" />);
  const canvas = await prepareNegativeBoard(page);
  const baselineCas = (await readState(page)).saveChunkRequests.length;

  await drawPenStroke(page, canvas);
  await waitForJournalOrNewCas(page, baselineCas);
  let state = await flushAndRead(page);
  const baseId = 'board_ct_object0001';
  const drawn = state.objects.find((object) => object.id !== baseId && object.content.kind === 'stroke');
  expect(drawn).toBeTruthy();

  await workspace(page).getByTestId('ink-board-eraser-tool').click();
  const beforeEraseCas = state.saveChunkRequests.length;
  await drawPenStroke(page, canvas);
  await waitForJournalOrNewCas(page, beforeEraseCas);
  state = await flushAndRead(page);
  expect(state.objects.some((object) => object.id === drawn?.id)).toBe(false);

  await expect(workspace(page).getByTestId('ink-board-undo')).toBeEnabled();
  const beforeUndoCas = state.saveChunkRequests.length;
  await workspace(page).getByTestId('ink-board-undo').click();
  await waitForJournalOrNewCas(page, beforeUndoCas);
  state = await flushAndRead(page);
  expect(state.objects.some((object) => object.id === drawn?.id)).toBe(true);

  await expect(workspace(page).getByTestId('ink-board-redo')).toBeEnabled();
  const beforeRedoCas = state.saveChunkRequests.length;
  await workspace(page).getByTestId('ink-board-redo').click();
  await waitForJournalOrNewCas(page, beforeRedoCas);
  state = await flushAndRead(page);
  expect(state.objects.some((object) => object.id === drawn?.id)).toBe(false);
});

test('rectangle and lasso selection copy vector content, paste creates fresh IDs with global z, and one undo removes the paste', async ({ mount, page }) => {
  await mount(<InkBoardEditorHarness mode="board-v2" label="select" />);
  const canvas = await prepareNegativeBoard(page);
  const baseId = 'board_ct_object0001';

  await workspace(page).getByTestId('ink-board-select-rectangle').click();
  await dragCanvasBox(page, canvas, { x: 200, y: 150 }, { x: 340, y: 210 });
  const copyButton = workspace(page).getByTestId('ink-board-selection-copy');
  await expect(copyButton).toBeEnabled();
  await copyButton.click();

  await expect.poll(async () => (await readState(page)).clipboardText.length).toBeGreaterThan(0);
  let state = await readState(page);
  const rectanglePayload = JSON.parse(state.clipboardText) as {
    format: string;
    version: number;
    objects: Array<{ index: number; content: { kind: string } }>;
  };
  expect(rectanglePayload.format).toBe('deep-student.ink-clipboard');
  expect(rectanglePayload.version).toBe(1);
  expect(rectanglePayload.objects[0].content.kind).toBe('stroke');
  expect(Object.keys(rectanglePayload.objects[0]).sort()).toEqual(['content', 'index']);

  await workspace(page).getByTestId('ink-board-select-lasso').click();
  await lassoCanvasBox(page, canvas, { left: 190, top: 140, right: 350, bottom: 220 });
  await expect(copyButton).toBeEnabled();
  await copyButton.click();
  await expect.poll(async () => (await readState(page)).clipboardText.length).toBeGreaterThan(0);
  state = await readState(page);
  const lassoPayload = JSON.parse(state.clipboardText) as { format: string; objects: Array<{ content: { kind: string } }> };
  expect(lassoPayload.format).toBe('deep-student.ink-clipboard');
  expect(lassoPayload.objects[0].content.kind).toBe('stroke');

  const beforePasteCas = state.saveChunkRequests.length;
  await workspace(page).getByTestId('ink-board-selection-paste').click();
  await waitForJournalOrNewCas(page, beforePasteCas);
  state = await flushAndRead(page);

  const baseObject = state.objects.find((object) => object.id === baseId);
  const pasted = state.objects.find((object) => object.id !== baseId);
  expect(baseObject).toBeTruthy();
  expect(pasted).toBeTruthy();
  expect(pasted?.id).toMatch(/^ink-board-/);
  expect(pasted?.content.kind).toBe('stroke');
  expect(pasted?.content.kind === 'stroke' ? pasted.content.samples.length : 0)
    .toBe(baseObject?.content.kind === 'stroke' ? baseObject.content.samples.length : 0);
  const zIndexes = state.objects.map((object) => object.z_index);
  expect(new Set(zIndexes).size).toBe(zIndexes.length);
  expect(pasted?.z_index).toBe(1);

  await expect(workspace(page).getByTestId('ink-board-undo')).toBeEnabled();
  const beforeUndoCas = state.saveChunkRequests.length;
  await workspace(page).getByTestId('ink-board-undo').click();
  await waitForJournalOrNewCas(page, beforeUndoCas);
  state = await flushAndRead(page);
  expect(state.objects.map((object) => object.id)).toEqual([baseId]);
});

test('same-source paste keeps +16 while an external clipboard payload far from the viewport is centered', async ({ mount, page }) => {
  await mount(<InkBoardEditorHarness mode="board-v2" label="paste-center" />);
  const canvas = await prepareNegativeBoard(page);
  const baseId = 'board_ct_object0001';
  const camera = await readCamera(canvas);
  expect(camera).not.toBeNull();
  const canvasSize = await canvas.evaluate((element) => ({
    width: (element as HTMLCanvasElement).clientWidth,
    height: (element as HTMLCanvasElement).clientHeight,
  }));
  const viewportCenter = {
    x: (camera?.x ?? 0) + canvasSize.width / (2 * (camera?.zoom ?? 1)),
    y: (camera?.y ?? 0) + canvasSize.height / (2 * (camera?.zoom ?? 1)),
  };

  await workspace(page).getByTestId('ink-board-select-rectangle').click();
  await dragCanvasBox(page, canvas, { x: 200, y: 150 }, { x: 340, y: 210 });
  await workspace(page).getByTestId('ink-board-selection-copy').click();
  await expect.poll(async () => (await readState(page)).clipboardText.length).toBeGreaterThan(0);
  await page.waitForTimeout(50);

  let state = await readState(page);
  const beforeSameSourceCas = state.saveChunkRequests.length;
  await workspace(page).getByTestId('ink-board-selection-paste').click();
  await waitForJournalOrNewCas(page, beforeSameSourceCas);
  state = await flushAndRead(page);
  const base = state.objects.find((object) => object.id === baseId);
  const sameSourcePasted = state.objects.find((object) => object.id !== baseId);
  expect(base?.content.kind).toBe('stroke');
  expect(sameSourcePasted?.content.kind).toBe('stroke');
  if (base?.content.kind === 'stroke' && sameSourcePasted?.content.kind === 'stroke') {
    expect(sameSourcePasted.content.samples[0]).toMatchObject({
      x: base.content.samples[0].x + 16,
      y: base.content.samples[0].y + 16,
    });
  }

  const farStroke = {
    kind: 'stroke',
    samples: [
      { x: 10000, y: 10000, pressure: 0.5 },
      { x: 10080, y: 10040, pressure: 0.5 },
    ],
    style: { tool: 'pen', color: '#000000', width: 4, pressure_enabled: false },
  };
  await setClipboard(page, JSON.stringify({
    format: 'deep-student.ink-clipboard',
    version: 1,
    origin: { x: 10000, y: 10000 },
    bounds: { x: 10000, y: 10000, width: 80, height: 40 },
    objects: [{ index: 0, content: farStroke }],
  }));

  const beforeExternalCas = state.saveChunkRequests.length;
  await workspace(page).getByTestId('ink-board-selection-paste').click();
  await waitForJournalOrNewCas(page, beforeExternalCas);
  state = await flushAndRead(page);
  const ids = new Set([baseId, sameSourcePasted?.id]);
  const externalPasted = state.objects.find((object) => !ids.has(object.id));
  expect(externalPasted?.content.kind).toBe('stroke');
  if (externalPasted?.content.kind === 'stroke') {
    const xs = externalPasted.content.samples.map((sample) => sample.x);
    const ys = externalPasted.content.samples.map((sample) => sample.y);
    const center = {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
    expect(Math.abs(center.x - viewportCenter.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(center.y - viewportCenter.y)).toBeLessThanOrEqual(1);
    expect(center.x).toBeLessThan(9000);
    expect(center.y).toBeLessThan(9000);
  }
});

test('pointercancel finishes one stroke and one eraser sweep, while a pinch-initiated cancel does not create a connecting stroke', async ({ mount, page }) => {
  await mount(<InkBoardEditorHarness mode="board-v2" label="cancel" />);
  const canvas = await prepareNegativeBoard(page);
  const baseId = 'board_ct_object0001';
  let state = await readState(page);

  const beforeStrokeCas = state.saveChunkRequests.length;
  await dispatchCanvasPointer(canvas, 'pointerdown', 71, { x: 80, y: 80 }, 'pen');
  await dispatchCanvasPointer(canvas, 'pointermove', 71, { x: 200, y: 140 }, 'pen');
  await dispatchCanvasPointer(canvas, 'pointercancel', 71, { x: 200, y: 140 }, 'pen');
  await waitForJournalOrNewCas(page, beforeStrokeCas);
  state = await flushAndRead(page);
  const cancelledStroke = state.objects.find((object) => object.id !== baseId);
  expect(cancelledStroke?.content.kind).toBe('stroke');

  await workspace(page).getByTestId('ink-board-eraser-tool').click();
  const beforeEraseCas = state.saveChunkRequests.length;
  await dispatchCanvasPointer(canvas, 'pointerdown', 72, { x: 80, y: 80 }, 'pen');
  await dispatchCanvasPointer(canvas, 'pointermove', 72, { x: 200, y: 140 }, 'pen');
  await dispatchCanvasPointer(canvas, 'pointercancel', 72, { x: 200, y: 140 }, 'pen');
  await waitForJournalOrNewCas(page, beforeEraseCas);
  state = await flushAndRead(page);
  expect(state.objects.some((object) => object.id === cancelledStroke?.id)).toBe(false);

  await workspace(page).getByTestId('ink-board-tool-pen').click();
  await workspace(page).getByTestId('ink-board-touch-draw-toggle').click();
  const objectsBeforePinch = JSON.stringify(state.objects);
  const beforePinchCas = state.saveChunkRequests.length;
  await dispatchCanvasPointer(canvas, 'pointerdown', 81, { x: 100, y: 100 }, 'touch');
  await dispatchCanvasPointer(canvas, 'pointermove', 81, { x: 160, y: 130 }, 'touch');
  await dispatchCanvasPointer(canvas, 'pointerdown', 82, { x: 300, y: 200 }, 'touch');
  await dispatchCanvasPointer(canvas, 'pointermove', 81, { x: 110, y: 110 }, 'touch');
  await dispatchCanvasPointer(canvas, 'pointermove', 82, { x: 310, y: 210 }, 'touch');
  await dispatchCanvasPointer(canvas, 'pointerup', 81, { x: 110, y: 110 }, 'touch');
  await dispatchCanvasPointer(canvas, 'pointerup', 82, { x: 310, y: 210 }, 'touch');
  await page.waitForTimeout(120);

  state = await readState(page);
  expect(JSON.stringify(state.objects)).toBe(objectsBeforePinch);
  expect(state.saveChunkRequests.length).toBe(beforePinchCas);
  expect(await readDraft(page)).toBeFalsy();
});

test('repeated toolbar zoom stays inside camera bounds and saved pointer coordinates match the rendered camera', async ({ mount, page }) => {
  await mount(<InkBoardEditorHarness mode="board-v2" label="zoom" />);
  await expect(workspace(page).getByTestId('ink-board-editor')).toBeVisible();
  await expect(workspace(page).getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready');
  const canvas = workspace(page).getByTestId('ink-board-canvas');
  await expect(canvas).toBeVisible();

  for (let index = 0; index < 30; index += 1) {
    await workspace(page).getByTestId('ink-board-zoom-out').click();
  }
  let camera = await readCamera(canvas);
  expect(camera).not.toBeNull();
  expect(camera?.zoom ?? 0).toBeGreaterThanOrEqual(CAMERA_MIN_ZOOM);
  expect(camera?.zoom ?? 0).toBeLessThanOrEqual(CAMERA_MAX_ZOOM);

  for (let index = 0; index < 40; index += 1) {
    await workspace(page).getByTestId('ink-board-zoom-in').click();
  }
  camera = await readCamera(canvas);
  expect(camera).not.toBeNull();
  expect(camera?.zoom ?? 0).toBeLessThanOrEqual(CAMERA_MAX_ZOOM);
  expect(camera?.zoom ?? 0).toBeGreaterThanOrEqual(CAMERA_MIN_ZOOM);

  const beforeDrawCas = (await readState(page)).saveChunkRequests.length;
  await drawPenStroke(page, canvas);
  await waitForJournalOrNewCas(page, beforeDrawCas);
  const state = await flushAndRead(page);
  const drawn = state.objects.find((object) => object.id !== 'board_ct_object0001');
  expect(drawn?.content.kind).toBe('stroke');
  if (drawn?.content.kind === 'stroke') {
    const expected = {
      x: (camera?.x ?? 0) + 80 / (camera?.zoom ?? 1),
      y: (camera?.y ?? 0) + 80 / (camera?.zoom ?? 1),
    };
    expect(Math.abs(drawn.content.samples[0].x - expected.x)).toBeLessThan(0.01);
    expect(Math.abs(drawn.content.samples[0].y - expected.y)).toBeLessThan(0.01);
  }
});

test('board export dialog exposes explicit finite PNG/PDF options and a row-major preview instead of the whole surface', async ({ mount, page }) => {
  await mount(<InkBoardEditorHarness mode="board-v2" label="export-options" />);
  await prepareNegativeBoard(page);

  const exportButton = workspace(page).getByTestId('ink-board-export');
  await expect(exportButton).toBeEnabled();
  await exportButton.click();
  const exportDialog = page.getByTestId('ink-board-export-dialog');
  await expect(exportDialog).toBeVisible();
  await expect(exportDialog).toHaveAttribute('role', 'dialog');
  await expect(exportDialog).not.toHaveAttribute('data-ink-workspace-page');

  await exportDialog.getByTestId('ink-board-export-format-pdf').click();
  await exportDialog.getByTestId('ink-board-export-page-width').fill('400');
  await exportDialog.getByTestId('ink-board-export-page-height').fill('300');
  const preview = exportDialog.getByTestId('ink-board-export-preview');
  await expect(preview).toHaveAttribute('data-row-major', 'true');
  const pageCount = Number(await preview.getAttribute('data-page-count'));
  expect(pageCount).toBeGreaterThan(0);
  expect(pageCount).toBeLessThanOrEqual(500);
  const regionRaw = await preview.getAttribute('data-region');
  expect(regionRaw).toBeTruthy();
  const region = JSON.parse(regionRaw ?? '{}') as { x: number; y: number; width: number; height: number };
  expect([region.x, region.y, region.width, region.height].every(Number.isFinite)).toBe(true);
  expect(region.width).toBeGreaterThan(0);
  expect(region.height).toBeGreaterThan(0);

  const before = await readState(page);
  const surfaceBounds = (before.manifest as { surface?: { bounds?: unknown } }).surface?.bounds;
  expect(region).not.toEqual(surfaceBounds);

  await exportDialog.getByTestId('ink-board-export-submit').click();
  await expect.poll(async () => (await readState(page)).exportRequests.length).toBe(1);
  const state = await readState(page);
  const request = state.exportRequests[0];
  expect(request.document_id).toBe(state.documentId);
  expect(request.page_ids).toEqual(['board_ct_page0001']);
  expect(request.format).toBe('pdf');
  expect(request.operation_id).toMatch(/\S+/);
  expect(request.board).toMatchObject({
    region,
    page_width: 400,
    page_height: 300,
    paginate: true,
  });
});
