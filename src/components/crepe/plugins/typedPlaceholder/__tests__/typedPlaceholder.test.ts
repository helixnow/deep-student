import { Schema } from '@milkdown/prose/model';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { describe, expect, it } from 'vitest';

import { typedPlaceholderKey, typedPlaceholderProsePlugin } from '../index';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
    bullet_list: { content: 'list_item+', group: 'block', toDOM: () => ['ul', 0] },
    list_item: { content: 'paragraph block*', attrs: { checked: { default: null } }, toDOM: () => ['li', 0] },
    text: { group: 'inline' },
  },
});

const decorationsAt = (item: { checked: boolean | null; text: string }) => {
  const doc = schema.node('doc', null, [
    schema.node('bullet_list', null, [
      schema.node('list_item', { checked: item.checked }, [schema.node('paragraph', null, item.text ? [schema.text(item.text)] : [])]),
    ]),
  ]);
  const plugin = typedPlaceholderProsePlugin();
  const state = EditorState.create({ schema, doc, plugins: [plugin], selection: TextSelection.create(doc, 3) });
  const set = typedPlaceholderKey.get(state)!.props.decorations!.call(plugin, state);
  return set ? (set as unknown as { find: () => Array<{ type: { attrs: Record<string, string> } }> }).find() : [];
};

describe('typed placeholder', () => {
  it('marks an empty bullet item as list and an empty task item as todo', () => {
    expect(decorationsAt({ checked: null, text: '' }).map((d) => d.type.attrs['data-kind'])).toEqual(['list']);
    expect(decorationsAt({ checked: false, text: '' }).map((d) => d.type.attrs['data-kind'])).toEqual(['todo']);
  });

  it('stays silent once the item has text', () => {
    expect(decorationsAt({ checked: null, text: 'a' })).toEqual([]);
  });
});
