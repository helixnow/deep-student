import * as React from 'react';
import { cn } from '@/lib/utils';
import { ensureKatexStyles } from '@/utils/lazyStyles';

/**
 * 安全的数学公式组件（`@deepstudent/ui` 公共 API）。
 *
 * - `tex`：整段就是一个公式；`text`：普通文字里夹 `$…$`（行内）/ `$$…$$`（独立成行），`\$` 是字面美元符。
 * - 只把 KaTeX 自己生成的标记写进 DOM：`trust: false`（`\href`、`\url`、`\htmlClass` 等一律不生效）、
 *   限制尺寸与宏展开；输入里的其他文字始终作为文本节点渲染。
 * - KaTeX 按需加载（首次渲染公式时才 import，SDK 入口不变重）；加载中与解析失败都显示原文。
 */
export interface MathTextProps {
  /** 一个 LaTeX 公式（不带 `$`）。与 `text` 二选一，同时给出时用 `tex`。 */
  tex?: string;
  /** 夹带 `$…$` / `$$…$$` 公式的文字。 */
  text?: string;
  /** `tex` 按独立公式（居中成行）渲染；默认行内。 */
  display?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

type Katex = typeof import('katex').default;

let loaded: Katex | null = null;
let loading: Promise<Katex> | null = null;

function loadKatex(): Promise<Katex> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= Promise.all([import('katex'), import('katex/contrib/mhchem')])
    .then(([module]) => (loaded = module.default))
    .catch((error: unknown) => {
      loading = null; // 允许下次重试（网络抖动 / dev server 重启）
      throw error;
    });
  return loading;
}

/** 超过这个长度的公式不交给 KaTeX，直接显示原文。 */
const MAX_TEX_LENGTH = 2000;

/** KaTeX 渲染为 HTML 字符串；失败（语法错误、过长）返回 null。 */
function renderTex(katex: Katex, tex: string, displayMode: boolean): string | null {
  if (!tex.trim() || tex.length > MAX_TEX_LENGTH) return null;
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: true,
      trust: false,
      strict: 'ignore',
      maxSize: 20,
      maxExpand: 500,
      output: 'htmlAndMathml',
    });
  } catch {
    return null;
  }
}

type MathSegment = { kind: 'text'; value: string } | { kind: 'math'; value: string; display: boolean };

/** 把文字拆成文本段与公式段。没闭合的 `$` 按普通文字处理。 */
function splitMathText(input: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let text = '';
  let index = 0;
  const flush = () => {
    if (text) segments.push({ kind: 'text', value: text });
    text = '';
  };
  while (index < input.length) {
    const char = input[index]!;
    if (char === '\\' && input[index + 1] === '$') {
      text += '$';
      index += 2;
      continue;
    }
    if (char === '$') {
      const display = input[index + 1] === '$';
      const open = display ? 2 : 1;
      let end = index + open;
      let found = -1;
      while (end < input.length) {
        if (input[end] === '\\') { end += 2; continue; }
        if (input[end] === '$' && (!display || input[end + 1] === '$')) { found = end; break; }
        end += 1;
      }
      const body = found >= 0 ? input.slice(index + open, found) : '';
      if (found >= 0 && body.trim() && (display || !/\n\s*\n/.test(body))) {
        flush();
        segments.push({ kind: 'math', value: body, display });
        index = found + open;
        continue;
      }
    }
    text += char;
    index += 1;
  }
  flush();
  return segments;
}

function Formula({ katex, tex, display }: { katex: Katex | null; tex: string; display: boolean }) {
  const html = React.useMemo(() => (katex ? renderTex(katex, tex, display) : null), [katex, tex, display]);
  if (!html) {
    const source = display ? `$$${tex}$$` : `$${tex}$`;
    return <span data-math-source="" style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{source}</span>;
  }
  // html 只来自 KaTeX（trust: false），不含插件输入里的原始标记。
  return display
    ? <span data-math="display" style={{ display: 'block', maxWidth: '100%', overflowX: 'auto' }} dangerouslySetInnerHTML={{ __html: html }} />
    : <span data-math="inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function MathText({ tex, text, display = false, className, style }: MathTextProps) {
  const segments = React.useMemo<MathSegment[]>(
    () => (typeof tex === 'string' ? [{ kind: 'math', value: tex, display }] : splitMathText(typeof text === 'string' ? text : '')),
    [tex, text, display],
  );
  const hasMath = segments.some(segment => segment.kind === 'math');
  const [katex, setKatex] = React.useState<Katex | null>(loaded);

  React.useEffect(() => {
    if (!hasMath || katex) return;
    let active = true;
    loadKatex().then(module => { if (active) setKatex(module); }, () => { /* 保持原文显示 */ });
    return () => { active = false; };
  }, [hasMath, katex]);

  React.useEffect(() => {
    if (hasMath) ensureKatexStyles();
  }, [hasMath]);

  return (
    <span className={cn('ds-math-text', className)} style={style}>
      {segments.map((segment, index) => segment.kind === 'text'
        ? <React.Fragment key={index}>{segment.value}</React.Fragment>
        : <Formula key={index} katex={katex} tex={segment.value} display={segment.display} />)}
    </span>
  );
}
