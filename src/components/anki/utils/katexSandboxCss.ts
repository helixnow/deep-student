/**
 * 卡面 iframe 内的 KaTeX 样式（含 data: 字体）按需加载。
 *
 * 模板卡面原先只输出 MathML，字形完全取自设备数学字体：部分 Android WebView 能排版
 * 却取不到标识符字形，拉丁/希腊字母整段消失（#461）。现与聊天侧一致输出
 * htmlAndMathml，由 KaTeX 自带字体排版；样式模块约 160KB，只在卡面含公式时动态导入。
 */
import { useEffect, useState } from 'react';

let cachedCss: string | null = null;
let loadPromise: Promise<string> | null = null;

export function loadKatexSandboxCss(): Promise<string> {
  if (cachedCss != null) return Promise.resolve(cachedCss);
  if (!loadPromise) {
    loadPromise = import('./katexSandboxCssData')
      .then((mod) => {
        cachedCss = mod.KATEX_SANDBOX_CSS;
        return cachedCss;
      })
      .catch((error: unknown) => {
        // 失败后允许下次重试；调用方保持 MathML 输出兜底
        loadPromise = null;
        throw error;
      });
  }
  return loadPromise;
}

/**
 * 需要时返回 KaTeX 样式；未就绪（首次下载中或加载失败）返回 null，
 * 调用方此时应输出纯 MathML——没有样式的 htmlAndMathml 会把 HTML 与 MathML 两份都显示出来。
 */
export function useKatexSandboxCss(needed: boolean): string | null {
  const [css, setCss] = useState<string | null>(cachedCss);
  useEffect(() => {
    if (!needed || css != null) return undefined;
    let cancelled = false;
    loadKatexSandboxCss()
      .then((loaded) => {
        if (!cancelled) setCss(loaded);
      })
      .catch((error: unknown) => {
        console.warn('[cardFace] KaTeX 样式加载失败，公式回退为 MathML', error);
      });
    return () => {
      cancelled = true;
    };
  }, [needed, css]);
  return needed ? css : null;
}
