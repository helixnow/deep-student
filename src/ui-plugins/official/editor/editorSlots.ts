/**
 * Editor extension points (FE-B5); the value types and SlotMap entries are the kernel contract
 * `@/ui-kernel/contracts/editor`, exported by the SDK.
 *
 * The official stack is 20 `editor.extensions` entries ordered 10…200 (components/crepe/plugins/index.ts), two
 * `editor.slashMenu` entries: callout / toggle (10), and the editor command registry plus the page layout group (20),
 * and two `editor.selectionToolbar` entries: the editor command wiring (10) and the host actions group (20).
 * They load with CrepeEditor (not at startup) and announce themselves to `editorContributions`; `dstu.ui.editor`
 * declares the slots and contributes what is announced. Without a UI kernel CrepeEditor uses the same official tables
 * directly.
 */
import type { MilkdownPlugin } from '@milkdown/ctx';
import type { Ctx } from '@milkdown/kit/ctx';
import type {
  EditorBlockMenuContribution,
  EditorBlockMenuRow,
  EditorBlockMenuTarget,
  EditorExtensionContribution,
  EditorInstanceContext,
  EditorPurpose,
  EditorSelectionToolbarContribution,
  EditorSlashMenuContribution,
  SelectionToolbarBuilder,
  SelectionToolbarItem,
  SlashMenuBuilder,
  SlotDefinition,
  SlotEntry,
} from '@/ui-sdk';
import { createLazyContributionPoint } from '@/ui-sdk/lazy';
import { compareCodePoints } from '@/ui-sdk/order';

export type {
  EditorBlockMenuContribution,
  EditorBlockMenuRow,
  EditorBlockMenuSurface,
  EditorBlockMenuTarget,
  EditorExtensionContribution,
  EditorInstanceContext,
  EditorPurpose,
  EditorSelectionToolbarContribution,
  EditorSlashMenuContribution,
  SelectionToolbarBuilder,
  SelectionToolbarItem,
  SlashMenuBuilder,
  SlashMenuItem,
} from '@/ui-sdk';

export const EDITOR_SLOTS: readonly SlotDefinition[] = [
  { name: 'editor.extensions', cardinality: 'list', description: '编辑器 Milkdown 插件：每个编辑器实例按 order 调用工厂' },
  { name: 'editor.slashMenu', cardinality: 'list', description: '编辑器斜杠菜单：内置分组之后按 order 追加或改写条目' },
  { name: 'editor.selectionToolbar', cardinality: 'list', description: '编辑器选中浮条：每个编辑器实例按 order 追加按钮（构建后不再重算）' },
  { name: 'editor.blockMenu', cardinality: 'list', description: '编辑器块菜单：每次打开时按 order 生成行（桌面句柄、移动插入、移动块菜单）' },
];

export type EditorAnnouncement =
  | { slot: 'editor.extensions'; entry: SlotEntry<EditorExtensionContribution> }
  | { slot: 'editor.slashMenu'; entry: SlotEntry<EditorSlashMenuContribution> }
  | { slot: 'editor.selectionToolbar'; entry: SlotEntry<EditorSelectionToolbarContribution> }
  | { slot: 'editor.blockMenu'; entry: SlotEntry<EditorBlockMenuContribution> };

export const editorContributions = createLazyContributionPoint<EditorAnnouncement>('editor');

export type EditorContributionError = (entry: SlotEntry<unknown>, error: unknown) => void;

type Runner = ReturnType<MilkdownPlugin>;

/** A community plugin that throws while it sets up, runs or cleans up only drops itself. */
function isolate(plugin: MilkdownPlugin, onError: (error: unknown) => void): MilkdownPlugin {
  const guarded = ((ctx: Ctx) => {
    let run: Runner;
    try {
      run = plugin(ctx);
    } catch (error) {
      onError(error);
      return () => {};
    }
    return async () => {
      try {
        const cleanup = await run();
        if (typeof cleanup !== 'function') return cleanup;
        return async () => {
          try {
            await cleanup();
          } catch (error) {
            onError(error);
          }
        };
      } catch (error) {
        onError(error);
        return undefined;
      }
    };
  }) as MilkdownPlugin;
  return Object.assign(guarded, plugin);
}

/** What one entry adds: a plugin or a plugin list, as its factory returned it (one `editor.use` call each). */
export type EditorExtensionGroup = MilkdownPlugin | MilkdownPlugin[];

const isPluginList = (created: MilkdownPlugin | readonly MilkdownPlugin[]): created is readonly MilkdownPlugin[] => Array.isArray(created);

/** The Milkdown plugins of one editor instance, one group per entry that took part, in slot order. */
export function resolveEditorExtensionGroups(
  entries: readonly SlotEntry<EditorExtensionContribution>[],
  editor: EditorInstanceContext,
  onError: EditorContributionError,
): EditorExtensionGroup[] {
  const groups: EditorExtensionGroup[] = [];
  for (const entry of entries) {
    if (entry.origin === 'builtin') {
      const created = entry.value.create(editor);
      if (created) groups.push(isPluginList(created) ? [...created] : created);
      continue;
    }
    try {
      const created = entry.value.create(editor);
      if (!created) continue;
      const guard = (plugin: MilkdownPlugin) => isolate(plugin, (error) => onError(entry, error));
      groups.push(isPluginList(created) ? created.map(guard) : guard(created));
    } catch (error) {
      onError(entry, error);
    }
  }
  return groups;
}

/** The Milkdown plugins of one editor instance, flattened in slot order. */
export function resolveEditorExtensions(
  entries: readonly SlotEntry<EditorExtensionContribution>[],
  editor: EditorInstanceContext,
  onError: EditorContributionError,
): MilkdownPlugin[] {
  return resolveEditorExtensionGroups(entries, editor, onError).flat();
}

export function buildEditorSlashMenu(
  entries: readonly SlotEntry<EditorSlashMenuContribution>[],
  menu: SlashMenuBuilder,
  editor: EditorInstanceContext,
  onError: EditorContributionError,
): void {
  for (const entry of entries) {
    if (entry.origin === 'builtin') {
      entry.value.build(menu, editor);
      continue;
    }
    try {
      entry.value.build(menu, editor);
    } catch (error) {
      onError(entry, error);
    }
  }
}

/**
 * The editor's official entries plus the slot entries, in order (ties by entry id, then insertion). Official entries
 * are passed per instance because their factories read host state.
 */
export function mergeEditorEntries<T>(officials: readonly SlotEntry<T>[], contributions: readonly SlotEntry<T>[] | undefined): SlotEntry<T>[] {
  return [...officials, ...(contributions ?? [])]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.order - b.entry.order)
      || compareCodePoints(a.entry.id, b.entry.id)
      || a.index - b.index)
    .map(({ entry }) => entry);
}

/** Entries that take part in an instance of the given purpose; omitted `purposes` means `['editor']`. */
export function editorEntriesForPurpose<T extends { purposes?: readonly EditorPurpose[] }>(
  entries: readonly SlotEntry<T>[],
  purpose: EditorPurpose,
): SlotEntry<T>[] {
  return entries.filter((entry) => (entry.value.purposes ?? ['editor']).includes(purpose));
}

/** Crepe's own toolbar builder requires `active` on every item; the contract lets entries omit it. */
export interface CrepeSelectionToolbarBuilder {
  addGroup(key: string, label: string): { addItem(key: string, item: SelectionToolbarItem & { active: (ctx: Ctx) => boolean }): unknown };
  getGroup(key: string): { addItem(key: string, item: SelectionToolbarItem & { active: (ctx: Ctx) => boolean }): unknown };
  build(): { key: string; items: { key: string; onRun?: (ctx: Ctx) => void }[] }[];
}

const alwaysInactive = () => false;

/**
 * Adapts Crepe's GroupBuilder to the contract: a missing `active` becomes `() => false` (Crepe requires it), and
 * `build()` returns the live items so the official entry's `onRun` rewiring still applies to the rendered buttons.
 */
export function adaptSelectionToolbar(builder: CrepeSelectionToolbarBuilder): SelectionToolbarBuilder {
  const group = (handle: { addItem(key: string, item: SelectionToolbarItem & { active: (ctx: Ctx) => boolean }): unknown }) => ({
    addItem: (key: string, item: SelectionToolbarItem) => handle.addItem(key, { ...item, active: item.active ?? alwaysInactive }),
  });
  return {
    addGroup: (key, label) => group(builder.addGroup(key, label)),
    getGroup: (key) => group(builder.getGroup(key)),
    build: () => builder.build(),
  };
}

/**
 * The bubble toolbar of one instance: official entries then the slot, in order. Crepe builds the toolbar once when the
 * editor is created, so later slot changes only affect editors created afterwards.
 */
// RUST-FIX(RF-W18-selection-toolbar-contributions): stage builds and attribute community callbacks.
export function buildEditorSelectionToolbar(
  entries: readonly SlotEntry<EditorSelectionToolbarContribution>[],
  toolbar: SelectionToolbarBuilder,
  editor: EditorInstanceContext,
  onError: EditorContributionError,
): void {
  for (const entry of entries) {
    if (entry.origin === 'builtin') {
      entry.value.build(toolbar, editor);
      continue;
    }
    try {
      // Community builds are staged: a throw must not leave half a group or rewritten official callbacks behind.
      type Item = SelectionToolbarItem & { key: string };
      const originals = toolbar.build();
      const staged = originals.map(group => ({ ...group, items: group.items.map(item => ({ ...item } as Item)) }));
      const handle = (group: (typeof staged)[number]) => ({
        addItem(key: string, item: SelectionToolbarItem) { group.items.push({ ...item, key }); },
      });
      entry.value.build({
        addGroup(key, label) {
          const group = { key, label, items: [] as Item[] };
          staged.push(group);
          return handle(group);
        },
        getGroup(key) {
          const group = staged.find(group => group.key === key);
          if (!group) throw new Error(`Group with key ${key} not found`);
          return handle(group);
        },
        build: () => staged,
      }, editor);
      const guard = (item: Item, original?: { onRun?: SelectionToolbarItem['onRun']; active?: SelectionToolbarItem['active'] }) => {
        if (item.onRun && item.onRun !== original?.onRun) {
          const run = item.onRun;
          item.onRun = ctx => {
            try {
              const result = run(ctx) as unknown;
              if (result && typeof (result as Promise<void>).catch === 'function') {
                void (result as Promise<void>).catch(error => onError(entry, error));
              }
            } catch (error) { onError(entry, error); }
          };
        }
        if (item.active && item.active !== original?.active) {
          const active = item.active;
          item.active = ctx => {
            try { return active(ctx); } catch (error) { onError(entry, error); return false; }
          };
        }
        return item;
      };
      staged.forEach((group, index) => {
        const original = originals[index];
        const destination = original ? toolbar.getGroup(group.key) : toolbar.addGroup(group.key, 'label' in group ? String(group.label) : group.key);
        group.items.forEach((item, itemIndex) => {
          const old = original?.items[itemIndex];
          guard(item, old);
          if (old) Object.assign(old, item);
          else destination.addItem(item.key, item);
        });
      });
    } catch (error) {
      onError(entry, error);
    }
  }
}

/**
 * The rows one block menu shows, in merged slot order. Each row keeps its entry so the host
 * can attribute a rejected `run` to the contributing plugin. Community `rows()` throwing only drops that entry.
 */
// RUST-FIX(RF-W18-block-menu-contributions): collect merged official/community contributions.
export function collectEditorBlockMenuRows(
  entries: readonly SlotEntry<EditorBlockMenuContribution>[],
  target: EditorBlockMenuTarget,
  editor: EditorInstanceContext,
  onError: EditorContributionError,
): Array<{ entry: SlotEntry<EditorBlockMenuContribution>; row: EditorBlockMenuRow }> {
  const rows: Array<{ entry: SlotEntry<EditorBlockMenuContribution>; row: EditorBlockMenuRow }> = [];
  for (const entry of entries) {
    if (entry.origin === 'builtin') {
      for (const row of entry.value.rows(target, editor)) rows.push({ entry, row });
      continue;
    }
    try {
      for (const row of entry.value.rows(target, editor)) rows.push({ entry, row });
    } catch (error) {
      onError(entry, error);
    }
  }
  return rows;
}
