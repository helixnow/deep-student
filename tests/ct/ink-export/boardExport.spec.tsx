import { expect, test, type ComponentFixtures } from '@playwright/experimental-ct-react';
import { BoardExportHarness } from './BoardExportHarness';

type Mode = 'png' | 'pdf' | 'cancel';

async function startExport(mount: ComponentFixtures['mount'], mode: Mode) {
  const component = await mount(<BoardExportHarness mode={mode} />);
  const status = component.getByTestId('ink-board-export-status');
  await expect.poll(() => status.textContent(), { timeout: 60000 }).toMatch(/^(done|error: .+)$/);
  expect(await status.textContent()).toBe('done');
  const artifact = component.getByTestId('ink-board-export-artifact');
  const href = await artifact.getAttribute('href');
  if (!href) throw new Error('Board export artifact URL was not published');
  const bytes = await component.evaluate(async (_element, url) => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())), href);
  return { component, bytes: Buffer.from(bytes) };
}

async function imagePixel(component: Awaited<ReturnType<typeof startExport>>['component'], x: number, y: number) {
  return component.getByTestId('ink-board-export-image').evaluate((image, point) => {
    const canvas = document.createElement('canvas');
    canvas.width = (image as HTMLImageElement).naturalWidth;
    canvas.height = (image as HTMLImageElement).naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    context.drawImage(image as HTMLImageElement, 0, 0);
    return Array.from(context.getImageData(point.x, point.y, 1, 1).data);
  }, { x, y });
}

test('exports a real board PNG frame with explicit world-region pixels', async ({ mount }) => {
  const { component, bytes } = await startExport(mount, 'png');
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  await expect(component.getByTestId('ink-board-export-source-unchanged')).toHaveText('true');
  const image = component.getByTestId('ink-board-export-image');
  await expect(image).toHaveJSProperty('naturalWidth', 120);
  await expect(image).toHaveJSProperty('naturalHeight', 160);
  expect(await imagePixel(component, 20, 15)).toEqual([255, 0, 0, 255]);
  expect(await imagePixel(component, 80, 100)).toEqual([255, 255, 255, 255]);
});

test('exports a real paginated board PDF in row-major page order', async ({ mount }) => {
  const { component, bytes } = await startExport(mount, 'pdf');
  expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  await expect(component.getByTestId('ink-board-export-source-unchanged')).toHaveText('true');
  await expect(component.getByTestId('ink-board-export-pdf-page-count')).toHaveText('2');
  const pages = [
    component.getByTestId('ink-board-export-pdf-page-1'),
    component.getByTestId('ink-board-export-pdf-page-2'),
  ];
  await expect(pages[0]).toBeVisible();
  await expect(pages[1]).toBeVisible();
  expect(Number(await pages[0].getAttribute('data-page-ratio'))).toBeCloseTo(25 / 15, 4);
  expect(Number(await pages[1].getAttribute('data-page-ratio'))).toBeCloseTo(25 / 15, 4);
  const colors = await Promise.all(pages.map((canvas) => canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    const pixels = context.getImageData(0, 0, (element as HTMLCanvasElement).width, (element as HTMLCanvasElement).height).data;
    let red = 0;
    let blue = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 180 && pixels[index + 1] < 80 && pixels[index + 2] < 80) red += 1;
      if (pixels[index] < 80 && pixels[index + 1] < 80 && pixels[index + 2] > 150) blue += 1;
    }
    return { red, blue };
  })));
  expect(colors[0].red).toBeGreaterThan(20);
  expect(colors[0].blue).toBe(0);
  expect(colors[1].blue).toBeGreaterThan(20);
  expect(colors[1].red).toBe(0);
});

test('cancels real board PDF rendering without publishing an artifact or staged output', async ({ mount }) => {
  const component = await mount(<BoardExportHarness mode="cancel" />);
  await expect(component.getByTestId('ink-board-export-status')).toHaveText('cancelled');
  await expect(component.getByTestId('ink-board-export-source-unchanged')).toHaveText('true');
  await expect(component.getByTestId('ink-board-export-artifact')).toHaveCount(0);
  await expect(component.getByTestId('ink-board-export-pdf-page-1')).toHaveCount(0);
  await expect(component.getByTestId('ink-board-export-pdf-page-count')).toHaveText('0');
});
