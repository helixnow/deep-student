/**
 * `editor.blockMenu` entries for the block menus that are not React trees (the programmatic mobile menu in
 * `blockCommandMenu.ts`). `CrepeEditor` registers the entries for its view once the editor is ready; the menu reads them
 * when it opens. The desktop block handle menu gets the entries directly from the slot in `CrepeEditor`.
 */
import type { EditorView } from '@milkdown/prose/view';
import type { EditorBlockMenuContribution, EditorBlockMenuRow, EditorBlockMenuSurface, EditorBlockMenuTarget, EditorInstanceContext, SlotEntry } from '@/ui-sdk';
import { canEditCrepeView } from './commandRegistry';
import type { BlockTarget } from './blockTarget';

export interface BlockMenuContributions {
  entries: readonly SlotEntry<EditorBlockMenuContribution>[];
  editor: EditorInstanceContext;
  onError: (entry: SlotEntry<unknown>, error: unknown) => void;
}

export type BlockMenuContributionRow = { entry: SlotEntry<EditorBlockMenuContribution>; row: EditorBlockMenuRow };

/** Host-built official rows retain private command targets; the public slot supplies the ordering contract. */
// RUST-FIX(RF-W18-block-menu-contributions): preserve the four published segment orders.
export function officialBlockMenuEntries(
  rows: (segment: 'insert' | 'turn-into' | 'actions' | 'layout') => readonly EditorBlockMenuRow[],
): SlotEntry<EditorBlockMenuContribution>[] {
  return (['insert', 'turn-into', 'actions', 'layout'] as const).map((segment, index) => ({
    id: `block:${segment}`, owner: 'dstu.ui.editor', origin: 'builtin', order: (index + 1) * 10,
    value: { rows: () => rows(segment) },
  }));
}

/** The contract target for a block menu open: the block's own type and the nodes outwards from it. */
export function contractBlockMenuTarget(view: EditorView, target: BlockTarget, surface: EditorBlockMenuSurface): EditorBlockMenuTarget {
  const $pos = view.state.doc.resolve(Math.min(target.pos + 1, view.state.doc.content.size));
  const nodeTypes: string[] = [];
  for (let depth = $pos.depth; depth > 0; depth -= 1) nodeTypes.push($pos.node(depth).type.name);
  return { surface, nodeTypes, depth: target.depth, editable: canEditCrepeView(view) };
}

const hosts = new WeakMap<EditorView, BlockMenuContributions>();

/** Registers (or replaces) the contributions of one editor view; returns a disposer for that registration. */
export function registerBlockMenuContributions(view: EditorView, contributions: BlockMenuContributions): () => void {
  hosts.set(view, contributions);
  return () => { if (hosts.get(view) === contributions) hosts.delete(view); };
}

export function blockMenuContributions(view: EditorView): BlockMenuContributions | undefined {
  return hosts.get(view);
}
