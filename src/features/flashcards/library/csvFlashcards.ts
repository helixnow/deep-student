/**
 * RFC 4180 flashcard CSV serializer & parser.
 * Supports UTF-8 BOM, Basic and Cloze cards, multi-line quoted cells,
 * Anki `#separator:` / `#deck:` / `#notetype:` / `#columns:` header directives,
 * delimiter auto-detection (tab / comma / semicolon), and EN/ZH headers.
 */
import { hasValidCloze } from '../cloze';

export interface CsvExportableCard {
  front?: string | null;
  back?: string | null;
  text?: string | null;
  tags?: readonly string[] | null;
  fields?: Record<string, string> | null;
  extra_fields?: Record<string, string> | null;
  extraFields?: Record<string, string> | null;
  deckName?: string | null;
  deck?: string | null;
}

export interface SerializeFlashcardsToCsvOptions {
  defaultDeck?: string;
  includeBom?: boolean;
}

export interface ParsedCsvFlashcard {
  front: string;
  back: string;
  tags: string[];
  deck: string;
  noteType: 'Basic' | 'Cloze';
}

export interface CsvImportParseResult {
  cards: ParsedCsvFlashcard[];
  skippedRows: number;
  delimiter: string;
  headerDetected: boolean;
}

const CSV_HEADER_COLUMNS = ['Front', 'Back', 'Tags', 'Deck', 'Type'] as const;

const FRONT_HEADERS = new Set([
  'front', 'question', 'q', 'term', 'word', 'prompt', 'text',
  '正面', '问题', '题目', '题干',
]);

const BACK_HEADERS = new Set([
  'back', 'answer', 'a', 'definition', 'explanation', 'expl', 'meaning', 'extra',
  '背面', '答案', '解析', '释义',
]);

const TAGS_HEADERS = new Set(['tags', 'tag', '标签']);
const DECK_HEADERS = new Set(['deck', 'deckname', 'deck_name', '牌组']);
const TYPE_HEADERS = new Set(['type', 'notetype', 'note_type', 'model', '卡片类型', '类型', '笔记类型']);

function escapeCsvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function mergeCardFields(card: CsvExportableCard): Record<string, string> {
  return {
    ...(card.fields ?? {}),
    ...(card.extra_fields ?? {}),
    ...(card.extraFields ?? {}),
  };
}

/** Serialize cards to UTF-8 BOM + RFC 4180 CRLF CSV (`Front,Back,Tags,Deck,Type`). */
export function serializeFlashcardsToCsv(
  cards: readonly CsvExportableCard[],
  options: SerializeFlashcardsToCsvOptions = {},
): string {
  const rows: string[] = [CSV_HEADER_COLUMNS.join(',')];
  const defaultDeck = options.defaultDeck?.trim() ?? '';

  for (const card of cards) {
    const fields = mergeCardFields(card);
    const clozeCandidate =
      card.text?.trim() || fields.Text?.trim() || card.front?.trim() || '';
    const isCloze = hasValidCloze(clozeCandidate);

    const front = isCloze
      ? clozeCandidate
      : (card.front ?? fields.Front ?? card.text ?? '');
    const back = isCloze
      ? (card.back ?? fields.Extra ?? fields.Back ?? '')
      : (card.back ?? fields.Back ?? '');
    const tags = (card.tags ?? [])
      .map((tag) => tag.trim())
      .filter(Boolean)
      .join(' ');
    const deck = (card.deckName ?? card.deck ?? fields._deck ?? defaultDeck).trim();
    const noteType = isCloze ? 'Cloze' : 'Basic';

    rows.push(
      [front, back, tags, deck, noteType]
        .map((cell) => escapeCsvCell(String(cell ?? '')))
        .join(','),
    );
  }

  const csvBody = `${rows.join('\r\n')}\r\n`;
  return options.includeBom === false ? csvBody : `\uFEFF${csvBody}`;
}

interface ParsedDirectives {
  body: string;
  separator: string | null;
  deck: string;
  noteType: string;
  columns: string[] | null;
  tagsColumn: number | null;
  deckColumn: number | null;
  noteTypeColumn: number | null;
}

function parseSeparatorValue(raw: string): string | null {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'tab' || lower === '\\t' || raw === '\t') return '\t';
  if (lower === 'comma' || trimmed === ',') return ',';
  if (lower === 'semicolon' || trimmed === ';') return ';';
  if (lower === 'pipe' || trimmed === '|') return '|';
  if (lower === 'space') return ' ';
  return trimmed.length === 1 ? trimmed : null;
}

function parsePositiveColumnIndex(raw: string): number | null {
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed - 1 : null;
}

function parseLeadingDirectives(content: string): ParsedDirectives {
  let separator: string | null = null;
  let deck = '';
  let noteType = '';
  let columns: string[] | null = null;
  let tagsColumn: number | null = null;
  let deckColumn: number | null = null;
  let noteTypeColumn: number | null = null;

  let cursor = 0;
  while (cursor < content.length) {
    let lineEnd = cursor;
    while (lineEnd < content.length && content[lineEnd] !== '\n' && content[lineEnd] !== '\r') {
      lineEnd += 1;
    }
    const line = content.slice(cursor, lineEnd);
    let nextCursor = lineEnd;
    if (content[nextCursor] === '\r') nextCursor += 1;
    if (content[nextCursor] === '\n') nextCursor += 1;

    const trimmed = line.trim();
    if (trimmed === '') {
      cursor = nextCursor;
      continue;
    }

    const directiveMatch = /^#([a-z0-9 _-]+):(.*)$/i.exec(trimmed);
    if (!directiveMatch) break;

    const key = directiveMatch[1].trim().toLowerCase();
    const rawValue = directiveMatch[2];
    if (key === 'separator') {
      separator = parseSeparatorValue(rawValue) ?? separator;
    } else if (key === 'deck') {
      deck = rawValue.trim();
    } else if (key === 'notetype' || key === 'note type') {
      noteType = rawValue.trim();
    } else if (key === 'columns') {
      const colSep = separator ?? (rawValue.includes('\t') ? '\t' : rawValue.includes(';') ? ';' : ',');
      columns = rawValue.split(colSep).map((col) => col.trim()).filter(Boolean);
    } else if (key === 'tags column') {
      tagsColumn = parsePositiveColumnIndex(rawValue);
    } else if (key === 'deck column') {
      deckColumn = parsePositiveColumnIndex(rawValue);
    } else if (key === 'notetype column') {
      noteTypeColumn = parsePositiveColumnIndex(rawValue);
    }
    cursor = nextCursor;
  }

  return {
    body: content.slice(cursor),
    separator,
    deck,
    noteType,
    columns,
    tagsColumn,
    deckColumn,
    noteTypeColumn,
  };
}

function detectDelimiter(body: string): string {
  let inQuotes = false;
  let tabs = 0;
  let commas = 0;
  let semicolons = 0;

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '"') {
      if (inQuotes && body[i + 1] === '"') {
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (inQuotes) continue;
    if (ch === '\r' || ch === '\n') {
      if (tabs + commas + semicolons > 0) break;
      continue;
    }
    if (ch === '\t') tabs += 1;
    else if (ch === ',') commas += 1;
    else if (ch === ';') semicolons += 1;
  }

  if (tabs > 0 && tabs >= commas && tabs >= semicolons) return '\t';
  if (commas > 0) return ',';
  if (semicolons > 0) return ';';
  return ',';
}

function parseDelimitedRecords(body: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  const pushRow = () => {
    row.push(cell);
    cell = '';
    const isBlankRow = row.length === 1 && row[0].trim() === '';
    if (!isBlankRow) {
      rows.push(row);
    }
    row = [];
  };

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];

    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell.trim() === '') {
      // Allow leading whitespace before an opening quote while still keeping unquoted mode strict.
      cell = '';
      inQuotes = true;
      continue;
    }

    if (ch === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && body[i + 1] === '\n') {
        i += 1;
      }
      pushRow();
      continue;
    }

    cell += ch;
  }

  if (cell.length > 0 || row.length > 0 || inQuotes) {
    pushRow();
  }

  return rows;
}

interface ColumnMapping {
  frontIdx: number;
  backIdx: number;
  tagsIdx: number;
  deckIdx: number;
  typeIdx: number;
  isHeaderRow: boolean;
}

function resolveColumnsFromNames(
  names: readonly string[],
  rowCount: number,
): ColumnMapping {
  let frontIdx = -1;
  let backIdx = -1;
  let tagsIdx = -1;
  let deckIdx = -1;
  let typeIdx = -1;

  for (let i = 0; i < names.length; i += 1) {
    const normalized = names[i].trim().toLowerCase();
    if (!normalized) continue;
    if (frontIdx < 0 && FRONT_HEADERS.has(normalized)) frontIdx = i;
    else if (backIdx < 0 && BACK_HEADERS.has(normalized)) backIdx = i;
    else if (tagsIdx < 0 && TAGS_HEADERS.has(normalized)) tagsIdx = i;
    else if (deckIdx < 0 && DECK_HEADERS.has(normalized)) deckIdx = i;
    else if (typeIdx < 0 && TYPE_HEADERS.has(normalized)) typeIdx = i;
  }

  const matchedCount = [frontIdx, backIdx, tagsIdx, deckIdx, typeIdx].filter((idx) => idx >= 0).length;
  const looksLikeHeader =
    matchedCount >= 2 || (frontIdx >= 0 && rowCount > 1 && names.length <= 2);

  if (!looksLikeHeader) {
    return {
      frontIdx: 0,
      backIdx: 1,
      tagsIdx: 2,
      deckIdx: 3,
      typeIdx: 4,
      isHeaderRow: false,
    };
  }

  return {
    frontIdx: frontIdx >= 0 ? frontIdx : 0,
    backIdx,
    tagsIdx,
    deckIdx,
    typeIdx,
    isHeaderRow: true,
  };
}

function parseTagsCell(raw: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const trimmed = part.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    tags.push(trimmed);
  }
  return tags;
}

/** Parse UTF-8 BOM / Anki directives / RFC 4180 CSV or TSV flashcard text. */
export function parseFlashcardsFromCsv(rawContent: string): CsvImportParseResult {
  const normalized = rawContent.startsWith('\uFEFF') ? rawContent.slice(1) : rawContent;
  const directives = parseLeadingDirectives(normalized);
  const delimiter = directives.separator ?? detectDelimiter(directives.body);
  const records = parseDelimitedRecords(directives.body, delimiter);

  if (records.length === 0) {
    return { cards: [], skippedRows: 0, delimiter, headerDetected: false };
  }

  let mapping = resolveColumnsFromNames(records[0], records.length);
  if (!mapping.isHeaderRow && directives.columns && directives.columns.length > 0) {
    const fromDirective = resolveColumnsFromNames(directives.columns, records.length + 1);
    mapping = {
      ...fromDirective,
      isHeaderRow: false,
    };
  }

  if (mapping.tagsIdx < 0 && directives.tagsColumn !== null) {
    mapping.tagsIdx = directives.tagsColumn;
  }
  if (mapping.deckIdx < 0 && directives.deckColumn !== null) {
    mapping.deckIdx = directives.deckColumn;
  }
  if (mapping.typeIdx < 0 && directives.noteTypeColumn !== null) {
    mapping.typeIdx = directives.noteTypeColumn;
  }

  const startRow = mapping.isHeaderRow ? 1 : 0;
  const cards: ParsedCsvFlashcard[] = [];
  let skippedRows = 0;

  for (let i = startRow; i < records.length; i += 1) {
    const row = records[i];
    const front = (row[mapping.frontIdx] ?? '').trim();
    const back = mapping.backIdx >= 0 ? (row[mapping.backIdx] ?? '').trim() : '';
    const tagsRaw = mapping.tagsIdx >= 0 ? (row[mapping.tagsIdx] ?? '') : '';
    const deck =
      (mapping.deckIdx >= 0 ? (row[mapping.deckIdx] ?? '').trim() : '') || directives.deck;
    const typeCell =
      (mapping.typeIdx >= 0 ? (row[mapping.typeIdx] ?? '').trim() : '') || directives.noteType;

    const isCloze = /cloze|填空/i.test(typeCell) || hasValidCloze(front);
    if (!front || (!isCloze && !back)) {
      skippedRows += 1;
      continue;
    }

    cards.push({
      front,
      back,
      tags: parseTagsCell(tagsRaw),
      deck,
      noteType: isCloze ? 'Cloze' : 'Basic',
    });
  }

  return {
    cards,
    skippedRows,
    delimiter,
    headerDetected: mapping.isHeaderRow,
  };
}
