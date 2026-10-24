import React from 'react';
import { test, expect } from '@playwright/experimental-ct-react';
import { SourceViewerHarness } from './managementHarness';

const VIEWPORT_HEIGHT = 900;
const BBOX = { left: 0.08, top: 0.12, right: 0.62, bottom: 0.34 };

function near(actual: number, expected: number, tolerance = 2) {
  return Math.abs(actual - expected) <= tolerance;
}

for (const width of [390, 1280]) {
  test(`source viewer renders a real raster page and the question bbox at ${width}px`, async ({
    mount,
    page,
  }) => {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
    });

    await mount(<SourceViewerHarness />);

    const viewer = page.getByTestId('question-source-viewer');
    await expect(viewer).toBeVisible();
    await expect(viewer).toHaveAttribute(
      'data-source-viewer-layout',
      width < 768 ? 'mobile' : 'desktop',
    );
    await expect(page.getByRole('dialog', { name: '原题来源' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '原题来源' })).toBeVisible();

    const canvas = page.getByTestId('source-page-canvas');
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveAttribute('data-page-width', '900');
    await expect(canvas).toHaveAttribute('data-page-height', '1200');

    const image = canvas.locator('img');
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect
      .poll(async () => image.evaluate((element) => {
        const img = element as HTMLImageElement;
        return img.complete && img.naturalWidth > 0 ? img.naturalWidth : 0;
      }))
      .toBe(900);
    expect(
      await image.evaluate((element) => (element as HTMLImageElement).naturalHeight),
    ).toBe(1200);

    await expect(page.getByText('fixture-midterm.pdf').first()).toBeVisible();
    await expect(page.getByText('第 2 页').first()).toBeVisible();
    await expect(page.getByText('共 3 页')).toBeVisible();
    await expect(page.getByText('/fixtures/fixture-midterm.pdf')).toBeVisible();
    await expect(page.getByText('第 2 页文字层：用于验证原题来源页面与定位框的稳定渲染。')).toBeVisible();

    // Wait for the spring animation to settle before measuring geometry.
    await expect
      .poll(async () => page.getByRole('dialog', { name: '原题来源' }).evaluate(
        (element) => getComputedStyle(element).transform,
      ))
      .toBe('none');

    const bbox = page.getByTestId('source-page-bbox');
    await expect(bbox).toBeVisible();
    await expect(bbox).toHaveAttribute('aria-label', '题目定位区域');

    const imageBox = await image.boundingBox();
    const bboxBox = await bbox.boundingBox();
    expect(imageBox).not.toBeNull();
    expect(bboxBox).not.toBeNull();
    expect(near(bboxBox!.x, imageBox!.x + BBOX.left * imageBox!.width)).toBe(true);
    expect(near(bboxBox!.y, imageBox!.y + BBOX.top * imageBox!.height)).toBe(true);
    expect(
      near(bboxBox!.x + bboxBox!.width, imageBox!.x + BBOX.right * imageBox!.width),
    ).toBe(true);
    expect(
      near(bboxBox!.y + bboxBox!.height, imageBox!.y + BBOX.bottom * imageBox!.height),
    ).toBe(true);

    for (const [name, label] of [
      ['previous page', '上一页'],
      ['next page', '下一页'],
      ['previous ref', '上一条来源'],
      ['next ref', '下一条来源'],
    ] as const) {
      const button = page.getByRole('button', { name: label });
      await expect(button, name).toBeVisible();
      const box = await button.boundingBox();
      expect(box, name).not.toBeNull();
      expect(box!.x, name).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, name).toBeLessThanOrEqual(width);
      expect(box!.y, name).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height, name).toBeLessThanOrEqual(VIEWPORT_HEIGHT);
    }

    const dialogBox = await page.getByRole('dialog', { name: '原题来源' }).boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(width + 1);
    expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(VIEWPORT_HEIGHT + 1);

    const noHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    expect(noHorizontalOverflow).toBe(true);

    await page.screenshot({ path: `/tmp/deepstudent-import-fix-source-${width}.png` });
  });
}
