import { describe, expect, it, vi } from 'vitest';
import { NodeSelection, TextSelection } from '@milkdown/prose/state';
import { undo, undoDepth } from '@milkdown/prose/history';
import {
  deleteCrepeBlock, duplicateCrepeBlock, moveCrepeBlocks, toggleCrepeBlockFormat, turnCrepeBlockInto,
} from '../blockMenuCommands';
import { resolveBlockSelection, resolveBlockTarget } from '../blockTarget';
import { bullet, doc, item, p, schema, testView, textPos, wrap } from './blockCommandFixtures';

describe('runtime BlockTarget commands', () => {
  it.each(['blockquote', 'callout', 'toggle'])('deletes only the nearest content block in %s', (type) => {
    const original = doc(wrap(type, p('one'), p('two')), p('outside'));
    const view = testView(original, textPos(original, 'two'));
    const target = resolveBlockSelection(view)!;
    expect(target).toMatchObject({ view, doc: original, type: 'paragraph', depth: 2, parentPos: 0 });
    expect(deleteCrepeBlock(view, target)).toBe(true);
    expect(view.state.doc.eq(doc(wrap(type, p('one')), p('outside')))).toBe(true);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(undoDepth(view.state)).toBe(1);
    undo(view.state, view.dispatch);
    expect(view.state.doc.eq(original)).toBe(true);
  });

  it('all operations resolve a direct list paragraph to the same nearest list item', () => {
    const original = doc(bullet(item(p('outer'), bullet(item(p('nested')), item(p('sibling')))), item(p('last'))));
    const pos = textPos(original, 'nested');
    for (const action of ['duplicate', 'delete', 'convert'] as const) {
      const view = testView(original, pos);
      const target = resolveBlockSelection(view)!;
      expect(target.type).toBe('list_item');
      expect(target.depth).toBe(4);
      if (action === 'duplicate') expect(duplicateCrepeBlock(view, pos)).toBe(true);
      if (action === 'delete') expect(deleteCrepeBlock(view, pos)).toBe(true);
      if (action === 'convert') expect(turnCrepeBlockInto(view, pos, 'heading-2')).toBe(true);
      expect(view.state.doc.firstChild!.childCount).toBe(2);
      expect(view.state.doc.textContent).toContain('outer');
      expect(view.state.doc.textContent).toContain('sibling');
      expect(view.state.doc.textContent).toContain('last');
      expect(view.dispatch).toHaveBeenCalledTimes(1);
      undo(view.state, view.dispatch);
      expect(view.state.doc.eq(original)).toBe(true);
    }
  });

  it('list item conversion retains sublists, other items and surrounding callout attributes', () => {
    const original = doc(schema.node('callout', { title: 'keep me', type: 'warning' }, [
      bullet(item(p('before')), item(p('chosen'), bullet(item(p('child')))), item(p('after'))),
    ]));
    const view = testView(original, textPos(original, 'chosen'));
    expect(turnCrepeBlockInto(view, resolveBlockSelection(view)!, 'heading-2')).toBe(true);
    const callout = view.state.doc.firstChild!;
    expect(callout.attrs).toEqual(original.firstChild!.attrs);
    expect(callout.child(0).eq(bullet(item(p('before'))))).toBe(true);
    expect(callout.child(1).type.name).toBe('heading');
    expect(callout.child(2).eq(bullet(item(p('child'))))).toBe(true);
    expect(callout.child(3).eq(bullet(item(p('after'))))).toBe(true);
  });

  it('converts only selected list items to tasks, retaining their children and siblings', () => {
    const original = doc(bullet(item(p('one')), item(p('two')), item(p('three'))));
    const view = testView(original, textPos(original, 'two'));
    expect(turnCrepeBlockInto(view, resolveBlockSelection(view)!, 'task-list')).toBe(true);
    expect(view.state.doc.child(0).firstChild!.attrs.checked).toBe(null);
    expect(view.state.doc.child(1).firstChild!.attrs.checked).toBe(false);
    expect(view.state.doc.child(2).firstChild!.attrs.checked).toBe(null);
    expect(view.state.doc.textContent).toBe(original.textContent);
  });

  it('removes an empty list without deleting the containing toggle', () => {
    const original = doc(wrap('toggle', bullet(item(p('only')))), p('outside'));
    const view = testView(original, textPos(original, 'only'));
    expect(deleteCrepeBlock(view, resolveBlockSelection(view)!)).toBe(true);
    expect(view.state.doc.eq(doc(wrap('toggle', p()), p('outside')))).toBe(true);
  });

  it('deletes the sole document block with a valid empty paragraph', () => {
    const view = testView(doc(p('only')));
    expect(deleteCrepeBlock(view, 0)).toBe(true);
    expect(view.state.doc.eq(doc(p()))).toBe(true);
  });

  it('keeps table-cell operations inside that cell', () => {
    const original = doc(wrap('table', wrap('table_row', wrap('table_cell', p('left')), wrap('table_cell', p('right')))));
    const view = testView(original, textPos(original, 'left'));
    expect(deleteCrepeBlock(view, resolveBlockSelection(view)!)).toBe(true);
    expect(view.state.doc.firstChild!.firstChild!.firstChild!.firstChild!.eq(p())).toBe(true);
    expect(view.state.doc.textContent).toBe('right');
  });

  it('rejects ambiguous legacy container coordinates instead of deleting a top-level ancestor', () => {
    const view = testView(doc(wrap('blockquote', p('one'), p('two'))), 2);
    expect(deleteCrepeBlock(view, 0)).toBe(false);
    expect(duplicateCrepeBlock(view, 0)).toBe(false);
    expect(turnCrepeBlockInto(view, 0, 'heading-1')).toBe(false);
    expect(view.dispatch).not.toHaveBeenCalled();
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)));
    expect(deleteCrepeBlock(view, 0)).toBe(true);
  });

  it('rejects stale and foreign-view targets, including equal documents with different identity', () => {
    const original = doc(p('old'));
    const view = testView(original);
    const target = resolveBlockSelection(view)!;
    expect(deleteCrepeBlock(testView(original), target)).toBe(false);
    view.state = testView(doc(p('old'))).state;
    expect(view.state.doc.eq(original)).toBe(true);
    expect(deleteCrepeBlock(view, target)).toBe(false);
    view.dispatch(view.state.tr.insertText('new'));
    vi.mocked(view.dispatch).mockClear();
    expect(deleteCrepeBlock(view, target)).toBe(false);
    expect(moveCrepeBlocks(view, target, 0)).toBe(false);
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(resolveBlockTarget(view, -1)).toBeNull();
    expect(resolveBlockTarget(view, 999)).toBeNull();
  });

  it('unsupported or lossy conversion leaves document, selection and history untouched', () => {
    const rich = schema.node('paragraph', null, [schema.text('bold', [schema.mark('strong')]), schema.node('image', { src: 'asset' })]);
    const original = doc(wrap('toggle', rich));
    const view = testView(original, 2);
    const state = view.state;
    expect(turnCrepeBlockInto(view, resolveBlockSelection(view)!, 'code-block')).toBe(false);
    expect(view.state).toBe(state);
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(undoDepth(view.state)).toBe(0);
    const wrapper = resolveBlockTarget(view, 0)!;
    expect(turnCrepeBlockInto(view, wrapper, 'heading-1')).toBe(false);
    expect(view.state).toBe(state);
  });

  it('selection-only transactions keep targets valid and successful conversion is one undo step', () => {
    const original = doc(p('hello'));
    const view = testView(original, 3);
    const target = resolveBlockSelection(view)!;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(original, 4)));
    vi.mocked(view.dispatch).mockClear();
    expect(turnCrepeBlockInto(view, target, 'heading-2')).toBe(true);
    expect(view.state.selection.from).toBe(4);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(undoDepth(view.state)).toBe(1);
    undo(view.state, view.dispatch);
    expect(view.state.doc.eq(original)).toBe(true);
  });

  it('a later incompatible block rejects the entire range conversion without a partial edit', () => {
    const original = doc(p('plain'), schema.node('paragraph', null, schema.text('rich', [schema.mark('strong')])));
    const view = testView(original, 1, original.content.size - 1);
    expect(turnCrepeBlockInto(view, resolveBlockSelection(view)!, 'code-block')).toBe(false);
    expect(view.state.doc).toBe(original);
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(undoDepth(view.state)).toBe(0);
  });

  it('format no-ops and read-only commands leave no undo entry', () => {
    const view = testView(doc(bullet(item(p('a')), item(p('b')))), 3);
    const target = resolveBlockSelection(view)!;
    expect(turnCrepeBlockInto(view, target, 'bullet-list')).toBe(false);
    Object.defineProperty(view, 'editable', { value: false });
    expect(deleteCrepeBlock(view, target)).toBe(false);
    expect(duplicateCrepeBlock(view, target)).toBe(false);
    expect(turnCrepeBlockInto(view, target, 'heading-1')).toBe(false);
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(undoDepth(view.state)).toBe(0);
  });

  it('supports same-container ranges for duplicate, delete, convert and move', () => {
    const original = doc(wrap('callout', p('a'), p('b'), p('c'), p('d')));
    for (const operation of ['duplicate', 'delete', 'convert', 'move'] as const) {
      const view = testView(original, textPos(original, 'b'), textPos(original, 'd') - 1);
      const target = resolveBlockSelection(view)!;
      expect(target.nodes.map((node) => node.textContent)).toEqual(['b', 'c']);
      if (operation === 'duplicate') expect(duplicateCrepeBlock(view, target)).toBe(true);
      if (operation === 'delete') expect(deleteCrepeBlock(view, target)).toBe(true);
      if (operation === 'convert') expect(turnCrepeBlockInto(view, target, 'heading-2')).toBe(true);
      if (operation === 'move') expect(moveCrepeBlocks(view, target, 1)).toBe(true);
      const expected = { duplicate: 'abcbcd', delete: 'ad', convert: 'abcd', move: 'bcad' }[operation];
      expect(view.state.doc.textContent).toBe(expected);
      expect(view.state.doc.firstChild!.type.name).toBe('callout');
      expect(view.dispatch).toHaveBeenCalledTimes(1);
      undo(view.state, view.dispatch);
      expect(view.state.doc.eq(original)).toBe(true);
    }
  });

  it('moves down, preserves task attributes, and rejects cross-container/interior/no-op drops', () => {
    const task = schema.node('list_item', { checked: true }, p('a'));
    const original = doc(bullet(task, item(p('b')), item(p('c'))), p('outside'));
    const view = testView(original, textPos(original, 'a'));
    const target = resolveBlockSelection(view)!;
    expect(moveCrepeBlocks(view, target, target.pos)).toBe(false);
    expect(moveCrepeBlocks(view, target, target.to)).toBe(false);
    expect(moveCrepeBlocks(view, target, target.pos + 1)).toBe(false);
    expect(moveCrepeBlocks(view, target, original.content.size)).toBe(false);
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(moveCrepeBlocks(view, target, original.firstChild!.nodeSize - 1)).toBe(true);
    expect(view.state.doc.firstChild!.lastChild!.eq(task)).toBe(true);
    expect(view.state.doc.textContent).toBe('bcaoutside');
  });

  it('refuses to widen selections across containers', () => {
    const original = doc(wrap('callout', p('inside')), p('outside'));
    const view = testView(original, textPos(original, 'inside'), textPos(original, 'outside') + 2);
    expect(resolveBlockSelection(view)).toBeNull();
  });

  it('mobile list/quote formatting toggles preserve neighboring content', () => {
    const original = doc(wrap('blockquote', p('a'), p('b'), p('c')));
    const view = testView(original, textPos(original, 'b'));
    expect(toggleCrepeBlockFormat(view, resolveBlockSelection(view)!, 'quote')).toBe(true);
    expect(view.state.doc.eq(doc(wrap('blockquote', p('a')), p('b'), wrap('blockquote', p('c'))))).toBe(true);
    const listView = testView(doc(bullet(item(p('a')), item(p('b')))), 3);
    expect(toggleCrepeBlockFormat(listView, resolveBlockSelection(listView)!, 'bullet-list')).toBe(true);
    expect(listView.state.doc.eq(doc(p('a'), bullet(item(p('b')))))).toBe(true);
  });
});
