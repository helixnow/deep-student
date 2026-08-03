import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import { BlankedText } from '@/features/mindmap/components/shared/BlankedText';

test('allows dragging across recite text to create a native selection', async ({ mount, page }) => {
  const component = await mount(
    <div className="mindmap-container" style={{ padding: 40, fontSize: 24 }}>
      <BlankedText text="中心主题" reciteMode onAddBlank={() => undefined} />
    </div>,
  );
  const segment = component.locator('.mm-blankable-text-segment');

  await expect(segment).toHaveCSS('user-select', 'text');
  const box = await segment.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toContain('中心主题');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(page.getByRole('button', { name: 'recite.blank' })).toBeVisible();
});
