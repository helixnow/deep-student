import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { renderCardFaceLatexHtml, renderCardTemplateMath } from '../cardFaceLatex';
import { TemplateRenderService } from '@/services/templateRenderService';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';

/** 用户报告的原文：背面 {{Expl}} 中的 $AB$、$x$ 原样露出 */
const REPORTED = '几何意义：连续曲线弧 $AB$ 除端点外处处有不垂直于 $x$ 轴的切线';

const countMath = (html: string) => (html.match(/<math\b/g) ?? []).length;
/** 去掉 KaTeX 的 <annotation>（内含 TeX 源码）后检查是否还有裸 $ */
const visibleText = (html: string) =>
  html.replace(/<annotation[\s\S]*?<\/annotation>/g, '').replace(/<[^>]+>/g, '');

describe('renderCardFaceLatexHtml：$...$ 行内公式', () => {
  it('渲染不含 LaTeX 特征字符的行内公式（紧邻中文与中文标点）', () => {
    const html = renderCardFaceLatexHtml(REPORTED, 'mathml');
    expect(html).not.toBeNull();
    expect(countMath(html!)).toBe(2);
    expect(visibleText(html!)).not.toContain('$');
    expect(visibleText(html!)).toContain('几何意义：连续曲线弧');
  });

  it.each([
    ['弧$AB$，', 1],
    ['（$x$）', 1],
    ['且 $f(a)=f(b)$。', 1],
    ['存在 $\\xi\\in(a,b)$ 使 $f\'(\\xi)=0$', 2],
    ['$ \\alpha $ 与 $\\beta$', 2],
  ])('%s → %i 个公式', (text, expected) => {
    const html = renderCardFaceLatexHtml(text, 'mathml');
    expect(countMath(html ?? '')).toBe(expected);
    expect(visibleText(html ?? '')).not.toContain('$');
  });

  it.each([
    '售价 $5 和 $10',
    '区间 $5-$10 不等',
    'US$5，优惠后 US$3',
    '转义的 \\$x\\$ 不是公式',
    '$ x $ 两侧留空的非 LaTeX 内容不是公式',
  ])('货币/转义写法不误判：%s', (text) => {
    expect(renderCardFaceLatexHtml(text, 'mathml')).toBeNull();
  });

  it('货币与公式混排时只渲染公式', () => {
    const html = renderCardFaceLatexHtml('花了 $5 买书，求 $x^2$ 的导数', 'mathml');
    expect(countMath(html!)).toBe(1);
    expect(visibleText(html!)).toContain('花了 $5 买书');
  });

  it('其余定界符紧邻中文标点同样渲染', () => {
    const html = renderCardFaceLatexHtml('函数\\(f(x)\\)，积分$$\\int_0^1 f$$。及\\[a=b\\]！', 'mathml');
    expect(countMath(html!)).toBe(3);
    expect(visibleText(html!)).not.toMatch(/\\[()[\]]|\$/);
    expect(html!.startsWith('函数<span class="katex">')).toBe(true);
    expect(html!.endsWith('！')).toBe(true);
  });
});

describe('renderCardTemplateMath：模板 HTML', () => {
  it('公式 div 与说明 p 中的公式一并渲染，属性与代码不动', () => {
    const html = renderCardTemplateMath(
      `<div class="arch-formula">$f'(\\xi)=0$</div>`
      + `<p style="font-size:0.9rem; color:#dbeafe;" title="$x$">${REPORTED}</p>`
      + '<code>$y$</code>',
    );
    expect(countMath(html)).toBe(3);
    expect(html).toContain('title="$x$"');
    expect(html).toContain('<code>$y$</code>');
    expect(html).toContain('style="font-size:0.9rem; color:#dbeafe;"');
  });
});

describe('design-architect：正反面公式渲染一致', () => {
  const raw = (JSON.parse(
    readFileSync(path.resolve(__dirname, '../../../../data/anki/builtin-templates.json'), 'utf8'),
  ) as Array<Record<string, string>>).find((t) => t.id === 'design-architect')!;
  const template = { ...raw, fields: JSON.parse(raw.fields_json) } as unknown as CustomAnkiTemplate;
  const card = {
    front: '',
    back: '',
    text: '',
    tags: [],
    fields: {
      ID: '问题索引_02',
      Question: '拉格朗日中值定理的几何意义？',
      Formula: "$f'(\\xi) = \\frac{f(b)-f(a)}{b-a}$",
      Expl: REPORTED,
    },
  } as unknown as AnkiCard;

  it.each(['front', 'back'] as const)('%s 面 {{Expl}} 中的 $AB$、$x$ 已渲染', (side) => {
    const rendered = TemplateRenderService.renderCardDetailed(card, template)[side];
    const html = renderCardTemplateMath(rendered.html);
    // Formula 1 个 + Expl 2 个
    expect(countMath(html)).toBe(3);
    expect(visibleText(html)).not.toMatch(/\$[^$]+\$/);
  });
});
