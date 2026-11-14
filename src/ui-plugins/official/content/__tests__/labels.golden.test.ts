import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { UiKernel } from '@/ui-kernel/kernel';
import type { ContentMenuContext, ContentMenuContribution } from '@/ui-kernel/contracts/content';
import contentPlugin from '../index';

// Supplement the DOM fixture (which records translated text) with the exact old
// i18n key inventory. Capture reads the immutable pre-refactor revision, not HEAD.
const sourceRevision = 'c3d573c5bcfd273953790a9587943aecc05d9c44';
const file = 'src/ui-plugins/official/content/__golden__/menu-label-keys.json';

it('retains every original menu translation key in the registered metadata', async () => {
  if (process.env.U4_CAPTURE_LABEL_KEYS === '1') {
    const source = execFileSync('git', ['show', `${sourceRevision}:src/features/learning-hub/components/LearningHubContextMenu.tsx`], { encoding: 'utf8' });
    const labelKeys = [...new Set([...source.matchAll(/\bt\('([^']+)'/g)].map(match => match[1]))].sort();
    writeFileSync(file, `${JSON.stringify({ sourceRevision, labelKeys }, null, 2)}\n`, { flag: 'wx' });
  }
  const kernel = new UiKernel();
  await kernel.install(contentPlugin, { origin: 'builtin' });
  const keys = new Set<string>();
  for (const entry of kernel.slots.list<ContentMenuContribution>('resource.contextMenu')) {
    if (typeof entry.value.labelKey === 'string') keys.add(entry.value.labelKey);
    if (typeof entry.value.labelKey === 'function') {
      for (const pasteCount of [0, 1, 2]) for (const isFavorite of [false, true]) for (const isAddedToDesktop of [false, true]) {
        keys.add(entry.value.labelKey({ pasteCount, resourceItem: { isFavorite }, isAddedToDesktop } as ContentMenuContext));
      }
    }
  }
  expect({ sourceRevision, labelKeys: [...keys].sort() }).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  await kernel.dispose();
});
