import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { buildKatexSandboxCss } from '../katexSandboxCssData';
import { buildHtmlSandboxDocument, getHtmlSandboxCsp, sanitizeHtmlForPreview } from '@/components/previews/htmlSandboxPolicy';
import { renderCardTemplateMath } from '../cardFaceLatex';

// vitest 关闭 CSS 处理，?raw 拿不到原文；直接读 katex 包里的真实样式
const katexCss = readFileSync(createRequire(import.meta.url).resolve('katex/dist/katex.min.css'), 'utf8');
const fontFaces = (css: string) => css.match(/@font-face\s*\{[^}]*\}/g) ?? [];

describe('buildKatexSandboxCss：卡面 iframe 内可用的 KaTeX 样式', () => {
  const css = buildKatexSandboxCss(katexCss);

  it('子集字体全部内联为 data: woff2，不残留任何相对/外链 url（CSP 只允许 font-src data:）', () => {
    const faces = fontFaces(css);
    expect(faces).toHaveLength(8);
    for (const face of faces) {
      expect(face).toMatch(/src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]{1000,}\) format\("woff2"\)\}$/);
    }
    expect(css).not.toMatch(/url\((?!data:)/);
    expect(getHtmlSandboxCsp('template-safe')).toContain('font-src data:');
  });

  it('覆盖标识符与希腊字母所需字族（Math-Italic / Main-Regular / Main-Italic）', () => {
    const families = fontFaces(css).map((face) => {
      const family = /font-family:(\w+)/.exec(face)?.[1];
      const style = /font-style:(\w+)/.exec(face)?.[1];
      return `${family}/${style}`;
    });
    expect(families).toEqual(expect.arrayContaining([
      'KaTeX_Math/italic',
      'KaTeX_Main/normal',
      'KaTeX_Main/italic',
      'KaTeX_AMS/normal',
      'KaTeX_Size1/normal',
    ]));
  });

  it('保留 KaTeX 排版规则（隐藏 MathML 副本、mathnormal 走 KaTeX_Math）', () => {
    expect(css).toContain('.katex .katex-mathml');
    expect(css).toMatch(/\.katex \.mathnormal\{font-family:KaTeX_Math/);
  });
});

describe('卡面 sandbox 文档：htmlAndMathml 输出经净化后结构完整', () => {
  it('KaTeX HTML（含内联 style 与 svg）不被 DOMPurify 剥掉', () => {
    const html = renderCardTemplateMath('<div>$\\sqrt{x}+\\dfrac{\\sigma}{\\varepsilon_0}$</div>');
    const safe = sanitizeHtmlForPreview(html, 'template-safe');
    expect(safe).toContain('class="katex-html"');
    expect(safe).toContain('class="katex-mathml"');
    expect(safe).toMatch(/style="height:/);
    expect(safe).toContain('<svg');
    expect(safe).toContain('mathnormal');
  });

  it('trustedCss 原样进文档且位于模板 CSS 之前；未传时不多出样式块', () => {
    const doc = buildHtmlSandboxDocument({
      html: '<p>x</p>',
      css: '.tpl{}',
      mode: 'template-safe',
      fidelity: 'anki',
      trustedCss: '@font-face{font-family:K;src:url(data:font/woff2;base64,AA)}',
    });
    expect(doc).toContain('@font-face{font-family:K;src:url(data:font/woff2;base64,AA)}');
    expect(doc.indexOf('@font-face')).toBeLessThan(doc.indexOf('.tpl{}'));

    const plain = buildHtmlSandboxDocument({ html: '<p>x</p>', css: '', mode: 'template-safe' });
    expect((plain.match(/<style>/g) ?? []).length).toBe(1);
  });
});
