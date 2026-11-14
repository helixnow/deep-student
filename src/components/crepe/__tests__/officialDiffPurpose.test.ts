/**
 * FE-B9: `EditorPurpose`, `purposes` and the review projection's one-shot editor.
 *
 * `createOfficialDiffAdapter` keeps its fixed official stack first and appends only `editor.extensions` entries that
 * list `'diff'` (omitted `purposes` means `['editor']`); each receives `{ options, purpose: 'diff' }`, a throwing
 * factory is reported against its plugin and drops only itself, and the review still reports its changed groups.
 */
import { Editor } from '@milkdown/kit/core';
import type { MilkdownPlugin } from '@milkdown/ctx';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import type { EditorExtensionContribution, SlotEntry } from '@/ui-sdk';
import type { EditorInstanceContext } from '@/ui-plugins/official/editor/editorSlots';
import { createOfficialDiffAdapter } from '../officialDiffAdapter';

const realMake = Editor.make;
let used: unknown[] = [];
beforeAll(async () => {
  await i18next.init({ lng: 'zh-CN', resources: {} });
});
beforeEach(() => {
  used = [];
  Editor.make = function make() {
    const editor = realMake.call(Editor);
    const use = editor.use;
    editor.use = (plugin) => { used.push(plugin); use.call(editor, plugin); return editor; };
    return editor;
  };
});
afterAll(() => { Editor.make = realMake; });

function extension(
  owner: string,
  id: string,
  value: EditorExtensionContribution,
): SlotEntry<EditorExtensionContribution> {
  return { id, order: 100, owner, origin: 'community', value };
}

const marked = (name: string): MilkdownPlugin => Object.assign(
  (() => async () => undefined) as unknown as MilkdownPlugin,
  { pluginName: name },
);

it('RF-W18-diff-extension-purpose: admits only entries listing diff, passing the diff instance, and drops a throwing factory', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const editorOnly = vi.fn(() => { throw new Error('editor purpose must sit out'); });
  const implicit = vi.fn(() => marked('community:implicit'));
  const diffCreate = vi.fn((_editor: EditorInstanceContext) => marked('community:diff'));
  const broken = vi.fn(() => { throw new Error('broken diff'); });
  const onContributionError = vi.fn();

  const entries = [
    extension('example.editor-only', 'editor-only', { create: editorOnly, purposes: ['editor'] }),
    extension('example.implicit', 'implicit', { create: implicit }),
    extension('example.diff', 'diff', { create: diffCreate, purposes: ['diff'] }),
    extension('example.broken', 'broken', { create: broken, purposes: ['diff'] }),
  ];

  const adapter = await createOfficialDiffAdapter({
    root,
    baseline: 'Keep.\n\nOld.',
    target: 'Keep.\n\nNew.',
    onDecision: async () => undefined,
    onError: (error) => { throw error; },
    extensions: entries,
    onContributionError,
  });
  try {
    expect(editorOnly).not.toHaveBeenCalled();
    expect(implicit).not.toHaveBeenCalled();
    expect(diffCreate).toHaveBeenCalledTimes(1);
    expect(diffCreate.mock.calls[0][0]).toMatchObject({
      purpose: 'diff',
      options: expect.objectContaining({ automd: false, wikilink: false, callout: false, toggle: false }),
    });
    expect(Object.isFrozen(diffCreate.mock.calls[0][0].options)).toBe(true);
    expect(used.flat(Infinity)).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginName: 'community:diff' }),
    ]));
    expect(used.flat(Infinity)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginName: 'community:implicit' }),
    ]));

    expect(broken).toHaveBeenCalledTimes(1);
    expect(onContributionError).toHaveBeenCalledTimes(1);
    expect(onContributionError.mock.calls[0][0]).toMatchObject({
      id: 'broken', owner: 'example.broken', origin: 'community',
    });
    expect(adapter.pending()).toHaveLength(1);
  } finally {
    await adapter.destroy();
    root.remove();
  }
});

it('leaves the fixed official stack alone when no entry lists diff', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const create = vi.fn(() => { throw new Error('must sit out'); });
  const adapter = await createOfficialDiffAdapter({
    root,
    baseline: 'Old.',
    target: 'New.',
    onDecision: async () => undefined,
    onError: (error) => { throw error; },
    extensions: [extension('example.implicit', 'implicit', { create })],
  });
  try {
    expect(create).not.toHaveBeenCalled();
    expect(adapter.pending()).toHaveLength(1);
  } finally {
    await adapter.destroy();
    root.remove();
  }
});
