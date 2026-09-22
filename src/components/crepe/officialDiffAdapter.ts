import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { commandsCtx, editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core';
import { diffComponent, diffComponentConfig } from '@milkdown/kit/component/diff';
import { acceptAllDiffsCmd, clearDiffReviewCmd, diff, diffPluginKey, getPendingChanges, startDiffReviewFromDocCmd } from '@milkdown/kit/plugin/diff';
import { Fragment, type Node as ProseNode } from '@milkdown/prose/model';
import { Transform } from '@milkdown/prose/transform';
import type { Transaction } from '@milkdown/prose/state';
import { calloutPlugin } from './plugins/callout';
import { togglePlugin } from './plugins/toggle';
import { wikilinkSchema } from './plugins/wikilink/schema';
import { remarkWikilinkPlugin } from './plugins/wikilink/remark';
import { blockIdentityPlugin } from './plugins/blockIdentity';
import { columnsSchema, columnSchema } from './plugins/columns/schema';
import { remarkColumnsPlugin } from './plugins/columns/remark';
import { COLUMNS_TYPE } from './plugins/columns/format';
import type { OfficialReviewControls, OfficialReviewDecision } from '@/features/notes/officialDiffContract';
import { assertNoteContentSize } from '@/features/notes/fullDocument';

/** Repair the upstream 7.22.1 image parser's null title, recursively, before doc.check. */
export function normalizeOfficialDiffDoc(node: ProseNode): ProseNode {
  if (node.isText) return node;
  const children: ProseNode[] = [];
  node.forEach(child => children.push(normalizeOfficialDiffDoc(child)));
  return node.type.create(node.type.name === 'image-block' && node.attrs.caption == null
    ? { ...node.attrs, caption: '' } : node.attrs, Fragment.fromArray(children), node.marks);
}

/** Crepe's trailing plugin keeps a final empty paragraph as a layout placeholder.
 * It carries no user content, so review bookkeeping must not count it as a
 * pending change (otherwise "accept all" never reports the review as finished). */
export function withoutTrailingPlaceholderParagraph(node: ProseNode): ProseNode {
  const last = node.lastChild;
  if (!last || last.type.name !== 'paragraph' || last.content.size > 0) return node;
  return node.type.create(node.attrs, node.content.cut(0, node.content.size - last.nodeSize), node.marks);
}

/** The component's schema serializer doesn't run our NodeViews. Add read-only titles. */
export function renderOfficialDiffTitles(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('.milkdown-diff-added [data-type="toggle"], .milkdown-diff-added [data-type="callout"]').forEach(node => {
    if (node.querySelector(':scope > [data-review-title]')) return;
    const title = node.getAttribute('data-title') ?? node.getAttribute('data-callout-title');
    if (!title) return;
    const label = document.createElement('div');
    label.dataset.reviewTitle = 'true';
    label.className = 'font-medium';
    label.textContent = title;
    node.prepend(label);
  });
}

/**
 * Uses unmodified Milkdown plugin-diff and component/diff (MIT, Mirone).
 * No vendored upstream code. Commands run only in this disposable review projection.
 * The official component supplies its merged block range via transaction metadata;
 * no second grouping algorithm or pending filter exists here.
 */
export async function createOfficialDiffAdapter(options: {
  root: HTMLElement;
  baseline: string;
  target: string;
  onDecision: (decision: OfficialReviewDecision) => Promise<string | void>;
  onError: (error: unknown) => void;
}) {
  assertNoteContentSize(options.target);
  const crepe = new Crepe({ root: options.root, defaultValue: '', features: {
    [CrepeFeature.AI]: false, [CrepeFeature.Toolbar]: false,
    [CrepeFeature.BlockEdit]: false, [CrepeFeature.LinkTooltip]: false,
  } });
  crepe.editor.use(calloutPlugin()).use(togglePlugin()).use(diff).use(diffComponent);
  crepe.editor.use([remarkWikilinkPlugin, wikilinkSchema, remarkColumnsPlugin, columnsSchema, columnSchema].flat())
    .use(blockIdentityPlugin());
  crepe.editor.config(ctx => ctx.update(diffComponentConfig.key, value => ({ ...value,
    customBlockTypes: ['table', 'image-block', 'code_block', 'toggle', 'callout', COLUMNS_TYPE], acceptLabel: '接受此组', rejectLabel: '拒绝此组',
  })));
  await crepe.create();
  const view = crepe.editor.ctx.get(editorViewCtx);
  const commands = crepe.editor.ctx.get(commandsCtx);
  const serialize = crepe.editor.ctx.get(serializerCtx);
  const parse = (markdown: string) => {
    const parsed = crepe.editor.ctx.get(parserCtx)(markdown);
    if (!parsed) throw new Error('候选 Markdown 无法解析。');
    const doc = normalizeOfficialDiffDoc(parsed); doc.check(); return doc;
  };
  let target: ProseNode;
  try {
    target = parse(options.target);
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, parse(options.baseline).content));
  } catch (error) { await crepe.destroy(); throw error; }
  let busy = false, disposed = false, suspended = false;
  let operation: Promise<void> = Promise.resolve();
  const pending = () => {
    const state = diffPluginKey.getState(view.state);
    return state ? getPendingChanges(state) : [];
  };
  const decorate = () => {
    renderOfficialDiffTitles(options.root);
    options.root.querySelectorAll<HTMLButtonElement>('.milkdown-diff-controls button').forEach(button => { button.disabled = busy; });
  };
  const start = () => {
    if (suspended || disposed) return;
    commands.call(startDiffReviewFromDocCmd.key, target);
    if (!pending().length) commands.call(clearDiffReviewCmd.key);
    decorate();
  };
  const apply = (tr: Transaction) => { view.updateState(view.state.apply(tr)); decorate(); };
  const decide = async (tr: Transaction, action: { type: string; range?: OfficialReviewDecision['range']; changeIndex?: number; fromB?: number; toB?: number }) => {
    if (busy || disposed || suspended) return;
    busy = true; decorate();
    try {
      const state = diffPluginKey.getState(view.state);
      if (!state) return;
      const range = action.range ?? (action.changeIndex != null ? pending()[action.changeIndex] : undefined)
        ?? (action.type === 'reject' ? pending().find(c => c.fromB === action.fromB && c.toB === action.toB) : undefined);
      const rejection = action.type === 'reject' || action.type === 'rejectRange';
      const nextTarget = rejection && range
        ? new Transform(target).replace(range.fromB, range.toB, view.state.doc.slice(range.fromA, range.toA)).doc : target;
      // A pure deletion has an empty B interval. Withdrawing it from the target
      // avoids upstream isChangeRejected's strict non-empty intersection bug.
      if (rejection && !range) throw new Error('审阅分组已变化，请重新打开审阅。');
      const nextDoc = rejection ? view.state.doc : view.state.applyTransaction(tr).state.doc;
      nextDoc.check(); nextTarget.check();
      const { computeDocDiff } = await import('@milkdown/kit/plugin/diff');
      const decision: OfficialReviewDecision = { action: rejection ? 'reject' : 'accept',
        before: serialize(view.state.doc), after: serialize(nextDoc), target: serialize(nextTarget),
        remaining: computeDocDiff(
          withoutTrailingPlaceholderParagraph(nextDoc),
          withoutTrailingPlaceholderParagraph(nextTarget),
        ).length,
        range: range && { fromA: range.fromA, toA: range.toA, fromB: range.fromB, toB: range.toB },
      };
      const confirmed = await options.onDecision(decision);
      if (disposed) return;
      if (!rejection) apply(tr);
      if (typeof confirmed === 'string' && !rejection) {
        const actual = parse(confirmed);
        if (!actual.eq(view.state.doc)) apply(view.state.tr.replaceWith(0, view.state.doc.content.size, actual.content)
          .setMeta(diffPluginKey, { type: 'clear' }));
      }
      target = nextTarget;
      start();
    } finally { busy = false; if (!disposed) decorate(); }
  };
  view.setProps({ editable: () => false, dispatchTransaction: tr => {
    const action = tr.getMeta(diffPluginKey);
    if (action && ['accept', 'acceptRange', 'acceptAll', 'reject', 'rejectRange'].includes(action.type)) {
      operation = decide(tr, action);
      void operation.catch(options.onError);
    } else apply(tr);
  } });
  start();
  const controls: OfficialReviewControls = {
    async acceptAll() {
      if (busy) return operation;
      if (disposed || suspended) throw new Error('审阅已挂起。');
      if (!pending().length) {
        busy = true;
        try { await options.onDecision({ action: 'accept', before: serialize(view.state.doc), after: serialize(view.state.doc),
          target: serialize(view.state.doc), remaining: 0 }); }
        finally { busy = false; }
        return;
      }
      commands.call(acceptAllDiffsCmd.key); await operation;
    },
    async decideGroup(index, action) {
      if (busy) return operation;
      const button = options.root.querySelectorAll<HTMLButtonElement>(`.milkdown-diff-${action}`)[index];
      if (!button) throw new Error('审阅分组已变化，请重新打开审阅。');
      button.click(); await operation;
    },
    suspend() { suspended = true; commands.call(clearDiffReviewCmd.key); },
  };
  return { ...controls, crepe, view, parse, pending,
    whenIdle: () => operation,
    async destroy() { disposed = true; suspended = true; await crepe.destroy(); },
  };
}
