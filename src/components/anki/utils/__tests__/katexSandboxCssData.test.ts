import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

import {
  arrayBufferToWoff2DataUri,
  buildKatexSandboxCss,
  KATEX_SANDBOX_FONT_URLS,
  resolveWoff2DataUri,
} from '../katexSandboxCssData';
import { buildHtmlSandboxDocument, getHtmlSandboxCsp, sanitizeHtmlForPreview } from '@/components/previews/htmlSandboxPolicy';
import { renderCardTemplateMath } from '../cardFaceLatex';

const require = createRequire(import.meta.url);
// vitest 关闭 CSS 处理，?raw 拿不到原文；直接读 katex 包里的真实样式与 woff2 字体
const katexCss = readFileSync(require.resolve('katex/dist/katex.min.css'), 'utf8');
const fontFaces = (css: string) => css.match(/@font-face\s*\{[^}]*\}/g) ?? [];

async function loadRealKatexFontDataUri(_url: string, fontName: string): Promise<string> {
  const bytes = readFileSync(require.resolve(`katex/dist/fonts/${fontName}.woff2`));
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return arrayBufferToWoff2DataUri(arrayBuffer);
}

describe('buildKatexSandboxCss：卡面 iframe 内可用的 KaTeX 样式', () => {
  it('按需将 8 个子集字体转为 data: woff2，不残留任何相对/外链 url（CSP 只允许 font-src data:）', async () => {
    expect(Object.keys(KATEX_SANDBOX_FONT_URLS)).toHaveLength(8);
    const css = await buildKatexSandboxCss(katexCss, loadRealKatexFontDataUri);
    const faces = fontFaces(css);
    expect(faces).toHaveLength(8);
    for (const face of faces) {
      expect(face).toMatch(/src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]{1000,}\) format\("woff2"\)\}$/);
    }
    expect(css).not.toMatch(/url\((?!data:)/);
    expect(getHtmlSandboxCsp('template-safe')).toContain('font-src data:');
  });

  it('覆盖标识符与希腊字母所需字族（Math-Italic / Main-Regular / Main-Italic）', async () => {
    const css = await buildKatexSandboxCss(katexCss, loadRealKatexFontDataUri);
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

  it('保留 KaTeX 排版规则（隐藏 MathML 副本、mathnormal 走 KaTeX_Math）', async () => {
    const css = await buildKatexSandboxCss(katexCss, loadRealKatexFontDataUri);
    expect(css).toContain('.katex .katex-mathml');
    expect(css).toMatch(/\.katex \.mathnormal\{font-family:KaTeX_Math/);
  });

  it('resolveWoff2DataUri 既兼容 fetch 资源 URL 又兼容已有 data: URI', async () => {
    const sampleBytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]);
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => sampleBytes.buffer,
    }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const fetched = await resolveWoff2DataUri('/assets/KaTeX_Main-Regular.woff2');
      expect(fetchSpy).toHaveBeenCalledWith('/assets/KaTeX_Main-Regular.woff2');
      expect(fetched).toBe('data:font/woff2;base64,d09GMgAB');

      const inlined = await resolveWoff2DataUri('data:application/octet-stream;base64,d09GMgAB');
      expect(inlined).toBe('data:font/woff2;base64,d09GMgAB');
    } finally {
      vi.unstubAllGlobals();
    }
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
