import { describe, expect, it } from 'vitest';
import { containsLatex, renderLatexToHtml } from '../renderLatex';

describe('containsLatex · 公式与货币', () => {
  it.each([
    '齐次方程组 $Ax = 0$',
    '记号：$A$ 为 $n$ 阶方阵，$r(A)$ 为秩',
    '$|kA| = k^n|A|$',
    '$$\\sum_i a_i$$',
    '定义：$A\\xi = \\lambda\\xi$',
  ])('公式：%s', (text) => {
    expect(containsLatex(text)).toBe(true);
  });

  it.each([
    'costs $5 and $10',
    '$5-$10 区间',
    '价格 $5 到 $10',
    '只有一个 $ 符号',
    '转义 \\$x$ 不算',
    '$ 两端有空格 $',
  ])('不是公式：%s', (text) => {
    expect(containsLatex(text)).toBe(false);
  });

  it('混排时只渲染公式段，其余文本转义', () => {
    const html = renderLatexToHtml('齐次 $Ax = 0$ <b>')!;
    expect(html).toContain('katex');
    expect(html.startsWith('齐次 ')).toBe(true);
    expect(html.endsWith(' &lt;b&gt;')).toBe(true);
  });
});
