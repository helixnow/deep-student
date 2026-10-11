import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// vitest 关闭 CSS 处理（css:false），katex.min.css?raw 为空串；用桩样式代替真实产物
vi.mock('../utils/katexSandboxCssData', () => ({
  KATEX_SANDBOX_CSS:
    '@font-face{font-family:KaTeX_Math;font-style:italic;font-weight:400;src:url(data:font/woff2;base64,AAAA) format("woff2")}.katex{font:normal 1.21em KaTeX_Main}',
}));

import { AnkiTemplateCardFace } from '../AnkiTemplateCardFace';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';

// #461 报告的 design-glass 填空卡：公式在 cloze 内外都有
const template = {
  id: 'cloze-min',
  name: 'Cloze',
  note_type: 'Cloze',
  fields: ['Text', 'Back Extra'],
  front_template: '<div class="glass">{{cloze:Text}}</div>',
  back_template: '<div class="glass">{{cloze:Text}}</div><div class="extra">{{Back Extra}}</div>',
  css_style: '@font-face{font-family:Evil;src:url(https://evil.example/f.woff2)} .card{padding:8px}',
} as unknown as CustomAnkiTemplate;

const card = {
  front: '',
  back: '',
  text: '',
  tags: [],
  images: [],
  fields: {
    Text: '电势 $V=\\dfrac{q}{4\\pi\\varepsilon_0 R}$，电容 $C=$ {{c1::$4\\pi\\varepsilon_0 R$}}',
    'Back Extra': '$q$ 为电荷量',
  },
} as unknown as AnkiCard;

function srcDocOf(container: HTMLElement): string {
  const iframe = container.querySelector('iframe');
  expect(iframe).not.toBeNull();
  return iframe!.getAttribute('srcdoc') ?? '';
}

describe('AnkiTemplateCardFace：模板卡面公式不依赖设备数学字体（#461）', () => {
  it.each(['front', 'back'] as const)('%s 面输出 KaTeX HTML 并在 iframe 内注入自带字体', async (side) => {
    const { container } = render(
      <AnkiTemplateCardFace card={card} template={template} side={side} compact />,
    );
    await waitFor(() => expect(srcDocOf(container)).toContain('katex-html'));
    const doc = srcDocOf(container);
    // 标识符由 KaTeX 自己排版（mathnormal → KaTeX_Math 字体），不再只剩 <mi>
    expect(doc).toMatch(/class="mord mathnormal"[^>]*>V</);
    expect(doc).toContain('<math');
    // 应用自带的 data: 字体保留，模板 CSS 里的外链 @font-face 仍被净化
    expect(doc).toContain('src:url(data:font/woff2;base64,AAAA)');
    expect(doc).not.toContain('evil.example');
    // KaTeX 样式在模板 CSS 之前，模板可覆盖
    expect(doc.indexOf('KaTeX_Math')).toBeLessThan(doc.indexOf('.card{padding:8px}'));
  });

  it('无公式的卡面不注入 KaTeX 样式', () => {
    const plainCard = { ...card, fields: { Text: '电容只与{{c1::几何构形}}有关', 'Back Extra': '' } } as unknown as AnkiCard;
    const { container } = render(
      <AnkiTemplateCardFace card={plainCard} template={template} side="front" compact />,
    );
    const doc = srcDocOf(container);
    expect(doc).not.toContain('KaTeX_Math');
    expect(doc).not.toContain('class="katex');
  });
});
