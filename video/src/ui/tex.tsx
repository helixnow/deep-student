import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useEffect, useState, type CSSProperties } from 'react';
import { cancelRender, continueRender, delayRender, getInputProps } from 'remotion';

const cache = new Map<string, string>();

export const Tex = ({ tex, display = false, style }: { tex: string; display?: boolean; style?: CSSProperties }) => {
  const key = `${display ? 'D' : 'I'}:${tex}`;
  let html = cache.get(key);
  if (!html) {
    html = katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html' });
    cache.set(key, html);
  }
  return <span style={style} dangerouslySetInnerHTML={{ __html: html }} />;
};

const FONT_PROBES = ['20px KaTeX_Main', 'italic 20px KaTeX_Math', 'italic 20px KaTeX_Main', 'bold 20px KaTeX_Main', '20px KaTeX_Size1', '20px KaTeX_Size2', '20px "PingFang SC"', '20px "Songti SC"'];

/** 字幕、标题和界面中文靠这两套 macOS 系统字体；缺了会静默回退成雅黑 / 宋体，字宽和换行都会变。 */
const REQUIRED_FONTS = ['PingFang SC', 'Songti SC'];

/** CJK 字都是 1em 宽，只比宽度测不出中文字体：同时比西文宽度和汉字的墨迹高度。 */
const hasFont = (family: string) => {
  const c = document.createElement('canvas').getContext('2d');
  if (!c) return true;
  const sig = (f: string) => {
    c.font = `64px ${f}`;
    const a = c.measureText('DeepStudent 0123');
    const b = c.measureText('学');
    return `${a.width.toFixed(2)}|${b.actualBoundingBoxAscent.toFixed(2)}|${b.actualBoundingBoxDescent.toFixed(2)}`;
  };
  return ['monospace', 'serif', 'sans-serif'].some((fb) => sig(`"${family}", ${fb}`) !== sig(fb));
};

/**
 * 逐帧渲染前等 KaTeX 与系统字体就绪，避免首帧回退字体。
 * 缺系统字体时在浏览器控制台告警；正式出片加 `--props='{"strictFonts":true}'`，缺字体直接中止渲染。
 */
export const useFontsReady = () => {
  const [handle] = useState(() => delayRender('fonts'));
  useEffect(() => {
    Promise.all(FONT_PROBES.map((f) => document.fonts.load(f, 'fξ′中')))
      .then(() => document.fonts.ready)
      .catch(() => undefined)
      .then(() => {
        const missing = REQUIRED_FONTS.filter((f) => !hasFont(f));
        if (missing.length && getInputProps().strictFonts === true) {
          cancelRender(new Error(`缺少字体：${missing.join('、')}（正式成片请在装有这些字体的 macOS 上渲染）`));
          return;
        }
        if (missing.length) console.warn(`[fonts] 缺少 ${missing.join('、')}，已回退到系统默认中文字体；这一版只适合预览`);
        continueRender(handle);
      });
  }, [handle]);
};
