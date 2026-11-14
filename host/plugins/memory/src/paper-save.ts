/**
 * Paper save / citation formatting pure layer — TS mirror of
 * `src-tauri/src/chat_v2/tools/paper_save_executor.rs`.
 *
 * PDF download, VFS storage and OCR stay out of scope; filename sanitization
 * and the three citation formats are deterministic and ported here.
 */
import { ensureLocalizedError } from './tool-errors.ts';

export const PAPER_SAVE_TOOLS = ['paper_save', 'cite_format'] as const;
export const CITE_FORMATS = ['bibtex', 'gbt7714', 'apa'] as const;

export type PaperSensitivity = 'low' | 'medium';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rust `strip_tool_namespace` (builtin-/mcp_ prefixes). */
export function stripToolNamespace(toolName: string): string {
  if (toolName.startsWith('builtin-')) return toolName.slice('builtin-'.length);
  if (toolName.startsWith('mcp_')) return toolName.slice('mcp_'.length);
  return toolName;
}

export function paperSaveCanHandle(toolName: string): boolean {
  const stripped = stripToolNamespace(toolName);
  return stripped === 'paper_save' || stripped === 'cite_format';
}

export function paperSaveSensitivity(toolName: string): PaperSensitivity {
  return stripToolNamespace(toolName) === 'cite_format' ? 'low' : 'medium';
}

/** Rust `localized_paper_failure`. */
export function localizedPaperFailure(error: string): string {
  return ensureLocalizedError(error, 'PAPER_OPERATION_FAILED', 'chat.tools.paper.error',
    '论文工具操作失败', 'The paper operation failed.');
}

/** Rust `sanitize_filename` (illegal/control chars -> `_`, 100-char cap). */
export function sanitizeFilename(name: string): string {
  const mapped = Array.from(name).map(char => {
    if ('/\\:*?"<>|'.includes(char)) return '_';
    const code = char.codePointAt(0)!;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? '_' : char;
  });
  return mapped.slice(0, 100).join('');
}

export function extractAuthorsList(paper: unknown): string[] {
  if (!isRecord(paper)) return [];
  const authors = paper['authors'];
  if (Array.isArray(authors)) {
    return authors.filter((author): author is string => typeof author === 'string');
  }
  if (typeof authors === 'string') return authors.split(', ');
  return [];
}

function stringField(paper: unknown, key: string, fallback: string): string {
  const value = isRecord(paper) ? paper[key] : undefined;
  return typeof value === 'string' ? value : fallback;
}

function yearField(paper: unknown): number {
  const value = isRecord(paper) ? paper['year'] : undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Rust `format_bibtex`. */
export function formatBibtex(paper: unknown): string {
  const title = stringField(paper, 'title', 'Untitled');
  const year = yearField(paper);
  const doi = stringField(paper, 'doi', '');
  const venue = stringField(paper, 'venue', '');
  const authors = extractAuthorsList(paper);
  const authorStr = authors.join(' and ');

  const firstAuthor = authors[0] ?? 'unknown';
  const parts = firstAuthor.trim().split(/\s+/).filter(Boolean);
  const lastName = parts.at(-1) ?? 'unknown';
  const clean = Array.from(lastName)
    .filter(char => /[\p{L}\p{N}]/u.test(char)).join('').toLowerCase();
  const citeKey = `${clean}${year}`;

  let bib = `@article{${citeKey},\n`;
  bib += `  title = {${title}},\n`;
  if (authorStr !== '') bib += `  author = {${authorStr}},\n`;
  if (year > 0) bib += `  year = {${year}},\n`;
  if (venue !== '') bib += `  journal = {${venue}},\n`;
  if (doi !== '') bib += `  doi = {${doi}},\n`;
  bib += '}';
  return bib;
}

/** Rust `format_gbt7714`. */
export function formatGbt7714(paper: unknown): string {
  const title = stringField(paper, 'title', 'Untitled');
  const year = yearField(paper);
  const doi = stringField(paper, 'doi', '');
  const venue = stringField(paper, 'venue', '');
  const authors = extractAuthorsList(paper);
  const authorStr = authors.length > 3
    ? `${authors.slice(0, 3).join(', ')}, 等`
    : authors.join(', ');

  let citation = '';
  if (authorStr !== '') citation += `${authorStr}. `;
  citation += title;
  citation += '[J]. ';
  if (venue !== '') citation += `${venue}, `;
  if (year > 0) citation += `${year}`;
  citation += '.';
  if (doi !== '') citation += ` DOI: ${doi}.`;
  return citation;
}

function apaAuthor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts.at(-1)!;
    const initials = parts.slice(0, -1)
      .map(part => `${Array.from(part)[0] ?? '?'}.`).join(' ');
    return `${last}, ${initials}`;
  }
  return name;
}

/** Rust `format_apa`. */
export function formatApa(paper: unknown): string {
  const title = stringField(paper, 'title', 'Untitled');
  const year = yearField(paper);
  const doi = stringField(paper, 'doi', '');
  const venue = stringField(paper, 'venue', '');
  const apaAuthors = extractAuthorsList(paper).map(apaAuthor);

  let authorStr: string;
  if (apaAuthors.length > 7) {
    authorStr = `${apaAuthors.slice(0, 6).join(', ')}, ... ${apaAuthors.at(-1)}`;
  } else if (apaAuthors.length === 2) {
    authorStr = `${apaAuthors[0]}, & ${apaAuthors[1]}`;
  } else if (apaAuthors.length > 2) {
    const last = apaAuthors.at(-1)!;
    const rest = apaAuthors.slice(0, -1).join(', ');
    authorStr = `${rest}, & ${last}`;
  } else {
    authorStr = apaAuthors.join(', ');
  }

  let citation = '';
  if (authorStr !== '') citation += `${authorStr} `;
  if (year > 0) citation += `(${year}). `;
  citation += title;
  citation += '.';
  if (venue !== '') citation += ` *${venue}*.`;
  if (doi !== '') {
    const cleanDoi = doi.startsWith('https://doi.org/') ? doi.slice('https://doi.org/'.length) : doi;
    citation += ` https://doi.org/${cleanDoi}`;
  }
  return citation;
}

export function formatCitation(paper: unknown, format: string): string {
  if (format === 'bibtex') return formatBibtex(paper);
  if (format === 'gbt7714') return formatGbt7714(paper);
  if (format === 'apa') return formatApa(paper);
  throw new Error(`Unsupported format: '${format}'. Use 'bibtex', 'gbt7714', or 'apa'.`);
}
