import type { ComponentType } from 'react';
import type { MilkdownPlugin } from '@milkdown/ctx';
import type { Ctx } from '@milkdown/kit/ctx';
import type { EditorView } from '@milkdown/prose/view';
import type { CrepePluginsOptions } from '@/components/crepe/plugins';

/**
 * Editor extension points (FE-B5): the Milkdown plugins and slash menu entries every Crepe editor instance assembles.
 *
 * - `editor.extensions`: called once per editor instance, in `order`, before `crepe.create()`; returns the Milkdown
 *   plugins to `use` (or null to sit out). Milkdown applies plugins in this order, so input rules, keymaps and paste
 *   handlers of earlier entries take precedence.
 * - `editor.slashMenu`: called with the slash menu builder after Crepe added its built-in groups, in `order`, each
 *   time the menu rebuilds its groups (Crepe recomputes them while the user filters), so changes apply to open editors.
 * - `editor.selectionToolbar`: called once per editor instance when Crepe builds its bubble toolbar; entry changes only
 *   affect editors created afterwards.
 * - `editor.blockMenu`: called every time a block menu opens, for the three surfaces (desktop handle, mobile insert,
 *   mobile block), with the target block.
 *
 * Owned by `dstu.ui.editor` (ui-plugins/official/editor); a community entry that throws is skipped and reported, the
 * editor still opens.
 */
export interface EditorInstanceContext {
  /** The editor instance's plugin options (host `plugins` prop, with the layout write gate). */
  options: Readonly<CrepePluginsOptions>;
  /** Instance purpose; omitted = 'editor'. The AI change review projection passes 'diff'. */
  purpose?: EditorPurpose;
}

/** What an editor instance is for: the editable editor, or the read-only AI change review projection. */
export type EditorPurpose = 'editor' | 'diff';

export interface EditorExtensionContribution {
  create(editor: EditorInstanceContext): MilkdownPlugin | readonly MilkdownPlugin[] | null;
  /**
   * Instances this entry takes part in; omitted = `['editor']`. The diff projection only applies entries that list
   * `'diff'` explicitly, so existing entries never turn up in the read-only review view by accident.
   */
  purposes?: readonly EditorPurpose[];
}

export interface SlashMenuItem {
  label: string;
  icon: string;
  onRun?: (ctx: Ctx) => void;
}

/** The surface of Crepe's slash menu GroupBuilder that contributions may use. */
export interface SlashMenuBuilder {
  addGroup(key: string, label: string): { addItem(key: string, item: SlashMenuItem): unknown };
  getGroup(key: string): { addItem(key: string, item: SlashMenuItem): unknown };
  build(): { key: string; items: { key: string; onRun?: (ctx: Ctx) => void }[] }[];
}

export interface EditorSlashMenuContribution {
  build(menu: SlashMenuBuilder, editor: EditorInstanceContext): void;
}

/** A bubble toolbar button. `active` is optional here; the host fills in `() => false` (Crepe requires one). */
export interface SelectionToolbarItem {
  label: string;
  icon: string;
  active?: (ctx: Ctx) => boolean;
  onRun?: (ctx: Ctx) => void;
}

/** The part of Crepe's bubble toolbar GroupBuilder that contributions may use. */
export interface SelectionToolbarBuilder {
  addGroup(key: string, label: string): { addItem(key: string, item: SelectionToolbarItem): unknown };
  getGroup(key: string): { addItem(key: string, item: SelectionToolbarItem): unknown };
  build(): { key: string; items: { key: string; onRun?: (ctx: Ctx) => void }[] }[];
}

export interface EditorSelectionToolbarContribution {
  build(toolbar: SelectionToolbarBuilder, editor: EditorInstanceContext): void;
}

/** Which block menu is open. */
export type EditorBlockMenuSurface = 'desktop-handle' | 'mobile-insert' | 'mobile-block';

/** The block a menu was opened on; read once per open, the menu keeps this target while it stays open. */
export interface EditorBlockMenuTarget {
  surface: EditorBlockMenuSurface;
  /** Node types from the target block outwards, e.g. ['paragraph', 'list_item', 'bullet_list', 'callout']. */
  nodeTypes: readonly string[];
  depth: number;
  editable: boolean;
}

export interface EditorBlockMenuRow {
  /** Unique within the menu; rendered as `data-command`. */
  id: string;
  /** Already translated. */
  label: string;
  /** Only shown in the desktop block handle menu. */
  icon?: ComponentType<{ size?: number }>;
  destructive?: boolean;
  disabled?: boolean;
  /** The menu closes and focus returns to the editor first; rejections count against the error budget (community). */
  run(view: EditorView): void | Promise<void>;
}

export interface EditorBlockMenuContribution {
  /** Called each time a menu opens; compute `disabled` from the current target. */
  rows(target: EditorBlockMenuTarget, editor: EditorInstanceContext): readonly EditorBlockMenuRow[];
}

declare module '../slot-map' {
  interface SlotMap {
    'editor.extensions': EditorExtensionContribution;
    'editor.slashMenu': EditorSlashMenuContribution;
    'editor.selectionToolbar': EditorSelectionToolbarContribution;
    'editor.blockMenu': EditorBlockMenuContribution;
  }
}
