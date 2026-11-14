import React from 'react';
import { act } from '@testing-library/react';
import { expect, it } from 'vitest';
import { renderWithOfficialUi } from '@/ui-plugins/testing/render';
import { officialMarkdownEntries, officialMenuEntries } from '../index';

it('is installed as builtin by the production official installer with the same static entries', async () => {
  const view = await renderWithOfficialUi(<div />);
  expect(view.kernel.slots.list('markdown.codeBlocks')).toEqual(officialMarkdownEntries);
  expect(view.kernel.slots.list('resource.contextMenu')).toEqual(officialMenuEntries);
  expect([
    ...view.kernel.slots.list('markdown.codeBlocks'),
    ...view.kernel.slots.list('resource.contextMenu'),
  ].every(entry => entry.origin === 'builtin')).toBe(true);
  await act(async () => { await view.dispose(); });
});
