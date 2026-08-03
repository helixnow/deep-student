/** compatible callout types supported by this plugin. */
export const CALLOUT_TYPES = ['note', 'tip', 'warning', 'danger', 'info'] as const;

export type CalloutType = (typeof CALLOUT_TYPES)[number];

export const CALLOUT_TYPE_SET = new Set<string>(CALLOUT_TYPES);

export function isCalloutType(value: string): value is CalloutType {
  return CALLOUT_TYPE_SET.has(value.toLowerCase());
}

export function normalizeCalloutType(value: string | null | undefined): CalloutType {
  const lower = (value ?? 'note').toLowerCase();
  return isCalloutType(lower) ? lower : 'note';
}

/** Cycle note → tip → warning → danger → info → note */
export function nextCalloutType(current: string): CalloutType {
  const type = normalizeCalloutType(current);
  const index = CALLOUT_TYPES.indexOf(type);
  return CALLOUT_TYPES[(index + 1) % CALLOUT_TYPES.length]!;
}

/**
 * Match callout marker at the start of a blockquote's first paragraph.
 * Examples: `[!note]`, `[!tip] Title`, `[!warning]  注意`
 * 容错：全角感叹号 `！`、类型任意大小写、`]` 后可跟半/全角冒号、
 * 折叠后缀 `-`（collapsed）/ `+`（展开）。
 */
export const CALLOUT_MARKER_RE =
  /^\[[!！]([a-zA-Z]+)\]([+-])?(?:[:：]\s*(.*)|\s+(.*))?$/;

export interface ParsedCalloutMarker {
  type: CalloutType;
  title: string;
  collapsed: boolean;
}

export function parseCalloutMarker(text: string): ParsedCalloutMarker | null {
  const trimmed = text.trim();
  const match = CALLOUT_MARKER_RE.exec(trimmed);
  if (!match) return null;
  const rawType = match[1] ?? '';
  if (!isCalloutType(rawType)) return null;
  return {
    type: rawType.toLowerCase() as CalloutType,
    title: (match[3] ?? match[4] ?? '').trim(),
    collapsed: match[2] === '-',
  };
}
