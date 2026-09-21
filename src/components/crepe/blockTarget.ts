import type { Node as ProseNode } from '@milkdown/prose/model';
import { NodeSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';

/** Runtime identity only: valid for this view and this immutable document snapshot. */
export interface BlockTarget {
  readonly view: EditorView;
  readonly doc: ProseNode;
  readonly pos: number;
  readonly to: number;
  readonly type: string;
  readonly depth: number;
  readonly parentPos: number;
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly nodes: readonly ProseNode[];
}

export const isListItem = (node: ProseNode): boolean =>
  node.type.name === 'list_item' || node.type.name === 'listItem';

export function isBlockTargetCurrent(view: EditorView, target: BlockTarget): boolean {
  return !view.isDestroyed && target.view === view && target.doc === view.state.doc;
}

/** A node boundary addresses that node; an interior position addresses the nearest
 * content block. Direct children of a list item operate on the whole item. */
export function resolveBlockTarget(view: EditorView, pos: number): BlockTarget | null {
  const doc = view.state.doc;
  if (!Number.isInteger(pos) || pos < 0 || pos >= doc.content.size) return null;
  const $pos = doc.resolve(pos);
  let depth = $pos.depth + 1;
  let node = $pos.nodeAfter;
  let start = pos;
  if (!node?.isBlock) {
    depth = $pos.depth;
    while (depth > 0 && !$pos.node(depth).isBlock) depth -= 1;
    if (!depth) return null;
    node = $pos.node(depth);
    start = $pos.before(depth);
  }
  const $start = doc.resolve(start);
  if ($start.depth > 0 && isListItem($start.parent)) {
    depth = $start.depth;
    node = $start.parent;
    start = $start.before(depth);
  }
  const $block = doc.resolve(start);
  return {
    view, doc, pos: start, to: start + node.nodeSize, type: node.type.name,
    depth, parentPos: $block.depth ? $block.before($block.depth) : -1,
    fromIndex: $block.index(), toIndex: $block.index() + 1, nodes: [node],
  };
}

/** Only siblings are a range. Never widen a cross-container selection to an ancestor. */
export function resolveBlockSelection(view: EditorView): BlockTarget | null {
  const { selection, doc } = view.state;
  const first = resolveBlockTarget(view, selection.from);
  if (!first || selection.empty || selection instanceof NodeSelection) return first;
  const last = resolveBlockTarget(view, selection.to - 1);
  if (!last || first.parentPos !== last.parentPos || first.depth !== last.depth) return null;
  const parent = doc.resolve(first.pos).parent;
  const nodes: ProseNode[] = [];
  for (let i = first.fromIndex; i < last.toIndex; i += 1) nodes.push(parent.child(i));
  return { ...first, to: last.to, toIndex: last.toIndex, nodes,
    type: nodes.length > 1 ? 'range' : first.type };
}

/** Legacy menu hosts pass top-level positions. A container coordinate has already
 * lost the hovered child, so refuse it until the host passes a captured BlockTarget. */
export function resolveBlockCommandTarget(
  view: EditorView, input: number | BlockTarget,
): BlockTarget | null {
  if (typeof input !== 'number') return isBlockTargetCurrent(view, input) ? input : null;
  const target = resolveBlockTarget(view, input);
  if (!target) return null;
  const node = target.nodes[0];
  if (!node.isTextblock && !node.isLeaf && !isListItem(node)) {
    const selection = view.state.selection;
    if (!(selection instanceof NodeSelection) || selection.from !== target.pos) return null;
  }
  return target;
}

/** Prefer the deepest visible content unit at the handle's Y. A container's own
 * header (including a collapsed toggle) addresses that container, not an unrelated
 * nearby paragraph. Structural table rows/cells are not standalone block targets. */
export function blockTargetsAtY(view: EditorView, y: number): BlockTarget | null {
  let best: BlockTarget | null = null;
  let distance = Infinity;
  view.state.doc.descendants((node, pos) => {
    if (!node.isBlock) return;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;
    if (dom.closest('[hidden], [inert]')) return false;
    const rect = dom.getBoundingClientRect();
    if (rect.height <= 0) return false;
    if (!node.isTextblock && !node.isLeaf && !isListItem(node)
      && !node.type.spec.group?.split(' ').includes('block')) return;
    const nextDistance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const target = resolveBlockTarget(view, pos);
    if (target && (nextDistance < distance || (nextDistance === distance && target.depth > (best?.depth ?? 0)))) {
      best = target;
      distance = nextDistance;
    }
    return !node.isLeaf && !node.isTextblock;
  });
  return best;
}

/** The handle menu and drag must also agree on whether the hovered block belongs
 * to the current sibling selection, not just on the single-node hit test. */
export function resolveBlockHandleTarget(view: EditorView, handle: Element): BlockTarget | null {
  if (view.isDestroyed || !view.editable) return null;
  const rect = handle.getBoundingClientRect();
  const target = blockTargetsAtY(view, rect.top + rect.height / 2);
  const selected = resolveBlockSelection(view);
  return target && selected && selected.nodes.length > 1
    && selected.parentPos === target.parentPos && target.pos >= selected.pos && target.to <= selected.to
    ? selected : target;
}
