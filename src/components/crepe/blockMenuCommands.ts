import type { EditorView } from '@milkdown/prose/view';
import type { Attrs, NodeType } from '@milkdown/prose/model';
import { TextSelection } from '@milkdown/prose/state';
import { lift, setBlockType, wrapIn } from '@milkdown/prose/commands';

export type CrepeBlockTurnInto =
  | 'paragraph'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list'
  | 'quote'
  | 'code-block'
  | 'callout'
  | 'toggle';

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

/**
 * 转换完成后把光标放回块内原来的相对位置。
 * offset 基于旧块结构，wrap/lift 会平移 1~2 个 token；TextSelection.near
 * 会把落在非文本位置的目标吸附到最近合法点，误差可接受。
 */
function restoreCaretInCurrentBlock(view: EditorView, caretOffset: number | null): void {
  if (caretOffset === null) return;
  const { $from } = view.state.selection;
  const blockStart = $from.depth > 0 ? $from.before(1) : $from.pos;
  const blockNode = view.state.doc.nodeAt(blockStart);
  if (!blockNode) return;
  const targetPos = Math.max(
    blockStart + 1,
    Math.min(blockStart + caretOffset, blockStart + blockNode.nodeSize - 1),
  );
  const selection = TextSelection.near(view.state.doc.resolve(targetPos));
  view.dispatch(view.state.tr.setSelection(selection));
}

export function turnCrepeBlockInto(
  view: EditorView,
  pos: number,
  target: CrepeBlockTurnInto,
): boolean {
  const blockPos = clampTopLevelPos(view, pos);
  if (blockPos === null) return false;
  const blockNode = view.state.doc.nodeAt(blockPos);
  if (!blockNode) return false;

  // 光标原本就在该块内时记录相对偏移，转换后还原
  const { from, empty } = view.state.selection;
  const caretOffset = empty && from > blockPos && from < blockPos + blockNode.nodeSize
    ? from - blockPos
    : null;

  if (!selectBlockText(view, blockPos)) return false;
  liftToDocument(view);

  const { nodes } = view.state.schema;
  let applied = false;
  if (target === 'paragraph') {
    if (nodes.paragraph) applied = setBlockType(nodes.paragraph)(view.state, view.dispatch);
  } else if (target.startsWith('heading-')) {
    const level = Number(target.slice(-1));
    if (nodes.heading) applied = setBlockType(nodes.heading, { level })(view.state, view.dispatch);
  } else if (target === 'code-block') {
    const codeBlock = nodes.code_block ?? nodes.codeBlock;
    if (codeBlock) applied = setBlockType(codeBlock)(view.state, view.dispatch);
  } else {
    let wrapper: NodeType | undefined;
    let attrs: Attrs | undefined;
    switch (target) {
      case 'quote':
        wrapper = nodes.blockquote;
        break;
      case 'bullet-list':
        wrapper = nodes.bullet_list ?? nodes.bulletList;
        break;
      case 'ordered-list':
        wrapper = nodes.ordered_list ?? nodes.orderedList;
        break;
      case 'task-list':
        // Milkdown 任务列表 = checked 属性的 list_item；findWrapping 会自动补外层 bullet_list。
        wrapper = nodes.list_item ?? nodes.listItem;
        attrs = { checked: false };
        break;
      case 'callout':
        wrapper = nodes.callout;
        attrs = { type: 'note', title: '' };
        break;
      case 'toggle':
        wrapper = nodes.toggle;
        attrs = { title: '', open: true };
        break;
    }
    if (wrapper) applied = wrapIn(wrapper, attrs)(view.state, view.dispatch);
  }
  if (applied) restoreCaretInCurrentBlock(view, caretOffset);
  view.focus();
  return applied;
}
