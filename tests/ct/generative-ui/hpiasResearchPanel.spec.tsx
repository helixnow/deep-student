/**
 * Playwright CT — Generative UI smoke（14 块 + HPIAS 时间线契约）
 */
import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { buildAllBlocksIntent } from '@/features/generative-ui/demo/allBlocksFixture';
import { buildStyleLabHpiasDemoTimeline } from '@/features/generative-ui/demo/styleLabHpiasDemo';
import { HPIAS_REQUIRED_LIFECYCLE_TYPES } from '@/features/generative-ui/contracts/hpiasLifecycleContract';
import '@/features/generative-ui/blocks';

test('renders all-blocks generative UI intent smoke', async ({ mount }) => {
  const component = await mount(
    <div style={{ width: 960, padding: 16 }}>
      <GenerativeUIRenderer intent={buildAllBlocksIntent()} showChrome={false} />
    </div>,
  );

  await expect(component.getByText('指标')).toBeVisible();
  await expect(component.getByText('正文内容')).toBeVisible();
});

test('hpias style lab timeline covers required lifecycle types', () => {
  const types = buildStyleLabHpiasDemoTimeline().map((e) => e.type);
  for (const required of HPIAS_REQUIRED_LIFECYCLE_TYPES) {
    expect(types, `missing ${required}`).toContain(required);
  }
});
