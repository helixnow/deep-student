/**
 * 卡片库列表摘要渲染公式：行内不再出现 `$f'(\xi)$` / `\frac{\pi}{2}` 源码。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { AnkiLibraryCard } from '@/types';
import { CardMathText, renderAnkiCardPreviewHtml, renderCardPreviewMathHtml } from '../../cardMathPreview';
import { LibraryCardRow } from '../LibraryCardRow';

vi.mock('@/hooks/useAnkiTemplateLoader', () => ({
  useAnkiTemplateLoader: () => ({ template: null }),
}));
vi.mock('@/components/anki/AnkiCardPreviewPanel', () => ({
  AnkiCardPreviewPanel: () => null,
}));
vi.mock('@/utils/lazyStyles', () => ({ ensureKatexStyles: vi.fn() }));

describe('renderCardPreviewMathHtml', () => {
  it('returns null for plain text (zero-cost path)', () => {
    expect(renderCardPreviewMathHtml('拉格朗日中值定理的条件')).toBeNull();
    expect(renderCardPreviewMathHtml('价格 $5 到 $10')).toBeNull();
  });

  it('renders $…$ inline math and escapes the surrounding text', () => {
    const html = renderCardPreviewMathHtml("关键是选取合适的 $f$ 与 $[a,b]$，再对 $f'(\\xi)$ 放缩 <b>");
    expect(html).not.toBeNull();
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('$f$');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
  });

  it('supports Anki \\( \\) / \\[ \\] delimiters', () => {
    const html = renderCardPreviewMathHtml('证明：\\(\\arcsin x+\\arccos x=\\frac{\\pi}{2}\\)');
    expect(html).toContain('class="katex"');
    expect(html).toContain('mfrac');
    expect(html).not.toContain('\\(');
    expect(renderCardPreviewMathHtml('\\[x^2\\]', { inline: true })).not.toContain('\\[');
  });

  it('inline mode demotes display math and collapses whitespace for one-line previews', () => {
    const html = renderCardPreviewMathHtml('结论：\n$$\\int_a^b f(x)\\,dx$$\n成立', { inline: true });
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('katex-display');
    expect(html).not.toContain('\n');

    const block = renderCardPreviewMathHtml('结论：\n$$\\int_a^b f(x)\\,dx$$', { inline: false });
    expect(block).toContain('katex-display');
  });

  it('renders safe Anki HTML formatting and image placeholders while escaping unsafe scripts (U19 regression)', () => {
    const raw = '<b>Card #763</b>: $I_{763} = \\mathrm{tr}(A)$ <img src="qa_img_63.png"> <i>hint</i> <script>alert(1)</script>';
    const blockHtml = renderAnkiCardPreviewHtml(raw, { inline: false })!;
    expect(blockHtml).toContain('<b>Card #763</b>');
    expect(blockHtml).toContain('<i>hint</i>');
    expect(blockHtml).toContain('class="katex"');
    expect(blockHtml).toContain('[图片: qa_img_63.png]');
    expect(blockHtml).not.toContain('<img');
    expect(blockHtml).not.toContain('<script>');
    expect(blockHtml).toContain('&lt;script&gt;');

    const inlineHtml = renderAnkiCardPreviewHtml(raw, { inline: true })!;
    expect(inlineHtml).toContain('Card #763');
    expect(inlineHtml).not.toContain('<b>');
    expect(inlineHtml).toContain('[图片: qa_img_63.png]');

    // Pure HTML without LaTeX must NOT crash when renderLatexToHtml returns null
    const htmlOnly = renderAnkiCardPreviewHtml('<b>Amoxicillin</b><br><img src="rx.png"> <script>x()</script>', { inline: false })!;
    expect(htmlOnly).toContain('<b>Amoxicillin</b>');
    expect(htmlOnly).toContain('<br />');
    expect(htmlOnly).toContain('[图片: rx.png]');
    expect(htmlOnly).toContain('&lt;script&gt;');
    expect(renderAnkiCardPreviewHtml(null)).toBeNull();
  });
});

describe('CardMathText', () => {
  it('renders plain text untouched when there is no math', () => {
    const { container } = render(<CardMathText text="罗尔定理" inline />);
    expect(container.textContent).toBe('罗尔定理');
    expect(container.querySelector('.katex')).toBeNull();
  });
});

describe('LibraryCardRow preview', () => {
  const card = {
    id: 'card-1',
    front: '证明：$\\arcsin x+\\arccos x=\\frac{\\pi}{2}$',
    back: "关键是选取合适的 $f$ 与 $[a,b]$，再对 $f'(\\xi)$ 放缩",
    tags: [],
    images: [],
    fields: {},
    extra_fields: {},
    template_id: null,
    created_at: '2026-10-01T00:00:00Z',
    enqueued: false,
    suspended: false,
  } as unknown as AnkiLibraryCard;

  it('renders KaTeX in the front/back one-line previews instead of raw TeX', () => {
    const noop = () => {};
    const { container } = render(
      <ul>
        <LibraryCardRow
          card={card}
          busy={false}
          deleting={false}
          selected={false}
          expanded={false}
          confirmingDelete={false}
          onToggleSelect={noop}
          onToggleExpand={noop}
          onStartReview={noop}
          onEnqueue={noop}
          onToggleSuspended={noop}
          onRequestDelete={noop}
          onCancelDelete={noop}
          onConfirmDelete={noop}
          onSaveEdit={async () => {}}
          onUndoReview={noop}
          onResetProgress={noop}
          onRowKeyDown={noop}
          rowRef={noop}
        />
      </ul>,
    );
    const front = container.querySelector('.wb-fc-row-front')!;
    const back = container.querySelector('.wb-fc-row-back')!;
    expect(front.querySelector('.katex')).not.toBeNull();
    expect(back.querySelectorAll('.katex').length).toBe(3);
    // 可见文本里不再有 TeX 源码（KaTeX 的 MathML annotation 除外）
    const visible = (el: Element) => {
      const clone = el.cloneNode(true) as Element;
      clone.querySelectorAll('.katex-mathml').forEach((node) => node.remove());
      return clone.textContent ?? '';
    };
    expect(visible(front)).not.toContain('\\frac');
    expect(visible(back)).not.toContain('$');
  });
});
