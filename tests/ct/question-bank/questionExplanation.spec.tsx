import React from 'react';
import { test, expect } from '@playwright/experimental-ct-react';
import { QuestionExplanationHarness } from './QuestionExplanationHarness';

for (const width of [390, 1280]) {
  test(`persisted explanation opens without answering at ${width}px`, async ({ mount, page }) => {
    await page.setViewportSize({ width, height: 850 });
    const component = await mount(<QuestionExplanationHarness />);
    await expect(component.getByText('方向与加速度一致。')).toHaveCount(0);
    await component.getByRole('button', { name: '查看解析' }).click();
    await expect(component.getByText('方向与加速度一致。')).toBeVisible();
    await expect(component.locator('.katex')).toBeVisible();
    await expect(component.getByRole('button', { name: '提交答案' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/deepstudent-explanation-${width}.png` });
  });
}
