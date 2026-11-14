/**
 * What a debug panel shows, for evidence goldens: tag, class, inline style, title, disabled/open and full text
 * (whitespace collapsed); an svg is one line with its size and the start of its first path, which identifies the icon.
 * Unlike `serializeDom` nothing is masked or cut, so inline colours and long detail text stay in the golden.
 */
export function dump(node: Node, depth = 0, out: string[] = []): string[] {
  const pad = '  '.repeat(depth);
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.nodeValue?.replace(/\s+/g, ' ').trim();
    if (text) out.push(`${pad}${JSON.stringify(text)}`);
    return out;
  }
  if (!(node instanceof Element)) return out;
  const tag = node.tagName.toLowerCase();
  const attrs = ['class', 'style', 'title', 'disabled', 'open']
    .filter((name) => node.hasAttribute(name))
    .map((name) => `${name}=${JSON.stringify(node.getAttribute(name))}`);
  if (tag === 'svg') {
    const path = (node.querySelector('path')?.getAttribute('d') ?? '').slice(0, 24);
    out.push(`${pad}<svg size=${node.getAttribute('width')} icon=${JSON.stringify(path)}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`);
    return out;
  }
  out.push(`${pad}<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`);
  node.childNodes.forEach((child) => dump(child, depth + 1, out));
  return out;
}

export const panelText = (container: Element) => `${dump(container).join('\n')}\n`;
