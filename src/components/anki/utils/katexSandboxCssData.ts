/**
 * 卡面隔离文档（sandbox iframe）用的 KaTeX 样式：katex.min.css 原文 + 字体子集内联为 data: URI。
 *
 * 卡面文档 CSP 为 `font-src data:`，且模板 CSS 经 sanitizeCssForPreview 去掉全部 @font-face，
 * 宿主已加载的 katex.css（字体走资源 URL）在 iframe 内不可用——必须自带 data: 字体。
 * 只内联常用子集（正文/斜体/数学斜体/AMS/大号定界符，woff2 约 107KB）；其余字族
 * （粗体、花体、哥特体、等宽等）的 @font-face 删除，浏览器退回系统字体合成，字形仍可见。
 *
 * 本模块体积较大，只经 katexSandboxCss.ts 动态导入：卡面含公式时才下载。
 */
import katexCssRaw from 'katex/dist/katex.min.css?raw';
import amsRegular from 'katex/dist/fonts/KaTeX_AMS-Regular.woff2?inline';
import mainItalic from 'katex/dist/fonts/KaTeX_Main-Italic.woff2?inline';
import mainRegular from 'katex/dist/fonts/KaTeX_Main-Regular.woff2?inline';
import mathItalic from 'katex/dist/fonts/KaTeX_Math-Italic.woff2?inline';
import size1Regular from 'katex/dist/fonts/KaTeX_Size1-Regular.woff2?inline';
import size2Regular from 'katex/dist/fonts/KaTeX_Size2-Regular.woff2?inline';
import size3Regular from 'katex/dist/fonts/KaTeX_Size3-Regular.woff2?inline';
import size4Regular from 'katex/dist/fonts/KaTeX_Size4-Regular.woff2?inline';

/** 字体文件名（不含扩展名）→ data: URI */
const INLINE_FONTS: Record<string, string> = {
  'KaTeX_AMS-Regular': amsRegular,
  'KaTeX_Main-Italic': mainItalic,
  'KaTeX_Main-Regular': mainRegular,
  'KaTeX_Math-Italic': mathItalic,
  'KaTeX_Size1-Regular': size1Regular,
  'KaTeX_Size2-Regular': size2Regular,
  'KaTeX_Size3-Regular': size3Regular,
  'KaTeX_Size4-Regular': size4Regular,
};

/** 统一成 woff2 MIME：构建链对 ?inline 字体可能给出 application/octet-stream 等类型 */
function toWoff2DataUri(dataUri: string): string {
  const comma = dataUri.indexOf(',');
  return comma > 0 && /;base64$/.test(dataUri.slice(0, comma))
    ? `data:font/woff2;base64,${dataUri.slice(comma + 1)}`
    : dataUri;
}

/** 改写 @font-face：子集内的字族 src 换成单一 data: woff2，子集外的整条删除（不留外链）。 */
export function buildKatexSandboxCss(css: string = katexCssRaw): string {
  return css.replace(/@font-face\s*\{[^}]*\}/g, (rule) => {
    const file = /url\(\s*['"]?(?:[^'")]*\/)?(KaTeX_[\w-]+)\.woff2['"]?\s*\)/.exec(rule)?.[1];
    const dataUri = file ? INLINE_FONTS[file] : undefined;
    if (!dataUri?.startsWith('data:')) return '';
    return rule.replace(/src\s*:[^;}]*/, `src:url(${toWoff2DataUri(dataUri)}) format("woff2")`);
  });
}

export const KATEX_SANDBOX_CSS = buildKatexSandboxCss();
