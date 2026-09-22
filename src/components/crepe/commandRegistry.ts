import type { Ctx } from '@milkdown/ctx';
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core';
import { $command, $prose } from '@milkdown/utils';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { EditorState, Plugin, NodeSelection, Selection, TextSelection, type Command, type Transaction } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { closeHistory, undo, redo } from '@milkdown/prose/history';
import { toggleMark } from '@milkdown/prose/commands';
import { sinkListItem, liftListItem } from '@milkdown/prose/schema-list';
import { toggleStrongCommand, toggleEmphasisCommand, toggleInlineCodeCommand,
  insertHrCommand, addBlockTypeCommand } from '@milkdown/kit/preset/commonmark';
import { toggleStrikethroughCommand, insertTableCommand } from '@milkdown/kit/preset/gfm';
import { linkTooltipAPI } from '@milkdown/kit/component/link-tooltip';
import { crepeBlockCommands, toggleCrepeBlockFormat, type CrepeBlockTurnInto } from './blockMenuCommands';
import { isBlockTargetCurrent, resolveBlockSelection, resolveBlockTarget, type BlockTarget } from './blockTarget';
import { createToggleNode } from './plugins/toggle';
import { createColumnsValidator, columnsKey, canWriteColumns, containsColumns } from './plugins/columns';
import { noteLayoutCommand, type NoteLayoutAction } from '@/features/notes/components/NoteLayoutCommands';
import { copyBlockWithFreshIdentity } from './plugins/blockIdentity';

export const LAYOUT_COMMANDS: readonly NoteLayoutAction[] = ['insert-columns', 'insert-cornell',
  'convert-columns', 'convert-cornell', 'convert-cornell-template', 'unwrap-columns'];
export type CrepeCommandId = CrepeBlockTurnInto | NoteLayoutAction | 'duplicate' | 'delete'
  | 'bold' | 'italic' | 'strikethrough' | 'inline-code' | 'link' | 'image' | 'table' | 'hr'
  | 'insert-toggle' | 'insert-callout' | 'inline-math' | 'math' | 'indent' | 'outdent' | 'undo' | 'redo' | 'wikilink';
export interface CrepeCommandRequest {
  target?: BlockTarget;
  /** Block menus turn into a type; formatting controls toggle active wrappers. */
  toggle?: boolean;
  /** Remove only the current slash query in the same transaction as the command. */
  slash?: boolean;
  href?: string;
  text?: string;
  src?: string;
  alt?: string;
}
export interface CrepeCommandHost {
  ctx?: Ctx;
  isReviewActive?: () => boolean;
  canWriteLayout?: () => boolean;
  requestLayoutCapability?: () => Promise<boolean>;
  onError?: (error: unknown) => void;
}
const hosts = new WeakMap<EditorView, CrepeCommandHost>();
const observers = new WeakMap<EditorView, Set<() => void>>();
export function notifyCrepeCommandState(view: EditorView | null): void { if (view) observers.get(view)?.forEach(listener => listener()); }
export function subscribeCrepeCommandState(view: EditorView, listener: () => void): () => void {
  const listeners = observers.get(view) ?? new Set();
  observers.set(view, listeners); listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const validateColumns = createColumnsValidator();
const previewLayoutCapability = new Plugin({
  key: columnsKey,
  state: { init: () => ({ canWrite: () => true }), apply: (_tr, value) => value },
});
export function bindCrepeCommandHost(view: EditorView, host: CrepeCommandHost): () => void {
  hosts.set(view, host);
  notifyCrepeCommandState(view);
  return () => { if (hosts.get(view) === host) hosts.delete(view); };
}
export const isLayoutCommand = (id: string): id is NoteLayoutAction => LAYOUT_COMMANDS.includes(id as NoteLayoutAction);
export const canEditCrepeView = (view: EditorView) => !view.isDestroyed && view.editable
  && !view.dom.inert && !hosts.get(view)?.isReviewActive?.();

function registered(view: EditorView, key: string | { name: string } | undefined, fallback: Command, payload?: unknown): Command {
  const ctx = hosts.get(view)?.ctx;
  if (ctx && key) {
    try { return ctx.get(commandsCtx).get(key as string)(payload); } catch { /* standalone PM hosts use the same native command */ }
  }
  return fallback;
}
const markNames = { bold: ['strong'], italic: ['emphasis', 'em'], strikethrough: ['strike_through', 'strikethrough'], 'inline-code': ['inlineCode', 'code'] };
const markCommands = { bold: toggleStrongCommand, italic: toggleEmphasisCommand,
  strikethrough: toggleStrikethroughCommand, 'inline-code': toggleInlineCodeCommand };

function inheritLayoutIdentity(before: ProseNode, tr: Transaction): void {
  // Replacing several roots with a layout keeps the first root's ID. Insertion
  // after a nonempty root is not a replacement and gets a fresh ID from the plugin.
  for (const step of tr.steps) {
    const range = step as unknown as { from?: number; to?: number };
    if (range.from == null || range.to == null || range.to <= range.from) continue;
    if (before.resolve(range.from).depth !== 0) continue;
    const id = before.nodeAt(range.from)?.attrs.dsBlockId;
    const node = tr.doc.nodeAt(range.from);
    if (id && node && 'dsBlockId' in node.attrs) tr.setNodeMarkup(range.from, undefined, { ...node.attrs, dsBlockId: id });
    break;
  }
}

/** Prepare against an immutable projection; canExecute never dispatches or moves focus. */
function prepare(view: EditorView, id: CrepeCommandId, request: CrepeCommandRequest = {}, initial = view.state): Transaction | null {
  if (!canEditCrepeView(view) || (request.target && !isBlockTargetCurrent(view, request.target))) return null;
  let state = initial;
  let prefix: Transaction | null = null;
  if (request.slash) {
    const { $from, empty } = state.selection;
    if (!empty || $from.parent.type.name !== 'paragraph') return null;
    const query = $from.parent.textBetween(0, $from.parentOffset);
    if (!/^\/[^\n]*$/.test(query)) return null;
    prefix = state.tr.delete($from.start(), $from.pos);
    state = state.apply(prefix);
  }
  if (request.target && !request.slash) {
    const target = request.target;
    const selection = target.nodes.length === 1 && NodeSelection.isSelectable(target.nodes[0])
      ? NodeSelection.create(state.doc, target.pos)
      : TextSelection.between(state.doc.resolve(target.pos + 1), state.doc.resolve(target.to - 1));
    state = state.apply(state.tr.setSelection(selection));
  }
  const projection = Object.create(view) as EditorView;
  Object.defineProperty(projection, 'state', { value: state });
  let output: Transaction | null = null;
  const capture = (tr: Transaction) => { output = tr; };
  Object.defineProperty(projection, 'dispatch', { value: capture });
  Object.defineProperty(projection, 'focus', { value: () => {} });
  const target = resolveBlockSelection(projection);
  let applied = false;
  if (id in crepeBlockCommands) {
    if (!target) return null;
    applied = request.toggle && ['bullet-list', 'ordered-list', 'task-list', 'quote'].includes(id)
      ? toggleCrepeBlockFormat(projection, target, id as 'bullet-list' | 'ordered-list' | 'task-list' | 'quote')
      : crepeBlockCommands[id as keyof typeof crepeBlockCommands](projection, target);
  } else if (isLayoutCommand(id)) {
    applied = noteLayoutCommand(id)(state, capture, projection);
    if (output) inheritLayoutIdentity(state.doc, output);
  } else if (id in markNames) {
    if (state.selection.$from.parent.type.name === 'toggleTitle' || state.selection.$to.parent.type.name === 'toggleTitle') return null;
    const name = id as keyof typeof markNames;
    const mark = markNames[name].map(key => state.schema.marks[key]).find(Boolean);
    if (!mark) return null;
    applied = registered(view, markCommands[name].key, toggleMark(mark))(state, capture, projection);
  } else {
    const nodes = state.schema.nodes;
    const insert: Command = (_state, dispatch) => {
      let node: ProseNode | null = null;
      if (id === 'insert-toggle') node = createToggleNode(state.schema);
      if (id === 'insert-callout') node = nodes.callout?.createAndFill();
      if (id === 'image') node = (nodes['image-block'] ?? nodes.image)?.createAndFill({ src: request.src ?? '', alt: request.alt ?? '', caption: '' });
      if (id === 'hr') node = (nodes.hr ?? nodes.horizontal_rule)?.createAndFill();
      if (id === 'math') node = nodes.code_block?.createAndFill({ language: 'LaTeX' });
      if (!node) return false;
      return registered(view, addBlockTypeCommand.key, (_s, d) => { d?.(state.tr.replaceSelectionWith(node!)); return true; }, { nodeType: node })(state, dispatch, projection);
    };
    if (['insert-toggle', 'insert-callout', 'image', 'math'].includes(id)) applied = insert(state, capture, projection);
    else if (id === 'hr') applied = registered(view, insertHrCommand.key, insert)(state, capture, projection);
    else if (id === 'table') applied = registered(view, insertTableCommand.key, () => false, { row: 2, col: 3 })(state, capture, projection);
    else if (id === 'inline-math') applied = registered(view, 'ToggleLatex', () => false)(state, capture, projection);
    else if (id === 'undo' || id === 'redo') applied = (id === 'undo' ? undo : redo)(state, capture, projection);
    else if (id === 'indent' || id === 'outdent') {
      const item = nodes.list_item ?? nodes.listItem;
      applied = Boolean(item && (id === 'indent' ? sinkListItem(item) : liftListItem(item))(state, capture, projection));
    } else if (id === 'wikilink') { capture(state.tr.insertText('[[')); applied = true; }
    else if (id === 'link' && request.href?.trim()) {
      const mark = state.schema.marks.link;
      if (!mark || !state.selection.$from.parent.type.allowsMarkType(mark)) return null;
      const href = request.href.trim();
      const tr = state.tr;
      if (state.selection.empty) {
        const text = request.text || href;
        tr.insertText(text).addMark(state.selection.from, state.selection.from + text.length, mark.create({ href }));
      } else tr.addMark(state.selection.from, state.selection.to, mark.create({ href }));
      capture(tr); applied = true;
    }
  }
  if (!applied || !output) return null;
  let tr = output as Transaction;
  if (prefix) {
    for (const step of tr.steps) prefix.step(step);
    prefix.setSelection(Selection.fromJSON(prefix.doc, tr.selection.toJSON()));
    prefix.setStoredMarks(tr.storedMarks);
    tr = closeHistory(prefix);
  }
  tr.doc.check();
  if (!validateColumns(tr.doc)) return null;
  if (tr.docChanged && !canWriteColumns(state)
    && (containsColumns(state.doc.content) || containsColumns(tr.doc.content))) return null;
  return tr;
}

function canRequestLayout(view: EditorView, id: NoteLayoutAction, request: CrepeCommandRequest): boolean {
  if (!hosts.get(view)?.requestLayoutCapability || !canEditCrepeView(view)) return false;
  // Ask the real command whether this selection would work after opt-in. The
  // prospective capability exists only in this disposable state, never the editor.
  const { doc, selection, storedMarks } = view.state;
  const prospective = EditorState.create({ doc, selection, storedMarks, plugins: [previewLayoutCapability] });
  return Boolean(prepare(view, id, request, prospective));
}
export function canExecuteCrepeCommand(view: EditorView, id: CrepeCommandId, request: CrepeCommandRequest = {}): boolean {
  try {
    if (!canEditCrepeView(view)) return false;
    if (id === 'link' && !request.href) return Boolean(hosts.get(view)?.ctx && view.state.schema.marks.link
      && view.state.selection.$from.parent.type.allowsMarkType(view.state.schema.marks.link));
    if (isLayoutCommand(id) && !hosts.get(view)?.canWriteLayout?.()) return canRequestLayout(view, id, request);
    return Boolean(prepare(view, id, request));
  } catch { return false; }
}
export function runCrepeCommand(view: EditorView, id: CrepeCommandId, request: CrepeCommandRequest = {}): boolean {
  if (!canEditCrepeView(view)) return false;
  try {
    if (id === 'link' && !request.href) {
      if (!canExecuteCrepeCommand(view, id, request)) return false;
      hosts.get(view)!.ctx!.get(linkTooltipAPI.key).addLink(view.state.selection.from, view.state.selection.to);
      return true;
    }
    const tr = prepare(view, id, request);
    if (!tr) return false;
    view.dispatch(tr.scrollIntoView()); view.focus();
    return !tr.docChanged || view.state.doc.eq(tr.doc) || view.state.doc !== tr.before;
  } catch (error) { hosts.get(view)?.onError?.(error); return false; }
}
export async function executeCrepeCommand(view: EditorView, id: CrepeCommandId, request: CrepeCommandRequest = {}): Promise<boolean> {
  if (!canExecuteCrepeCommand(view, id, request)) return false;
  const host = hosts.get(view);
  if (isLayoutCommand(id) && !host?.canWriteLayout?.()) {
    const doc = view.state.doc, selection = view.state.selection;
    if (!await host?.requestLayoutCapability?.() || view.isDestroyed || hosts.get(view) !== host || !canEditCrepeView(view)) return false;
    if (view.state.doc === doc && !request.target && !selection.eq(view.state.selection)) return false;
    if (view.state.doc !== doc) {
      if (!copyBlockWithFreshIdentity(doc, false).eq(copyBlockWithFreshIdentity(view.state.doc, false))) return false;
      if (request.target) {
        const first = resolveBlockTarget(view, request.target.pos);
        if (!first) return false;
        request = { ...request, target: { ...first, nodes: request.target.nodes.map((_, i) => view.state.doc.child(first.fromIndex + i)),
          to: request.target.to, toIndex: request.target.toIndex } };
      } else view.dispatch(view.state.tr.setSelection(Selection.fromJSON(view.state.doc, selection.toJSON())));
    }
  }
  return runCrepeCommand(view, id, request);
}

/** One registered Milkdown command, shared by toolbar, bubble, block, mobile and slash. */
export const crepeExecuteCommand = $command('DsCrepeExecute', ctx =>
  (payload?: { id: CrepeCommandId; request?: CrepeCommandRequest }) => (_state, dispatch, view) => {
    if (!payload) return false;
    const current = view ?? ctx.get(editorViewCtx);
    return dispatch ? runCrepeCommand(current, payload.id, payload.request) : canExecuteCrepeCommand(current, payload.id, payload.request);
  });

export const crepeCommandBindingsPlugin = $prose(ctx => new Plugin({
  view(view) {
    const dispose = bindCrepeCommandHost(view, { ctx, canWriteLayout: () => canWriteColumns(view.state) });
    return { destroy: dispose, update: () => notifyCrepeCommandState(view) };
  },
}));
