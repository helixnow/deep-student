import type { EditorView } from '@milkdown/prose/view';
import { TextSelection } from '@milkdown/prose/state';
import { lift, setBlockType, wrapIn } from '@milkdown/prose/commands';

export type CrepeBlockTurnInto =
  | 'paragraph'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'bullet-list'
  | 'ordered-list'
  | 'quote';

function clampTopLevelPos(view: EditorView, pos: number): number | null {
  const { doc } = view.state;
  const safePos = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(safePos);
  if ($pos.depth === 0) {
    const node = doc.nodeAt(safePos);
    return node ? safePos : null;
  }
  return $pos.before(1);
}

function selectBlockText(view: EditorView, blockPos: number): boolean {
  const node = view.state.doc.nodeAt(blockPos);
  if (!node) return false;
  const selection = TextSelection.near(view.state.doc.resolve(blockPos + 1));
  view.dispatch(view.state.tr.setSelection(selection));
  return true;
}

function liftToDocument(view: EditorView): void {
  // Lists and quotes add at most a few wrapper levels. Re-reading view.state
  // after each dispatch keeps the command compatible with Milkdown history.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (view.state.selection.$from.depth <= 1) return;
    if (!lift(view.state, view.dispatch)) return;
  }
}

export function duplicateCrepeBlock(view: EditorView, pos: number): boolean {
  const blockPos = clampTopLevelPos(view, pos);
  if (blockPos === null) return false;
  const node = view.state.doc.nodeAt(blockPos);
  if (!node) return false;
  const insertPos = blockPos + node.nodeSize;
  const tr = view.state.tr.insert(insertPos, node.copy(node.content));
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 1)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

export function deleteCrepeBlock(view: EditorView, pos: number): boolean {
  const blockPos = clampTopLevelPos(view, pos);
  if (blockPos === null) return false;
  const node = view.state.doc.nodeAt(blockPos);
  if (!node) return false;

  let tr = view.state.tr.delete(blockPos, blockPos + node.nodeSize);
  if (tr.doc.childCount === 0) {
    const paragraph = view.state.schema.nodes.paragraph?.create();
    if (!paragraph) return false;
    tr = tr.insert(0, paragraph);
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(blockPos + 1, tr.doc.content.size))));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

export function turnCrepeBlockInto(
  view: EditorView,
  pos: number,
  target: CrepeBlockTurnInto,
): boolean {
  const blockPos = clampTopLevelPos(view, pos);
  if (blockPos === null || !selectBlockText(view, blockPos)) return false;
  liftToDocument(view);

  const { nodes } = view.state.schema;
  let applied = false;
  if (target === 'paragraph') {
    if (nodes.paragraph) applied = setBlockType(nodes.paragraph)(view.state, view.dispatch);
  } else if (target.startsWith('heading-')) {
    const level = Number(target.slice(-1));
    if (nodes.heading) applied = setBlockType(nodes.heading, { level })(view.state, view.dispatch);
  } else {
    const wrapper = target === 'quote'
      ? nodes.blockquote
      : target === 'bullet-list'
        ? nodes.bullet_list ?? nodes.bulletList
        : nodes.ordered_list ?? nodes.orderedList;
    if (wrapper) applied = wrapIn(wrapper)(view.state, view.dispatch);
  }
  view.focus();
  return applied;
}
