/**
 * 列表内的类型占位（Crepe 自带占位会跳过列表）：
 * 光标停在空的列表项段落时，按列表种类提示「列表」/「待办事项」，文案由 CSS 变量提供。
 */
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';

export const typedPlaceholderKey = new PluginKey('ds-typed-placeholder');

export const typedPlaceholderProsePlugin = () => new Plugin({
  key: typedPlaceholderKey,
  props: {
    decorations(state) {
      const { selection } = state;
      if (!selection.empty) return null;
      const $pos = selection.$from;
      const block = $pos.parent;
      if (!block.isTextblock || block.content.size > 0 || $pos.depth < 2) return null;
      const item = $pos.node($pos.depth - 1);
      if (item.type.name !== 'list_item') return null;
      const kind = typeof item.attrs.checked === 'boolean' ? 'todo' : 'list';
      const before = $pos.before();
      return DecorationSet.create(state.doc, [
        Decoration.node(before, before + block.nodeSize, { class: 'ds-typed-placeholder', 'data-kind': kind }),
      ]);
    },
  },
});

export const typedPlaceholderPlugin = () => $prose(() => typedPlaceholderProsePlugin());
