import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import UnifiedSourcePanel from '@/features/chat/components/panels/UnifiedSourcePanel';
import type { UnifiedSourceBundle } from '@/features/chat/components/panels/sourceTypes';

function makeWebSearchBundle(count: number): UnifiedSourceBundle {
  const items = Array.from({ length: count }).map((_, i) => ({
    id: `ws-${i + 1}`,
    title: `搜索结果标题 ${i + 1} — Date Calculator: Add to or Subtract From a Date`,
    snippet:
      `这是第 ${i + 1} 条搜索结果的摘要内容。Find a specific business date and calculate the ` +
      'working days in a given period. The Date Calculator adds or subtracts days, weeks, months.',
    score: Math.max(0.2, 1 - i * 0.07),
    link: `https://example${i % 4}.com/result/${i + 1}`,
    origin: 'web_search',
    providerId: 'external-search',
    providerLabel: '外部搜索',
    citationType: 'web_search' as const,
    typeIndex: i + 1,
    raw: {
      document_id: `doc-${i}`,
      file_name: '',
      chunk_text: '',
      score: 1 - i * 0.07,
      chunk_index: 0,
    },
  }));
  return {
    total: count,
    groups: [
      {
        group: 'web_search',
        providerId: 'external-search',
        providerLabel: '外部搜索',
        count,
        items,
      },
    ],
  };
}

async function waitForCardsSettled(page: any) {
  await page.waitForFunction(() => {
    const cards = Array.from(document.querySelectorAll('.usp-item-card'));
    return cards.length > 0 && cards.every((el) => getComputedStyle(el).opacity === '1');
  });
}

async function mountPanel(mount: any, page: any, width: number) {
  const component = await mount(
    <div className="chat-v2" data-theme="light" style={{ width, padding: 16, background: 'hsl(var(--background))' }}>
      <UnifiedSourcePanel data={makeWebSearchBundle(12)} messageId="msg-1" />
    </div>
  );
  // 打开面板 → 切到展开网格
  await component.getByTestId('btn-toggle-source-panel').click();
  await component.locator('.usp-expand-btn').click();
  await component.locator('.usp-grid').waitFor();
  // 等待入场动画结束
  await waitForCardsSettled(page);
  return component;
}

test('expanded grid renders 3 columns on wide panels', async ({ mount, page }) => {
  const component = await mountPanel(mount, page, 860);
  const grid = component.locator('.usp-grid');
  const columns = await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(3);

  const cards = component.locator('.usp-grid .usp-item-card');
  expect(await cards.count()).toBe(12);

  await page.screenshot({ path: '/tmp/usp-grid-wide.png', fullPage: true });
});

test('expanded grid renders 2 columns on medium panels', async ({ mount, page }) => {
  const component = await mountPanel(mount, page, 540);
  const grid = component.locator('.usp-grid');
  const columns = await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(2);

  await page.screenshot({ path: '/tmp/usp-grid-medium.png', fullPage: true });
});

test('collapsed carousel lays out cards horizontally', async ({ mount, page }) => {
  const component = await mount(
    <div className="chat-v2" data-theme="light" style={{ width: 860, padding: 16, background: 'hsl(var(--background))' }}>
      <UnifiedSourcePanel data={makeWebSearchBundle(12)} messageId="msg-1" />
    </div>
  );
  await component.getByTestId('btn-toggle-source-panel').click();
  const carousel = component.locator('.usp-carousel');
  await carousel.waitFor();
  await waitForCardsSettled(page);

  const display = await carousel.evaluate((el) => getComputedStyle(el).display);
  expect(display).toBe('flex');

  // 卡片应横向排布：前两张卡 top 相同、left 递增
  const boxes = await component
    .locator('.usp-carousel .usp-item-card')
    .evaluateAll((els) => els.slice(0, 2).map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left };
    }));
  expect(boxes[0].top).toBe(boxes[1].top);
  expect(boxes[1].left).toBeGreaterThan(boxes[0].left);

  await page.screenshot({ path: '/tmp/usp-carousel.png', fullPage: true });
});

test('inline detail opens when a card is clicked', async ({ mount, page }) => {
  const component = await mountPanel(mount, page, 860);
  await component.locator('.usp-grid .usp-item-card').first().click();
  const detail = component.locator('.usp-inline-detail');
  await detail.waitFor();
  await page.waitForFunction(() => {
    const el = document.querySelector('.usp-inline-detail');
    return el != null && getComputedStyle(el).opacity === '1';
  });
  await page.screenshot({ path: '/tmp/usp-detail.png', fullPage: true });
});
