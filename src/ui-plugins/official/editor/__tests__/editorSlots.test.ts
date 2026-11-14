import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MilkdownPlugin } from '@milkdown/ctx';
import type { Ctx } from '@milkdown/kit/ctx';
import type { SlotEntry } from '@/ui-kernel/slots';
import { UiKernel } from '@/ui-kernel/kernel';
import { officialEditorExtensionEntries } from '@/components/crepe/plugins';
import { officialSlashMenuEntries } from '@/components/crepe/commandMenus';
import { installOfficialUiPlugins } from '../../install';
import { memoryRegistryAdapters } from '../../../testing/registries';
import {
  buildEditorSlashMenu,
  resolveEditorExtensionGroups,
  resolveEditorExtensions,
  type EditorExtensionContribution,
  type EditorInstanceContext,
  type EditorSlashMenuContribution,
  type SlashMenuBuilder,
} from '../editorSlots';

let kernel: UiKernel | undefined;
afterEach(async () => {
  await kernel?.dispose();
  kernel = undefined;
});

async function boot() {
  kernel = new UiKernel(memoryRegistryAdapters());
  await installOfficialUiPlugins(kernel);
  return kernel;
}

const describeEntries = (entries: readonly SlotEntry<unknown>[]) =>
  entries.map(({ id, order, owner, origin }) => ({ id, order, owner, origin }));

function entry<T>(id: string, value: T, origin: 'builtin' | 'community' = 'community'): SlotEntry<T> {
  return { id, order: 0, owner: origin === 'builtin' ? 'dstu.ui.editor' : 'example.editor', origin, value };
}

const extension = (create: EditorExtensionContribution['create']): EditorExtensionContribution => ({ create });
const slash = (build: EditorSlashMenuContribution['build']): EditorSlashMenuContribution => ({ build });

function plugin(name: string, run: () => unknown = () => undefined, setup?: () => void): MilkdownPlugin {
  const value = (() => {
    setup?.();
    return async () => run();
  }) as unknown as MilkdownPlugin;
  return Object.assign(value, { pluginName: name });
}

const editor: EditorInstanceContext = { options: { wikilink: false } };
const ctx = {} as Ctx;

describe('editor slots (FE-B5)', () => {
  it('holds the official stack in assembly order, owned by dstu.ui.editor', async () => {
    const k = await boot();
    expect(k.slots.list('editor.extensions').map((item) => item.id)).toEqual([
      'editor:automd', 'editor:search-highlight', 'editor:agent-highlight', 'editor:paste-link', 'editor:callout',
      'editor:toggle', 'editor:wikilink', 'editor:mention', 'editor:image-lightbox', 'editor:link-keymap',
      'editor:internal-link-schema', 'editor:pdf-ref', 'editor:media-ref', 'editor:columns', 'editor:block-identity',
      'editor:block-selection', 'editor:typed-placeholder', 'editor:canonical-document', 'editor:command-execute',
      'editor:command-bindings', 'editor:list-item-has-checked', 'editor:inline-cards',
    ]);
    expect(describeEntries(k.slots.list('editor.extensions'))).toEqual(describeEntries(officialEditorExtensionEntries));
    expect(k.slots.list('editor.extensions').map((item) => item.value)).toEqual(officialEditorExtensionEntries.map((item) => item.value));
    expect(describeEntries(k.slots.list('editor.slashMenu'))).toEqual([
      { id: 'slash:callout-toggle', order: 10, owner: 'dstu.ui.editor', origin: 'builtin' },
      { id: 'slash:editor-commands', order: 20, owner: 'dstu.ui.editor', origin: 'builtin' },
    ]);
    expect(k.slots.list('editor.slashMenu').map((item) => item.value)).toEqual(officialSlashMenuEntries.map((item) => item.value));
  });

  it('removes the official stack with its plugin', async () => {
    const k = await boot();
    await k.unload('dstu.ui.editor');
    expect(k.slots.list('editor.extensions')).toEqual([]);
    expect(k.slots.list('editor.slashMenu')).toEqual([]);
  });
});

describe('resolveEditorExtensions', () => {
  it('flattens the factories in entry order, passes the editor instance and skips null', () => {
    const a = plugin('a');
    const b = plugin('b');
    const c = plugin('c');
    const seen: EditorInstanceContext[] = [];
    const plugins = resolveEditorExtensions([
      entry('a', extension((instance) => { seen.push(instance); return [a, b]; }), 'builtin'),
      entry('none', extension((instance) => { seen.push(instance); return null; })),
      entry('c', extension((instance) => { seen.push(instance); return c; })),
    ], editor, vi.fn());
    expect(plugins.slice(0, 2)).toEqual([a, b]);
    expect(plugins).toHaveLength(3);
    expect((plugins[2] as { pluginName?: string }).pluginName).toBe('c');
    expect(seen).toEqual([editor, editor, editor]);
  });

  it('keeps one group per entry, a single plugin or a list as the factory returned it', () => {
    const a = plugin('a');
    const b = plugin('b');
    const c = plugin('c');
    const d = plugin('d');
    const groups = resolveEditorExtensionGroups([
      entry('single', extension(() => a), 'builtin'),
      entry('list', extension(() => [b, c]), 'builtin'),
      entry('none', extension(() => null)),
      entry('community-list', extension(() => [d])),
    ], editor, vi.fn());
    expect(groups).toHaveLength(3);
    expect(groups[0]).toBe(a);
    expect(groups[1]).toEqual([b, c]);
    expect(Array.isArray(groups[2])).toBe(true);
    expect((groups[2] as MilkdownPlugin[]).map((item) => (item as { pluginName?: string }).pluginName)).toEqual(['d']);
  });

  it('skips and reports a throwing community factory; an official factory error propagates', () => {
    const onError = vi.fn();
    const failure = new Error('community factory');
    const broken = entry('broken', extension(() => { throw failure; }));
    const after = plugin('after');
    expect(resolveEditorExtensions([broken, entry('after', extension(() => after), 'builtin')], editor, onError)).toEqual([after]);
    expect(onError).toHaveBeenCalledWith(broken, failure);
    expect(() => resolveEditorExtensions([entry('official', extension(() => { throw new Error('official factory'); }), 'builtin')], editor, onError))
      .toThrow('official factory');
  });

  it('isolates a community plugin that throws while it sets up, runs or cleans up', async () => {
    const onError = vi.fn();
    const setupFailure = new Error('setup');
    const runFailure = new Error('run');
    const cleanupFailure = new Error('cleanup');
    const setupEntry = entry('setup', extension(() => plugin('setup', undefined, () => { throw setupFailure; })));
    const runEntry = entry('run', extension(() => plugin('run', () => { throw runFailure; })));
    const cleanupEntry = entry('cleanup', extension(() => plugin('cleanup', () => () => { throw cleanupFailure; })));
    const okEntry = entry('ok', extension(() => plugin('ok', () => 'ran')));
    const [setup, run, cleanup, ok] = resolveEditorExtensions([setupEntry, runEntry, cleanupEntry, okEntry], editor, onError);

    expect(await setup(ctx)()).toBeUndefined();
    expect(await run(ctx)()).toBeUndefined();
    const dispose = await cleanup(ctx)();
    expect(typeof dispose).toBe('function');
    await expect((dispose as () => Promise<void>)()).resolves.toBeUndefined();
    expect(await ok(ctx)()).toBe('ran');
    expect(onError.mock.calls).toEqual([[setupEntry, setupFailure], [runEntry, runFailure], [cleanupEntry, cleanupFailure]]);
  });
});

describe('buildEditorSlashMenu', () => {
  function builder() {
    const groups: { key: string; items: { key: string }[] }[] = [];
    const handle = (group: { items: { key: string }[] }) => ({ addItem: (key: string) => { group.items.push({ key }); return handle(group); } });
    const menu: SlashMenuBuilder = {
      addGroup: (key) => { const group = { key, items: [] }; groups.push(group); return handle(group); },
      getGroup: (key) => {
        const group = groups.find((item) => item.key === key);
        if (!group) throw new Error(`Group with key ${key} not found`);
        return handle(group);
      },
      build: () => groups,
    };
    menu.addGroup('text', 'Text').addItem('h1', { label: 'H1', icon: '' });
    return menu;
  }

  it('runs the entries in order; a throwing community entry is reported and the rest still build', () => {
    const menu = builder();
    const onError = vi.fn();
    const missingGroup = entry('missing-group', slash((target) => { target.getGroup('community-missing').addItem('x', { label: 'x', icon: '' }); }));
    buildEditorSlashMenu([
      entry('official', slash((target) => { target.addGroup('official', 'Official').addItem('o', { label: 'o', icon: '' }); }), 'builtin'),
      missingGroup,
      entry('stamp', slash((target, instance) => {
        expect(instance).toBe(editor);
        target.getGroup('text').addItem('stamp', { label: 'Stamp', icon: '' });
      })),
    ], menu, editor, onError);
    expect(menu.build().map((group) => [group.key, group.items.map((item) => item.key)])).toEqual([
      ['text', ['h1', 'stamp']],
      ['official', ['o']],
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(missingGroup);
    expect(() => buildEditorSlashMenu([entry('official', slash(() => { throw new Error('official menu'); }), 'builtin')], builder(), editor, onError))
      .toThrow('official menu');
  });
});
