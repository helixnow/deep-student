/**
 * Shared utility functions for markdown renderers.
 * - parseChainOfThought: extract <thinking>/<think> tag content (streaming fast path)
 * - shallowEqualSpans: shallow comparison of highlight span arrays
 * - makeUncertaintyHighlightPlugin: remark plugin that wraps text matching highlight spans in <mark> elements
 */

export type HighlightSpan = { start: number; end: number; reason?: string };

export type ParsedChainOfThought = {
  thinkingContent: string;
  mainContent: string;
};

// 预编译（旧实现每次调用 new RegExp ×2）。
// 快速探测：绝大多数 content 块不含 thinking 标签（V2 架构中 thinking 是独立块），
// 单次 test() 扫描即可返回，避免流式期间每次 flush 对全量累计文本做
// 带捕获组的完整匹配 + replace 二次扫描（O(n²) 热点之一）。
const THINKING_PROBE_RE = /<think/i;
// 交替 + 反向引用：<thinking>…</thinking> 与 <think>…</think> 一次匹配，
// 同位置优先 thinking（交替顺序），闭合标签必须与开启标签一致
const THINKING_TAG_RE = /<(thinking|think)[^>]*>([\s\S]*?)<\/\1>\s*/i;

/**
 * 解析思维链内容：同时支持 <thinking>…</thinking> 与 <think>…</think>
 *
 * 🔔 V2 兼容性说明：V2 架构中 thinking 已是独立块，此解析主要用于：
 * 1. 兼容旧架构的遗留数据
 * 2. 处理某些 AI 模型在正文中输出 thinking 标签的情况
 * 正常 V2 流程中，content 块不应包含 thinking 标签
 */
export function parseChainOfThought(content: string): ParsedChainOfThought | null {
  if (!content || !THINKING_PROBE_RE.test(content)) return null;

  const match = THINKING_TAG_RE.exec(content);
  if (!match) return null;

  const thinkingContent = (match[2] || '').trim();
  // 按索引切片拼接（原实现用 content.replace(match[0], …) 会对全文再扫描一次）
  const mainContent = (
    content.slice(0, match.index) + content.slice(match.index + match[0].length)
  ).trim();
  return { thinkingContent, mainContent };
}

/**
 * Shallow-compare two highlight-span arrays to avoid JSON.stringify overhead.
 */
export function shallowEqualSpans(
  a: HighlightSpan[] | undefined,
  b: HighlightSpan[] | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end || a[i].reason !== b[i].reason) {
      return false;
    }
  }
  return true;
}

/**
 * Remark plugin factory: wraps text covered by `spans` in `<mark>` elements with
 * a background highlight and a tooltip showing the reason.
 */
export function makeUncertaintyHighlightPlugin(
  fullText: string,
  spans: HighlightSpan[],
  defaultReason: string = '不确定'
) {
  const len = typeof fullText === 'string' ? fullText.length : 0;
  const ranges = (spans || [])
    .map(s => ({
      start: Math.max(0, Math.min(len, Number(s.start))),
      end: Math.max(0, Math.min(len, Number(s.end))),
      reason: s.reason,
    }))
    .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start);
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Array<{ start: number; end: number; reason?: string }> = [];
  for (const r of ranges) {
    if (merged.length === 0) {
      merged.push({ ...r });
      continue;
    }
    const last = merged[merged.length - 1];
    if (r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
      if (!last.reason && r.reason) last.reason = r.reason;
    } else {
      merged.push({ ...r });
    }
  }

  return function attacher() {
    return function transformer(tree: any) {
      let offset = 0;
      const SKIP_IN = new Set(['code', 'inlineCode', 'math', 'inlineMath']);
      function walk(node: any, parent: any | null) {
        if (!node) return;
        const t = node.type;
        if (t === 'text') {
          const value: string = node.value || '';
          const startOff = offset;
          const endOff = offset + value.length;
          const hits = merged.filter(r => r.start < endOff && r.end > startOff);
          if (hits.length > 0 && parent && Array.isArray(parent.children)) {
            const parts: any[] = [];
            let cur = 0;
            for (const r of hits) {
              const a = Math.max(0, r.start - startOff);
              const b = Math.min(value.length, r.end - startOff);
              if (a > cur) parts.push({ type: 'text', value: value.slice(cur, a) });
              const frag = value.slice(a, b);
              const markNode: any = {
                type: 'strong',
                children: [{ type: 'text', value: frag }],
                data: {
                  hName: 'mark',
                  hProperties: {
                    // 用 class 而非内联 style：rehype-sanitize 默认丢弃 style 属性，
                    // 旧写法在消毒管线里会让高亮样式（乃至整个 mark 标签）静默失效。
                    // 样式定义见 renderers/streaming.css 的 .uncertainty-mark。
                    className: ['uncertainty-mark'],
                    title: r.reason || defaultReason,
                  },
                },
              };
              parts.push(markNode);
              cur = b;
            }
            if (cur < value.length) parts.push({ type: 'text', value: value.slice(cur) });
            const idx = parent.children.indexOf(node);
            if (idx >= 0) parent.children.splice(idx, 1, ...parts);
          }
          offset += value.length;
          return;
        }
        if (SKIP_IN.has(t)) {
          const v = node.value || '';
          offset += typeof v === 'string' ? v.length : 0;
          return;
        }
        const children = node.children || [];
        for (const c of children) walk(c, node);
      }
      walk(tree, null);
    };
  };
}
