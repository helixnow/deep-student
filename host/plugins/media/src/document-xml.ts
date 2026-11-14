/** Minimal XML tokenizer and the EPUB chapter HTML → text renderer used by `document_parser.rs` callers. */

export interface XmlToken {
  kind: 'start' | 'end' | 'text';
  local: string;
  /** Qualified name as written (prefix included); empty for text tokens. */
  qname?: string;
  /** True for CDATA sections (xml-rs reports these as `CData`, not `Characters`). */
  cdata?: boolean;
  attrs: Record<string, string>;
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', times: '\u00d7',
  divide: '\u00f7', plusmn: '\u00b1', deg: '\u00b0', laquo: '\u00ab',
  raquo: '\u00bb', sup2: '\u00b2', sup3: '\u00b3', frac12: '\u00bd',
};

/** 解码 XML/HTML 实体（命名实体子集 + 数字实体）。 */
export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function localName(name: string): string {
  const colon = name.lastIndexOf(':');
  return colon >= 0 ? name.slice(colon + 1) : name;
}

/** 极简 XML 分词器：处理声明、注释、CDATA、空元素与属性。 */
export function* xmlTokens(xml: string): Generator<XmlToken> {
  let index = 0;
  while (index < xml.length) {
    const lt = xml.indexOf('<', index);
    if (lt < 0) {
      yield { kind: 'text', local: '', attrs: {}, text: decodeXmlEntities(xml.slice(index)) };
      return;
    }
    if (lt > index) {
      yield { kind: 'text', local: '', attrs: {}, text: decodeXmlEntities(xml.slice(index, lt)) };
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      index = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      const text = xml.slice(lt + 9, end < 0 ? xml.length : end);
      yield { kind: 'text', local: '', attrs: {}, text, cdata: true };
      index = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2);
      index = end < 0 ? xml.length : end + 1;
      continue;
    }
    let pos = lt + 1;
    const closing = xml[pos] === '/';
    if (closing) pos += 1;
    const nameStart = pos;
    while (pos < xml.length && !/[\s/>]/.test(xml[pos]!)) pos += 1;
    const name = xml.slice(nameStart, pos);
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    while (pos < xml.length) {
      while (pos < xml.length && /\s/.test(xml[pos]!)) pos += 1;
      if (xml[pos] === '>') { pos += 1; break; }
      if (xml[pos] === '/' && xml[pos + 1] === '>') { selfClosing = true; pos += 2; break; }
      const attrStart = pos;
      while (pos < xml.length && !/[\s=/>]/.test(xml[pos]!)) pos += 1;
      const attrName = xml.slice(attrStart, pos);
      while (pos < xml.length && /\s/.test(xml[pos]!)) pos += 1;
      let attrValue = '';
      if (xml[pos] === '=') {
        pos += 1;
        while (pos < xml.length && /\s/.test(xml[pos]!)) pos += 1;
        const quote = xml[pos];
        if (quote === '"' || quote === "'") {
          const end = xml.indexOf(quote, pos + 1);
          attrValue = xml.slice(pos + 1, end < 0 ? xml.length : end);
          pos = end < 0 ? xml.length : end + 1;
        }
      }
      if (attrName !== '') attrs[localName(attrName)] = decodeXmlEntities(attrValue);
    }
    yield {
      kind: closing ? 'end' : 'start',
      local: localName(name),
      qname: name,
      attrs,
      text: '',
    };
    if (selfClosing) {
      yield { kind: 'end', local: localName(name), qname: name, attrs: {}, text: '' };
    }
    index = pos;
  }
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'dl', 'dt', 'dd',
  'tr', 'table', 'blockquote', 'section', 'article', 'header', 'footer', 'pre', 'hr',
]);

/**
 * EPUB 章节 HTML → 纯文本。Rust 侧用 `html2text::from_read(_, 80)`；这里保留
 * 块级换行与实体解码，不做 80 列折行（章节文本只用于索引/展示，不构成线协议）。
 */
export function htmlToText(html: string): string {
  const parts: string[] = [];
  let skipDepth = 0;
  let skipTag: string | null = null;
  for (const token of xmlTokens(html)) {
    if (token.kind === 'start') {
      if (skipTag !== null) {
        if (token.local === skipTag) skipDepth += 1;
        continue;
      }
      if (token.local === 'head' || token.local === 'script' || token.local === 'style') {
        skipTag = token.local;
        skipDepth = 1;
        continue;
      }
      if (token.local === 'br') parts.push('\n');
      else if (token.local === 'li') parts.push('\n- ');
      else if (BLOCK_TAGS.has(token.local)) parts.push('\n');
    } else if (token.kind === 'end') {
      if (skipTag !== null) {
        if (token.local === skipTag) {
          skipDepth -= 1;
          if (skipDepth === 0) skipTag = null;
        }
        continue;
      }
      if (BLOCK_TAGS.has(token.local)) parts.push('\n');
    } else if (skipTag === null) {
      parts.push(token.text);
    }
  }
  return parts.join('')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .filter(line => line !== '')
    .join('\n');
}
