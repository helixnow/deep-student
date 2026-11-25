/**
 * 卡面隔离文档（sandbox iframe）用的 KaTeX 样式：katex.min.css 原文 + 字体子集按需转成 data: URI。
 *
 * 卡面文档 CSP 为 `font-src data:`，且模板 CSS 经 sanitizeCssForPreview 去掉全部 @font-face，
 * 宿主已加载的 katex.css（字体走资源 URL）在 iframe 内不可用——必须自带 data: 字体。
 * 通过 `?url` 复用构建产物里已经输出的 `dist/assets/KaTeX_*.woff2`，仅在卡面首次含公式时
 * 按需 fetch → base64 内联，避免把 8 个字体（~110 KiB gz）静态内联进冷启动 JS bundle。
 * 其余字族（粗体、花体、哥特体、等宽等）的 @font-face 删除，浏览器退回系统字体合成。
 */
import katexCssRaw from 'katex/dist/katex.min.css?raw';
import amsRegularUrl from 'katex/dist/fonts/KaTeX_AMS-Regular.woff2?url';
import mainItalicUrl from 'katex/dist/fonts/KaTeX_Main-Italic.woff2?url';
import mainRegularUrl from 'katex/dist/fonts/KaTeX_Main-Regular.woff2?url';
import mathItalicUrl from 'katex/dist/fonts/KaTeX_Math-Italic.woff2?url';
import size1RegularUrl from 'katex/dist/fonts/KaTeX_Size1-Regular.woff2?url';
import size2RegularUrl from 'katex/dist/fonts/KaTeX_Size2-Regular.woff2?url';
import size3RegularUrl from 'katex/dist/fonts/KaTeX_Size3-Regular.woff2?url';
import size4RegularUrl from 'katex/dist/fonts/KaTeX_Size4-Regular.woff2?url';

/** 字体文件名（不含扩展名）→ 构建产物资源 URL（或低于 assetsInlineLimit 时的 data: URI） */
export const KATEX_SANDBOX_FONT_URLS: Readonly<Record<string, string>> = {
  'KaTeX_AMS-Regular': amsRegularUrl,
  'KaTeX_Main-Italic': mainItalicUrl,
  'KaTeX_Main-Regular': mainRegularUrl,
  'KaTeX_Math-Italic': mathItalicUrl,
  'KaTeX_Size1-Regular': size1RegularUrl,
  'KaTeX_Size2-Regular': size2RegularUrl,
  'KaTeX_Size3-Regular': size3RegularUrl,
  'KaTeX_Size4-Regular': size4RegularUrl,
};

/** 统一成 woff2 MIME：构建链对 data: 字体可能给出 application/octet-stream 等类型 */
function toWoff2DataUri(dataUri: string): string {
  const comma = dataUri.indexOf(',');
  return comma > 0 && /;base64$/.test(dataUri.slice(0, comma))
    ? `data:font/woff2;base64,${dataUri.slice(comma + 1)}`
    : dataUri;
}

export function arrayBufferToWoff2DataUri(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:font/woff2;base64,${btoa(binary)}`;
}

export async function resolveWoff2DataUri(urlOrDataUri: string): Promise<string> {
  if (urlOrDataUri.startsWith('data:')) {
    return toWoff2DataUri(urlOrDataUri);
  }
  const response = await fetch(urlOrDataUri);
  if (!response.ok) {
    throw new Error(`Failed to fetch KaTeX font (${response.status}): ${urlOrDataUri}`);
  }
  return arrayBufferToWoff2DataUri(await response.arrayBuffer());
}

/** 改写 @font-face：子集内的字族 src 换成单一 data: woff2，子集外的整条删除（不留外链）。 */
export function rewriteKatexSandboxCss(
  css: string,
  fontDataUris: Readonly<Record<string, string>>,
): string {
  return css.replace(/@font-face\s*\{[^}]*\}/g, (rule) => {
    const file = /url\(\s*['"]?(?:[^'")]*\/)?(KaTeX_[\w-]+)\.woff2['"]?\s*\)/.exec(rule)?.[1];
    const dataUri = file ? fontDataUris[file] : undefined;
    if (!dataUri?.startsWith('data:')) return '';
    return rule.replace(/src\s*:[^;}]*/, `src:url(${toWoff2DataUri(dataUri)}) format("woff2")`);
  });
}

export type KatexFontDataUriLoader = (url: string, fontName: string) => Promise<string>;

/** 异步拉取 8 个子集字体并生成可直接注入 sandbox iframe 的 KaTeX CSS。 */
export async function buildKatexSandboxCss(
  css: string = katexCssRaw,
  loadFont: KatexFontDataUriLoader = (url) => resolveWoff2DataUri(url),
): Promise<string> {
  const entries = await Promise.all(
    Object.entries(KATEX_SANDBOX_FONT_URLS).map(async ([fontName, url]) => [
      fontName,
      await loadFont(url, fontName),
    ] as const),
  );
  return rewriteKatexSandboxCss(css, Object.fromEntries(entries));
}
