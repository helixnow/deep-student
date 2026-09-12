import type { EditorState } from '@milkdown/prose/state';

/** Shared by the fixed, overflow and mobile formatting controls. */
export type CrepeFormattingState = Partial<Record<
  'bold' | 'italic' | 'strikethrough' | 'code' | 'h1' | 'h2' | 'h3' |
  'bullet' | 'ordered' | 'task' | 'quote' | 'link', boolean
>>;

export function readFormattingState(state: EditorState): CrepeFormattingState {
  const { from, to, empty, $from } = state.selection;
  const marks = state.storedMarks ?? $from.marks();
  const hasMark = (...names: string[]) => names.some((name) => {
    const type = state.schema.marks[name];
    return type && (empty ? !!type.isInSet(marks) : state.doc.rangeHasMark(from, to, type));
  });
  const ancestors = Array.from({ length: $from.depth + 1 }, (_, depth) => $from.node(depth));
  const hasNode = (name: string) => ancestors.some((node) => node.type.name === name);
  const task = ancestors.some((node) =>
    node.type.name === 'task_item' || node.type.name === 'task_list' ||
    (node.type.name === 'list_item' && typeof node.attrs.checked === 'boolean'));
  const heading = $from.parent.type.name === 'heading' ? Number($from.parent.attrs.level) : 0;
  return {
    bold: hasMark('strong'), italic: hasMark('emphasis', 'em'),
    strikethrough: hasMark('strike_through', 'strikethrough'), code: hasMark('inlineCode', 'code'),
    h1: heading === 1, h2: heading === 2, h3: heading === 3,
    bullet: hasNode('bullet_list') && !task, ordered: hasNode('ordered_list'),
    task, quote: hasNode('blockquote'), link: hasMark('link'),
  };
}
