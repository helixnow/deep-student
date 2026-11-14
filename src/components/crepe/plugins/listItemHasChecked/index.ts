/**
 * 列表项节点视图外层 `div.milkdown-list-item-block` 上的 `data-has-checked="true"`：
 * 本项或任一后代列表项已勾选时才有，命中的列表项与 `li:has(.label.checked)` 相同
 * （勾选态取节点 attrs，与 list-item-block 组件给标签加 `checked` class 的判断一致）。
 * 只写属性、不带样式：样式可以改用属性选择器，不再依赖非主语位置的 `:has()`
 * （Chromium 把这类规则并成一个失效集，往编辑器里插节点时整棵子树重算）。
 */
import type { Node as ProseNode } from '@milkdown/prose/model';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';

export const listItemHasCheckedKey = new PluginKey<DecorationSet>('ds-list-item-has-checked');

const HAS_CHECKED = { 'data-has-checked': 'true' };

/** 返回这段内容里有没有已勾选的列表项；本项或后代已勾选的列表项各加一个节点装饰。 */
function collect(parent: ProseNode, contentStart: number, out: Decoration[]): boolean {
  let found = false;
  parent.forEach((child, offset) => {
    if (child.isTextblock || child.isLeaf) return;
    const from = contentStart + offset;
    const isItem = child.type.name === 'list_item';
    const has = collect(child, from + 1, out) || (isItem && Boolean(child.attrs.checked));
    if (isItem && has) out.push(Decoration.node(from, from + child.nodeSize, HAS_CHECKED));
    found ||= has;
  });
  return found;
}

function build(doc: ProseNode): DecorationSet {
  const out: Decoration[] = [];
  collect(doc, 0, out);
  return out.length ? DecorationSet.create(doc, out) : DecorationSet.empty;
}

export const listItemHasCheckedProsePlugin = () => new Plugin<DecorationSet>({
  key: listItemHasCheckedKey,
  state: {
    init: (_config, state) => build(state.doc),
    apply: (tr, previous) => (tr.docChanged ? build(tr.doc) : previous),
  },
  props: {
    decorations: (state) => listItemHasCheckedKey.getState(state),
  },
});

export const listItemHasCheckedPlugin = () => $prose(() => listItemHasCheckedProsePlugin());
