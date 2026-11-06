import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { MountResult } from '@playwright/experimental-ct-react';
import type { Page } from '@playwright/test';
import { OfficeHarness } from './OfficeHarness';
import { DOCX_MARKER_COLORS, OFFICE_FIXTURE_MAX_ENTRY_BYTES, OFFICE_FIXTURE_MAX_TOTAL_BYTES, PPTX_MARKER_COLORS, PPTX_SECOND_MARKER_COLORS } from './fixtures';
import { convertOfficePages } from '@/features/ink/prepare/office';

type OfficeResult = Awaited<ReturnType<typeof convertOfficePages>>;

declare global {
  interface Window {
    __INK_OFFICE_CT_RESULT__?: OfficeResult;
    __INK_OFFICE_CT_CHART_READY__?: boolean;
    __INK_OFFICE_CT_FIXTURE_BYTES__?: number;
  }
}

async function inspectRenderedPages(page: Page, colors: readonly string[], checkWholePage = false) {
  return page.evaluate(async ({ expectedColors, checkWholePage }) => {
    const result = window.__INK_OFFICE_CT_RESULT__;
    if (!result) throw new Error('Converter returned no result');
    const expected = expectedColors.map((hex) => {
      const value = hex.slice(1);
      return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
    });
    return Promise.all(result.pages.map(async ({ png, width, height }) => {
      const bytes = new Uint8Array(await png.slice(0, 8).arrayBuffer());
      const bitmap = await createImageBitmap(png);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas unavailable while inspecting rendered page');
      context.drawImage(bitmap, 0, 0);
      const imageWidth = bitmap.width;
      const imageHeight = bitmap.height;
      bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const markerTops: number[] = [];
      const markers = expected.map(([r, g, b]) => {
        let count = 0;
        let firstY = -1;
        const startY = checkWholePage ? 0 : Math.floor(canvas.height * 0.7);
        for (let y = startY; y < canvas.height; y += 1) {
          for (let x = 0; x < canvas.width; x += 1) {
            const offset = (y * canvas.width + x) * 4;
            if (Math.abs(pixels[offset] - r) < 8 && Math.abs(pixels[offset + 1] - g) < 8 && Math.abs(pixels[offset + 2] - b) < 8 && pixels[offset + 3] > 240) {
              count += 1;
              if (firstY < 0) firstY = y;
            }
          }
        }
        markerTops.push(firstY);
        return count;
      });
      return {
        signature: Array.from(bytes),
        width,
        height,
        imageWidth,
        imageHeight,
        markers,
        markerTops,
        lowerRegionNonWhitePixels: (() => {
          let count = 0;
          for (let y = checkWholePage ? 0 : Math.floor(canvas.height * 0.7); y < canvas.height; y += 1) {
            for (let x = 0; x < canvas.width; x += 1) {
              const offset = (y * canvas.width + x) * 4;
              if (pixels[offset] < 245 || pixels[offset + 1] < 245 || pixels[offset + 2] < 245) count += 1;
            }
          }
          return count;
        })(),
      };
    }));
  }, { expectedColors: colors, checkWholePage });
}

async function runOfficeComponent(component: MountResult) {
  await component.getByRole('button', { name: 'ready' }).click();
  await expect(component.getByRole('button')).toHaveText(/^(done|failed:)/, { timeout: 60000 });
}

async function expectTwoRenderedPages(component: MountResult, page: Page, colors: readonly string[], aspect: readonly [number, number]) {
  await runOfficeComponent(component);
  await expect(component.getByRole('button')).toHaveText('done');
  const metrics = await inspectRenderedPages(page, colors);
  expect(metrics).toHaveLength(2);
  for (let index = 0; index < metrics.length; index += 1) {
    const rendered = metrics[index];
    expect(rendered.signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(rendered.width).toBeGreaterThan(0);
    expect(rendered.height).toBeGreaterThan(0);
    expect(rendered.imageWidth).toBe(rendered.width);
    expect(rendered.imageHeight).toBe(rendered.height);
    expect(rendered.width / rendered.height).toBeGreaterThan(aspect[0]);
    expect(rendered.width / rendered.height).toBeLessThan(aspect[1]);
    expect(rendered.markers[index]).toBeGreaterThan(0);
    expect(rendered.markers[1 - index]).toBe(0);
    expect(rendered.lowerRegionNonWhitePixels).toBeGreaterThan(0);
  }
}

test('converts the two-page DOCX into ordered full-page PNGs with bottom markers', async ({ mount, page }) => {
  test.setTimeout(90000);
  const component = await mount(<OfficeHarness format="docx" />);
  await expectTwoRenderedPages(component, page, DOCX_MARKER_COLORS, [0.62, 0.82]);
});

test('converts the two-slide PPTX into ordered full-slide PNGs with bottom markers', async ({ mount, page }) => {
  test.setTimeout(90000);
  const component = await mount(<OfficeHarness format="pptx" />);
  await expectTwoRenderedPages(component, page, PPTX_MARKER_COLORS, [1.7, 1.9]);
});

test('rejects conversion when max_pages is lower than the complete PPTX slide count', async ({ mount }) => {
  const component = await mount(<OfficeHarness format="pptx" maxPages={1} />);
  await runOfficeComponent(component);
  await expect(component.getByRole('button')).toContainText('LIMIT_EXCEEDED');
});

test('rejects malformed, legacy and encrypted containers explicitly', async ({ mount }) => {
  for (const refusal of ['malformed', 'legacy', 'encrypted'] as const) {
    const component = await mount(<OfficeHarness format="docx" refusal={refusal} />);
    await runOfficeComponent(component);
    await expect(component.getByRole('button')).toContainText('UNSUPPORTED_FORMAT');
    await component.unmount();
  }
});

test('cancels before parsing and leaves no staging host', async ({ mount, page }) => {
  const component = await mount(<OfficeHarness format="docx" abortBeforeConvert />);
  await runOfficeComponent(component);
  await expect(component.getByRole('button')).toContainText('CANCELLED');
  expect(await page.locator('.ink-office-docx, .ink-office-pptx').count()).toBe(0);
});

test('cancels during PPTX rendering and removes staging DOM and image URLs', async ({ mount, page }) => {
  const component = await mount(<OfficeHarness format="pptx" abortOnSelector=".pptx-preview-slide-wrapper img" />);
  await runOfficeComponent(component);
  await expect(component.getByRole('button')).toContainText('CANCELLED');
  const cleanup = await page.evaluate(() => ({
    hosts: document.querySelectorAll('.ink-office-docx, .ink-office-pptx, .ink-office-slide-capture').length,
    images: document.querySelectorAll('.ink-office-pptx img').length,
  }));
  expect(cleanup).toEqual({ hosts: 0, images: 0 });
});

test('refuses an external PPTX image without requesting it', async ({ mount, page }) => {
  const requests: string[] = [];
  const listener = (request: { url(): string }) => {
    if (request.url().includes('example.invalid')) requests.push(request.url());
  };
  page.on('request', listener);
  try {
    const component = await mount(<OfficeHarness format="pptx" options={{ externalImage: true }} />);
    await runOfficeComponent(component);
    await expect(component.getByRole('button')).toContainText('CONVERSION_FAILED');
    expect(requests).toEqual([]);
  } finally {
    page.off('request', listener);
  }
});

test('uses both slide image relationships in OOXML pic order', async ({ mount, page }) => {
  const component = await mount(<OfficeHarness format="pptx" options={{ includeSecondImage: true }} />);
  await runOfficeComponent(component);
  await expect(component.getByRole('button')).toHaveText('done');
  const metrics = await inspectRenderedPages(page, [...PPTX_MARKER_COLORS, ...PPTX_SECOND_MARKER_COLORS], true);
  expect(metrics).toHaveLength(2);
  for (const slide of metrics) {
    const index = metrics.indexOf(slide);
    expect(slide.markers[index]).toBeGreaterThan(0);
    expect(slide.markers[1 - index]).toBe(0);
    expect(slide.markers[index + 2]).toBeGreaterThan(0);
    expect(slide.markers[3 - index]).toBe(0);
    expect(slide.markerTops[index + 2]).toBeGreaterThan(slide.markerTops[index]);
  }
});

test('waits for an actual PPTX chart SVG before capture', async ({ mount, page }) => {
  const component = await mount(<OfficeHarness format="pptx" options={{ includeChart: true }} />);
  await runOfficeComponent(component);
  await expect(component.getByRole('button')).toHaveText('done');
  const result = await page.evaluate(() => ({
    pageCount: window.__INK_OFFICE_CT_RESULT__?.pages.length ?? 0,
    pngs: (window.__INK_OFFICE_CT_RESULT__?.pages ?? []).map((item) => item.png.type),
    svgReady: window.__INK_OFFICE_CT_CHART_READY__ === true,
  }));
  expect(result).toEqual({ pageCount: 2, pngs: ['image/png', 'image/png'], svgReady: true });
});

test('rejects ZIP entry-count and declared uncompressed-size budgets before rendering', async ({ mount, page }) => {
  test.setTimeout(90000);
  const scenarios = [
    { kind: 'entry-count', fixtureByteLimit: 5 * 1024 * 1024 },
    { kind: 'entry-size', fixtureByteLimit: OFFICE_FIXTURE_MAX_ENTRY_BYTES },
    { kind: 'total-size', fixtureByteLimit: OFFICE_FIXTURE_MAX_TOTAL_BYTES },
  ] as const;
  for (const { kind, fixtureByteLimit } of scenarios) {
    const component = await mount(<OfficeHarness format="docx" budgetFixture={kind} />);
    await runOfficeComponent(component);
    await expect(component.getByRole('button')).toContainText('LIMIT_EXCEEDED');
    const cleanup = await page.evaluate(() => ({
      fixtureBytes: window.__INK_OFFICE_CT_FIXTURE_BYTES__ ?? Number.POSITIVE_INFINITY,
      hosts: document.querySelectorAll('.ink-office-docx, .ink-office-pptx').length,
    }));
    expect(cleanup.fixtureBytes).toBeLessThan(fixtureByteLimit);
    expect(cleanup.hosts).toBe(0);
    await component.unmount();
  }
});
