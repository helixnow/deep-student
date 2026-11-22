import { defaultValueCtx, Editor, editorViewCtx, parserCtx, schemaCtx, serializerCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { EditorState } from '@milkdown/prose/state';
import { describe, expect, it } from 'vitest';
import { setupMilkdownTimers } from '../../../__tests__/milkdownTimers';
setupMilkdownTimers();

import {
  applyCalloutInputRule,
  applyFullLineCalloutInputRule,
  CALLOUT_FULL_LINE_INPUT_RULE_RE,
  CALLOUT_INPUT_RULE_RE,
  CALLOUT_TYPES,
  calloutPlugin,
  nextCalloutType,
  parseCalloutMarker,
  promoteBlockquoteToCallout,
  type CalloutType,
} from '../index';

async function createCalloutEditor(markdown = '') {
  const editor = Editor.make();
  editor.use(commonmark).use(gfm).use(calloutPlugin());
  if (markdown) {
    editor.config((ctx) => {
      ctx.set(defaultValueCtx, markdown);
    });
  }
  await editor.create();
  return editor;
}

function normalizeMd(md: string): string {
  return md.replace(/\r\n/g, '\n').trim();
}

describe('parseCalloutMarker / remark', () => {
  it('parses supported markers with optional title', () => {
    expect(parseCalloutMarker('[!note]')).toEqual({ type: 'note', title: '', collapsed: false });
    expect(parseCalloutMarker('[!tip] 小提示')).toEqual({
      type: 'tip',
      title: '小提示',
      collapsed: false,
    });
    expect(parseCalloutMarker('[!WARNING] Careful')).toEqual({
      type: 'warning',
      title: 'Careful',
      collapsed: false,
    });
  });

  it('tolerates full-width bang / colon separators and fold suffix', () => {
    expect(parseCalloutMarker('[！note] 全角叹号')).toEqual({
      type: 'note',
      title: '全角叹号',
      collapsed: false,
    });
    expect(parseCalloutMarker('[!tip]：中文冒号标题')).toEqual({
      type: 'tip',
      title: '中文冒号标题',
      collapsed: false,
    });
    expect(parseCalloutMarker('[!warning]: colon title')).toEqual({
      type: 'warning',
      title: 'colon title',
      collapsed: false,
    });
    expect(parseCalloutMarker('[!danger]- 默认折叠')).toEqual({
      type: 'danger',
      title: '默认折叠',
      collapsed: true,
    });
    expect(parseCalloutMarker('[!info]+ 显式展开')).toEqual({
      type: 'info',
      title: '显式展开',
      collapsed: false,
    });
  });

  it('rejects unknown types', () => {
    expect(parseCalloutMarker('[!todo] later')).toBeNull();
    expect(parseCalloutMarker('not a callout')).toBeNull();
  });

  it('promotes matching blockquotes in AST', () => {
    const node = {
      type: 'blockquote',
      children: [
        { type: 'paragraph', children: [{ type: 'text', value: '[!danger] 危险' }] },
        { type: 'paragraph', children: [{ type: 'text', value: 'body' }] },
      ],
    };
    expect(promoteBlockquoteToCallout(node)).toBe(true);
    expect(node.type).toBe('callout');
    expect(node.calloutType).toBe('danger');
    expect(node.calloutTitle).toBe('危险');
    expect(node.children).toHaveLength(1);
  });

  it('cycles types in order', () => {
    expect(nextCalloutType('note')).toBe('tip');
    expect(nextCalloutType('info')).toBe('note');
  });
});

describe('callout markdown roundtrip', () => {
  it('roundtrips a titled note with nested list and multi-paragraph body', async () => {
    const input = [
      '> [!note] 学习要点',
      '>',
      '> 第一段说明。',
      '>',
      '> - 列表甲',
      '> - 列表乙',
      '>',
      '> 第二段收尾。',
      '',
    ].join('\n');

    const editor = await createCalloutEditor(input);
    const view = editor.ctx.get(editorViewCtx);
    const serializer = editor.ctx.get(serializerCtx);
    const schema = editor.ctx.get(schemaCtx);

    const callout = view.state.doc.firstChild;
    expect(callout?.type.name).toBe('callout');
    expect(callout?.attrs.type).toBe('note');
    expect(callout?.attrs.title).toBe('学习要点');
    expect(schema.nodes.callout).toBeTruthy();

    // Nested list + multiple paragraphs preserved inside callout
    const childTypes = [] as string[];
    callout?.forEach((child) => {
      childTypes.push(child.type.name);
    });
    expect(childTypes).toContain('paragraph');
    expect(childTypes.some((t) => t === 'bullet_list' || t === 'list_item')).toBe(true);

    const output = serializer(view.state.doc);
    expect(normalizeMd(output)).toContain('> [!note] 学习要点');
    expect(normalizeMd(output)).toContain('第一段说明');
    expect(normalizeMd(output)).toMatch(/列表甲/);
    expect(normalizeMd(output)).toContain('第二段收尾');

    // Second pass: parse serialized markdown again
    const editor2 = await createCalloutEditor(output);
    const view2 = editor2.ctx.get(editorViewCtx);
    const again = view2.state.doc.firstChild;
    expect(again?.type.name).toBe('callout');
    expect(again?.attrs.type).toBe('note');
    expect(again?.attrs.title).toBe('学习要点');

    await editor.destroy();
    await editor2.destroy();
  });

  it('roundtrips all five types', async () => {
    for (const type of CALLOUT_TYPES) {
      const md = `> [!${type}] Title-${type}\n>\n> Content for ${type}\n`;
      const editor = await createCalloutEditor(md);
      const view = editor.ctx.get(editorViewCtx);
      const serializer = editor.ctx.get(serializerCtx);
      const node = view.state.doc.firstChild;
      expect(node?.type.name).toBe('callout');
      expect(node?.attrs.type).toBe(type);
      expect(node?.attrs.title).toBe(`Title-${type}`);

      const out = serializer(view.state.doc);
      expect(normalizeMd(out)).toContain(`> [!${type}] Title-${type}`);
      await editor.destroy();
    }
  });

  it('keeps plain blockquotes untouched', async () => {
    const editor = await createCalloutEditor('> just a quote\n');
    const view = editor.ctx.get(editorViewCtx);
    expect(view.state.doc.firstChild?.type.name).toBe('blockquote');
    await editor.destroy();
  });
});

describe('callout input rules', () => {
  it('converts blockquote paragraph after typing [!note] ', async () => {
    const editor = await createCalloutEditor('> placeholder\n');
    const view = editor.ctx.get(editorViewCtx);
    const schema = editor.ctx.get(schemaCtx);

    // Build a blockquote with paragraph text `[!note]` then apply rule as if space typed
    const paragraph = schema.nodes.paragraph!.create(null, schema.text('[!note]'));
    const blockquote = schema.nodes.blockquote!.create(null, paragraph);
    const doc = schema.nodes.doc!.create(null, blockquote);
    const state = EditorState.create({ schema, doc });

    // Match range: entire `[!note]` + the typed space would be at end; simulate match of `[!note] `
    // by placing text `[!note] ` and matching start..end
    const paraWithSpace = schema.nodes.paragraph!.create(null, schema.text('[!note] '));
    const bq = schema.nodes.blockquote!.create(null, paraWithSpace);
    const state2 = EditorState.create({
      schema,
      doc: schema.nodes.doc!.create(null, bq),
    });

    // Positions: doc(0) blockquote(0) paragraph(0) text — start of text is 2
    const start = 2;
    const end = start + '[!note] '.length;
    const match = CALLOUT_INPUT_RULE_RE.exec('[!note] ');
    expect(match).toBeTruthy();

    const tr = applyCalloutInputRule(state2, match!, start, end, schema.nodes.callout);
    expect(tr).toBeTruthy();
    const next = state2.apply(tr!);
    expect(next.doc.firstChild?.type.name).toBe('callout');
    expect(next.doc.firstChild?.attrs.type).toBe('note');

    void state;
    void view;
    await editor.destroy();
  });

  it('converts full-line > [!tip]  in a plain paragraph', async () => {
    const editor = await createCalloutEditor();
    const schema = editor.ctx.get(schemaCtx);
    const text = '> [!tip] ';
    const paragraph = schema.nodes.paragraph!.create(null, schema.text(text));
    const state = EditorState.create({
      schema,
      doc: schema.nodes.doc!.create(null, paragraph),
    });
    const start = 1;
    const end = start + text.length;
    const match = CALLOUT_FULL_LINE_INPUT_RULE_RE.exec(text);
    expect(match).toBeTruthy();

    const tr = applyFullLineCalloutInputRule(state, match!, start, end, schema.nodes.callout);
    expect(tr).toBeTruthy();
    const next = state.apply(tr!);
    expect(next.doc.firstChild?.type.name).toBe('callout');
    expect(next.doc.firstChild?.attrs.type).toBe('tip');
    await editor.destroy();
  });
});

describe('callout render classes', () => {
  it('renders crepe-callout--{type} for all five types', async () => {
    for (const type of CALLOUT_TYPES as readonly CalloutType[]) {
      const editor = await createCalloutEditor(`> [!${type}]\n>\n> body\n`);
      const view = editor.ctx.get(editorViewCtx);
      const el = view.dom.querySelector(`.crepe-callout--${type}`);
      expect(el).toBeTruthy();
      expect(el?.classList.contains('crepe-callout')).toBe(true);
      expect(el?.getAttribute('data-callout-type')).toBe(type);
      expect(el?.querySelector('.crepe-callout__icon')).toBeTruthy();
      expect(el?.querySelector('.crepe-callout__content')).toBeTruthy();
      await editor.destroy();
    }
  });

  it('opens type picker popover on icon click and updates type on selection', async () => {
    const editor = await createCalloutEditor('> [!note]\n>\n> body\n');
    const view = editor.ctx.get(editorViewCtx);
    const icon = view.dom.querySelector('.crepe-callout__icon') as HTMLButtonElement | null;
    expect(icon).toBeTruthy();
    expect(icon!.getAttribute('aria-haspopup')).toBe('menu');
    expect(icon!.getAttribute('aria-expanded')).toBe('false');

    icon!.click();
    const picker = document.body.querySelector('.crepe-callout__picker') as HTMLDivElement | null;
    expect(picker).toBeTruthy();
    expect(picker!.getAttribute('role')).toBe('menu');
    expect(icon!.getAttribute('aria-expanded')).toBe('true');

    const items = Array.from(
      picker!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    );
    expect(items).toHaveLength(CALLOUT_TYPES.length);
    expect(items.find((el) => el.dataset.calloutType === 'note')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(items.find((el) => el.dataset.calloutType === 'tip')?.getAttribute('aria-checked')).toBe(
      'false',
    );

    const tipItem = items.find((el) => el.dataset.calloutType === 'tip');
    expect(tipItem).toBeTruthy();
    tipItem!.click();

    expect(view.state.doc.firstChild?.attrs.type).toBe('tip');
    expect(view.dom.querySelector('.crepe-callout--tip')).toBeTruthy();
    expect(document.body.querySelector('.crepe-callout__picker')).toBeNull();
    expect(icon!.getAttribute('aria-expanded')).toBe('false');
    await editor.destroy();
  });

  it('supports keyboard navigation, Escape focus return, click-outside, scroll, and destroy cleanup in picker', async () => {
    const editor = await createCalloutEditor('> [!note]\n>\n> body\n');
    const view = editor.ctx.get(editorViewCtx);
    const icon = view.dom.querySelector('.crepe-callout__icon') as HTMLButtonElement;

    // Open picker → initial active is 'note' (index 0)
    icon.click();
    let picker = document.body.querySelector('.crepe-callout__picker') as HTMLDivElement | null;
    expect(picker).toBeTruthy();

    // ArrowDown twice -> warning (index 2), then ArrowUp -> tip (index 1)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));

    // IME composing Enter should be ignored
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
    );
    expect(document.body.querySelector('.crepe-callout__picker')).toBeTruthy();
    expect(view.state.doc.firstChild?.attrs.type).toBe('note');

    // Space selects active item ('tip')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(view.state.doc.firstChild?.attrs.type).toBe('tip');
    expect(document.body.querySelector('.crepe-callout__picker')).toBeNull();

    // Open again, ArrowDown -> warning, Enter selects 'warning'
    icon.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(view.state.doc.firstChild?.attrs.type).toBe('warning');
    expect(document.body.querySelector('.crepe-callout__picker')).toBeNull();

    // Clicking icon a second time toggles picker closed
    icon.click();
    expect(document.body.querySelector('.crepe-callout__picker')).toBeTruthy();
    icon.click();
    expect(document.body.querySelector('.crepe-callout__picker')).toBeNull();

    // Open again and press Escape -> closes and returns focus to iconButton
    icon.click();
    expect(document.body.querySelector('.crepe-callout__picker')).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.body.querySelector('.crepe-callout__picker')).toBeNull();
    expect(document.activeElement).toBe(icon);

    // Open again and click outside (pointerdown) -> closes
    icon.click();
    expect(document.body.querySelector('.crepe-callout__picker')).toBeTruthy();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.body.querySelector('.crepe-callout__picker')).toBeNull();

    // Open again and scroll window -> closes
    icon.click();
    expect(document.body.querySelector('.crepe-callout__picker')).toBeTruthy();
    window.dispatchEvent(new Event('scroll'));
    expect(document.body.querySelector('.crepe-callout__picker')).toBeNull();

    // Open again and destroy editor -> cleans up popover from document.body
    icon.click();
    picker = document.body.querySelector('.crepe-callout__picker') as HTMLDivElement | null;
    expect(picker).toBeTruthy();
    await editor.destroy();
    expect(document.body.querySelector('.crepe-callout__picker')).toBeNull();
  });

  it('allows inline editing of callout title with Enter, blur, Escape, empty reset, and IME safety', async () => {
    const editor = await createCalloutEditor('> [!note] 初始标题\n>\n> body\n');
    const view = editor.ctx.get(editorViewCtx);
    const serializer = editor.ctx.get(serializerCtx);

    const titleEl = view.dom.querySelector('.crepe-callout__title') as HTMLDivElement;
    expect(titleEl).toBeTruthy();
    expect(titleEl.textContent).toBe('初始标题');
    expect(titleEl.tabIndex).toBe(0);
    expect(titleEl.getAttribute('role')).toBe('button');
    expect(titleEl.getAttribute('aria-label')).toBeTruthy();

    // Click to enter inline edit mode
    titleEl.click();
    let input = view.dom.querySelector('.crepe-callout__title-input') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    expect(input!.value).toBe('初始标题');
    expect(input!.placeholder).toBeTruthy();

    // IME composing Enter must NOT commit
    input!.value = '拼音输入中';
    input!.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    input!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
    );
    expect(view.dom.querySelector('.crepe-callout__title-input')).toBe(input);
    expect(view.state.doc.firstChild?.attrs.title).toBe('初始标题');

    // End composition: first Enter within 100ms (macOS WKWebView confirmation Enter) must NOT commit
    input!.dispatchEvent(new Event('compositionend', { bubbles: true }));
    input!.value = '  新标题  ';
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(view.dom.querySelector('.crepe-callout__title-input')).toBe(input);
    expect(view.state.doc.firstChild?.attrs.title).toBe('初始标题');

    // Global shortcut (Cmd/Ctrl+S) bubbles to window instead of being swallowed
    let bubbledSave = false;
    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        bubbledSave = true;
      }
    };
    window.addEventListener('keydown', onGlobalKeyDown);
    input!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }),
    );
    window.removeEventListener('keydown', onGlobalKeyDown);
    expect(bubbledSave).toBe(true);
    expect(view.dom.querySelector('.crepe-callout__title-input')).toBe(input);

    // Next Enter commits trimmed value
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(view.dom.querySelector('.crepe-callout__title-input')).toBeNull();
    expect(view.state.doc.firstChild?.attrs.title).toBe('新标题');
    expect(titleEl.textContent).toBe('新标题');
    expect(normalizeMd(serializer(view.state.doc))).toContain('> [!note] 新标题');

    // Keyboard activation (Enter on titleEl) + Escape cancels without mutating
    titleEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input = view.dom.querySelector('.crepe-callout__title-input') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    input!.value = '将被放弃';
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(view.dom.querySelector('.crepe-callout__title-input')).toBeNull();
    expect(view.state.doc.firstChild?.attrs.title).toBe('新标题');
    expect(titleEl.textContent).toBe('新标题');

    // Blur with empty/whitespace string resets to default placeholder title
    titleEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    input = view.dom.querySelector('.crepe-callout__title-input') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    input!.value = '   ';
    input!.dispatchEvent(new FocusEvent('blur'));
    expect(view.dom.querySelector('.crepe-callout__title-input')).toBeNull();
    expect(view.state.doc.firstChild?.attrs.title).toBe('');
    expect(titleEl.classList.contains('crepe-callout__title--placeholder')).toBe(true);
    expect(titleEl.textContent).toBeTruthy();
    expect(normalizeMd(serializer(view.state.doc)).split('\n')[0]).toBe('> [!note]');

    await editor.destroy();
  });

  it('syncs dynamic read-only mode via MutationObserver and allows local fold toggling', async () => {
    const editor = await createCalloutEditor('> [!info]- 只读标题\n>\n> body\n');
    const view = editor.ctx.get(editorViewCtx);

    const calloutEl = view.dom.querySelector('.crepe-callout') as HTMLElement;
    const icon = view.dom.querySelector('.crepe-callout__icon') as HTMLButtonElement;
    const titleEl = view.dom.querySelector('.crepe-callout__title') as HTMLDivElement;
    const fold = view.dom.querySelector('.crepe-callout__fold') as HTMLButtonElement;

    // Open picker before switching to read-only
    icon.click();
    expect(document.body.querySelector('.crepe-callout__picker')).toBeTruthy();

    // Switch to read-only WITHOUT dispatching a ProseMirror transaction
    view.setProps({ editable: () => false });
    await Promise.resolve();

    // MutationObserver on contenteditable closes picker & updates icon/title attributes
    expect(document.body.querySelector('.crepe-callout__picker')).toBeNull();
    expect(icon.disabled).toBe(true);
    expect(icon.hasAttribute('aria-haspopup')).toBe(false);
    expect(icon.classList.contains('crepe-callout__icon--readonly')).toBe(true);

    icon.click();
    expect(document.body.querySelector('.crepe-callout__picker')).toBeNull();

    titleEl.click();
    expect(view.dom.querySelector('.crepe-callout__title-input')).toBeNull();
    expect(view.state.doc.firstChild?.attrs.title).toBe('只读标题');

    // Read-only fold toggle expands/collapses locally in DOM without mutating doc attrs
    expect(view.state.doc.firstChild?.attrs.collapsed).toBe(true);
    expect(calloutEl.dataset.calloutCollapsed).toBe('true');
    expect(fold.getAttribute('aria-expanded')).toBe('false');

    fold.click();
    expect(calloutEl.dataset.calloutCollapsed).toBe('false');
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(view.state.doc.firstChild?.attrs.collapsed).toBe(true);

    fold.click();
    expect(calloutEl.dataset.calloutCollapsed).toBe('true');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(view.state.doc.firstChild?.attrs.collapsed).toBe(true);

    // Switching back to editable restores iconButton state
    view.setProps({ editable: () => true });
    await Promise.resolve();
    expect(icon.disabled).toBe(false);
    expect(icon.getAttribute('aria-haspopup')).toBe('menu');

    await editor.destroy();
  });

  it('toggles collapsed attr via fold button and persists marker suffix', async () => {
    const editor = await createCalloutEditor('> [!note] 可折叠\n>\n> body\n');
    const view = editor.ctx.get(editorViewCtx);
    const serializer = editor.ctx.get(serializerCtx);

    const fold = view.dom.querySelector('.crepe-callout__fold') as HTMLButtonElement | null;
    expect(fold).toBeTruthy();
    expect(fold!.getAttribute('aria-expanded')).toBe('true');

    fold!.click();
    expect(view.state.doc.firstChild?.attrs.collapsed).toBe(true);
    const el = view.dom.querySelector('.crepe-callout') as HTMLElement;
    expect(el.dataset.calloutCollapsed).toBe('true');
    expect(normalizeMd(serializer(view.state.doc))).toContain('> [!note]- 可折叠');

    fold!.click();
    expect(view.state.doc.firstChild?.attrs.collapsed).toBe(false);
    expect(normalizeMd(serializer(view.state.doc))).toContain('> [!note] 可折叠');
    await editor.destroy();
  });

  it('parses collapsed marker from markdown', async () => {
    const editor = await createCalloutEditor('> [!warning]- 先折叠\n>\n> hidden\n');
    const view = editor.ctx.get(editorViewCtx);
    const node = view.state.doc.firstChild;
    expect(node?.type.name).toBe('callout');
    expect(node?.attrs.collapsed).toBe(true);
    expect(node?.attrs.title).toBe('先折叠');
    await editor.destroy();
  });
});

describe('parser/serializer smoke', () => {
  it('parser produces callout nodes from markdown string', async () => {
    const editor = await createCalloutEditor();
    const parser = editor.ctx.get(parserCtx);
    const doc = parser('> [!info] Hi\n>\n> text\n');
    expect(doc.firstChild?.type.name).toBe('callout');
    expect(doc.firstChild?.attrs.type).toBe('info');
    expect(doc.firstChild?.attrs.title).toBe('Hi');
    await editor.destroy();
  });
});
