import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { EditorState } from '@milkdown/prose/state';
import { EditorView } from '@milkdown/prose/view';
import { createInlineCardsProsePlugin } from '@/components/crepe/plugins/inlineCards';
import {
  compileInlineCardsFromDoc,
  compileInlineCardsFromMarkdown,
  compileInlineCardText,
} from '../inlineCardParser';

const testSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      attrs: { dsBlockId: { default: null } },
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }],
    },
    code_block: {
      group: 'block',
      content: 'text*',
      code: true,
      toDOM: () => ['pre', ['code', 0]],
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    },
    blockquote: {
      group: 'block',
      content: 'block+',
      toDOM: () => ['blockquote', 0],
      parseDOM: [{ tag: 'blockquote' }],
    },
    text: { group: 'inline' },
  },
  marks: {
    inlineCode: {
      toDOM: () => ['code', 0],
      parseDOM: [{ tag: 'code' }],
    },
  },
});

describe('inlineCardParser (RemNote-style >> QA & {{}} Cloze grammar)', () => {
  it('compiles >> into deterministic QA card scoped to (noteId, blockId)', () => {
    const md = '有丝分裂 >> 真核生物体细胞的分裂方式 <!-- ds:block-id=blk_mitosis -->';
    const cards = compileInlineCardsFromMarkdown(md, { noteId: 'note_cell' });
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.kind).toBe('qa');
    expect(card.front).toBe('有丝分裂');
    expect(card.back).toBe('真核生物体细胞的分裂方式');
    expect(card.blockId).toBe('blk_mitosis');
    expect(card.cardCount).toBe(1);
    expect(card.cardId).toMatch(/^card_inline_[0-9a-f]{16}$/);
    expect(card.sourceAnchorUri).toBe('ds-anchor://v1/note/note_cell?block=blk_mitosis');

    // Editing definition preserves exact deterministic cardId while changing contentHash
    const edited = compileInlineCardsFromMarkdown(
      '有丝分裂 >> 真核生物产生体细胞的主要分裂方式 <!-- ds:block-id=blk_mitosis -->',
      { noteId: 'note_cell' },
    );
    expect(edited[0].cardId).toBe(card.cardId);
    expect(edited[0].contentHash).not.toBe(card.contentHash);
  });

  it('compiles shorthand {{...}} sequentially into {{c1::...}}, {{c2::...}}', () => {
    const md = 'ATP 的全称是 {{腺苷三磷酸}}，高能磷酸键有 {{2}} 个 <!-- ds:block-id=blk_atp -->';
    const cards = compileInlineCardsFromMarkdown(md, { noteId: 'note_atp' });
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe('cloze');
    expect(cards[0].cardCount).toBe(2);
    expect(cards[0].clozeText).toBe('ATP 的全称是 {{c1::腺苷三磷酸}}，高能磷酸键有 {{c2::2}} 个');
  });

  it('preserves LaTeX math inside >> sides and inside {{...}} without false-splitting inner braces', () => {
    const qaMath = compileInlineCardText('动能定理 >> $W = \\Delta E_k = \\frac{1}{2}mv^2$');
    expect(qaMath).not.toBeNull();
    expect(qaMath!.kind).toBe('qa');
    expect(qaMath!.front).toBe('动能定理');
    expect(qaMath!.back).toBe('$W = \\Delta E_k = \\frac{1}{2}mv^2$');

    const clozeMath = compileInlineCardText('动能表达式为 {{$\\frac{1}{2}mv^2$}}，单位为焦耳');
    expect(clozeMath).not.toBeNull();
    expect(clozeMath!.kind).toBe('cloze');
    expect(clozeMath!.clozeText).toBe('动能表达式为 {{c1::$\\frac{1}{2}mv^2$}}，单位为焦耳');
  });

  it('strictly ignores >> and {{...}} inside fenced code, inline code, LaTeX formulas, blockquotes, HTML comments, >>>, and URLs', () => {
    const md = [
      '```ts',
      'const shift = a >> b;',
      'const tpl = "{{not_a_card}}";',
      '```',
      '',
      '行内代码 `x >> y` 与 `{{not_cloze}}` 不应触发制卡',
      '',
      '纯公式 $a \\gg b$ 以及 $$\\frac{{1}}{{2}} >> 0$$ 不应触发制卡',
      '',
      '> 引用块内的 概念 >> 释义 不应触发制卡',
      '',
      '位运算 a >>> b 不应触发制卡',
      '',
      '<!-- 注释里的 隐藏 >> 卡片 {{隐藏挖空}} -->',
      '',
      '链接 https://example.com/path?x={{raw}} 不应触发制卡',
    ].join('\n');

    const cards = compileInlineCardsFromMarkdown(md, { noteId: 'note_exclusions' });
    expect(cards).toEqual([]);
  });

  it('freezes ProseMirror inline-card decorations during IME composition and refreshes after compositionend', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const plugin = createInlineCardsProsePlugin({ noteId: 'note_ime' });
    const initialDoc = testSchema.node('doc', null, [
      testSchema.node(
        'paragraph',
        { dsBlockId: 'blk_1' },
        [testSchema.text('原核细胞 >> 无核膜包被的细胞核')],
      ),
    ]);

    const state = EditorState.create({
      doc: initialDoc,
      schema: testSchema,
      plugins: [plugin],
    });
    const view = new EditorView(host, { state });

    try {
      expect(host.querySelectorAll('[data-testid="inline-card-indicator"]')).toHaveLength(1);
      expect(host.querySelector('[data-testid="inline-card-indicator"]')?.textContent).toContain('QA');

      // Simulate active Chinese Pinyin IME composition while appending a second paragraph
      Object.defineProperty(view, 'composing', { value: true, configurable: true });
      const secondParagraph = testSchema.node(
        'paragraph',
        { dsBlockId: 'blk_2' },
        [testSchema.text('酶的本质 >> {{绝大多数是蛋白质}}')],
      );
      view.dispatch(view.state.tr.insert(view.state.doc.content.size, secondParagraph));

      // While composing === true, plugin defers scanning new blocks so IME selection is untouched
      expect(host.querySelectorAll('[data-testid="inline-card-indicator"]')).toHaveLength(1);

      // End IME composition -> plugin flushes deferred scan and renders second pill
      Object.defineProperty(view, 'composing', { value: false, configurable: true });
      view.dom.dispatchEvent(new CompositionEvent('compositionend'));
      await Promise.resolve();

      const pills = host.querySelectorAll('[data-testid="inline-card-indicator"]');
      expect(pills).toHaveLength(2);

      // Verify compileInlineCardsFromDoc skips inlineCode marks directly on ProseMirror nodes too
      const codeMarkedText = testSchema.text('a >> b', [testSchema.marks.inlineCode.create()]);
      const codeDoc = testSchema.node('doc', null, [
        testSchema.node('paragraph', { dsBlockId: 'blk_code' }, [codeMarkedText]),
      ]);
      expect(compileInlineCardsFromDoc(codeDoc, { noteId: 'note_ime' })).toHaveLength(0);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
