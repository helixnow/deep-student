/**
 * FE-A1 layer 2: structural DOM serialisation shared by the demo-shell DOM golden (Playwright, the
 * function source is evaluated in the page) and component-level goldens in jsdom tests.
 *
 * Self-contained on purpose: no imports, erasable TypeScript only, so Node can load this file
 * directly and `serializeDom.toString()` is valid page JavaScript.
 *
 * Kept: tag, sorted classes, semantic attributes (role, aria-*, data-*, form/link attributes),
 * open shadow roots and trimmed text. Dropped: inline style (layout depends on fonts), SVG internals,
 * script/style. Ids and id references become @1, @2 … in order of first appearance; timestamps,
 * UUIDs, the server origin and measured durations are masked so that clock and render-order noise
 * does not show up as drift.
 */
export interface DomSnapshotOptions {
  /** Longest text node kept verbatim; longer ones are cut with "…". Default 120. */
  maxText?: number;
  /** Elements matching this selector are printed as a single line without children. */
  opaque?: string;
}

export function serializeDom(root: Element | ShadowRoot | Document, options: DomSnapshotOptions = {}): string {
  const maxText = options.maxText ?? 120;
  const opaque = options.opaque ?? '';
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta']);
  const KEEP = /^(role|aria-.+|data-.+|type|name|href|src|alt|title|placeholder|disabled|checked|selected|readonly|hidden|open|tabindex|contenteditable|draggable|for|value|viewBox|lang|dir|inert)$/;
  const REF_ATTRS = new Set(['id', 'for', 'aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'form', 'list', 'headers']);
  const ids = new Map<string, string>();
  function dynamicToken(value: string): string {
    return value
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
      .replace(/\bblob:[^\s"']+/g, 'blob:<url>')
      .replace(/\bdata:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, 'data:<base64>')
      .replace(/\bhttps?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/g, '<origin>')
      // Epoch timestamps (ms / s): time flows from a fixed start, so only the prefix is stable.
      .replace(/(?<!\d)1[6-9]\d{11}(?!\d)/g, '<ts>')
      .replace(/(?<!\d)1[6-9]\d{8}(?!\d)/g, '<ts>')
      // Wall-clock seconds and measured durations (stream timings, 「已用时 N 秒」 and the like).
      .replace(/(?<![\d:])(\d{1,2}:\d{2}):\d{2}(?![\d:])/g, '$1:<ss>')
      .replace(/(?<![\w.])\d+(?:\.\d+)?\s?ms\b/g, '<n>ms')
      .replace(/^\d+(?:\.\d+)?\s?(?:s|秒)$/, '<n>s')
      .replace(/(用时\s?)\d+(\s?秒)/g, '$1<n>$2')
      .replace(/(?<![A-Za-z0-9])(?=[a-z0-9]*\d[a-z0-9]*\d)(?=[a-z0-9]*[a-z][a-z0-9]*[a-z])[a-z0-9]{8,}(?![A-Za-z0-9])/g, '<id>');
  }
  // Runtime state of OverlayScrollbars' auto-hide timer, not structure.
  const VOLATILE_CLASS = /^os-scrollbar-auto-hide$/;
  // Every id-like value is renumbered: libraries mint them from counters or randomness consumed in
  // async order, and only the references between elements are structural.
  const ref = (value: string) => value.split(/\s+/).filter(Boolean).map((part) => {
    if (!ids.has(part)) ids.set(part, `@${ids.size + 1}`);
    return ids.get(part)!;
  }).join(' ');
  // Owner keys like `sandbox:chat-page:<n>` end in a module-wide counter bumped by every (possibly discarded)
  // render that initialises one; renumber per prefix by first appearance, keeping distinct owners distinct.
  const OWNER_KEY_ATTR = /^data-.+-owner-key$/;
  const ownerKeys = new Map<string, string>();
  const ownerKey = (value: string) => {
    const match = /^(.*):\d+$/.exec(value);
    if (!match) return value;
    if (!ownerKeys.has(value)) {
      const prefix = match[1]!;
      const seen = [...ownerKeys.keys()].filter((key) => key.startsWith(`${prefix}:`)).length;
      ownerKeys.set(value, `${prefix}:#${seen + 1}`);
    }
    return ownerKeys.get(value)!;
  };
  const quote = (value: string) => JSON.stringify(value);
  const text = (value: string) => {
    const collapsed = value.replace(/\s+/g, ' ').trim();
    return collapsed.length > maxText ? `${collapsed.slice(0, maxText)}…` : collapsed;
  };
  const lines: string[] = [];
  const visit = (node: Node, depth: number) => {
    const pad = '  '.repeat(depth);
    if (node.nodeType === 3) {
      const value = text(node.nodeValue ?? '');
      if (value) lines.push(`${pad}${quote(dynamicToken(value))}`);
      return;
    }
    if (node.nodeType === 11) {
      for (const child of Array.from(node.childNodes)) visit(child, depth);
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    const parts = [tag];
    const classes = [...new Set((element.getAttribute('class') ?? '').split(/\s+/).filter((name) => name && !VOLATILE_CLASS.test(name)))].sort();
    if (classes.length) parts.push(`.${classes.join('.')}`);
    const attributes = Array.from(element.attributes)
      .filter((attr) => attr.name !== 'class' && (REF_ATTRS.has(attr.name) || KEEP.test(attr.name)))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const attr of attributes) {
      const value = REF_ATTRS.has(attr.name) ? ref(attr.value) : OWNER_KEY_ATTR.test(attr.name) ? ownerKey(attr.value) : dynamicToken(attr.value);
      parts.push(value === '' ? attr.name : `${attr.name}=${quote(value.length > 200 ? `${value.slice(0, 200)}…` : value)}`);
    }
    const leaf = tag === 'svg' || tag === 'iframe' || tag === 'canvas' || (opaque !== '' && element.matches(opaque));
    // Tailwind scans src/** for class candidates: no negated identifiers named like utilities here.
    const shadowTree = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
    if (leaf || (element.childNodes.length === 0 && shadowTree === null)) {
      lines.push(`${pad}<${parts.join(' ')} />`);
      return;
    }
    lines.push(`${pad}<${parts.join(' ')}>`);
    if (shadowTree !== null) {
      lines.push(`${pad}  #shadow-root`);
      for (const child of Array.from(shadowTree.childNodes)) visit(child, depth + 2);
    }
    for (const child of Array.from(element.childNodes)) visit(child, depth + 1);
  };
  const start = (root as Document).body ?? root;
  if ((start as Node).nodeType === 1) visit(start as Node, 0);
  else for (const child of Array.from((start as Node).childNodes)) visit(child, 0);
  return `${lines.join('\n')}\n`;
}
