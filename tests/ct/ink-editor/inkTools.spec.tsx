import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { Locator, Page } from '@playwright/test';
import type { InkPage } from '@/features/ink/types';
import { INK_TOOL_PREFERENCES_STORAGE_KEY } from '@/features/ink/toolSettings';
import { InkEditorHarness } from './InkEditorHarness';
import { inkEditorDocumentId, inkEditorPageId } from './fixtures';

async function drawHorizontalStroke(page: Page, canvas: Locator, localY: number) {
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Ink page input canvas has no visible bounds');
  await page.mouse.move(bounds.x + 16, bounds.y + localY);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 56, bounds.y + localY, { steps: 2 });
  await page.mouse.move(bounds.x + 96, bounds.y + localY, { steps: 2 });
  await page.mouse.up();
}

async function sweep(page: Page, canvas: Locator, from: { x: number; y: number }, to: { x: number; y: number }) {
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Ink page input canvas has no visible bounds');
  await page.mouse.move(bounds.x + from.x, bounds.y + from.y);
  await page.mouse.down();
  // Deliberately few steps: adjacent samples must sweep the whole eraser disc.
  await page.mouse.move(bounds.x + to.x, bounds.y + to.y, { steps: 2 });
  await page.mouse.up();
}

async function readFixturePage(page: Page, pageId = inkEditorPageId): Promise<InkPage | undefined> {
  return page.evaluate(({ documentId, pageId }) => {
    const backend = (window as Window & {
      __INK_EDITOR_CT_BACKEND__?: { readPage(id: string): InkPage | undefined };
    }).__INK_EDITOR_CT_BACKEND__;
    if (!backend || documentId !== 'ink-editor-ct-document') return undefined;
    return backend.readPage(pageId);
  }, { documentId: inkEditorDocumentId, pageId });
}

async function canvasPixel(canvas: Locator, x: number, y: number): Promise<number[]> {
  return canvas.evaluate((element, point) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    return Array.from(context.getImageData(point.x, point.y, 1, 1).data);
  }, { x, y });
}

async function countDarkPixels(canvas: Locator, top: number, bottom: number): Promise<number> {
  return canvas.evaluate((element, band) => {
    const target = element as HTMLCanvasElement;
    const context = target.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    const pixels = context.getImageData(0, 0, target.width, target.height).data;
    let count = 0;
    for (let y = band.top; y < band.bottom; y += 1) {
      for (let x = 12; x < 108; x += 1) {
        const offset = (y * target.width + x) * 4;
        if (pixels[offset] < 48 && pixels[offset + 1] < 48 && pixels[offset + 2] < 48 && pixels[offset + 3] > 240) count += 1;
      }
    }
    return count;
  }, { top, bottom });
}

async function fillNumeric(field: Locator, value: string) {
  await field.fill(value);
  await field.blur();
}

function hexChannels(color: string): [number, number, number] {
  const value = color.replace('#', '').slice(0, 6);
  if (!/^[\da-f]{6}$/i.test(value)) throw new Error(`Expected a hex ink color, received ${color}`);
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function isGreenish(pixel: number[]): boolean {
  return pixel[1] > 180 && pixel[1] > pixel[0] + 80 && pixel[1] > pixel[2] + 40;
}

const TOOL_SETTINGS_PANEL = 'ink-tool-settings-panel';

async function openSettings(page: Page): Promise<Locator> {
  const panel = page.getByTestId(TOOL_SETTINGS_PANEL);
  await expect(panel).not.toBeVisible();
  await expect(page.getByTestId('ink-settings-color-green')).not.toBeVisible();
  await page.getByTestId('ink-tool-settings').click();
  await expect(panel).toBeVisible();
  return panel;
}

async function closeSettings(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(TOOL_SETTINGS_PANEL)).not.toBeVisible();
}

async function expectAccessibleSettingsPanel(panel: Locator) {
  const role = await panel.getAttribute('role');
  expect(role).not.toBeNull();
  expect(['dialog', 'group']).toContain(role);
}

async function expectPaletteTargetsAndNoHorizontalOverflow(page: Page, panel: Locator) {
  const targets = panel.locator('[data-testid^="ink-settings-color-"]');
  await expect(targets).toHaveCount(12);
  await expect(targets.first()).toBeVisible();
  // Wait out the popover/sheet entrance animation before measuring targets.
  await expect.poll(async () => {
    const boxes = await Promise.all(Array.from({ length: 12 }, (_, index) => targets.nth(index).boundingBox()));
    return boxes.every((box) => box !== null && box.width >= 44 && box.height >= 44);
  }).toBe(true);
  for (let index = 0; index < 12; index += 1) {
    const box = await targets.nth(index).boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  const panelOverflow = await panel.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(panelOverflow.scrollWidth).toBeLessThanOrEqual(panelOverflow.clientWidth + 1);
  const pageOverflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(pageOverflow.scrollWidth).toBeLessThanOrEqual(pageOverflow.innerWidth + 1);
}

test('applies a custom hex color and a numeric pen width to the saved stroke and rendered pixels', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();
  await openSettings(page);

  // Fail immediately on missing controls rather than waiting on a click timeout.
  expect(await page.getByTestId('ink-settings-color-green').count()).toBe(1);
  expect(await page.locator('[data-testid^="ink-settings-color-"]').count()).toBe(12);
  for (const legacyId of [
    'ink-color-black', 'ink-color-red', 'ink-color-blue',
    'ink-width-small', 'ink-width-medium', 'ink-width-large',
  ]) {
    expect(await component.getByTestId(legacyId).count()).toBe(1);
  }
  expect(await page.getByTestId('ink-custom-color').count()).toBe(1);
  expect(await page.getByTestId('ink-width-value').count()).toBe(1);

  const customColor = page.getByTestId('ink-custom-color');
  const widthValue = page.getByTestId('ink-width-value');
  expect(await component.getByTestId('ink-color-black').getAttribute('aria-pressed')).toBe('true');
  expect(Number(await widthValue.inputValue())).toBe(8);

  await customColor.fill('#00ff00');
  await customColor.blur();
  await fillNumeric(widthValue, '24');
  expect(await customColor.inputValue()).toBe('#00ff00');
  expect(await widthValue.inputValue()).toBe('24');
  await closeSettings(page);

  await drawHorizontalStroke(page, component.getByTestId('ink-active-stroke-canvas'), 72);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');

  const saved = await readFixturePage(page);
  const newStrokes = saved?.objects.filter((object) => object.content.kind === 'stroke' && object.id !== 'fixture-blue-stroke');
  expect(newStrokes).toHaveLength(1);
  expect(newStrokes?.[0].content).toMatchObject({
    kind: 'stroke',
    style: { tool: 'pen', color: '#00ff00', width: 24 },
  });

  const center = await canvasPixel(canvas, 48, 72);
  const tenUnitsFromCenter = await canvasPixel(canvas, 48, 62);
  const outsideWideStroke = await canvasPixel(canvas, 48, 50);
  expect(isGreenish(center)).toBe(true);
  // A width of 24 reaches 12 logical units from the centerline; the old width 8 could not.
  expect(isGreenish(tenUnitsFromCenter)).toBe(true);
  expect(outsideWideStroke.slice(0, 3)).toEqual([255, 255, 255]);
});

test('keeps pen and highlighter color, numeric width, and highlighter opacity separate and remembers each tool', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  await expect(canvas).toBeVisible();

  await openSettings(page);
  expect(await page.getByTestId('ink-settings-color-green').count()).toBe(1);
  expect(await page.getByTestId('ink-custom-color').count()).toBe(1);
  expect(await page.getByTestId('ink-width-value').count()).toBe(1);
  expect(await component.getByTestId('ink-tool-highlighter').count()).toBe(1);
  expect(await component.getByTestId('ink-tool-pen').count()).toBe(1);
  await closeSettings(page);

  // Configure the highlighter first, then the pen, then verify the highlighter kept its own values.
  await component.getByTestId('ink-tool-highlighter').click();
  await openSettings(page);
  expect(await page.getByTestId('ink-opacity').count()).toBe(1);
  const opacity = page.getByTestId('ink-opacity');
  const highlighterWidthValue = page.getByTestId('ink-width-value');
  const highlighterColorValue = page.getByTestId('ink-custom-color');
  await highlighterColorValue.fill('#ff8800');
  await highlighterColorValue.blur();
  await fillNumeric(highlighterWidthValue, '16');
  await fillNumeric(opacity, '0.4');
  const highlighterWidth = await highlighterWidthValue.inputValue();
  const highlighterColor = await highlighterColorValue.inputValue();
  const highlighterOpacity = await opacity.inputValue();
  await closeSettings(page);

  await component.getByTestId('ink-tool-pen').click();
  await openSettings(page);
  await page.getByTestId('ink-settings-color-green').click();
  await fillNumeric(page.getByTestId('ink-width-value'), '4');
  expect(await page.getByTestId('ink-settings-color-green').getAttribute('aria-pressed')).toBe('true');
  expect(Number(await page.getByTestId('ink-width-value').inputValue())).toBe(4);
  await closeSettings(page);

  await drawHorizontalStroke(page, component.getByTestId('ink-active-stroke-canvas'), 72);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');

  await component.getByTestId('ink-tool-highlighter').click();
  await openSettings(page);
  expect(await page.getByTestId('ink-width-value').inputValue()).toBe(highlighterWidth);
  expect(await page.getByTestId('ink-custom-color').inputValue()).toBe(highlighterColor);
  expect(await page.getByTestId('ink-opacity').inputValue()).toBe(highlighterOpacity);
  expect(Number(await page.getByTestId('ink-width-value').inputValue())).toBe(16);
  await closeSettings(page);

  await drawHorizontalStroke(page, component.getByTestId('ink-active-stroke-canvas'), 110);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');

  const saved = await readFixturePage(page);
  const newStrokes = saved?.objects.filter((object) => object.content.kind === 'stroke' && object.id !== 'fixture-blue-stroke');
  expect(newStrokes).toHaveLength(2);
  const [penStroke, highlighterStroke] = newStrokes ?? [];
  expect(penStroke?.content).toMatchObject({ kind: 'stroke', style: { tool: 'pen', width: 4 } });
  expect(highlighterStroke?.content).toMatchObject({ kind: 'stroke', style: { tool: 'highlighter', width: 16 } });

  if (penStroke?.content.kind === 'stroke') {
    const [red, green, blue] = hexChannels(penStroke.content.style.color);
    expect(green).toBeGreaterThan(red + 80);
    expect(green).toBeGreaterThan(blue + 40);
  }
  if (highlighterStroke?.content.kind === 'stroke') {
    const color = highlighterStroke.content.style.color;
    expect(color).toMatch(/^#ff8800[\da-f]{2}$/i);
    // v1 has no opacity field, so the highlighter opacity must be encoded in the color alpha.
    expect(parseInt(color.slice(-2), 16)).not.toBe(0x80);
  }

  const penPixel = await canvasPixel(canvas, 48, 72);
  const highlighterPixel = await canvasPixel(canvas, 48, 110);
  expect(penPixel[1]).toBeGreaterThan(penPixel[0] + 80);
  expect(penPixel[1]).toBeGreaterThan(penPixel[2] + 40);
  expect(highlighterPixel[0]).toBeGreaterThan(200);
  expect(highlighterPixel[0]).toBeGreaterThan(highlighterPixel[2] + 40);
  expect(highlighterPixel[1]).toBeGreaterThan(highlighterPixel[2]);
});

test('one fast adjustable-size eraser sweep removes two strokes, and one undo restores both in order without erasing the background', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" imageBackground />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toBeVisible();

  await drawHorizontalStroke(page, input, 60);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
  await drawHorizontalStroke(page, input, 110);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');

  const beforeErase = await readFixturePage(page);
  const originalIds = beforeErase?.objects.map((object) => object.id) ?? [];
  expect(originalIds).toHaveLength(3);
  expect(await countDarkPixels(canvas, 56, 64)).toBeGreaterThan(10);
  expect(await countDarkPixels(canvas, 106, 114)).toBeGreaterThan(10);

  await component.getByTestId('ink-eraser-tool').click();
  await openSettings(page);
  expect(await page.getByTestId('ink-eraser-size').count()).toBe(1);
  let eraserSize = page.getByTestId('ink-eraser-size');

  // A diameter of 8 leaves a 4-unit radius; this path runs 25 units from both strokes.
  await fillNumeric(eraserSize, '8');
  expect(await eraserSize.inputValue()).toBe('8');
  await closeSettings(page);
  await sweep(page, input, { x: 20, y: 85 }, { x: 100, y: 85 });
  expect((await readFixturePage(page))?.objects.map((object) => object.id)).toEqual(originalIds);

  // A diameter of 64 gives a 32-unit radius, so the same fast sweep must collect both strokes.
  await openSettings(page);
  eraserSize = page.getByTestId('ink-eraser-size');
  await fillNumeric(eraserSize, '64');
  expect(await eraserSize.inputValue()).toBe('64');
  await closeSettings(page);
  await sweep(page, input, { x: 20, y: 85 }, { x: 100, y: 85 });
  await expect.poll(async () => (await readFixturePage(page))?.objects.map((object) => object.id)).toEqual(['fixture-blue-stroke']);
  await expect.poll(() => countDarkPixels(canvas, 56, 64)).toBe(0);
  await expect.poll(() => countDarkPixels(canvas, 106, 114)).toBe(0);
  // The image background is not an editable object and must survive the eraser.
  expect(await canvasPixel(canvas, 48, 85)).toEqual([255, 0, 0, 255]);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');

  await component.getByTestId('ink-undo').click();
  await expect.poll(async () => (await readFixturePage(page))?.objects.map((object) => object.id)).toEqual(originalIds);
  await expect.poll(() => countDarkPixels(canvas, 56, 64)).toBeGreaterThan(10);
  await expect.poll(() => countDarkPixels(canvas, 106, 114)).toBeGreaterThan(10);
  expect(await canvasPixel(canvas, 48, 85)).toEqual([255, 0, 0, 255]);
  await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
});

test('restores pen, highlighter, and eraser settings across an unmount/remount without restoring tool or eraser mode and saves a pen stroke with the restored style', async ({ mount, page }) => {
  const originalPreferences = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    INK_TOOL_PREFERENCES_STORAGE_KEY,
  );
  // Each test owns only the ink preference key; app-wide localStorage is left untouched.
  await page.evaluate((key) => window.localStorage.removeItem(key), INK_TOOL_PREFERENCES_STORAGE_KEY);

  try {
    const component = await mount(<InkEditorHarness saveMode="success" />);
    const canvas = component.getByTestId('ink-page-canvas');
    await expect(canvas).toBeVisible();

    // Pen: green, width 6.
    await openSettings(page);
    await page.getByTestId('ink-settings-color-green').click();
    await fillNumeric(page.getByTestId('ink-width-value'), '6');
    expect(await page.getByTestId('ink-settings-color-green').getAttribute('aria-pressed')).toBe('true');
    expect(Number(await page.getByTestId('ink-width-value').inputValue())).toBe(6);
    await closeSettings(page);

    // Highlighter: orange, width 18 (not the default 8), opacity 0.35.
    await component.getByTestId('ink-tool-highlighter').click();
    await openSettings(page);
    await page.getByTestId('ink-settings-color-orange').click();
    await fillNumeric(page.getByTestId('ink-width-value'), '18');
    await fillNumeric(page.getByTestId('ink-opacity'), '0.35');
    expect(await page.getByTestId('ink-settings-color-orange').getAttribute('aria-pressed')).toBe('true');
    expect(Number(await page.getByTestId('ink-width-value').inputValue())).toBe(18);
    expect(await page.getByTestId('ink-opacity').inputValue()).toBe('0.35');
    await closeSettings(page);

    // Eraser: size 32, explicitly selected before unmounting.
    await component.getByTestId('ink-eraser-tool').click();
    await openSettings(page);
    await page.getByTestId('ink-eraser-size-32').click();
    expect(await page.getByTestId('ink-eraser-size').inputValue()).toBe('32');
    await closeSettings(page);
    expect(await component.getByTestId('ink-eraser-tool').getAttribute('aria-pressed')).toBe('true');

    await component.getByTestId('ink-editor-unmount').click();
    await expect(component.getByTestId('ink-page-canvas')).toHaveCount(0);
    await component.getByTestId('ink-editor-remount').click();
    await expect(component.getByTestId('ink-page-canvas')).toBeVisible();

    // Tool selection and eraser mode are not preferences: a fresh mount starts on pen.
    expect(await component.getByTestId('ink-tool-pen').getAttribute('aria-pressed')).toBe('true');
    expect(await component.getByTestId('ink-eraser-tool').getAttribute('aria-pressed')).toBe('false');

    // Pen settings must come back with the mounted editor.
    await openSettings(page);
    expect(await page.getByTestId('ink-settings-color-green').getAttribute('aria-pressed')).toBe('true');
    expect(Number(await page.getByTestId('ink-width-value').inputValue())).toBe(6);
    await closeSettings(page);

    await component.getByTestId('ink-tool-highlighter').click();
    await openSettings(page);
    expect(await page.getByTestId('ink-settings-color-orange').getAttribute('aria-pressed')).toBe('true');
    expect(Number(await page.getByTestId('ink-width-value').inputValue())).toBe(18);
    expect(await page.getByTestId('ink-opacity').inputValue()).toBe('0.35');
    await closeSettings(page);

    await component.getByTestId('ink-eraser-tool').click();
    await openSettings(page);
    expect(await page.getByTestId('ink-eraser-size').inputValue()).toBe('32');
    await closeSettings(page);

    await component.getByTestId('ink-tool-pen').click();
    await openSettings(page);
    expect(await page.getByTestId('ink-settings-color-green').getAttribute('aria-pressed')).toBe('true');
    expect(Number(await page.getByTestId('ink-width-value').inputValue())).toBe(6);
    await closeSettings(page);

    // The restored pen settings must reach a real pointer stroke and its save.
    await drawHorizontalStroke(page, component.getByTestId('ink-active-stroke-canvas'), 72);
    await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');

    const saved = await readFixturePage(page);
    const newStrokes = saved?.objects.filter((object) => object.content.kind === 'stroke' && object.id !== 'fixture-blue-stroke');
    expect(newStrokes).toHaveLength(1);
    expect(newStrokes?.[0].content).toMatchObject({
      kind: 'stroke',
      style: { tool: 'pen', color: '#22c55e', width: 6 },
    });
  } finally {
    await page.evaluate(({ key, value }) => {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    }, { key: INK_TOOL_PREFERENCES_STORAGE_KEY, value: originalPreferences });
  }
});

test('keeps the IndexedDB journal and CAS save working when localStorage getItem/setItem throw', async ({ mount, page }) => {
  const originalPreferences = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    INK_TOOL_PREFERENCES_STORAGE_KEY,
  );
  // This test owns its snapshot/restore of the preference key instead of
  // relying on another test's cleanup having run.
  await page.evaluate((key) => window.localStorage.removeItem(key), INK_TOOL_PREFERENCES_STORAGE_KEY);

  try {
    // Only localStorage calls fail; sessionStorage and IndexedDB remain usable.
    await page.evaluate(() => {
      const prototype = Storage.prototype;
      const getItemDescriptor = Object.getOwnPropertyDescriptor(prototype, 'getItem');
      const setItemDescriptor = Object.getOwnPropertyDescriptor(prototype, 'setItem');
      if (!getItemDescriptor || !setItemDescriptor) throw new Error('Storage prototype methods are unavailable');
      const originalGetItem = getItemDescriptor.value as Storage['getItem'];
      const originalSetItem = setItemDescriptor.value as Storage['setItem'];
      (window as Window & { __INK_CT_STORAGE_RESTORE__?: () => void }).__INK_CT_STORAGE_RESTORE__ = () => {
        Object.defineProperty(prototype, 'getItem', getItemDescriptor);
        Object.defineProperty(prototype, 'setItem', setItemDescriptor);
        delete (window as Window & { __INK_CT_STORAGE_RESTORE__?: () => void }).__INK_CT_STORAGE_RESTORE__;
      };
      const targetsLocalStorage = (receiver: unknown) => {
        try {
          return receiver === window.localStorage;
        } catch {
          return false;
        }
      };
      Object.defineProperty(prototype, 'getItem', {
        ...getItemDescriptor,
        value(this: Storage, key: string) {
          if (targetsLocalStorage(this)) throw new Error('localStorage.getItem is blocked by the CT fixture');
          return originalGetItem.call(this, key);
        },
      });
      Object.defineProperty(prototype, 'setItem', {
        ...setItemDescriptor,
        value(this: Storage, key: string, value: string) {
          if (targetsLocalStorage(this)) throw new Error('localStorage.setItem is blocked by the CT fixture');
          return originalSetItem.call(this, key, value);
        },
      });
    });

    const blocked = await page.evaluate(() => {
      const thrownFor: string[] = [];
      try { window.localStorage.getItem('ink-ct-storage-probe'); } catch { thrownFor.push('getItem'); }
      try { window.localStorage.setItem('ink-ct-storage-probe', 'blocked'); } catch { thrownFor.push('setItem'); }
      return thrownFor;
    });
    expect(blocked).toEqual(['getItem', 'setItem']);

    const component = await mount(<InkEditorHarness saveMode="success" />);
    const canvas = component.getByTestId('ink-page-canvas');
    await expect(canvas).toBeVisible();

    await openSettings(page);
    await page.getByTestId('ink-settings-color-green').click();
    await fillNumeric(page.getByTestId('ink-width-value'), '6');
    await closeSettings(page);
    await drawHorizontalStroke(page, component.getByTestId('ink-active-stroke-canvas'), 72);
    await expect(component.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');

    const saved = await readFixturePage(page);
    const newStrokes = saved?.objects.filter((object) => object.content.kind === 'stroke' && object.id !== 'fixture-blue-stroke');
    expect(newStrokes).toHaveLength(1);
    expect(newStrokes?.[0].content).toMatchObject({
      kind: 'stroke',
      style: { tool: 'pen', color: '#22c55e', width: 6 },
    });

    // The fixture only advances when the save carries the expected CAS revision.
    const revision = await page.evaluate(() => {
      const backend = (window as Window & {
        __INK_EDITOR_CT_BACKEND__?: { readManifest(): { revision: string } };
      }).__INK_EDITOR_CT_BACKEND__;
      return backend?.readManifest().revision;
    });
    expect(revision).toBe('revision-2');
  } finally {
    await page.evaluate(() => {
      (window as Window & { __INK_CT_STORAGE_RESTORE__?: () => void }).__INK_CT_STORAGE_RESTORE__?.();
    });
    await page.evaluate(({ key, value }) => {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    }, { key: INK_TOOL_PREFERENCES_STORAGE_KEY, value: originalPreferences });
  }
});

test('keeps style settings collapsed until ink-tool-settings opens an accessible popover with 44px palette targets and no horizontal overflow', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  await expect(component.getByTestId('ink-page-canvas')).toBeVisible();
  expect(await component.getByTestId('ink-tool-settings').count()).toBe(1);

  const panel = await openSettings(page);
  await expectAccessibleSettingsPanel(panel);
  await expectPaletteTargetsAndNoHorizontalOverflow(page, panel);
});

test('opens the same ink-tool-settings entry as a bottom sheet at 390px with 44px palette targets and no horizontal overflow', async ({ mount, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  const component = await mount(<InkEditorHarness saveMode="success" />);
  await expect(component.getByTestId('ink-page-canvas')).toBeVisible();
  expect(await component.getByTestId('ink-tool-settings').count()).toBe(1);

  const panel = await openSettings(page);
  await expectAccessibleSettingsPanel(panel);

  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await expect.poll(async () => {
    const box = await panel.boundingBox();
    if (!box) return false;
    const bottomGap = viewport.height - (box.y + box.height);
    return box.width >= viewport.width * 0.9 && bottomGap >= -1 && bottomGap <= 16;
  }).toBe(true);
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(viewport.width * 0.9);
  const finalBottomGap = viewport.height - ((box?.y ?? 0) + (box?.height ?? viewport.height));
  expect(finalBottomGap).toBeGreaterThanOrEqual(-1);
  expect(finalBottomGap).toBeLessThanOrEqual(16);

  await expectPaletteTargetsAndNoHorizontalOverflow(page, panel);
});

test('shows an eraser cursor on canvas hover whose diameter follows eraserSize * zoom and hides it on leave', async ({ mount, page }) => {
  const component = await mount(<InkEditorHarness saveMode="success" />);
  const canvas = component.getByTestId('ink-page-canvas');
  const input = component.getByTestId('ink-active-stroke-canvas');
  await expect(canvas).toBeVisible();

  await component.getByTestId('ink-eraser-tool').click();
  await openSettings(page);
  await fillNumeric(page.getByTestId('ink-eraser-size'), '32');
  await closeSettings(page);

  const cursor = page.getByTestId('ink-eraser-cursor');
  await expect(cursor).not.toBeVisible();

  await input.hover();
  await expect(cursor).toBeVisible();
  await expect.poll(async () => {
    const box = await cursor.boundingBox();
    return box ? Math.abs(box.width - 32) <= 2 && Math.abs(box.height - 32) <= 2 : false;
  }).toBe(true);
  const zoom1 = await cursor.boundingBox();
  expect(zoom1).not.toBeNull();
  expect(Math.abs((zoom1?.width ?? 0) - 32)).toBeLessThanOrEqual(2);
  expect(Math.abs((zoom1?.height ?? 0) - 32)).toBeLessThanOrEqual(2);

  await component.getByTestId('ink-zoom-in').click();
  await page.mouse.move(2, 2);
  await input.hover();
  await expect(cursor).toBeVisible();
  await expect.poll(async () => {
    const box = await cursor.boundingBox();
    return box ? Math.abs(box.width - 40) <= 2 && Math.abs(box.height - 40) <= 2 : false;
  }).toBe(true);
  const zoom125 = await cursor.boundingBox();
  expect(zoom125).not.toBeNull();
  expect(Math.abs((zoom125?.width ?? 0) - 40)).toBeLessThanOrEqual(2);
  expect(Math.abs((zoom125?.height ?? 0) - 40)).toBeLessThanOrEqual(2);
  expect((zoom125?.width ?? 0) / (zoom1?.width ?? 1)).toBeCloseTo(1.25, 1);

  await page.mouse.move(2, 2);
  await expect(cursor).not.toBeVisible();
});
