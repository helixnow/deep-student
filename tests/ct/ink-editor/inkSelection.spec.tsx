import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { Locator, Page } from '@playwright/test';
import type { InkManifest, InkObject, InkPage } from '@/features/ink/types';
import { InkEditorHarness, type InkAskAiCapture } from './InkEditorHarness';
import { inkEditorDocumentId, inkEditorPageId } from './fixtures';
import { expectEditorFlush, flushEditor } from './inkTestUtils';

const SELECT_RECTANGLE = 'ink-select-rectangle';
const SELECT_LASSO = 'ink-select-lasso';
const SELECTION_ASK_AI = 'ink-selection-ask-ai';
const SELECTION_COPY = 'ink-selection-copy';
const SELECTION_PASTE = 'ink-selection-paste';

interface FixtureBackend {
  readPage(pageId: string): InkPage | undefined;
  readManifest(): InkManifest;
  readonly saveCalls: number;
}

interface ClipboardWireObject {
  index: number;
  content: InkObject['content'];
}

interface ClipboardWirePayload {
  format: string;
  version: number;
  origin: { x: number; y: number };
  bounds: { x: number; y: number; width: number; height: number };
  objects: ClipboardWireObject[];
}

async function dragSelection(page: Page, canvas: Locator, from: { x: number; y: number }, to: { x: number; y: number }) {
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Ink page input canvas has no visible bounds');
  await page.mouse.move(bounds.x + from.x, bounds.y + from.y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + to.x, bounds.y + to.y, { steps: 4 });
  await page.mouse.up();
}

async function dragLasso(page: Page, canvas: Locator, points: Array<{ x: number; y: number }>) {
  if (points.length < 3) throw new Error('Lasso needs at least three points');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Ink page input canvas has no visible bounds');
  const [first, ...rest] = points;
  await page.mouse.move(bounds.x + first.x, bounds.y + first.y);
  await page.mouse.down();
  for (const point of rest) {
    await page.mouse.move(bounds.x + point.x, bounds.y + point.y, { steps: 1 });
  }
  await page.mouse.up();
}

async function nextFrame(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

async function touchDragSelection(page: Page, canvas: Locator, from: { x: number; y: number }, to: { x: number; y: number }) {
  await canvas.evaluate((element, points) => {
    const rect = element.getBoundingClientRect();
    const fire = (type: string, x: number, y: number, buttons: number) => {
      element.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 41,
        pointerType: 'touch',
        isPrimary: true,
        buttons,
        clientX: rect.left + x,
        clientY: rect.top + y,
      }));
    };
    fire('pointerdown', points.from.x, points.from.y, 1);
    fire('pointermove', points.to.x, points.to.y, 1);
    fire('pointerup', points.to.x, points.to.y, 0);
  }, { from, to });
}

async function readVisiblePageCenter(page: Page, pageId: string) {
  return page.evaluate((id) => {
    const backend = (window as Window & { __INK_EDITOR_CT_BACKEND__?: FixtureBackend }).__INK_EDITOR_CT_BACKEND__;
    const pageRef = backend?.readManifest().pages.find((candidate) => candidate.page_id === id);
    const viewport = document.querySelector('[data-testid="ink-page-viewport"]') as HTMLElement | null;
    const canvas = document.querySelector('[data-testid="ink-page-canvas"]') as HTMLCanvasElement | null;
    if (!pageRef || !viewport || !canvas) throw new Error('Missing fixture layout for visible center');
    const viewportRect = viewport.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const scale = canvasRect.width / pageRef.width;
    return {
      x: (viewportRect.left + viewport.clientWidth / 2 - canvasRect.left) / scale,
      y: (viewportRect.top + viewport.clientHeight / 2 - canvasRect.top) / scale,
    };
  }, pageId);
}

function strokeCenter(object: InkObject): { x: number; y: number } | null {
  if (object.content.kind !== 'stroke' || object.content.samples.length === 0) return null;
  const xs = object.content.samples.map((sample) => sample.x);
  const ys = object.content.samples.map((sample) => sample.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

async function readFixturePage(page: Page, pageId = inkEditorPageId): Promise<InkPage | undefined> {
  return page.evaluate((id) => {
    const backend = (window as Window & { __INK_EDITOR_CT_BACKEND__?: FixtureBackend }).__INK_EDITOR_CT_BACKEND__;
    return backend?.readPage(id);
  }, pageId);
}

async function readFixtureManifest(page: Page): Promise<InkManifest | undefined> {
  return page.evaluate(() => {
    const backend = (window as Window & { __INK_EDITOR_CT_BACKEND__?: FixtureBackend }).__INK_EDITOR_CT_BACKEND__;
    return backend?.readManifest();
  });
}

async function readSaveCalls(page: Page): Promise<number> {
  return page.evaluate(() => {
    const backend = (window as Window & { __INK_EDITOR_CT_BACKEND__?: FixtureBackend }).__INK_EDITOR_CT_BACKEND__;
    return backend?.saveCalls ?? -1;
  });
}

async function readAskAiRequests(page: Page): Promise<InkAskAiCapture[]> {
  return page.evaluate(() => {
    const requests = (window as Window & { __INK_EDITOR_ASK_AI_REQUESTS__?: InkAskAiCapture[] }).__INK_EDITOR_ASK_AI_REQUESTS__;
    return requests ?? [];
  });
}

async function readClipboardText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const clipboard = (window as Window & { __INK_EDITOR_CT_CLIPBOARD__?: { read(): string } }).__INK_EDITOR_CT_CLIPBOARD__;
    return clipboard?.read() ?? '';
  });
}

async function readInvokeCommands(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const calls = (window as Window & { __CT_INVOKE_CALLS__?: Array<{ command: string }> }).__CT_INVOKE_CALLS__ ?? [];
    return calls.map((call) => call.command);
  });
}

async function canvasPixel(canvas: Locator, x: number, y: number): Promise<number[]> {
  return canvas.evaluate((element, point) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    return Array.from(context.getImageData(point.x, point.y, 1, 1).data);
  }, { x, y });
}

test('ask-ai on a background-only rectangle sends {documentId,pageId,revision,crop} with the logical rect and does not write', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" imageBackground captureAskAi />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toBeVisible();

  // The rectangle contains no ink objects: only the image background is present.
  await expect.poll(() => canvasPixel(canvas, 50, 80)).toEqual([255, 0, 0, 255]);

  // Fail immediately on a missing control instead of waiting for click actionability.
  expect(await component.getByTestId(SELECT_RECTANGLE).count()).toBe(1);
  expect(await component.getByTestId(SELECTION_ASK_AI).count()).toBe(0);

  const pageBefore = await readFixturePage(page);
  const manifestBefore = await readFixtureManifest(page);
  expect(pageBefore?.objects.map((object) => object.id)).toEqual(['fixture-blue-stroke']);
  expect(manifestBefore?.revision).toBe('revision-1');

  await component.getByTestId(SELECT_RECTANGLE).click();
  await dragSelection(page, input, { x: 20, y: 60 }, { x: 80, y: 100 });

  expect(await component.getByTestId(SELECTION_ASK_AI).count()).toBe(1);
  await component.getByTestId(SELECTION_ASK_AI).click();

  await expect.poll(async () => (await readAskAiRequests(page)).length).toBe(1);
  const [request] = await readAskAiRequests(page);
  expect(request).toEqual({
    documentId: inkEditorDocumentId,
    pageId: inkEditorPageId,
    revision: 'revision-1',
    crop: { x: 20, y: 60, width: 60, height: 40 },
  });

  // Selection and ask-ai are transient: the page and manifest must not be written.
  expect(await readFixturePage(page)).toEqual(pageBefore);
  expect(await readFixtureManifest(page)).toEqual(manifestBefore);
  expect(await readSaveCalls(page)).toBe(0);
});

test('copies and pastes a same-page vector duplicate through the clipboard IPC boundary with one save and one undo', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toBeVisible();

  // Fail immediately on missing controls instead of waiting for click actionability.
  expect(await component.getByTestId(SELECT_RECTANGLE).count()).toBe(1);
  expect(await component.getByTestId(SELECTION_COPY).count()).toBe(0);
  expect(await component.getByTestId(SELECTION_PASTE).count()).toBe(0);

  await component.getByTestId(SELECT_RECTANGLE).click();
  await dragSelection(page, input, { x: 8, y: 8 }, { x: 104, y: 32 });

  expect(await component.getByTestId(SELECTION_COPY).count()).toBe(1);
  expect(await component.getByTestId(SELECTION_PASTE).count()).toBe(1);

  const pageBefore = await readFixturePage(page);
  const original = pageBefore?.objects.find((object) => object.id === 'fixture-blue-stroke');
  expect(original).toBeDefined();
  expect(original?.content.kind).toBe('stroke');

  await component.getByTestId(SELECTION_COPY).click();
  await expect.poll(() => readClipboardText(page)).not.toBe('');
  const clipboardText = await readClipboardText(page);
  const payload = JSON.parse(clipboardText) as ClipboardWirePayload;
  expect(payload.format).toBe('deep-student.ink-clipboard');
  expect(payload.version).toBe(1);
  expect(payload.objects).toHaveLength(1);
  expect(payload.objects[0]?.content).toEqual(original?.content);
  // Copy is read-only and must still go through the production clipboard helper.
  expect(await readFixturePage(page)).toEqual(pageBefore);
  expect(await readSaveCalls(page)).toBe(0);
  expect(await readInvokeCommands(page)).toContain('plugin:clipboard-manager|write_text');

  await component.getByTestId(SELECTION_PASTE).click();
  await expectEditorFlush(page);
  await expect.poll(async () => (await readFixturePage(page))?.objects.length).toBe(2);

  const pastedPage = await readFixturePage(page);
  const duplicate = pastedPage?.objects.find((object) => object.id !== 'fixture-blue-stroke');
  expect(duplicate?.id).not.toBe('fixture-blue-stroke');
  expect(duplicate?.author).toBe('user');
  expect(duplicate?.content.kind).toBe('stroke');
  if (original?.content.kind !== 'stroke' || duplicate?.content.kind !== 'stroke') {
    throw new Error('The fixture and the pasted duplicate must both be strokes');
  }
  expect(duplicate.content.samples).toEqual(original.content.samples.map((sample) => ({
    ...sample,
    x: sample.x + 16,
    y: sample.y + 16,
  })));
  expect(duplicate.content.style).toEqual(original.content.style);
  expect(pastedPage?.objects.find((object) => object.id === 'fixture-blue-stroke')).toEqual(original);
  // The source clipboard payload is not rewritten by pasting.
  expect(await readClipboardText(page)).toBe(clipboardText);
  expect(await readInvokeCommands(page)).toContain('plugin:clipboard-manager|read_text');
  await expect.poll(() => readSaveCalls(page)).toBe(1);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');

  // One paste is one undo unit; flushing undo removes only the duplicate.
  expect(await component.getByTestId('ink-undo').count()).toBe(1);
  await component.getByTestId('ink-undo').click();
  await expectEditorFlush(page);
  await expect.poll(async () => (await readFixturePage(page))?.objects.map((object) => object.id)).toEqual(['fixture-blue-stroke']);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
});

test('lasso uses the true polygon for object selection and the true bbox for preview and ask-ai', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" captureAskAi />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toBeVisible();

  await component.getByTestId(SELECT_LASSO).click();

  // Π-shaped lasso: bbox spans the blue stroke, but the polygon notch does not.
  const lasso = [
    { x: 5, y: 5 },
    { x: 115, y: 5 },
    { x: 115, y: 100 },
    { x: 110, y: 100 },
    { x: 110, y: 10 },
    { x: 10, y: 10 },
    { x: 10, y: 100 },
    { x: 5, y: 100 },
  ];
  await dragLasso(page, input, lasso);

  const overlay = component.getByTestId('ink-selection-overlay');
  const boundsRect = overlay.locator('rect');
  await expect(boundsRect).toHaveCount(1);
  await expect(boundsRect).toHaveAttribute('x', '5');
  await expect(boundsRect).toHaveAttribute('y', '5');
  await expect(boundsRect).toHaveAttribute('width', '110');
  await expect(boundsRect).toHaveAttribute('height', '95');

  // The blue stroke sits in the bbox corner/notch but outside the lasso polygon.
  await expect(component.getByTestId(SELECTION_COPY)).toBeDisabled();
  expect(await readClipboardText(page)).toBe('');
  expect(await readSaveCalls(page)).toBe(0);

  await component.getByTestId(SELECTION_ASK_AI).click();
  await expect.poll(async () => (await readAskAiRequests(page)).length).toBe(1);
  const [request] = await readAskAiRequests(page);
  expect(request?.crop).toEqual({ x: 5, y: 5, width: 110, height: 95 });
});

test('cross-page paste centers on the scrolled and zoomed visible viewport instead of the page center', async ({ mount, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const component = await mount(<InkEditorHarness saveMode="success" largePage />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toHaveAttribute('data-page-id', inkEditorPageId);
  await expect(component.getByTestId('ink-zoom-level')).toHaveText('100%');

  await component.getByTestId(SELECT_RECTANGLE).click();
  await dragSelection(page, input, { x: 8, y: 8 }, { x: 104, y: 32 });
  await component.getByTestId(SELECTION_COPY).click();
  await expect.poll(() => readClipboardText(page)).not.toBe('');
  const clipboardText = await readClipboardText(page);

  await component.getByTestId('ink-page-previous').click();
  await expect(canvas).toHaveAttribute('data-page-id', 'ink-editor-ct-page-1');

  await page.evaluate(() => {
    const viewport = document.querySelector('[data-testid="ink-page-viewport"]') as HTMLElement | null;
    if (!viewport) throw new Error('Missing ink viewport');
    viewport.style.width = '480px';
    viewport.style.height = '360px';
    viewport.style.flex = '0 0 360px';
  });
  for (let index = 0; index < 4; index += 1) {
    await component.getByTestId('ink-zoom-in').click();
  }
  await expect.poll(() => canvas.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(2000);
  await expect.poll(() => component.getByTestId('ink-page-viewport').evaluate((element) => element.getBoundingClientRect().height)).toBe(360);
  await page.evaluate(() => {
    const viewport = document.querySelector('[data-testid="ink-page-viewport"]') as HTMLElement | null;
    if (!viewport) throw new Error('Missing ink viewport');
    viewport.scrollLeft = 700;
    viewport.scrollTop = 900;
  });

  // Page change invalidates selection mode; paste remains reachable once re-armed.
  await component.getByTestId(SELECT_RECTANGLE).click();
  await expect(component.getByTestId(SELECTION_PASTE)).toBeVisible();
  const expectedCenter = await readVisiblePageCenter(page, 'ink-editor-ct-page-1');

  await component.getByTestId(SELECTION_PASTE).click();
  await expectEditorFlush(page);
  await expect.poll(async () => (await readFixturePage(page, 'ink-editor-ct-page-1'))?.objects.length).toBe(2);
  const targetPage = await readFixturePage(page, 'ink-editor-ct-page-1');
  const pasted = targetPage?.objects.find((object) => object.id.startsWith('ink-paste-'));
  expect(pasted).toBeDefined();
  const center = strokeCenter(pasted as InkObject);
  expect(center).not.toBeNull();
  expect(Math.abs((center as { x: number; y: number }).x - expectedCenter.x)).toBeLessThan(1);
  expect(Math.abs((center as { x: number; y: number }).y - expectedCenter.y)).toBeLessThan(1);
  expect(await readClipboardText(page)).toBe(clipboardText);
  await expect.poll(() => readSaveCalls(page)).toBe(1);
});

test('invalidates transient selection on remote reload and page change so stale objects cannot be copied', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" captureAskAi />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toBeVisible();

  await component.getByTestId(SELECT_RECTANGLE).click();
  await dragSelection(page, input, { x: 8, y: 8 }, { x: 104, y: 32 });
  await expect(component.getByTestId(SELECTION_COPY)).toHaveCount(1);

  await component.getByTestId('ink-editor-advance-remote-external').click();
  await component.getByTestId('ink-editor-emit-changed').click();
  await expect.poll(async () => (await readFixturePage(page))?.objects.some((object) => object.id === 'external-remote-stroke')).toBe(true);
  await expect(component.getByTestId(SELECTION_COPY)).toHaveCount(0);
  await expect(component.getByTestId(SELECTION_ASK_AI)).toHaveCount(0);

  await page.evaluate(() => {
    document.querySelector('[data-testid="ink-active-stroke-canvas"]')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }),
    );
  });
  await nextFrame(page);
  expect(await readClipboardText(page)).toBe('');

  // Re-select, then a page change must invalidate the region again.
  await component.getByTestId(SELECT_RECTANGLE).click();
  await dragSelection(page, input, { x: 8, y: 8 }, { x: 104, y: 32 });
  await expect(component.getByTestId(SELECTION_COPY)).toHaveCount(1);
  await component.getByTestId('ink-page-previous').click();
  await expect(canvas).toHaveAttribute('data-page-id', 'ink-editor-ct-page-1');
  await expect(component.getByTestId(SELECTION_COPY)).toHaveCount(0);
  await page.evaluate(() => {
    document.querySelector('[data-testid="ink-active-stroke-canvas"]')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }),
    );
  });
  await nextFrame(page);
  expect(await readClipboardText(page)).toBe('');
});

test('does not ask after paste save/flush failure and does not write when clipboard read rejects', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="offline" captureAskAi />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toBeVisible();
  // Keep the browser clipboard fallback from masking the IPC-rejection contract.
  await page.evaluate(() => {
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    } catch {
      // The fallback is optional; the IPC handlers remain the contract under test.
    }
  });

  await component.getByTestId(SELECT_RECTANGLE).click();
  await dragSelection(page, input, { x: 8, y: 8 }, { x: 104, y: 32 });
  await component.getByTestId(SELECTION_COPY).click();
  await expect.poll(() => readClipboardText(page)).not.toBe('');

  await component.getByTestId(SELECTION_PASTE).click();
  await flushEditor(page);
  await expect.poll(() => readSaveCalls(page)).toBe(1);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'offline');

  // Selection ask must flush first; offline draft must not reach the ask/render boundary.
  await dragSelection(page, input, { x: 20, y: 60 }, { x: 80, y: 100 });
  await component.getByTestId(SELECTION_ASK_AI).click();
  await expect(component.getByRole('alert').first()).toBeVisible();
  expect(await readAskAiRequests(page)).toHaveLength(0);
  await expect.poll(() => readSaveCalls(page)).toBe(2);
  const failedFlushSaves = await readSaveCalls(page);

  // Clipboard read reject must not write a page or invoke a save.
  const pageBefore = await readFixturePage(page);
  const readCallsBefore = (await readInvokeCommands(page)).filter((command) => command === 'plugin:clipboard-manager|read_text').length;
  await component.getByTestId('ink-editor-reject-clipboard-read').click();
  await component.getByTestId(SELECTION_PASTE).click();
  await expect.poll(async () => (await readInvokeCommands(page)).filter((command) => command === 'plugin:clipboard-manager|read_text').length).toBeGreaterThan(readCallsBefore);
  await nextFrame(page);
  expect(await readFixturePage(page)).toEqual(pageBefore);
  expect(await readSaveCalls(page)).toBe(failedFlushSaves);
});

test('background-only copy is a disabled or no-error short-circuit and touch selection works with touch drawing off', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toBeVisible();

  await component.getByTestId(SELECT_RECTANGLE).click();
  await expect.poll(() => input.evaluate((element) => getComputedStyle(element).touchAction)).toBe('none');

  // Empty background-only rectangle: copy must not raise operationFailed.
  await dragSelection(page, input, { x: 20, y: 60 }, { x: 80, y: 100 });
  const copy = component.getByTestId(SELECTION_COPY);
  await expect(copy).toHaveCount(1);
  if (!(await copy.isDisabled())) await copy.click();
  await nextFrame(page);
  expect(await readClipboardText(page)).toBe('');
  expect(await component.getByText('errors.operationFailed').count()).toBe(0);
  expect(await readSaveCalls(page)).toBe(0);

  // touchDrawing is false, but an armed selection mode must still accept touch pointers.
  await touchDragSelection(page, input, { x: 20, y: 60 }, { x: 80, y: 100 });
  await expect(component.getByTestId(SELECTION_COPY)).toHaveCount(1);
});

test('queues paste behind a deferred copy write, serializes or rejects double paste, and ignores Ctrl/Cmd repeat', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" clipboardWriteDeferred />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toBeVisible();

  await component.getByTestId(SELECT_RECTANGLE).click();
  await dragSelection(page, input, { x: 8, y: 8 }, { x: 104, y: 32 });
  await component.getByTestId(SELECTION_COPY).click();
  await expect.poll(async () => (await readInvokeCommands(page)).filter((command) => command === 'plugin:clipboard-manager|write_text').length).toBeGreaterThan(0);

  // Copy IPC is held: paste must wait for the write instead of reading empty clipboard.
  await component.getByTestId(SELECTION_PASTE).click();
  await component.getByTestId('ink-editor-resolve-clipboard-write').click();
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'pending');
  await expectEditorFlush(page);
  await expect.poll(async () => (await readFixturePage(page))?.objects.length).toBe(2);
  await expect.poll(() => readSaveCalls(page)).toBe(1);

  // Synchronous pastes are local undo units; one flush saves only their final snapshot.
  const beforeSaves = await readSaveCalls(page);
  const beforeObjects = (await readFixturePage(page))?.objects.length ?? 0;
  await component.getByTestId(SELECTION_PASTE).evaluate((button) => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await nextFrame(page);
  await nextFrame(page);
  expect(await readSaveCalls(page)).toBe(beforeSaves);
  await expectEditorFlush(page);
  const saveDelta = (await readSaveCalls(page)) - beforeSaves;
  const objectDelta = ((await readFixturePage(page))?.objects.length ?? 0) - beforeObjects;
  expect(saveDelta).toBe(1);
  expect([1, 2]).toContain(objectDelta);

  // Ctrl/Cmd+C and Ctrl/Cmd+V with repeat=true are ignored.
  await dragSelection(page, input, { x: 8, y: 8 }, { x: 104, y: 32 });
  await expect(component.getByTestId(SELECTION_COPY)).toHaveCount(1);
  const writesBefore = (await readInvokeCommands(page)).filter((command) => command === 'plugin:clipboard-manager|write_text').length;
  await page.evaluate(() => {
    document.querySelector('[data-testid="ink-active-stroke-canvas"]')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, repeat: true, bubbles: true }),
    );
  });
  await nextFrame(page);
  expect((await readInvokeCommands(page)).filter((command) => command === 'plugin:clipboard-manager|write_text').length).toBe(writesBefore);

  const readsBefore = (await readInvokeCommands(page)).filter((command) => command === 'plugin:clipboard-manager|read_text').length;
  const savesBefore = await readSaveCalls(page);
  await page.evaluate(() => {
    document.querySelector('[data-testid="ink-active-stroke-canvas"]')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, repeat: true, bubbles: true }),
    );
  });
  await nextFrame(page);
  expect((await readInvokeCommands(page)).filter((command) => command === 'plugin:clipboard-manager|read_text').length).toBe(readsBefore);
  expect(await readSaveCalls(page)).toBe(savesBefore);
});

test('large clipboard geometry asks for the free canvas with zero writes', async ({ mount, page }) => {
  const largePayload = JSON.stringify({
    format: 'deep-student.ink-clipboard',
    version: 1,
    origin: { x: 0, y: 0 },
    bounds: { x: 0, y: 0, width: 500, height: 500 },
    objects: [{
      index: 0,
      content: {
        kind: 'stroke',
        samples: [{ x: 0, y: 0, pressure: 0.5 }, { x: 500, y: 500, pressure: 0.5 }],
        style: { tool: 'pen', color: '#000000', width: 4, pressure_enabled: false },
      },
    }],
  });
  const component = await mount(<InkEditorHarness saveMode="success" clipboardPreset={largePayload} />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();

  await component.getByTestId(SELECT_RECTANGLE).click();
  const pageBefore = await readFixturePage(page);
  const savesBefore = await readSaveCalls(page);
  await component.getByTestId(SELECTION_PASTE).click();

  const tooLarge = component.getByTestId('ink-selection-too-large');
  await expect(tooLarge).toBeVisible();
  await expect(tooLarge).toHaveText(/改用自由画布|selectionTooLarge|free.?canvas|infinite.?canvas/i);
  expect(await readSaveCalls(page)).toBe(savesBefore);
  expect(await readFixturePage(page)).toEqual(pageBefore);
});

test('cancels a queued paste when the page changes before a deferred copy write resolves', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" clipboardWriteDeferred />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toHaveAttribute('data-page-id', inkEditorPageId);

  const page2Before = await readFixturePage(page, inkEditorPageId);
  const page1Before = await readFixturePage(page, 'ink-editor-ct-page-1');
  expect(await readSaveCalls(page)).toBe(0);

  await component.getByTestId(SELECT_RECTANGLE).click();
  await dragSelection(page, input, { x: 8, y: 8 }, { x: 104, y: 32 });
  await component.getByTestId(SELECTION_COPY).click();
  await expect.poll(async () => (await readInvokeCommands(page)).filter((command) => command === 'plugin:clipboard-manager|write_text').length).toBeGreaterThan(0);

  // Paste is queued behind the still-pending copy write.
  await component.getByTestId(SELECTION_PASTE).click();

  // Navigate before the write resolves; the queued paste must not bind to page 1.
  await component.getByTestId('ink-page-previous').click();
  await expect(canvas).toHaveAttribute('data-page-id', 'ink-editor-ct-page-1');
  await component.getByTestId('ink-editor-resolve-clipboard-write').click();

  // The copy itself can finish and populate the clipboard.
  await expect.poll(() => readClipboardText(page)).not.toBe('');
  await nextFrame(page);
  await nextFrame(page);

  const clipboardText = await readClipboardText(page);
  const payload = JSON.parse(clipboardText) as ClipboardWirePayload;
  expect(payload.format).toBe('deep-student.ink-clipboard');
  expect(payload.version).toBe(1);
  expect(payload.objects).toHaveLength(1);

  // No paste may land on either the old page or the newly visible page.
  expect(await readFixturePage(page, inkEditorPageId)).toEqual(page2Before);
  expect(await readFixturePage(page, 'ink-editor-ct-page-1')).toEqual(page1Before);
  expect(await readSaveCalls(page)).toBe(0);
});
