import type { EditorView } from '@milkdown/prose/view';
import { Fragment, Slice, type Node as ProseNode, type Schema } from '@milkdown/prose/model';
import { Selection, type Transaction } from '@milkdown/prose/state';
import { closeHistory } from '@milkdown/prose/history';
import {
  isBlockTargetCurrent, isListItem, resolveBlockCommandTarget, type BlockTarget,
} from './blockTarget';

export type CrepeBlockTurnInto =
  | 'paragraph' | 'heading-1' | 'heading-2' | 'heading-3'
  | 'bullet-list' | 'ordered-list' | 'task-list'
  | 'quote' | 'code-block' | 'callout' | 'toggle';

type BlockInput = number | BlockTarget;

function atomicChange(view: EditorView, prepare: () => Transaction | false): boolean {
  let tr: Transaction | false;
  try {
    tr = prepare();
    if (!tr || !tr.docChanged || tr.doc.eq(view.state.doc)) return false;
    tr.doc.check();
  } catch { return false; }
  // No dispatch (including selection-only dispatch) occurs before the entire plan is valid.
  // Don't report a post-dispatch host exception as a rejected, unchanged command.
  view.dispatch(closeHistory(tr).scrollIntoView());
  view.focus();
  return true;
}

/** Use exact replacement, never replaceRange's schema fitting (which can lift or drop nodes). */
function replace(view: EditorView, from: number, to: number, content: Fragment, caret = from + 1): Transaction {
  const tr = view.state.tr.replace(from, to, new Slice(content, 0, 0));
  return tr.setSelection(Selection.near(tr.doc.resolve(Math.max(0, Math.min(caret, tr.doc.content.size)))));
}

export function duplicateCrepeBlock(view: EditorView, input: BlockInput): boolean {
  const target = resolveBlockCommandTarget(view, input);
  if (!target || !view.editable) return false;
  return atomicChange(view, () => replace(view, target.to, target.to, Fragment.fromArray([...target.nodes]), target.to + 1));
}

export function deleteCrepeBlock(view: EditorView, input: BlockInput): boolean {
  const target = resolveBlockCommandTarget(view, input);
  if (!target || !view.editable) return false;
  return atomicChange(view, () => {
    let { pos, to } = target;
    let $pos = target.doc.resolve(pos);
    // Removing the last list item removes only its now-empty list, never the outer container.
    if (isListItem(target.nodes[0]) && target.nodes.length === $pos.parent.childCount) {
      pos = $pos.before($pos.depth);
      to = pos + $pos.parent.nodeSize;
      $pos = target.doc.resolve(pos);
    }
    let content = Fragment.empty;
    if (!$pos.parent.canReplace($pos.index(), target.doc.resolve(to).index(), content)) {
      const paragraph = view.state.schema.nodes.paragraph?.createAndFill();
      if (!paragraph) return false;
      content = Fragment.from(paragraph);
      if (!$pos.parent.canReplace($pos.index(), target.doc.resolve(to).index(), content)) return false;
    }
    return replace(view, pos, to, content);
  });
}

function convertBlocks(schema: Schema, blocks: readonly ProseNode[], kind: CrepeBlockTurnInto): Fragment | null {
  const { nodes } = schema;
  const textType = kind === 'paragraph' ? nodes.paragraph
    : kind.startsWith('heading-') ? nodes.heading
      : kind === 'code-block' ? nodes.code_block ?? nodes.codeBlock : undefined;
  if (textType) {
    const converted: ProseNode[] = [];
    for (const node of blocks) {
      // Flattening containers or stripping marks/inline atoms is not lossless.
      if (!node.isTextblock || !textType.validContent(node.content)) return null;
      converted.push(textType.createChecked(
        { ...node.attrs, ...(kind.startsWith('heading-') ? { level: Number(kind.slice(-1)) } : {}) },
        node.content, node.marks,
      ));
    }
    return Fragment.fromArray(converted);
  }
  if (kind === 'bullet-list' || kind === 'ordered-list' || kind === 'task-list') {
    const list = kind === 'ordered-list' ? nodes.ordered_list ?? nodes.orderedList : nodes.bullet_list ?? nodes.bulletList;
    const item = nodes.list_item ?? nodes.listItem;
    if (!list || !item || (kind === 'task-list' && !('checked' in (item.spec.attrs ?? {})))) return null;
    const items = blocks.map((node) => item.createChecked({
      ...(isListItem(node) ? node.attrs : {}),
      listType: kind === 'ordered-list' ? 'ordered' : 'bullet',
      label: kind === 'ordered-list' ? '1.' : '•',
      checked: kind === 'task-list' ? (node.attrs.checked ?? false) : null,
    }, isListItem(node) ? node.content : Fragment.from(
      node.isTextblock && node.type !== nodes.paragraph
        ? nodes.paragraph.createChecked(null, node.content, node.marks) : node,
    )));
    return Fragment.from(list.createChecked(null, items));
  }
  const wrapper = kind === 'quote' ? nodes.blockquote : kind === 'callout' ? nodes.callout : kind === 'toggle' ? nodes.toggle : undefined;
  if (!wrapper) return null;
  return Fragment.from(wrapper.createChecked(null, Fragment.fromArray([...blocks])));
}

export function turnCrepeBlockInto(view: EditorView, input: BlockInput, kind: CrepeBlockTurnInto): boolean {
  const target = resolveBlockCommandTarget(view, input);
  if (!target || !view.editable) return false;
  return atomicChange(view, () => {
    const $pos = target.doc.resolve(target.pos);
    let blocks = [...target.nodes];
    const listItems = blocks.every(isListItem);
    const toList = kind === 'bullet-list' || kind === 'ordered-list' || kind === 'task-list';
    if (listItems && toList) {
      const listName = $pos.parent.type.name;
      const sameList = kind === 'ordered-list' ? ['ordered_list', 'orderedList'].includes(listName)
        : ['bullet_list', 'bulletList'].includes(listName);
      const sameCheck = blocks.every((node) => kind === 'task-list'
        ? node.attrs.checked != null : node.attrs.checked == null);
      if (sameList && sameCheck) return false;
    }
    if (listItems && !toList) blocks = blocks.flatMap((item) => Array.from({ length: item.childCount }, (_, i) => item.child(i)));
    const textConversion = kind === 'paragraph' || kind.startsWith('heading-') || kind === 'code-block';
    let converted: Fragment | null;
    if (listItems && textConversion) {
      // Convert each direct text block and retain sublists/other nested content intact.
      converted = Fragment.empty;
      for (const block of blocks) {
        const part = block.isTextblock ? convertBlocks(view.state.schema, [block], kind) : Fragment.from(block);
        if (!part) return false;
        converted = converted.append(part);
      }
    } else converted = convertBlocks(view.state.schema, blocks, kind);
    if (!converted) return false;
    if (listItems) {
      // Split only the containing list around the selected items. Siblings and nested lists survive.
      const list = $pos.parent;
      const before = list.content.cut(0, target.pos - $pos.start());
      const after = list.content.cut(target.to - $pos.start());
      let replacement = before.size ? Fragment.from(list.copy(before)) : Fragment.empty;
      replacement = replacement.append(converted);
      if (after.size) replacement = replacement.append(Fragment.from(list.type.createChecked({
        ...list.attrs,
        ...('order' in list.attrs ? { order: list.attrs.order + target.toIndex } : {}),
      }, after, list.marks)));
      const start = $pos.before($pos.depth);
      return replace(view, start, start + list.nodeSize, replacement, start + (before.size ? before.size + 2 : 0) + 1);
    }
    const caretOffset = view.state.selection.empty
      && view.state.selection.from > target.pos && view.state.selection.from < target.to
      ? view.state.selection.from - target.pos : 1;
    return replace(view, target.pos, target.to, converted,
      target.pos + Math.min(caretOffset, converted.size - 1));
  });
}

/** Formatting buttons retain their toggle behavior while sharing the same target
 * and exact, single-transaction replacement as the block menu. */
export function toggleCrepeBlockFormat(view: EditorView, target: BlockTarget,
  kind: 'bullet-list' | 'ordered-list' | 'task-list' | 'quote'): boolean {
  if (!view.editable || !isBlockTargetCurrent(view, target)) return false;
  const $pos = target.doc.resolve(target.pos);
  const parent = $pos.parent;
  if (target.nodes.every(isListItem)) {
    const active = kind === 'task-list' ? target.nodes.every((node) => node.attrs.checked != null)
      : kind === 'ordered-list' ? ['ordered_list', 'orderedList'].includes(parent.type.name)
        : kind === 'bullet-list' && ['bullet_list', 'bulletList'].includes(parent.type.name)
          && target.nodes.every((node) => node.attrs.checked == null);
    if (active) return turnCrepeBlockInto(view, target, 'paragraph');
  }
  if (kind === 'quote' && parent.type.name === 'blockquote') {
    return atomicChange(view, () => {
      const before = parent.content.cut(0, target.pos - $pos.start());
      const after = parent.content.cut(target.to - $pos.start());
      const content = (before.size ? Fragment.from(parent.copy(before)) : Fragment.empty)
        .append(Fragment.fromArray([...target.nodes]))
        .append(after.size ? Fragment.from(parent.copy(after)) : Fragment.empty);
      const pos = $pos.before($pos.depth);
      return replace(view, pos, pos + parent.nodeSize, content, pos + (before.size ? before.size + 2 : 0) + 1);
    });
  }
  return turnCrepeBlockInto(view, target, kind);
}

/** Same-container sibling move, including a captured multi-block range. */
export function moveCrepeBlocks(view: EditorView, target: BlockTarget, insertPos: number): boolean {
  if (!view.editable || !isBlockTargetCurrent(view, target)) return false;
  if (insertPos >= target.pos && insertPos <= target.to) return false;
  return atomicChange(view, () => {
    const $from = target.doc.resolve(target.pos);
    const $insert = target.doc.resolve(insertPos);
    if ($from.parent !== $insert.parent || $from.start() !== $insert.start() || $insert.textOffset) return false;
    const parent = $from.parent;
    const siblings = Array.from({ length: parent.childCount }, (_, i) => parent.child(i));
    siblings.splice(target.fromIndex, target.nodes.length);
    const index = $insert.index() - (insertPos > target.to ? target.nodes.length : 0);
    siblings.splice(index, 0, ...target.nodes);
    const content = Fragment.fromArray(siblings);
    if (!parent.type.validContent(content)) return false;
    return replace(view, $from.start(), $from.end(), content,
      insertPos > target.to ? insertPos - (target.to - target.pos) + 1 : insertPos + 1);
  });
}

/** Shared by the block entry points and the mobile menu/format controls. */
export const crepeBlockCommands = {
  paragraph: (view: EditorView, target: BlockInput) => turnCrepeBlockInto(view, target, 'paragraph'),
  'heading-1': (view: EditorView, target: BlockInput) => turnCrepeBlockInto(view, target, 'heading-1'),
  'heading-2': (view: EditorView, target: BlockInput) => turnCrepeBlockInto(view, target, 'heading-2'),
  'heading-3': (view: EditorView, target: BlockInput) => turnCrepeBlockInto(view, target, 'heading-3'),
  'bullet-list': (view: EditorView, target: BlockInput) => turnCrepeBlockInto(view, target, 'bullet-list'),
  'ordered-list': (view: EditorView, target: BlockInput) => turnCrepeBlockInto(view, target, 'ordered-list'),
  'task-list': (view: EditorView, target: BlockInput) => turnCrepeBlockInto(view, target, 'task-list'),
  quote: (view: EditorView, target: BlockInput) => turnCrepeBlockInto(view, target, 'quote'),
  'code-block': (view: EditorView, target: BlockInput) => turnCrepeBlockInto(view, target, 'code-block'),
  callout: (view: EditorView, target: BlockInput) => turnCrepeBlockInto(view, target, 'callout'),
  toggle: (view: EditorView, target: BlockInput) => turnCrepeBlockInto(view, target, 'toggle'),
  duplicate: duplicateCrepeBlock,
  delete: deleteCrepeBlock,
} satisfies Record<string, (view: EditorView, target: BlockInput) => boolean>;
