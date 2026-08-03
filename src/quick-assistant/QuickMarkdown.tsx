import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { KatexOptions } from 'katex';
import {
  ensureKatexLoaded,
  getLoadedKatex,
} from '@/features/chat/components/renderers/lazyKatex';
import { ensureKatexStyles } from '@/utils/lazyStyles';

const KATEX_OPTIONS: KatexOptions = {
  throwOnError: false,
  errorColor: 'hsl(var(--destructive))',
  strict: false,
  trust: false,
};

/**
 * remark-math v6 只识别 $...$ / $$...$$；
 * 模型常输出 \(...\) 与 \[...\]，这里做最小归一化。
 */
function normalizeMathDelimiters(text: string): string {
  return text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_match, body: string) => `$$${body}$$`)
    .replace(/\\\((.+?)\\\)/g, (_match, body: string) => `$${body}$`);
}

const MathNode: React.FC<{ latex: string; displayMode: boolean }> = ({ latex, displayMode }) => {
  const katex = getLoadedKatex();
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (katex) return;
    let cancelled = false;
    ensureKatexLoaded()
      .then(() => { if (!cancelled) forceRender((n) => n + 1); })
      .catch(() => { /* 加载失败保持原文降级 */ });
    return () => { cancelled = true; };
  }, [katex]);

  const value = latex.trim();
  if (!value) return null;
  if (!katex) {
    return <span style={{ display: displayMode ? 'block' : 'inline' }}>{value}</span>;
  }
  try {
    const html = katex.renderToString(value, { ...KATEX_OPTIONS, displayMode });
    return <span dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return <span style={{ display: displayMode ? 'block' : 'inline' }}>{value}</span>;
  }
};

/** 快速学习小窗的轻量 Markdown 渲染：GFM + 数学公式（KaTeX 懒加载）。 */
export const QuickMarkdown: React.FC<{ content: string }> = ({ content }) => {
  useEffect(() => { ensureKatexStyles(); }, []);
  const normalized = useMemo(() => normalizeMathDelimiters(content), [content]);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      components={{
        // @ts-expect-error remark-math 的 math/inlineMath 节点不在 react-markdown 类型里
        math: ({ value }: { value?: string }) => (
          <MathNode latex={String(value ?? '')} displayMode />
        ),
        inlineMath: ({ value }: { value?: string }) => (
          <MathNode latex={String(value ?? '')} displayMode={false} />
        ),
      }}
    >
      {normalized}
    </ReactMarkdown>
  );
};

export default QuickMarkdown;
