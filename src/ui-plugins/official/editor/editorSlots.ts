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
  { name: 'editor.selectionToolbar', cardinality: 'list', description: '编辑器选中浮条：每个编辑器实例按 order 追加按钮（槽位变化时已打开的编辑器重建浮条）' },
  { name: 'editor.blockMenu', cardinality: 'list', description: '编辑器块菜单：每次打开时按 order 生成行（桌面句柄、移动插入、移动块菜单）' },
];

export type EditorAnnouncement =
  | { slot: 'editor.extensions'; entry: SlotEntry<EditorExtensionContribution> }
  | { slot: 'editor.slashMenu'; entry: SlotEntry<EditorSlashMenuContribution> }
  | { slot: 'editor.selectionToolbar'; entry: SlotEntry<EditorSelectionToolbarContribution> }
  | { slot: 'editor.blockMenu'; entry: SlotEntry<EditorBlockMenuContribution> };

export const editorContributions = createLazyContributionPoint<EditorAnnouncement>('editor');

export type EditorContributionError = (entry: SlotEntry<unknown>, error: unknown) => void;

/**
 * A community plugin used one group / item key twice. Said plainly and skipped; it is a declaration mistake, not a
 * runtime failure, so it never counts toward the plugin's error budget (it does not go through `onError`).
 */
export type EditorKeyConflict = (entry: SlotEntry<unknown>, message: string) => void;
const warnKeyConflict: EditorKeyConflict = (_entry, message) => console.warn(`[editor] ${message}`);

/**
 * Community group / item keys live in the contributing plugin's namespace (`<pluginId>:<key>`), so two plugins that
 * both add a 'mnemonic' button both get one. Official keys are never prefixed; a plugin can still add to an official
 * group by its plain key.
 */
export function communityEditorKey(owner: string, key: string): string {
  return key.startsWith(`${owner}:`) ? key : `${owner}:${key}`;
}
function keyConflictMessage(entry: SlotEntry<unknown>, slot: string, kind: 'group' | 'item', key: string): string {
  return `plugin "${entry.owner}" uses the ${slot} ${kind} key "${key}" twice; the second one was skipped (rename it to show both)`;
}

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
  onConflict: EditorKeyConflict = warnKeyConflict,
): void {
  for (const entry of entries) {
    if (entry.origin === 'builtin') {
      entry.value.build(menu, editor);
      continue;
    }
    try {
      entry.value.build(namespacedSlashMenu(menu, entry, onConflict), editor);
    } catch (error) {
      onError(entry, error);
    }
  }
}

/** The slash menu as one community entry sees it: its keys prefixed with its plugin id, duplicates skipped. */
function namespacedSlashMenu(menu: SlashMenuBuilder, entry: SlotEntry<unknown>, onConflict: EditorKeyConflict): SlashMenuBuilder {
  const groups = () => menu.build();
  const handle = (groupKey: string, group: ReturnType<SlashMenuBuilder['getGroup']>) => ({
    addItem(key: string, item: Parameters<ReturnType<SlashMenuBuilder['getGroup']>['addItem']>[1]) {
      const scoped = communityEditorKey(entry.owner, key);
      if (groups().find(candidate => candidate.key === groupKey)?.items.some(existing => existing.key === scoped)) {
        onConflict(entry, keyConflictMessage(entry, 'editor.slashMenu', 'item', key));
        return undefined;
      }
      return group.addItem(scoped, item);
    },
  });
  return {
    addGroup(key, label) {
      const scoped = communityEditorKey(entry.owner, key);
      if (groups().some(group => group.key === scoped)) {
        onConflict(entry, keyConflictMessage(entry, 'editor.slashMenu', 'group', key));
        return handle(scoped, menu.getGroup(scoped));
      }
      return handle(scoped, menu.addGroup(scoped, label));
    },
    getGroup(key) {
      // Its own group first, then an official one by its plain key.
      const scoped = communityEditorKey(entry.owner, key);
      const own = groups().some(group => group.key === scoped);
      return handle(own ? scoped : key, menu.getGroup(own ? scoped : key));
    },
    build: () => menu.build(),
  };
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
 * DOM hooks of a labelled bubble toolbar button (`SelectionToolbarItem.showLabel`). Crepe renders every item as
 * `button.toolbar-item[data-toolbar-item=<key>][aria-label=<label>] > span.milkdown-icon` with the item's `icon` as
 * sanitized HTML, so the host puts the label into that markup and CrepeEditor.css sizes buttons that contain it.
 */
export const LABELLED_TOOLBAR_ITEM_CLASS = 'crepe-toolbar-labelled';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** The `icon` markup Crepe receives for a labelled item: the plugin's icon, then the label as visible text. */
export function labelledToolbarIcon(key: string, item: Pick<SelectionToolbarItem, 'label' | 'icon'>): string {
  const label = escapeHtml(String(item.label ?? ''));
  const icon = item.icon ? `<span class="${LABELLED_TOOLBAR_ITEM_CLASS}__icon" aria-hidden="true">${item.icon}</span>` : '';
  return `<span class="${LABELLED_TOOLBAR_ITEM_CLASS}" data-toolbar-label="${escapeHtml(key)}">${icon}`
    + `<span class="${LABELLED_TOOLBAR_ITEM_CLASS}__text">${label}</span></span>`;
}

/** The item Crepe receives: `active` filled in, and a labelled item's label rendered into its icon markup. */
function toCrepeToolbarItem(key: string, item: SelectionToolbarItem): SelectionToolbarItem & { active: (ctx: Ctx) => boolean } {
  const { showLabel, ...rest } = item;
  return {
    ...rest,
    ...(showLabel ? { icon: labelledToolbarIcon(key, item) } : {}),
    active: item.active ?? alwaysInactive,
  };
}

/**
 * Adapts Crepe's GroupBuilder to the contract: a missing `active` becomes `() => false` (Crepe requires it), a
 * `showLabel` item gets its label rendered next to the icon, and `build()` returns the live items so the official
 * entry's `onRun` rewiring still applies to the rendered buttons.
 */
export function adaptSelectionToolbar(builder: CrepeSelectionToolbarBuilder): SelectionToolbarBuilder {
  const group = (handle: { addItem(key: string, item: SelectionToolbarItem & { active: (ctx: Ctx) => boolean }): unknown }) => ({
    addItem: (key: string, item: SelectionToolbarItem) => handle.addItem(key, toCrepeToolbarItem(key, item)),
  });
  return {
    addGroup: (key, label) => group(builder.addGroup(key, label)),
    getGroup: (key) => group(builder.getGroup(key)),
    build: () => builder.build(),
  };
}

/**
 * The bubble toolbar of one instance: official entries then the slot, in order. CrepeEditor runs this inside Crepe's
 * toolbar build and re-runs it on open editors when the slot changes (components/crepe/liveSelectionToolbar.ts).
 */
// RUST-FIX(RF-W18-selection-toolbar-contributions): stage builds and attribute community callbacks.
export function buildEditorSelectionToolbar(
  entries: readonly SlotEntry<EditorSelectionToolbarContribution>[],
  toolbar: SelectionToolbarBuilder,
  editor: EditorInstanceContext,
  onError: EditorContributionError,
  onConflict: EditorKeyConflict = warnKeyConflict,
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
      // Keys are scoped to this plugin (communityEditorKey); a key it uses twice is skipped and reported, not thrown.
      const handle = (group: (typeof staged)[number]) => ({
        addItem(key: string, item: SelectionToolbarItem) {
          const scoped = communityEditorKey(entry.owner, key);
          if (group.items.some(existing => existing.key === scoped)) {
            onConflict(entry, keyConflictMessage(entry, 'editor.selectionToolbar', 'item', key));
            return;
          }
          group.items.push({ ...item, key: scoped });
        },
      });
      entry.value.build({
        addGroup(key, label) {
          const scoped = communityEditorKey(entry.owner, key);
          const existing = staged.find(group => group.key === scoped);
          if (existing) {
            onConflict(entry, keyConflictMessage(entry, 'editor.selectionToolbar', 'group', key));
            return handle(existing);
          }
          const group = { key: scoped, label, items: [] as Item[] };
          staged.push(group);
          return handle(group);
        },
        getGroup(key) {
          // Its own group first, then an official one by its plain key.
          const group = staged.find(group => group.key === communityEditorKey(entry.owner, key)) ?? staged.find(group => group.key === key);
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
  onConflict: EditorKeyConflict = warnKeyConflict,
): Array<{ entry: SlotEntry<EditorBlockMenuContribution>; row: EditorBlockMenuRow }> {
  const rows: Array<{ entry: SlotEntry<EditorBlockMenuContribution>; row: EditorBlockMenuRow }> = [];
  for (const entry of entries) {
    if (entry.origin === 'builtin') {
      for (const row of entry.value.rows(target, editor)) rows.push({ entry, row });
      continue;
    }
    try {
      // Rows are told apart by their plugin (the menus key them by owner + id), so only a plugin repeating its own
      // row id is a conflict: skipped and reported, never an error.
      const own: Array<{ entry: SlotEntry<EditorBlockMenuContribution>; row: EditorBlockMenuRow }> = [];
      for (const row of entry.value.rows(target, editor)) {
        if (own.some(existing => existing.row.id === row.id)) {
          onConflict(entry, keyConflictMessage(entry, 'editor.blockMenu', 'item', row.id));
          continue;
        }
        own.push({ entry, row });
      }
      rows.push(...own);
    } catch (error) {
      onError(entry, error);
    }
  }
  return rows;
}
