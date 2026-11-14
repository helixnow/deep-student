/**
 * FE-B6 evidence: which component renders each generative UI block type, and the rendered output of all 18 built-in
 * blocks (plus an unknown type) with and without the UI kernel. Captured before FE-B6; the golden is never rewritten.
 */
import React from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, cleanup, render } from '@testing-library/react';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (path: string) => path }));
vi.mock('@/features/chat/components/renderers/lazyKatex', () => ({ getLoadedKatex: () => null, ensureKatexLoaded: vi.fn(), scheduleKatexIdlePrefetch: vi.fn() }));
vi.mock('@/utils/lazyStyles', () => ({ ensureKatexStyles: vi.fn() }));

import { GenerativeUIRenderer } from '../GenerativeUIRenderer';
import { generativeUIRegistry } from '../registry';
import { BUILTIN_GENERATIVE_BLOCK_SCHEMAS } from '../blockSchemas';
import { ALL_BLOCK_TYPES, buildAllBlocksIntent, buildSingleBlockIntent } from '../demo/allBlocksFixture';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';

const GOLDEN = 'src/features/generative-ui/__golden__/components.json';

let kernel: UiKernel;
beforeAll(async () => {
  kernel = new UiKernel(memoryRegistryAdapters());
  await installOfficialUiPlugins(kernel);
});
afterAll(async () => { await kernel.dispose(); });

const componentName = (component: unknown) => {
  const c = component as { displayName?: string; name?: string; type?: { displayName?: string; name?: string } } | undefined;
  return c?.displayName ?? c?.name ?? c?.type?.displayName ?? c?.type?.name ?? null;
};

async function renderIntent(intent: unknown, provider: boolean) {
  const element = <GenerativeUIRenderer intent={intent as never} showChrome={false} />;
  const view = render(provider ? <UiKernelProvider kernel={kernel}>{element}</UiKernelProvider> : element);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const html = view.container.innerHTML.replace(/generative-ui-actions-[\w-]+/g, 'generative-ui-actions-ID');
  view.unmount();
  return html;
}

it('maps every block type to the same component and renders the same output', async () => {
  const schemas = new Map(BUILTIN_GENERATIVE_BLOCK_SCHEMAS.map((config) => [config.type, config]));
  const result = {
    registry: generativeUIRegistry.getAll().map((config) => ({
      type: config.type,
      component: componentName(config.component),
      builtinSchema: config.propsSchema === schemas.get(config.type)?.propsSchema,
      description: config.description ?? null,
      allowPartialRender: config.allowPartialRender ?? null,
    })),
    keys: generativeUIRegistry.keys(),
    catalog: generativeUIRegistry.getCatalogForPrompt(),
    render: {} as Record<string, unknown>,
  };
  for (const provider of [false, true]) {
    const out: Record<string, string> = {};
    out.all = await renderIntent(buildAllBlocksIntent(), provider);
    for (const type of ALL_BLOCK_TYPES) out[type] = await renderIntent(buildSingleBlockIntent(type), provider);
    out.unknown = await renderIntent({ version: '1', blocks: [{ type: 'no-such-block', props: {} }] }, provider);
    result.render[provider ? 'provider' : 'lightweight'] = out;
  }
  cleanup();
  if (process.env.FE_B6_CAPTURE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  expect(result.registry).toEqual(golden.registry);
  expect(result).toEqual(golden);
}, 60_000);
