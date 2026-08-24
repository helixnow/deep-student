/**
 * Playwright CT — Generative UI smoke（18 块 + HPIAS 时间线契约 + v1.1 layout）
 */
import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import {
  ALL_BLOCK_TYPES,
  ALL_BLOCKS_MINIMAL_PROPS,
  buildAllBlocksIntent,
} from '@/features/generative-ui/demo/allBlocksFixture';
import { buildStyleLabHpiasDemoTimeline } from '@/features/generative-ui/demo/styleLabHpiasDemo';
import { HPIAS_REQUIRED_LIFECYCLE_TYPES } from '@/features/generative-ui/contracts/hpiasLifecycleContract';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';
import '@/features/generative-ui/blocks';

const EXPECTED_EIGHTEEN_BLOCK_TYPES = [
  'stat-card',
  'alert',
  'list',
  'progress',
  'action-bar',
  'text',
  'key-value-grid',
  'flashcard-preview',
  'review-calendar',
  'mistake-analysis',
  'mindmap-embed',
  'paper-digest',
  'research-plan',
  'research-report',
  'markdown',
  'chart',
  'steps',
  'table',
] as const;

test('fixture lists all 18 block types including markdown/chart/steps/table', () => {
  expect(ALL_BLOCK_TYPES).toHaveLength(18);
  expect(EXPECTED_EIGHTEEN_BLOCK_TYPES).toHaveLength(18);
  for (const type of EXPECTED_EIGHTEEN_BLOCK_TYPES) {
    expect(ALL_BLOCK_TYPES, `missing type ${type}`).toContain(type);
  }
});

test('renders all-blocks generative UI intent smoke', async ({ mount }) => {
  const component = await mount(
    <div style={{ width: 960, padding: 16 }}>
      <GenerativeUIRenderer intent={buildAllBlocksIntent()} showChrome={false} />
    </div>,
  );

  await expect(component.getByText('指标')).toBeVisible();
  await expect(component.getByText('正文内容')).toBeVisible();
  await expect(component.locator('[data-generative-markdown]')).toBeVisible();
  await expect(component.locator('[data-generative-chart]')).toBeVisible();
  await expect(component.locator('[data-generative-steps]')).toBeVisible();
  await expect(component.locator('[data-generative-table]')).toBeVisible();
  await expect(component.locator('[data-layout-mode="stack"]')).toBeVisible();
});

test('v1.1 grid layout optional smoke', async ({ mount }) => {
  const intent: GenerativeUIIntent = {
    version: '1.1',
    layout: { mode: 'grid', columns: 2 },
    meta: { title: 'v1.1 layout' },
    blocks: [
      { type: 'markdown', props: ALL_BLOCKS_MINIMAL_PROPS.markdown, span: 2 },
      { type: 'chart', props: ALL_BLOCKS_MINIMAL_PROPS.chart },
      { type: 'steps', props: ALL_BLOCKS_MINIMAL_PROPS.steps },
      { type: 'table', props: ALL_BLOCKS_MINIMAL_PROPS.table },
    ],
  };

  const component = await mount(
    <div style={{ width: 960, padding: 16 }}>
      <GenerativeUIRenderer intent={intent} showChrome={false} />
    </div>,
  );

  await expect(component.locator('[data-layout-mode="grid"]')).toBeVisible();
  await expect(component.locator('[data-layout-columns="2"]')).toBeVisible();
  await expect(component.locator('[data-layout-span="2"]')).toBeVisible();
  await expect(component.locator('[data-generative-markdown]')).toBeVisible();
  await expect(component.locator('[data-generative-chart]')).toBeVisible();
  await expect(component.locator('[data-generative-steps]')).toBeVisible();
  await expect(component.locator('[data-generative-table]')).toBeVisible();
});

test('hpias style lab timeline covers required lifecycle types', () => {
  const types = buildStyleLabHpiasDemoTimeline().map((e) => e.type);
  for (const required of HPIAS_REQUIRED_LIFECYCLE_TYPES) {
    expect(types, `missing ${required}`).toContain(required);
  }
});
