/**
 * Shared utility functions for markdown renderers.
 * - shallowEqualSpans: shallow comparison of highlight span arrays
 * - makeUncertaintyHighlightPlugin: remark plugin that wraps text matching highlight spans in <mark> elements
 */

export type HighlightSpan = { start: number; end: number; reason?: string };

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
  let ranges = (spans || [])
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
                    style: 'background-color: hsl(var(--warning) / 0.3); border-radius:2px; padding:0 1px;',
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
