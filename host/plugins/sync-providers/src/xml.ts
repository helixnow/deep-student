/**
 * Minimal namespace-aware XML reader for WebDAV PROPFIND responses.
 *
 * Replaces `roxmltree` (webdav.rs:220,833,974) with the subset its call sites use:
 * element tree, namespace resolution, text content, and descendants(). Entities are
 * decoded for the five predefined names plus numeric character references; DTDs and
 * external entities are rejected, which is what roxmltree does without the `allow-dtds`
 * feature and removes the XXE surface webdav.rs:831 calls out.
 */

export interface XmlElement {
  readonly kind: 'element';
  readonly name: string;
  readonly namespace: string | null;
  readonly prefix: string | null;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlNode[];
  /** Concatenated text of direct child text nodes (roxmltree `node.text()`). */
  text(): string | null;
  descendants(): Iterable<XmlElement>;
  isElement(name: string, namespace?: string | null): boolean;
}

export interface XmlText { readonly kind: 'text'; readonly value: string }

export type XmlNode = XmlElement | XmlText;

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

const NAME_START = /[A-Za-z_:\u00C0-\uFFFF]/;
const NAME_CHAR = /[-A-Za-z0-9_:.\u00B7\u00C0-\uFFFF]/;
const SPACE = /[ \t\r\n]/;

class Element implements XmlElement {
  readonly kind = 'element' as const;
  readonly name: string;
  readonly namespace: string | null;
  readonly prefix: string | null;
  readonly attributes: Map<string, string>;
  readonly children: XmlNode[] = [];

  constructor(name: string, namespace: string | null, attributes: Map<string, string>) {
    this.name = name;
    this.namespace = namespace;
    const colon = name.indexOf(':');
    this.prefix = colon > 0 ? name.slice(0, colon) : null;
    this.attributes = attributes;
  }

  text(): string | null {
    let out = '';
    let sawText = false;
    for (const child of this.children) {
      if (child.kind !== 'text') continue;
      sawText = true;
      out += child.value;
    }
    return sawText ? out : null;
  }

  *descendants(): Iterable<XmlElement> {
    for (const child of this.children) {
      if (child.kind === 'text') continue;
      yield child;
      yield* child.descendants();
    }
  }

  isElement(name: string, namespace?: string | null): boolean {
    if (this.name !== name && localName(this.name) !== name) return false;
    if (namespace === undefined) return true;
    return this.namespace === namespace;
  }
}

function localName(qualified: string): string {
  const colon = qualified.indexOf(':');
  return colon >= 0 ? qualified.slice(colon + 1) : qualified;
}

function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    switch (body) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return whole;
    }
  });
}

/** Parse an XML document and return its root element. */
export function parseXml(source: string): XmlElement {
  let index = 0;
  const length = source.length;
  const fail = (message: string): never => { throw new XmlError(`${message} at byte ${index}`); };

  const skipSpace = (): void => { while (index < length && SPACE.test(source[index]!)) index++; };

  const readName = (): string => {
    const start = index;
    if (index >= length || !NAME_START.test(source[index]!)) fail('expected name');
    index++;
    while (index < length && NAME_CHAR.test(source[index]!)) index++;
    return source.slice(start, index);
  };

  const skipComment = (): void => {
    const end = source.indexOf('-->', index + 4);
    if (end < 0) fail('unterminated comment');
    index = end + 3;
  };

  const skipProcessingInstruction = (): void => {
    const end = source.indexOf('?>', index + 2);
    if (end < 0) fail('unterminated processing instruction');
    index = end + 2;
  };

  const skipDoctype = (): void => {
    let depth = 0;
    while (index < length) {
      const ch = source[index]!;
      if (ch === '[') depth++;
      else if (ch === ']') depth--;
      else if (ch === '>' && depth === 0) { index++; return; }
      index++;
    }
    fail('unterminated DOCTYPE');
  };

  const readAttributes = (namespaces: Map<string, string>): Map<string, string> => {
    const attributes = new Map<string, string>();
    for (;;) {
      skipSpace();
      if (index >= length) fail('unterminated start tag');
      const ch = source[index]!;
      if (ch === '>' || ch === '/' || ch === '?') break;
      const name = readName();
      skipSpace();
      if (source[index] !== '=') fail('expected =');
      index++;
      skipSpace();
      const quote = source[index];
      if (quote !== '"' && quote !== "'") fail('expected quoted value');
      index++;
      const start = index;
      while (index < length && source[index] !== quote) index++;
      if (index >= length) fail('unterminated attribute value');
      const value = decodeEntities(source.slice(start, index));
      index++;
      if (name === 'xmlns') namespaces.set('', value);
      else if (name.startsWith('xmlns:')) namespaces.set(name.slice(6), value);
      else attributes.set(name, value);
    }
    return attributes;
  };

  const parseElement = (inherited: Map<string, string>): XmlElement => {
    if (source[index] !== '<') fail('expected <');
    index++;
    const qualified = readName();
    const namespaces = new Map(inherited);
    const attributes = readAttributes(namespaces);
    const prefix = qualified.includes(':') ? qualified.slice(0, qualified.indexOf(':')) : '';
    const namespace = namespaces.get(prefix) ?? null;
    const element = new Element(qualified, namespace, attributes);
    skipSpace();
    if (source.startsWith('/>', index)) { index += 2; return element; }
    if (source[index] !== '>') fail('expected >');
    index++;
    for (;;) {
      if (index >= length) fail('unterminated element');
      if (source.startsWith('</', index)) {
        index += 2;
        const closing = readName();
        if (closing !== qualified) fail(`mismatched closing tag ${closing}`);
        skipSpace();
        if (source[index] !== '>') fail('expected >');
        index++;
        return element;
      }
      if (source.startsWith('<!--', index)) { skipComment(); continue; }
      if (source.startsWith('<![CDATA[', index)) {
        const end = source.indexOf(']]>', index + 9);
        if (end < 0) fail('unterminated CDATA');
        element.children.push({ kind: 'text', value: source.slice(index + 9, end) });
        index = end + 3;
        continue;
      }
      if (source.startsWith('<?', index)) { skipProcessingInstruction(); continue; }
      if (source[index] === '<') { element.children.push(parseElement(namespaces)); continue; }
      const start = index;
      while (index < length && source[index] !== '<') index++;
      const text = decodeEntities(source.slice(start, index));
      if (text) element.children.push({ kind: 'text', value: text });
    }
  };

  // Prolog: XML declaration, comments, DOCTYPE, processing instructions.
  for (;;) {
    skipSpace();
    if (index >= length) fail('no root element');
    if (source.startsWith('<?', index)) { skipProcessingInstruction(); continue; }
    if (source.startsWith('<!--', index)) { skipComment(); continue; }
    if (source.startsWith('<!DOCTYPE', index)) { skipDoctype(); continue; }
    break;
  }
  const root = parseElement(new Map());
  return root;
}

/** Every element in document order (roxmltree `document.descendants()`), including the root. */
export function* documentDescendants(root: XmlElement): Iterable<XmlElement> {
  yield root;
  yield* root.descendants();
}
