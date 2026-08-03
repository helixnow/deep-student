import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import { MarkdownTypographyFixture } from './MarkdownTypographyFixture';

async function setTheme(page: { evaluate: (fn: () => void) => Promise<unknown> }, dark: boolean) {
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  if (dark) {
    await page.evaluate(() => document.documentElement.classList.add('dark'));
  }
}

async function assertTypographyContract(component: any) {
  const styles = await component.locator('[data-sample="paragraph"]').first().evaluate((paragraph: HTMLElement) => {
    const readTypography = (element: Element | null) => {
      if (!element) return null;
      const computed = getComputedStyle(element);
      return {
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
      };
    };
    const root = paragraph.closest('.markdown-content');
    const strong = paragraph.querySelector('strong');
    const heading = root?.querySelector('h2');
    const listItem = root?.querySelector('li');
    const userParagraph = document.querySelector('[data-sample="user-paragraph"]');
    const status = document.querySelector('[data-sample="reconnect"]');
    const failure = document.querySelector('[data-sample="failure"]');
    const compact = root?.querySelector('[data-sample="code-block"] code');
    const timeline = root?.querySelector('.activity-timeline');
    const thinkingDetail = document.querySelector('[data-sample="thinking-detail"]');
    const toolDetail = document.querySelector('[data-sample="tool-detail"]');

    return {
      paragraph: readTypography(paragraph),
      strong: readTypography(strong),
      heading: readTypography(heading),
      listItem: readTypography(listItem),
      userParagraph: readTypography(userParagraph),
      status: readTypography(status),
      failure: readTypography(failure),
      compact: readTypography(compact),
      timeline: readTypography(timeline),
      thinkingDetail: readTypography(thinkingDetail),
      toolDetail: readTypography(toolDetail),
    };
  });

  expect(styles.paragraph?.fontSize).toBe('16px');
  expect(styles.paragraph?.fontWeight).toBe('400');
  expect(styles.strong?.fontSize).toBe('16px');
  expect(styles.strong?.fontWeight).toBe('600');
  expect(styles.heading?.fontWeight).toBe('600');
  expect(styles.listItem?.fontSize).toBe('16px');
  expect(styles.listItem?.fontWeight).toBe('400');
  expect(styles.userParagraph?.fontSize).toBe('16px');
  expect(styles.userParagraph?.fontWeight).toBe('400');
  expect(styles.status?.fontSize).toBe('16px');
  expect(styles.status?.fontWeight).toBe('400');
  expect(styles.failure?.fontSize).toBe('16px');
  expect(styles.failure?.fontWeight).toBe('400');
  expect(Number.parseFloat(styles.compact?.fontSize ?? '999')).toBeLessThan(16);
  expect(styles.timeline?.fontSize).toBe('16px');
  expect(styles.timeline?.fontWeight).toBe('400');
  expect(styles.thinkingDetail?.fontSize).toBe('16px');
  expect(styles.thinkingDetail?.fontWeight).toBe('400');
  expect(Number.parseFloat(styles.toolDetail?.fontSize ?? '999')).toBeLessThan(16);
}

for (const mode of [
  { name: 'desktop-light', width: 1100, height: 1200, dark: false },
  { name: 'desktop-dark', width: 1100, height: 1200, dark: true },
  { name: 'mobile-light', width: 390, height: 1500, dark: false },
  { name: 'mobile-dark', width: 390, height: 1500, dark: true },
]) {
  test(`chat typography visual baseline: ${mode.name}`, async ({ mount, page }) => {
    await page.setViewportSize({ width: mode.width, height: mode.height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setTheme(page, mode.dark);

    const component = await mount(<MarkdownTypographyFixture />);
    await assertTypographyContract(component);
    await expect(component).toHaveScreenshot(`chat-typography-${mode.name}.png`, {
      animations: 'disabled',
      caret: 'hide',
    });
  });
}
