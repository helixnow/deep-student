import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import type { Node as ProseNode } from '@milkdown/prose/model';
import type { EditorView } from '@milkdown/prose/view';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupMilkdownTimers } from '../../../__tests__/milkdownTimers';
setupMilkdownTimers();

import { listItemHasCheckedPlugin } from '../index';
import { calloutPlugin } from '../../callout';
import { togglePlugin } from '../../toggle';

const SAMPLE = [
  '- [ ] a',
  '- [x] b',
  '- c',
  '  - [x] c1',
  '  - d',
  '    - [ ] d1',
  '- [ ] e',
  '  - [ ] e1',
  '',
  '> quote',
  '>',
  '> - [x] quoted',
  '',
  '1. [x] ordered',
  '2. plain',
  '',
  '> [!toggle]- folded',
  '> - item',
  '>   - [x] in toggle',
  '',
  '> [!note] note',
  '> - [ ] in callout',
  '',
].join('\n');

/** CrepeEditor.css 里要换成属性选择器的四种写法（暗色规则只多一个 `.dark` 祖先），左边是现行的 `:has()`。 */
const SELECTOR_PAIRS = ['', ' > *', ' p', ' span'].map((tail) => [
  `.milkdown-list-item-block li:has(.label.checked) .children${tail}`,
  `.milkdown-list-item-block[data-has-checked="true"] .children${tail}`,
] as const);

interface Fixture { view: EditorView; root: HTMLElement; destroy: () => Promise<void> }
const open: Fixture[] = [];

async function editor(markdown: string, withPlugin = true): Promise<Fixture> {
  const root = document.createElement('div');
  document.body.append(root);
  const crepe = new Crepe({ root, defaultValue: markdown, features: {
    [Crepe.Feature.CodeMirror]: false, [Crepe.Feature.Latex]: false,
    [Crepe.Feature.Toolbar]: false, [Crepe.Feature.LinkTooltip]: false,
    [Crepe.Feature.ImageBlock]: false, [Crepe.Feature.BlockEdit]: false,
    [Crepe.Feature.Placeholder]: false,
  } });
  crepe.editor.use(togglePlugin()).use(calloutPlugin());
  if (withPlugin) crepe.editor.use(listItemHasCheckedPlugin());
  await crepe.create();
  const fixture = { view: crepe.editor.ctx.get(editorViewCtx), root, destroy: async () => { await crepe.destroy(); root.remove(); } };
  open.push(fixture);
  return fixture;
}

// jsdom has no layout; only provide the Range geometry needed by Crepe's cursor.
beforeAll(() => {
  Range.prototype.getClientRects = () => Object.assign([new DOMRect()], { item: () => new DOMRect() });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  Reflect.deleteProperty(Range.prototype, 'getClientRects');
  Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
});
afterEach(async () => {
  for (const fixture of open.splice(0)) await fixture.destroy();
});

/** list-item-block 组件的标签 class 在下一个微任务才重渲染。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const blocks = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('div.milkdown-list-item-block'));
const itemText = (block: Element) => block.querySelector(':scope > li > .children p')?.textContent ?? '';
const marked = (root: HTMLElement) => blocks(root).filter((block) => block.hasAttribute('data-has-checked')).map(itemText);

function expectSameAsHasSelector(root: HTMLElement) {
  for (const block of blocks(root)) {
    const li = block.querySelector(':scope > li')!;
    expect(block.children).toHaveLength(1);
    expect({ item: itemText(block), attr: block.getAttribute('data-has-checked') })
      .toEqual({ item: itemText(block), attr: li.matches('li:has(.label.checked)') ? 'true' : null });
  }
  const all = Array.from(root.querySelectorAll('*'));
  const indexes = (selector: string) => Array.from(root.querySelectorAll(selector), (element) => all.indexOf(element));
  for (const [hasSelector, attrSelector] of SELECTOR_PAIRS) {
    expect({ selector: attrSelector, matches: indexes(attrSelector) }).toEqual({ selector: attrSelector, matches: indexes(hasSelector) });
  }
}

function itemPos(view: EditorView, text: string): { pos: number; node: ProseNode } {
  let found: { pos: number; node: ProseNode } | undefined;
  view.state.doc.descendants((node, pos) => {
    if (!found && node.type.name === 'list_item' && node.firstChild?.textContent === text) found = { pos, node };
    return !found;
  });
  if (!found) throw new Error(`no list item "${text}"`);
  return found;
}

const setChecked = (view: EditorView, text: string, checked: boolean | null) =>
  view.dispatch(view.state.tr.setNodeAttribute(itemPos(view, text).pos, 'checked', checked));

/** 与用户点击勾选框同一路径：标签容器的 pointerdown 交给组件的 setAttr。 */
function clickLabel(root: HTMLElement, text: string) {
  const block = blocks(root).find((candidate) => itemText(candidate) === text)!;
  block.querySelector(':scope > li > .label-wrapper')!.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
}

describe('list item data-has-checked decoration', () => {
  it('marks exactly the list items that li:has(.label.checked) matches, nested and inside quote, toggle and callout', async () => {
    const { root } = await editor(SAMPLE);
    await settle();
    expect(blocks(root).map(itemText)).toEqual([
      'a', 'b', 'c', 'c1', 'd', 'd1', 'e', 'e1', 'quoted', 'ordered', 'plain', 'item', 'in toggle', 'in callout',
    ]);
    expect(marked(root)).toEqual(['b', 'c', 'c1', 'quoted', 'ordered', 'item', 'in toggle']);
    expectSameAsHasSelector(root);
  });

  it('follows the checked state through label clicks, nested changes, attribute resets and deletions', async () => {
    const { view, root } = await editor(SAMPLE);
    await settle();

    clickLabel(root, 'a');
    await settle();
    expect(itemPos(view, 'a').node.attrs.checked).toBe(true);
    expect(marked(root)).toEqual(['a', 'b', 'c', 'c1', 'quoted', 'ordered', 'item', 'in toggle']);
    expectSameAsHasSelector(root);

    clickLabel(root, 'c1');
    await settle();
    expect(marked(root)).toEqual(['a', 'b', 'quoted', 'ordered', 'item', 'in toggle']);
    expectSameAsHasSelector(root);

    setChecked(view, 'd1', true);
    await settle();
    expect(marked(root)).toEqual(['a', 'b', 'c', 'd', 'd1', 'quoted', 'ordered', 'item', 'in toggle']);
    expectSameAsHasSelector(root);

    setChecked(view, 'ordered', null);
    setChecked(view, 'in callout', true);
    await settle();
    expect(marked(root)).toEqual(['a', 'b', 'c', 'd', 'd1', 'quoted', 'item', 'in toggle', 'in callout']);
    expectSameAsHasSelector(root);

    const c = itemPos(view, 'c');
    view.dispatch(view.state.tr.delete(c.pos, c.pos + c.node.nodeSize));
    await settle();
    expect(marked(root)).toEqual(['a', 'b', 'quoted', 'item', 'in toggle', 'in callout']);
    expectSameAsHasSelector(root);

    view.dispatch(view.state.tr.setMeta('noop', true));
    view.dispatch(view.state.tr.insertText('x', itemPos(view, 'e').pos + 2));
    await settle();
    expect(marked(root)).toEqual(['a', 'b', 'quoted', 'item', 'in toggle', 'in callout']);
    expectSameAsHasSelector(root);
  });

  it('keeps the marked elements in place when the document changes elsewhere', async () => {
    const { view, root } = await editor(SAMPLE);
    await settle();
    const before = blocks(root).filter((block) => block.hasAttribute('data-has-checked'));
    view.dispatch(view.state.tr.insertText('typing ', itemPos(view, 'plain').pos + 2));
    await settle();
    expect(blocks(root).filter((block) => block.hasAttribute('data-has-checked'))).toEqual(before);
    expect(before.every((block) => block.isConnected)).toBe(true);
  });

  it('adds nothing else: without the attribute the editor DOM is the same as without the plugin, before and after toggling', async () => {
    const plain = await editor(SAMPLE, false);
    const decorated = await editor(SAMPLE, true);
    await settle();
    // Only one of the two editors can hold document focus (ProseMirror-focused); compare both unfocused.
    const stripped = (root: HTMLElement) => {
      (document.activeElement as HTMLElement | null)?.blur();
      const copy = root.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('[data-has-checked]').forEach((element) => element.removeAttribute('data-has-checked'));
      return copy.innerHTML;
    };
    expect(decorated.root.querySelectorAll('[data-has-checked]').length).toBeGreaterThan(0);
    expect(stripped(decorated.root)).toBe(stripped(plain.root));

    for (const fixture of [plain, decorated]) {
      clickLabel(fixture.root, 'e1');
      clickLabel(fixture.root, 'b');
    }
    await settle();
    expect(marked(decorated.root)).toEqual(['c', 'c1', 'e', 'e1', 'quoted', 'ordered', 'item', 'in toggle']);
    expect(plain.root.querySelectorAll('[data-has-checked]')).toHaveLength(0);
    expect(stripped(decorated.root)).toBe(stripped(plain.root));
  });

  it('leaves a document without checked items undecorated', async () => {
    const { root } = await editor('- [ ] one\n- two\n\n1. three\n');
    await settle();
    expect(root.querySelectorAll('[data-has-checked]')).toHaveLength(0);
    expectSameAsHasSelector(root);
  });
});
