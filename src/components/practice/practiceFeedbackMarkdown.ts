import type { PracticeResult } from '@/api/practiceApi';

const VERDICT_SCORE_TAG_RE =
  /<verdict\s*>\s*(?:correct|partial|incorrect)\s*<\/verdict\s*>|<score\s+value\s*=\s*["']\d+["']\s*\/?\s*>|<manual_override\b[^>]*\/?\s*>/gi;
const MANUAL_OVERRIDE_TAG_RE = /<manual_override\b([^>]*)\/?\s*>/gi;
const TABLE_SEPARATOR_RE = /^\|(?:\s*:?-{2,}:?\s*\|)+\s*$/;
const LOOSE_SEPARATOR_RE = /^\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?$/;
const INLINE_TABLE_SEPARATOR_RE = /(\|(?:\s*:?-{2,}:?\s*\|)+)/g;

export interface ParsedPracticeManualOverride {
  score: number;
  status: PracticeResult['status'] | null;
  originalScore: number | null;
  originalStatus: PracticeResult['status'] | null;
}

function parseOverrideAttr(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs);
  return match?.[1] ?? null;
}

const VALID_PRACTICE_STATUSES = new Set<PracticeResult['status']>([
  'unanswered',
  'pending',
  'failed',
  'correct',
  'incorrect',
  'partial',
]);

function asPracticeStatus(value: string | null): PracticeResult['status'] | null {
  if (!value) return null;
  return VALID_PRACTICE_STATUSES.has(value as PracticeResult['status'])
    ? (value as PracticeResult['status'])
    : null;
}

/**
 * Extracts persisted manual override metadata encoded in `PracticeResult.feedback`
 * so manual regrade state survives full page reloads without violating the strict
 * `PracticeResult` IPC schema (`additionalProperties: false`).
 */
export function parsePracticeManualOverride(
  raw: string | null | undefined,
): ParsedPracticeManualOverride | null {
  if (!raw || !raw.includes('<manual_override')) return null;
  MANUAL_OVERRIDE_TAG_RE.lastIndex = 0;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = MANUAL_OVERRIDE_TAG_RE.exec(raw)) !== null) {
    lastMatch = match;
  }
  if (!lastMatch) return null;
  const attrs = lastMatch[1] ?? '';
  const rawScore = parseOverrideAttr(attrs, 'score');
  const parsedScore = rawScore !== null && /^-?\d+$/.test(rawScore) ? Number.parseInt(rawScore, 10) : NaN;
  const rawOriginalScore = parseOverrideAttr(attrs, 'original_score');
  const originalScore =
    rawOriginalScore !== null && /^-?\d+$/.test(rawOriginalScore)
      ? Number.parseInt(rawOriginalScore, 10)
      : null;

  return {
    score: Number.isFinite(parsedScore) ? parsedScore : 0,
    status: asPracticeStatus(parseOverrideAttr(attrs, 'status')),
    originalScore,
    originalStatus: asPracticeStatus(parseOverrideAttr(attrs, 'original_status')),
  };
}

function countUnescapedPipes(line: string): number {
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '|' && line[i - 1] !== '\\') count += 1;
  }
  return count;
}

function splitTableCells(row: string): string[] {
  let inner = row.trim();
  if (inner.startsWith('|')) inner = inner.slice(1);
  if (inner.endsWith('|') && !inner.endsWith('\\|')) inner = inner.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  let inMath = false;
  let inCode = false;

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch === '`' && inner[i - 1] !== '\\') {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (!inCode && ch === '$' && inner[i - 1] !== '\\') {
      inMath = !inMath;
      current += ch;
      continue;
    }
    if (!inCode && !inMath && ch === '|' && inner[i - 1] !== '\\') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function ensureOuterPipes(line: string): string {
  let trimmed = line.trim();
  if (!trimmed.startsWith('|')) trimmed = `| ${trimmed}`;
  if (!trimmed.endsWith('|') || trimmed.endsWith('\\|')) trimmed = `${trimmed} |`;
  return trimmed;
}

function isTableRowCandidate(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.length > 1;
}

function isCompleteTableRow(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('|') &&
    trimmed.endsWith('|') &&
    !trimmed.endsWith('\\|') &&
    countUnescapedPipes(trimmed) >= 2
  );
}

/**
 * Splits collapsed GFM table rows on a single line into separate lines, e.g.:
 * `| A | B | | --- | --- | | 1 | 2 |` or `| A | B || --- | --- || 1 | 2 |`
 */
function splitCollapsedTableRows(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [line];

  const sepParts = trimmed.split(INLINE_TABLE_SEPARATOR_RE).map((part) => part.trim()).filter(Boolean);
  if (sepParts.length > 1 && sepParts.some((part) => TABLE_SEPARATOR_RE.test(part))) {
    const out: string[] = [];
    for (const part of sepParts) {
      if (TABLE_SEPARATOR_RE.test(part)) {
        out.push(part);
      } else {
        out.push(...splitRowGroupByPipes(part));
      }
    }
    return out;
  }

  return splitRowGroupByPipes(trimmed);
}

function splitRowGroupByPipes(line: string): string[] {
  const boundaryMatches = line.match(/\|\s*\|/g);
  if (!boundaryMatches) return [line];

  const segments = line.split(/\|[ \t]*\|/).map((seg, idx, arr) => {
    const withLeading = idx === 0 ? seg : `|${seg}`;
    return idx === arr.length - 1 ? withLeading : `${withLeading}|`;
  });
  if (
    segments.length > 1 &&
    segments.every((seg) => isCompleteTableRow(seg) && countUnescapedPipes(seg) === countUnescapedPipes(segments[0]!))
  ) {
    return segments;
  }
  return [line];
}

function normalizeSeparatorAlignCell(cell: string): string {
  const trimmed = cell.trim();
  if (/^:-+:$/.test(trimmed)) return ':---:';
  if (/^-+:$/.test(trimmed)) return '---:';
  if (/^:-+$/.test(trimmed)) return ':---';
  return '---';
}

function reconcileTableColumns(lines: string[]): string[] {
  const result = [...lines];
  let i = 0;
  while (i < result.length) {
    const sepLine = result[i + 1]?.trim() ?? '';
    const headerLine = result[i]?.trim() ?? '';
    if (
      i + 1 < result.length &&
      TABLE_SEPARATOR_RE.test(sepLine) &&
      isCompleteTableRow(headerLine) &&
      !TABLE_SEPARATOR_RE.test(headerLine)
    ) {
      const headerCells = splitTableCells(headerLine);
      const colCount = headerCells.length;
      if (colCount >= 2) {
        result[i] = `| ${headerCells.join(' | ')} |`;
        const rawSepCells = splitTableCells(sepLine).map(normalizeSeparatorAlignCell);
        const normalizedSepCells = Array.from({ length: colCount }, (_, idx) => rawSepCells[idx] ?? '---');
        result[i + 1] = `| ${normalizedSepCells.join(' | ')} |`;

        let rowIdx = i + 2;
        while (rowIdx < result.length && isCompleteTableRow(result[rowIdx]!)) {
          const rowTrimmed = result[rowIdx]!.trim();
          if (TABLE_SEPARATOR_RE.test(rowTrimmed)) break;
          const cells = splitTableCells(rowTrimmed);
          let normalizedCells: string[];
          if (cells.length === colCount) {
            normalizedCells = cells;
          } else if (cells.length < colCount) {
            normalizedCells = [
              ...cells,
              ...Array.from({ length: colCount - cells.length }, () => ''),
            ];
          } else {
            // Merge overflow cells (caused by unescaped `|` inside the explanation column) into the final column.
            normalizedCells = [
              ...cells.slice(0, colCount - 1),
              cells.slice(colCount - 1).join(' ｜ '),
            ];
          }
          result[rowIdx] = `| ${normalizedCells.join(' | ')} |`;
          rowIdx += 1;
        }
        i = rowIdx;
        continue;
      }
    }
    i += 1;
  }
  return result;
}

/**
 * Normalizes AI grading feedback markdown:
 * - strips `<verdict>`, `<score>`, and `<manual_override>` XML tags
 * - repairs markdown rubric tables broken by collapsed `| |` / `||` rows,
 *   missing outer pipes, unescaped `\\n` before table rows, blank lines inside
 *   tables, soft newlines inside table cells, or mismatched separator/row column counts.
 */
export function normalizePracticeFeedbackMarkdown(raw: string): string {
  if (!raw) return '';
  const text = raw
    .replace(VERDICT_SCORE_TAG_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\\n(?=[ \t]*\|)/g, '\n')
    .trim();

  if (!text.includes('|')) return text;

  const rawLines = text.split('\n');
  // Normalize pipe-separated tables missing outer `|` around a separator row.
  for (let idx = 0; idx < rawLines.length; idx += 1) {
    const trimmed = rawLines[idx]!.trim();
    if (LOOSE_SEPARATOR_RE.test(trimmed)) {
      rawLines[idx] = ensureOuterPipes(trimmed);
      if (idx > 0 && rawLines[idx - 1]!.includes('|') && !rawLines[idx - 1]!.trim().startsWith('```')) {
        rawLines[idx - 1] = ensureOuterPipes(rawLines[idx - 1]!);
      }
      let nextIdx = idx + 1;
      while (nextIdx < rawLines.length && rawLines[nextIdx]!.includes('|') && rawLines[nextIdx]!.trim() !== '') {
        rawLines[nextIdx] = ensureOuterPipes(rawLines[nextIdx]!);
        nextIdx += 1;
      }
    }
  }

  const expandedLines: string[] = [];
  for (const line of rawLines) {
    expandedLines.push(...splitCollapsedTableRows(line));
  }

  // Merge multiline broken table rows (e.g., `| col1 | line1\nline2 |`).
  const mergedLines: string[] = [];
  let inTable = false;
  let expectedPipes = 0;

  for (let i = 0; i < expandedLines.length; i += 1) {
    const line = expandedLines[i]!;
    const trimmed = line.trim();

    if (TABLE_SEPARATOR_RE.test(trimmed)) {
      inTable = true;
      expectedPipes = countUnescapedPipes(trimmed);
      mergedLines.push(trimmed);
      continue;
    }

    if (isTableRowCandidate(trimmed)) {
      let combined = trimmed;
      while (!isCompleteTableRow(combined) && i + 1 < expandedLines.length) {
        const nextTrimmed = expandedLines[i + 1]!.trim();
        if (!nextTrimmed || TABLE_SEPARATOR_RE.test(nextTrimmed)) break;
        if (nextTrimmed.startsWith('|') && isCompleteTableRow(nextTrimmed)) break;
        i += 1;
        combined = `${combined} ${nextTrimmed}`;
        if (expectedPipes > 0 && countUnescapedPipes(combined) >= expectedPipes && combined.endsWith('|')) {
          break;
        }
      }

      // Ensure blank line before table if preceded by non-table content.
      if (!inTable && mergedLines.length > 0 && mergedLines[mergedLines.length - 1]!.trim() !== '') {
        const prev = mergedLines[mergedLines.length - 1]!.trim();
        if (!isCompleteTableRow(prev)) {
          mergedLines.push('');
        }
      }
      if (isCompleteTableRow(combined)) {
        inTable = true;
        if (expectedPipes === 0) expectedPipes = countUnescapedPipes(combined);
      }
      mergedLines.push(combined);
      continue;
    }

    if (trimmed === '') {
      // Skip blank lines between consecutive table rows so GFM keeps one table.
      const nextNonEmpty = expandedLines.slice(i + 1).find((l) => l.trim() !== '');
      if (
        inTable &&
        nextNonEmpty &&
        (TABLE_SEPARATOR_RE.test(nextNonEmpty.trim()) || isTableRowCandidate(nextNonEmpty.trim()))
      ) {
        continue;
      }
      inTable = false;
      expectedPipes = 0;
      mergedLines.push('');
      continue;
    }

    inTable = false;
    expectedPipes = 0;
    mergedLines.push(line);
  }

  return reconcileTableColumns(mergedLines).join('\n').trim();
}
