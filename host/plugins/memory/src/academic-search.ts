/**
 * Academic search pure layer — TS mirror of
 * `src-tauri/src/chat_v2/tools/academic_search_executor.rs` tool routing,
 * arXiv Atom parsing, OpenAlex abstract reconstruction and source conversion.
 */
import { stripToolNamespace } from './paper-save.ts';

export const ACADEMIC_SEARCH_TOOLS = ['arxiv_search', 'scholar_search'] as const;
export type ToolSensitivity = 'low' | 'medium' | 'high';

export function academicSearchCanHandle(toolName: string): boolean {
  const stripped = stripToolNamespace(toolName);
  return (ACADEMIC_SEARCH_TOOLS as readonly string[]).includes(stripped);
}

export function academicSearchSensitivity(): ToolSensitivity {
  return 'low';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const XML_PREDEFINED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['lt', '<'], ['gt', '>'], ['amp', '&'], ['apos', "'"], ['quot', '"'],
]);

/** quick-xml 0.37 `parse_number`: only a lowercase `x` selects hex; a sign, no digits or a stray digit is invalid. */
function xmlCharReference(body: string): string {
  const hex = body.startsWith('x');
  const digits = hex ? body.slice(1) : body;
  const code = (hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits) ? Number.parseInt(digits, hex ? 16 : 10) : 0;
  // RUST-FIX(RF-S01-arxiv-invalid-char-ref-drops-text): Rust `unescape().unwrap_or_default()` blanks the whole text node (and drops the paper when it is <id>); only the bad reference becomes U+FFFD.
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
  return String.fromCodePoint(code);
}

/** quick-xml 0.37 `unescape`: one left-to-right pass, so text produced by a reference is never decoded again. */
function decodeXmlText(text: string): string {
  let output = '';
  let copied = 0;
  for (let start = text.indexOf('&'); start >= 0; start = text.indexOf('&', start + 1)) {
    const end = text.indexOf(';', start + 1);
    const nextAmpersand = text.indexOf('&', start + 1);
    // RUST-FIX(RF-S01-arxiv-unrecognized-entity-drops-text): Rust's UnterminatedEntity/UnrecognizedEntity errors blank the whole text node via unwrap_or_default(); the reference stays literal instead.
    if (end < 0 || (nextAmpersand >= 0 && nextAmpersand < end)) continue;
    const body = text.slice(start + 1, end);
    const decoded = body.startsWith('#') ? xmlCharReference(body.slice(1)) : XML_PREDEFINED_ENTITIES.get(body);
    if (decoded === undefined) continue;
    output += text.slice(copied, start) + decoded;
    copied = end + 1;
    start = end;
  }
  return copied === 0 ? text : output + text.slice(copied);
}

function tagText(entry: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(entry);
  return match === null ? '' : decodeXmlText(match[1]!).trim();
}

/** Rust reads attributes with `from_utf8_lossy(&attr.value)`: quick-xml accepts both quote styles and nothing is unescaped. */
function attributes(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of raw.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    map.set(match[1]!, match[2] ?? match[3]!);
  }
  return map;
}

function stripVersion(shortId: string): string {
  const index = shortId.lastIndexOf('v');
  if (index < 0) return shortId;
  const suffix = shortId.slice(index + 1);
  return suffix.length > 0 && /^[0-9]+$/.test(suffix) ? shortId.slice(0, index) : shortId;
}

export interface ArxivPaper {
  id: string;
  title: string;
  authors: string[];
  abstract: string;
  categories: string[];
  published: string;
  pdfUrl: string;
  arxivUrl: string;
}

/**
 * Rust `parse_arxiv_atom` for the Atom subset arXiv emits.
 *
 * It intentionally mirrors the state machine's text handling: titles/summaries
 * are trimmed and newlines become spaces, duplicate categories are dropped and
 * the short id loses its `vN` suffix.
 */
export function parseArxivAtom(xml: string): ArxivPaper[] {
  const papers: ArxivPaper[] = [];
  for (const match of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)) {
    const entry = match[1]!;
    const rawId = tagText(entry, 'id');
    if (rawId === '') continue;

    const title = tagText(entry, 'title').replace(/\n/g, ' ');
    const summary = tagText(entry, 'summary').replace(/\n/g, ' ');
    const published = tagText(entry, 'published');

    const authors: string[] = [];
    for (const author of entry.matchAll(/<author(?:\s[^>]*)?>([\s\S]*?)<\/author>/g)) {
      const name = tagText(author[1]!, 'name');
      if (name !== '') authors.push(name);
    }

    const categories: string[] = [];
    for (const category of entry.matchAll(/<category\b([^>]*?)\/?>/g)) {
      const term = attributes(category[1]!).get('term');
      if (term !== undefined && !categories.includes(term)) categories.push(term);
    }

    let pdfUrl = '';
    for (const link of entry.matchAll(/<link\b([^>]*?)\/?>/g)) {
      const attrs = attributes(link[1]!);
      const href = attrs.get('href') ?? '';
      if (attrs.get('title') === 'pdf' && href !== '') pdfUrl = href;
    }

    const shortId = stripVersion(rawId.split('/abs/').at(-1) ?? rawId);
    papers.push({
      id: shortId,
      title,
      authors,
      abstract: summary,
      categories,
      published,
      pdfUrl: pdfUrl === '' ? `https://arxiv.org/pdf/${shortId}` : pdfUrl,
      arxivUrl: `https://arxiv.org/abs/${shortId}`,
    });
  }
  return papers;
}

/** Rust `reconstruct_abstract` (OpenAlex inverted index -> position-sorted text). */
export function reconstructAbstract(invertedIndex: Record<string, unknown>): string {
  const words = new Map<number, string>();
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (typeof position === 'number' && Number.isInteger(position) && position >= 0) {
        words.set(position, word);
      }
    }
  }
  return [...words.entries()].sort((a, b) => a[0] - b[0]).map(([, word]) => word).join(' ');
}

export interface SourceInfo {
  title?: string;
  url?: string;
  snippet?: string;
  metadata?: Record<string, unknown>;
}

/** Rust `papers_to_sources` (metadata keys consumed by the citation ledger). */
export function papersToSources(papers: readonly unknown[], searchSource: string): SourceInfo[] {
  return papers.map(paper => {
    const record = isRecord(paper) ? paper : {};
    const title = typeof record['title'] === 'string' ? record['title'] : '';
    const url = (typeof record['arxivUrl'] === 'string' && record['arxivUrl']
      || typeof record['doi'] === 'string' && record['doi']
      || typeof record['pdfUrl'] === 'string' && record['pdfUrl']
      || '') as string;
    const snippet = typeof record['abstract'] === 'string' ? record['abstract'] : '';
    const chars = Array.from(snippet);
    return {
      title,
      url,
      snippet: chars.length > 300 ? `${chars.slice(0, 300).join('')}…` : snippet,
      metadata: {
        sourceType: 'academic_search',
        searchSource,
        authors: record['authors'],
        year: record['year'] ?? (typeof record['published'] === 'string' && record['published'].length >= 4
          ? record['published'].slice(0, 4) : null),
        citationCount: record['citationCount'],
        pdfUrl: record['pdfUrl'],
        doi: record['doi'],
        venue: record['venue'],
        arxivId: record['id'],
        categories: record['categories'],
      },
    };
  });
}

export { CitationLedger, type NumberingLedger } from './citation-ledger.ts';
