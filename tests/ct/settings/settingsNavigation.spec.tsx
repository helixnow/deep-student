import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import { SettingsNavigationHarness } from './SettingsNavigationHarness';

test('desktop categories and section tabs share the real settings route', async ({ mount, page }, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const component = await mount(<SettingsNavigationHarness />);
  const categories = component.locator('[data-settings-category-list]');
  await expect(categories.getByRole('button')).toHaveCount(6);
  await expect(component.getByRole('tab', { name: '模型分配' })).toBeVisible();
  await component.getByRole('tab', { name: '参数调整' }).click();
  await expect(component.locator('[data-wb-settings-active-tab]')).toHaveAttribute('data-wb-settings-active-tab', 'params');
  await expect(component.getByRole('tabpanel')).toBeVisible();
  await expect(component.getByText('聊天流式参数', { exact: true })).toBeVisible();
  await expect(component.getByRole('spinbutton')).toHaveValue('120');
  await expect(categories.getByRole('button', { name: '模型与 AI' })).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: testInfo.outputPath('settings-desktop.png'), animations: 'disabled' });
  await categories.getByRole('button', { name: '应用体验' }).click();
  await component.getByRole('tab', { name: '外观', exact: true }).click();
  await expect(component.locator('[data-wb-settings-active-tab]')).toHaveAttribute('data-wb-settings-active-tab', 'appearance');
  await expect(component.getByRole('tabpanel')).toBeVisible();
});

test('narrow settings starts with six categories and opens a section directly', async ({ mount, page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const component = await mount(<SettingsNavigationHarness mobile />);
  await expect(component.locator('[data-settings-category-list]').getByRole('button')).toHaveCount(6);
  await page.screenshot({ path: testInfo.outputPath('settings-mobile.png'), animations: 'disabled' });
  await component.getByRole('button', { name: '模型与 AI', exact: true }).click();
  await component.getByRole('tab', { name: '参数调整' }).click();
  await expect(component.locator('[data-wb-settings-active-tab]')).toHaveAttribute('data-wb-settings-active-tab', 'params');
  await expect(component.getByRole('tabpanel')).toBeVisible();
  await expect(component.getByText('聊天流式参数', { exact: true })).toBeVisible();
  await expect(component.getByRole('spinbutton')).toHaveValue('120');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('settings-mobile-detail.png'), animations: 'disabled' });
});
