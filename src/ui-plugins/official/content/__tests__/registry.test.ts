import { expect, it } from 'vitest';
import { UiKernel } from '@/ui-kernel/kernel';
import type { ContentMenuContribution } from '@/ui-kernel/contracts/content';
import contentPlugin, { officialMarkdownEntries, officialMenuEntries } from '../index';

it('registers all language keys and ordered menu entries, then revokes them with the fiber', async () => {
  const kernel = new UiKernel();
  await kernel.install(contentPlugin, { origin: 'builtin' });
  expect(kernel.slots.list('markdown.codeBlocks')).toEqual(officialMarkdownEntries);
  expect(kernel.slots.list('markdown.codeBlocks').map(entry => entry.key)).toEqual([
    'math', 'latex', 'mermaid', 'svg', 'html', 'htm', 'xml', 'vega-lite', 'vega', 'dot', 'abc', 'wavedrom', 'mol', 'molfile', 'sdf', 'pdb', 'geojson',
  ]);
  for (const entry of kernel.slots.list('markdown.codeBlocks')) {
    expect(entry.value).toBe(officialMarkdownEntries.find(item => item.id === entry.id)!.value);
    expect(entry.origin).toBe('builtin');
  }
  const menus = kernel.slots.list<ContentMenuContribution>('resource.contextMenu');
  expect(menus).toEqual(officialMenuEntries);
  expect(menus).toHaveLength(47);
  for (const entry of menus) {
    expect(entry.value.id).toBe(entry.id);
    expect(entry.value.order).toBe(entry.order);
    expect(entry.owner).toBe('dstu.ui.content');
  }
  await kernel.unload(contentPlugin.meta.id);
  expect(kernel.slots.list('markdown.codeBlocks')).toEqual([]);
  expect(kernel.slots.list('resource.contextMenu')).toEqual([]);
  await kernel.install(contentPlugin, { origin: 'builtin' });
  expect(kernel.slots.list('resource.contextMenu')).toHaveLength(menus.length);
  await kernel.dispose();
});
