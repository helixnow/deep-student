import { afterEach, describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { Decoration, EditorView } from '@milkdown/prose/view';

import {
  buildHighlightDecorations,
  createHighlightProsePlugin,
  findHighlightMatches,
  highlightPluginKey,
  isSelectionClozed,
  isSelectionHighlighted,
  toggleClozeSelection,
  toggleHighlightSelection,
} from '..';
import { compileInlineCardText } from '../../inlineCards/scanner';

const testSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 1 } },
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    },
    code_block: { group: 'block', content: 'text*', code: true, toDOM: () => ['pre', ['code', 0]] },
    math_block: { group: 'block', content: 'text*', toDOM: () => ['div', { 'data-math': 'true' }, 0] },
    hard_break: { inline: true, group: 'inline', selectable: false, toDOM: () => ['br'] },
    wikilink: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { target: { default: '' } },
      toDOM: (node) => ['span', { 'data-wikilink': node.attrs.target }, node.attrs.target],
    },
    text: { group: 'inline' },
  },
  marks: {
    strong: { toDOM: () => ['strong', 0] },
    code: { code: true, toDOM: () => ['code', 0] },
    inlineCode: { code: true, toDOM: () => ['code', 0] },
    link: {
      attrs: { href: { default: '' } },
      toDOM: (mark) => ['a', { href: mark.attrs.href }, 0],
    },
  },
});

const mountedViews: EditorView[] = [];

function createTestView(
  doc: ReturnType<typeof testSchema.node>,
  options?: { editable?: boolean; from?: number; to?: number },
): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const plugin = createHighlightProsePlugin();
  let state = EditorState.create({ doc, plugins: [plugin] });
  if (options?.from !== undefined) {
    state = state.apply(
      state.tr.setSelection(
        TextSelection.create(state.doc, options.from, options.to ?? options.from),
      ),
    );
  }
  const editable = options?.editable ?? true;
  const view = new EditorView(host, {
    state,
    editable: () => editable,
  });
  mountedViews.push(view);
  return view;
}

function getDecorationInfo(decos: readonly Decoration[]) {
  return decos.map((d) => ({
    from: d.from,
    to: d.to,
    className: (d as unknown as { type: { attrs?: { class?: string } } }).type.attrs?.class ?? '',
  }));
}

afterEach(() => {
  while (mountedViews.length > 0) {
    const view = mountedViews.pop()!;
    const host = view.dom.parentElement;
    view.destroy();
    host?.remove();
  }
});

describe('highlight scanner & decorations', () => {
  it('decorates a single ==foo== span with mark and delimiter spans', () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [testSchema.text('Hello ==foo== world')]),
    ]);
    // "Hello " is 1..7, "==" is 7..9, "foo" is 9..12, "==" is 12..14
    const matches = findHighlightMatches(doc);
    expect(matches).toEqual([
      { matchStart: 7, innerStart: 9, innerEnd: 12, matchEnd: 14 },
    ]);

    const decos = getDecorationInfo(buildHighlightDecorations(doc, { from: 1, to: 1 }).find());
    expect(decos).toEqual([
      { from: 7, to: 9, className: 'crepe-highlight-delim crepe-highlight-delim-hidden' },
      { from: 9, to: 12, className: 'crepe-highlight-mark' },
      { from: 12, to: 14, className: 'crepe-highlight-delim crepe-highlight-delim-hidden' },
    ]);
  });

  it('decorates multiple highlights in one paragraph including CJK and bold marks', () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [
        testSchema.text('==alpha== 和 =='),
        testSchema.text('核心', [testSchema.marks.strong.create()]),
        testSchema.text('概念==!'),
      ]),
    ]);
    const matches = findHighlightMatches(doc);
    expect(matches).toHaveLength(2);
    expect(doc.textBetween(matches[0].innerStart, matches[0].innerEnd)).toBe('alpha');
    expect(doc.textBetween(matches[1].innerStart, matches[1].innerEnd)).toBe('核心概念');
  });

  it('ignores malformed, empty, triple-equals, escaped, and hard-break-spanning markers', () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [
        testSchema.text('==== ===foo=== ==   == \\==escaped== ==unclosed'),
      ]),
      testSchema.node('paragraph', null, [
        testSchema.text('==line1'),
        testSchema.node('hard_break'),
        testSchema.text('line2=='),
      ]),
    ]);
    expect(findHighlightMatches(doc)).toEqual([]);
  });

  it('skips code_block, math_block, and inline code/inlineCode marks', () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('code_block', null, [testSchema.text('const x = "==nope==";')]),
      testSchema.node('math_block', null, [testSchema.text('==a + b==')]),
      testSchema.node('paragraph', null, [
        testSchema.text('Inline '),
        testSchema.text('==code==', [testSchema.marks.code.create()]),
        testSchema.text(' and '),
        testSchema.text('==inlineCode==', [testSchema.marks.inlineCode.create()]),
        testSchema.text(' plus ==real=='),
      ]),
    ]);

    const matches = findHighlightMatches(doc);
    expect(matches).toHaveLength(1);
    expect(doc.textBetween(matches[0].innerStart, matches[0].innerEnd)).toBe('real');
  });

  it('allows inline code containing == inside an outer highlight span', () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [
        testSchema.text('==use '),
        testSchema.text('a == b', [testSchema.marks.inlineCode.create()]),
        testSchema.text(' carefully=='),
      ]),
    ]);

    const matches = findHighlightMatches(doc);
    expect(matches).toHaveLength(1);
    expect(doc.textBetween(matches[0].innerStart, matches[0].innerEnd)).toBe('use a == b carefully');
  });

  it('allows single equals signs inside equations like ==E = mc^2== and ==a = 1==', () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [
        testSchema.text('公式 ==E = mc^2== 与 ==a = 1== 都需要记住'),
      ]),
    ]);
    const matches = findHighlightMatches(doc);
    expect(matches).toHaveLength(2);
    expect(doc.textBetween(matches[0].innerStart, matches[0].innerEnd)).toBe('E = mc^2');
    expect(doc.textBetween(matches[1].innerStart, matches[1].innerEnd)).toBe('a = 1');

    // Toggle wrap & unwrap on equation text
    const view = createTestView(
      testSchema.node('doc', null, [
        testSchema.node('paragraph', null, [testSchema.text('Remember E = mc^2 well')]),
      ]),
      { from: 10, to: 18 },
    );
    expect(toggleHighlightSelection(view)).toBe(true);
    expect(view.state.doc.textContent).toBe('Remember ==E = mc^2== well');
    expect(isSelectionHighlighted(view.state)).toBe(true);

    expect(toggleHighlightSelection(view)).toBe(true);
    expect(view.state.doc.textContent).toBe('Remember E = mc^2 well');
    expect(isSelectionHighlighted(view.state)).toBe(false);
  });

  it('protects link marks, bare URLs with base64 ==, and raw $...$/$$...$$ math fragments', () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [
        testSchema.text('Link '),
        testSchema.text('==not highlighted==', [
          testSchema.marks.link.create({ href: 'https://example.com/?a=MQ==&b=Mg==' }),
        ]),
        testSchema.text(' bare https://example.com/?a=MQ==&b=Mg== end'),
      ]),
      testSchema.node('paragraph', null, [
        testSchema.text('Math $a == b$ 和 $c == d$ 以及 $$x == y$$ 与 $$p == q$$'),
      ]),
      testSchema.node('paragraph', null, [
        testSchema.text('Price $5 ==real sale== $10 and ==formula $a == b$ ok=='),
      ]),
    ]);

    const matches = findHighlightMatches(doc);
    expect(matches).toHaveLength(2);
    expect(doc.textBetween(matches[0].innerStart, matches[0].innerEnd)).toBe('real sale');
    expect(doc.textBetween(matches[1].innerStart, matches[1].innerEnd)).toBe('formula $a == b$ ok');
  });

  it('reveals delimiters when cursor/selection touches the highlight and hides them when outside', () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [testSchema.text('See ==focus== now')]),
    ]);
    // match: [5, 14] ("See " is 1..5, "==" 5..7, "focus" 7..12, "==" 12..14)

    // Strictly before (pos 4) -> hidden
    const before = getDecorationInfo(buildHighlightDecorations(doc, { from: 4, to: 4 }).find());
    expect(before[0].className).toContain('crepe-highlight-delim-hidden');
    expect(before[2].className).toContain('crepe-highlight-delim-hidden');

    // Touching start boundary (pos 5) -> active
    const atStart = getDecorationInfo(buildHighlightDecorations(doc, { from: 5, to: 5 }).find());
    expect(atStart[0].className).toContain('crepe-highlight-delim-active');
    expect(atStart[2].className).toContain('crepe-highlight-delim-active');

    // Inside inner text (pos 9) -> active
    const inside = getDecorationInfo(buildHighlightDecorations(doc, { from: 9, to: 9 }).find());
    expect(inside[0].className).toContain('crepe-highlight-delim-active');
    expect(inside[1].className).toBe('crepe-highlight-mark');
    expect(inside[2].className).toContain('crepe-highlight-delim-active');

    // Touching end boundary (pos 14) -> active
    const atEnd = getDecorationInfo(buildHighlightDecorations(doc, { from: 14, to: 14 }).find());
    expect(atEnd[0].className).toContain('crepe-highlight-delim-active');

    // Strictly after (pos 15) -> hidden
    const after = getDecorationInfo(buildHighlightDecorations(doc, { from: 15, to: 15 }).find());
    expect(after[0].className).toContain('crepe-highlight-delim-hidden');
    expect(after[2].className).toContain('crepe-highlight-delim-hidden');
  });

  it('updates delimiter visibility reactively as selection moves in EditorView', () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [testSchema.text('See ==focus== now')]),
    ]);
    const view = createTestView(doc, { from: 1, to: 1 });

    const initialDecos = getDecorationInfo(highlightPluginKey.getState(view.state)!.find());
    expect(initialDecos[0].className).toContain('crepe-highlight-delim-hidden');

    // Move cursor into highlight
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 9, 9)));
    const activeDecos = getDecorationInfo(highlightPluginKey.getState(view.state)!.find());
    expect(activeDecos[0].className).toContain('crepe-highlight-delim-active');

    // Move cursor back out
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 16, 16)));
    const hiddenAgain = getDecorationInfo(highlightPluginKey.getState(view.state)!.find());
    expect(hiddenAgain[0].className).toContain('crepe-highlight-delim-hidden');
  });
});

describe('toggleHighlightSelection', () => {
  it('wraps selected text in ==...== and unwraps cleanly on second toggle', () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [testSchema.text('Hello world today')]),
    ]);
    // Select "world" (7..12)
    const view = createTestView(doc, { from: 7, to: 12 });

    expect(isSelectionHighlighted(view.state)).toBe(false);
    expect(toggleHighlightSelection(view)).toBe(true);
    expect(view.state.doc.textContent).toBe('Hello ==world== today');
    expect(
      view.state.doc.textBetween(view.state.selection.from, view.state.selection.to),
    ).toBe('world');
    expect(isSelectionHighlighted(view.state)).toBe(true);

    // Second toggle unwraps back to original text & selection
    expect(toggleHighlightSelection(view)).toBe(true);
    expect(view.state.doc.textContent).toBe('Hello world today');
    expect(
      view.state.doc.textBetween(view.state.selection.from, view.state.selection.to),
    ).toBe('world');
    expect(isSelectionHighlighted(view.state)).toBe(false);
  });

  it('unwraps when user selects including == delimiters or partial delimiters', () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [testSchema.text('Hello ==world== today')]),
    ]);
    // Select entire "==world==" (7..16)
    const view = createTestView(doc, { from: 7, to: 16 });
    expect(isSelectionHighlighted(view.state)).toBe(true);
    expect(toggleHighlightSelection(view)).toBe(true);
    expect(view.state.doc.textContent).toBe('Hello world today');
    expect(
      view.state.doc.textBetween(view.state.selection.from, view.state.selection.to),
    ).toBe('world');

    // Re-test partial selection ("==world" 7..14)
    const doc2 = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [testSchema.text('Hello ==world== today')]),
    ]);
    const view2 = createTestView(doc2, { from: 7, to: 14 });
    expect(toggleHighlightSelection(view2)).toBe(true);
    expect(view2.state.doc.textContent).toBe('Hello world today');
    expect(
      view2.state.doc.textBetween(view2.state.selection.from, view2.state.selection.to),
    ).toBe('world');
  });

  it('does not wrap empty selection, whitespace, read-only views, code blocks, or cross-paragraph selections', () => {
    const emptyView = createTestView(
      testSchema.node('doc', null, [
        testSchema.node('paragraph', null, [testSchema.text('Hello')]),
      ]),
      { from: 2, to: 2 },
    );
    expect(toggleHighlightSelection(emptyView)).toBe(false);

    const wsView = createTestView(
      testSchema.node('doc', null, [
        testSchema.node('paragraph', null, [testSchema.text('Hello   world')]),
      ]),
      { from: 6, to: 9 },
    );
    expect(toggleHighlightSelection(wsView)).toBe(false);

    const readOnlyView = createTestView(
      testSchema.node('doc', null, [
        testSchema.node('paragraph', null, [testSchema.text('Hello world')]),
      ]),
      { from: 1, to: 6, editable: false },
    );
    expect(toggleHighlightSelection(readOnlyView)).toBe(false);
    expect(readOnlyView.state.doc.textContent).toBe('Hello world');

    const codeView = createTestView(
      testSchema.node('doc', null, [
        testSchema.node('code_block', null, [testSchema.text('const a = 1;')]),
      ]),
      { from: 1, to: 6 },
    );
    expect(toggleHighlightSelection(codeView)).toBe(false);

    const multiBlockView = createTestView(
      testSchema.node('doc', null, [
        testSchema.node('paragraph', null, [testSchema.text('First')]),
        testSchema.node('paragraph', null, [testSchema.text('Second')]),
      ]),
      { from: 2, to: 10 },
    );
    expect(toggleHighlightSelection(multiBlockView)).toBe(false);
  });

  it('refuses to wrap/unwrap selections hitting protected masks, partial overlaps, or nested/unpaired delimiters', () => {
    // 1. Inside or overlapping inline code
    const codeSpanView = createTestView(
      testSchema.node('doc', null, [
        testSchema.node('paragraph', null, [
          testSchema.text('Use '),
          testSchema.text('const x = 1', [testSchema.marks.inlineCode.create()]),
          testSchema.text(' now'),
        ]),
      ]),
      { from: 3, to: 10 },
    );
    expect(toggleHighlightSelection(codeSpanView)).toBe(false);
    expect(toggleClozeSelection(codeSpanView)).toBe(false);
    expect(codeSpanView.state.doc.textContent).toBe('Use const x = 1 now');

    // 2. Inside link mark
    const linkView = createTestView(
      testSchema.node('doc', null, [
        testSchema.node('paragraph', null, [
          testSchema.text('See '),
          testSchema.text('Docs', [testSchema.marks.link.create({ href: 'https://example.com' })]),
        ]),
      ]),
      { from: 5, to: 9 },
    );
    expect(toggleHighlightSelection(linkView)).toBe(false);

    // 3. Inside bare URL
    const urlView = createTestView(
      testSchema.node('doc', null, [
        testSchema.node('paragraph', null, [
          testSchema.text('Visit https://example.com/?a=1 today'),
        ]),
      ]),
      { from: 7, to: 20 },
    );
    expect(toggleHighlightSelection(urlView)).toBe(false);

    // 4. Inside raw math fragment
    const mathView = createTestView(
      testSchema.node('doc', null, [
        testSchema.node('paragraph', null, [testSchema.text('Check $a + b = c$ here')]),
      ]),
      { from: 8, to: 15 },
    );
    expect(toggleHighlightSelection(mathView)).toBe(false);

    // 5. Overlapping an inline atom (wikilink)
    const atomView = createTestView(
      testSchema.node('doc', null, [
        testSchema.node('paragraph', null, [
          testSchema.text('See '),
          testSchema.node('wikilink', { target: 'Note' }),
          testSchema.text(' now'),
        ]),
      ]),
      { from: 3, to: 8 },
    );
    expect(toggleHighlightSelection(atomView)).toBe(false);

    // 6. Partial overlap with an existing highlight span
    const partialOverlapView = createTestView(
      testSchema.node('doc', null, [
        testSchema.node('paragraph', null, [testSchema.text('Hello ==world== today')]),
      ]),
      { from: 1, to: 12 },
    );
    expect(toggleHighlightSelection(partialOverlapView)).toBe(false);
    expect(partialOverlapView.state.doc.textContent).toBe('Hello ==world== today');

    // 7. Full containment over an existing highlight span
    const outerOverlapView = createTestView(
      testSchema.node('doc', null, [
        testSchema.node('paragraph', null, [testSchema.text('Hello ==world== today')]),
      ]),
      { from: 1, to: 22 },
    );
    expect(toggleHighlightSelection(outerOverlapView)).toBe(false);

    // 8. Unpaired delimiters inside selection
    const unpairedEqView = createTestView(
      testSchema.node('doc', null, [
        testSchema.node('paragraph', null, [testSchema.text('foo == bar')]),
      ]),
      { from: 1, to: 11 },
    );
    expect(toggleHighlightSelection(unpairedEqView)).toBe(false);

    const unpairedClozeView = createTestView(
      testSchema.node('doc', null, [
        testSchema.node('paragraph', null, [testSchema.text('foo {{ bar')]),
      ]),
      { from: 1, to: 11 },
    );
    expect(toggleClozeSelection(unpairedClozeView)).toBe(false);
  });

  it('handles Mod-Shift-h shortcut in the plugin keymap', () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [testSchema.text('Key term here')]),
    ]);
    // Select "term" (5..9)
    const view = createTestView(doc, { from: 5, to: 9 });
    const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform);

    const event = new KeyboardEvent('keydown', {
      key: 'H',
      shiftKey: true,
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    });
    view.dom.dispatchEvent(event);

    expect(view.state.doc.textContent).toBe('Key ==term== here');

    // IME keydown (keyCode 229) must be ignored
    const imeEvent = new KeyboardEvent('keydown', {
      key: 'H',
      shiftKey: true,
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(imeEvent, 'keyCode', { value: 229 });
    view.dom.dispatchEvent(imeEvent);
    expect(view.state.doc.textContent).toBe('Key ==term== here');
  });
});

describe('toggleClozeSelection', () => {
  it('wraps selection in {{...}} compatible with inlineCards scanner and unwraps cleanly', () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [
        testSchema.text('Mitochondria is the powerhouse of the cell.'),
      ]),
    ]);
    // Select "powerhouse" (21..31)
    const view = createTestView(doc, { from: 21, to: 31 });

    expect(isSelectionClozed(view.state)).toBe(false);
    expect(toggleClozeSelection(view)).toBe(true);
    expect(view.state.doc.textContent).toBe('Mitochondria is the {{powerhouse}} of the cell.');
    expect(
      view.state.doc.textBetween(view.state.selection.from, view.state.selection.to),
    ).toBe('powerhouse');
    expect(isSelectionClozed(view.state)).toBe(true);

    // Exact compatibility check with inlineCards/scanner.ts
    const compiled = compileInlineCardText(view.state.doc.textContent);
    expect(compiled).not.toBeNull();
    expect(compiled?.kind).toBe('cloze');
    expect(compiled?.clozeText).toBe('Mitochondria is the {{c1::powerhouse}} of the cell.');

    // Toggle again -> unwraps back cleanly
    expect(toggleClozeSelection(view)).toBe(true);
    expect(view.state.doc.textContent).toBe('Mitochondria is the powerhouse of the cell.');
    expect(
      view.state.doc.textBetween(view.state.selection.from, view.state.selection.to),
    ).toBe('powerhouse');
    expect(isSelectionClozed(view.state)).toBe(false);
  });

  it('unwraps both plain {{...}} (including delimiters) and explicit {{c1::...::hint}} forms', () => {
    const plainDoc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [testSchema.text('The {{nucleus}} stores DNA.')]),
    ]);
    // Select entire "{{nucleus}}" (5..16)
    const plainView = createTestView(plainDoc, { from: 5, to: 16 });
    expect(toggleClozeSelection(plainView)).toBe(true);
    expect(plainView.state.doc.textContent).toBe('The nucleus stores DNA.');
    expect(
      plainView.state.doc.textBetween(plainView.state.selection.from, plainView.state.selection.to),
    ).toBe('nucleus');

    const explicitDoc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [
        testSchema.text('The {{c1::ribosome::organelle}} synthesizes proteins.'),
      ]),
    ]);
    // Select "ribosome" (11..19)
    const explicitView = createTestView(explicitDoc, { from: 11, to: 19 });
    expect(isSelectionClozed(explicitView.state)).toBe(true);
    expect(toggleClozeSelection(explicitView)).toBe(true);
    expect(explicitView.state.doc.textContent).toBe('The ribosome synthesizes proteins.');
    expect(
      explicitView.state.doc.textBetween(
        explicitView.state.selection.from,
        explicitView.state.selection.to,
      ),
    ).toBe('ribosome');
  });

  it('composes cleanly with toggleHighlightSelection', () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [testSchema.text('ATP synthesis occurs here.')]),
    ]);
    // Select "ATP" (1..4)
    const view = createTestView(doc, { from: 1, to: 4 });
    expect(toggleHighlightSelection(view)).toBe(true);
    expect(view.state.doc.textContent).toBe('==ATP== synthesis occurs here.');

    expect(toggleClozeSelection(view)).toBe(true);
    expect(view.state.doc.textContent).toBe('=={{ATP}}== synthesis occurs here.');
    expect(findHighlightMatches(view.state.doc)).toHaveLength(1);
    expect(compileInlineCardText(view.state.doc.textContent)?.kind).toBe('cloze');
  });
});

describe('CJK IME composition guard', () => {
  it('skips rebuilding decorations during composition and refreshes cleanly on compositionend', async () => {
    const doc = testSchema.node('doc', null, [
      testSchema.node('paragraph', null, [testSchema.text('笔记：')]),
    ]);
    const view = createTestView(doc, { from: 4, to: 4 });

    // Start IME composition
    view.dom.dispatchEvent(new Event('compositionstart'));

    // Insert "==中文高亮==" while composing
    view.dispatch(
      view.state.tr
        .insertText('==中文高亮==', 4)
        .setMeta('composition', true),
    );

    // Must NOT rebuild decorations mid-composition
    expect(highlightPluginKey.getState(view.state)!.find()).toHaveLength(0);

    // Also selection commands must no-op when view.composing is true
    Object.defineProperty(view, 'composing', { value: true, configurable: true });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
    expect(toggleHighlightSelection(view)).toBe(false);
    expect(toggleClozeSelection(view)).toBe(false);
    Object.defineProperty(view, 'composing', { value: false, configurable: true });

    // End IME composition -> waits 25ms (past PM scheduleComposeEnd(20)) before forceRebuild
    Object.defineProperty(view, 'composing', { value: true, configurable: true });
    view.dom.dispatchEvent(new Event('compositionend'));
    await Promise.resolve();
    // Still untouched immediately on microtask while PM composing window is open
    expect(highlightPluginKey.getState(view.state)!.find()).toHaveLength(0);

    // PM finishes composing within 20ms, then our 25ms timer triggers forceRebuild
    Object.defineProperty(view, 'composing', { value: false, configurable: true });
    await new Promise((resolve) => setTimeout(resolve, 35));

    const decos = getDecorationInfo(highlightPluginKey.getState(view.state)!.find());
    expect(decos).toHaveLength(3);
    expect(decos[1].className).toBe('crepe-highlight-mark');
    expect(view.state.doc.textBetween(decos[1].from, decos[1].to)).toBe('中文高亮');

    // Pending compositionend timer is safely cleaned up on view.destroy()
    view.dom.dispatchEvent(new Event('compositionstart'));
    view.dom.dispatchEvent(new Event('compositionend'));
    view.destroy();
    await new Promise((resolve) => setTimeout(resolve, 35));
  });
});
