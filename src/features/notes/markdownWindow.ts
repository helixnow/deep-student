export const DEFAULT_INITIAL_LINE_WINDOW = 600;
export const MIN_INITIAL_LINE_WINDOW = 100;
export const MAX_INITIAL_LINE_WINDOW = 5000;
export const DEFAULT_LOAD_MORE_PRELOAD_PX = 1200;

export type MarkdownWindow = {
  loadedMarkdown: string;
  loadedLineCount: number;
  totalLineCount: number;
  hasMore: boolean;
};

export type MarkdownLoadMoreResult = MarkdownWindow;

export type ViewportMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

const FENCE_RE = /^(```|~~~)/;
const DISPLAY_MATH_RE = /^\$\$$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const LIST_MARKER_RE = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;
const HTML_BLOCK_START_RE = /^<(div|section|article|table|details|ul|ol|li|pre|blockquote|math)(?:\s|>|$)/i;

export function clampInitialLineWindow(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_INITIAL_LINE_WINDOW;
  }

  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_INITIAL_LINE_WINDOW;
  }

  const floored = Math.floor(parsed);
  return Math.min(MAX_INITIAL_LINE_WINDOW, Math.max(MIN_INITIAL_LINE_WINDOW, floored));
}

export function getLoadMoreLineChunk(initialLineWindow: number): number {
  return Math.max(300, Math.floor(clampInitialLineWindow(initialLineWindow) / 2));
}

export function shouldWindowMarkdown(totalLineCount: number, initialLineWindow: number): boolean {
  const initial = clampInitialLineWindow(initialLineWindow);
  return totalLineCount > initial + getLoadMoreLineChunk(initial);
}

export function createMarkdownWindow(markdown: string, requestedLines: number): MarkdownWindow {
  const lines = markdown.split('\n');
  const totalLineCount = lines.length;
  const requestedBoundary = Math.min(clampInitialLineWindow(requestedLines), totalLineCount);
  const loadedLineCount = adjustMarkdownBoundary(lines, requestedBoundary);

  return {
    loadedMarkdown: lines.slice(0, loadedLineCount).join('\n'),
    loadedLineCount,
    totalLineCount,
    hasMore: loadedLineCount < totalLineCount,
  };
}

export function expandMarkdownWindow(
  originalMarkdown: string,
  currentLoadedMarkdown: string,
  loadedLineCount: number,
  linesToAppend: number,
): MarkdownLoadMoreResult {
  const lines = originalMarkdown.split('\n');
  const totalLineCount = lines.length;
  const appendCount = Math.max(0, Math.floor(Number(linesToAppend)));
  const safeLoadedLineCount = Math.min(Math.max(0, loadedLineCount), totalLineCount);
  const requestedBoundary = Math.min(safeLoadedLineCount + appendCount, totalLineCount);
  const nextBoundary = adjustMarkdownBoundary(lines, requestedBoundary);
  const nextChunk = lines.slice(safeLoadedLineCount, nextBoundary).join('\n');
  const loadedMarkdown = joinMarkdownChunks(currentLoadedMarkdown, nextChunk);

  return {
    loadedMarkdown,
    loadedLineCount: nextBoundary,
    totalLineCount,
    hasMore: nextBoundary < totalLineCount,
  };
}

export function composeWindowedSave(
  editorMarkdown: string,
  originalMarkdown: string,
  loadedLineCount: number,
  hasMore: boolean,
): string {
  if (!hasMore) {
    return editorMarkdown;
  }

  const originalLines = originalMarkdown.split('\n');
  const safeLoadedLineCount = Math.min(Math.max(0, loadedLineCount), originalLines.length);
  const suffixLines = originalLines.slice(safeLoadedLineCount);
  if (suffixLines.length === 0) {
    return editorMarkdown;
  }

  const suffix = suffixLines.join('\n');
  return joinMarkdownChunks(editorMarkdown, suffix);
}

export function shouldRequestLoadMore(
  metrics: ViewportMetrics,
  preloadPx = DEFAULT_LOAD_MORE_PRELOAD_PX,
): boolean {
  const safePreloadPx = Math.max(0, Math.floor(Number(preloadPx) || 0));
  return metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - safePreloadPx;
}

function joinMarkdownChunks(left: string, right: string): string {
  if (!left) {
    return right;
  }
  if (!right) {
    return left.endsWith('\n') ? left : `${left}\n`;
  }
  return left.endsWith('\n') ? `${left}${right}` : `${left}\n${right}`;
}

function adjustMarkdownBoundary(lines: string[], requestedBoundary: number): number {
  let boundary = Math.min(Math.max(0, requestedBoundary), lines.length);

  for (let guard = 0; guard < lines.length && boundary < lines.length; guard += 1) {
    const nextBoundary = Math.max(
      boundary,
      extendFenceBoundary(lines, boundary),
      extendDisplayMathBoundary(lines, boundary),
      extendHtmlBoundary(lines, boundary),
      extendTableBoundary(lines, boundary),
      extendContinuationBoundary(lines, boundary),
    );

    if (nextBoundary === boundary) {
      break;
    }
    boundary = Math.min(nextBoundary, lines.length);
  }

  return boundary;
}

function extendFenceBoundary(lines: string[], boundary: number): number {
  let openFence: string | null = null;

  for (let i = 0; i < boundary; i += 1) {
    const trimmed = lines[i].trim();
    if (!FENCE_RE.test(trimmed)) {
      continue;
    }
    const marker = trimmed.startsWith('~~~') ? '~~~' : '```';
    if (!openFence) {
      openFence = marker;
    } else if (openFence === marker) {
      openFence = null;
    }
  }

  if (!openFence) {
    return boundary;
  }

  for (let i = boundary; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith(openFence)) {
      return i + 1;
    }
  }
  return lines.length;
}

function extendDisplayMathBoundary(lines: string[], boundary: number): number {
  let inMath = false;
  for (let i = 0; i < boundary; i += 1) {
    if (DISPLAY_MATH_RE.test(lines[i].trim())) {
      inMath = !inMath;
    }
  }

  if (!inMath) {
    return boundary;
  }

  for (let i = boundary; i < lines.length; i += 1) {
    if (DISPLAY_MATH_RE.test(lines[i].trim())) {
      return i + 1;
    }
  }
  return lines.length;
}

function extendHtmlBoundary(lines: string[], boundary: number): number {
  let openTag: string | null = null;

  for (let i = 0; i < boundary; i += 1) {
    const trimmed = lines[i].trim();
    if (!openTag) {
      const match = trimmed.match(HTML_BLOCK_START_RE);
      if (match && !trimmed.includes(`</${match[1].toLowerCase()}>`)) {
        openTag = match[1].toLowerCase();
      }
      continue;
    }

    if (trimmed === '' || trimmed.toLowerCase().includes(`</${openTag}>`)) {
      openTag = null;
    }
  }

  if (!openTag) {
    return boundary;
  }

  for (let i = boundary; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.toLowerCase().includes(`</${openTag}>`)) {
      return i + 1;
    }
  }
  return lines.length;
}

function extendTableBoundary(lines: string[], boundary: number): number {
  const previousIndex = boundary - 1;
  const nextIndex = boundary;
  if (!isTableCandidate(lines[previousIndex]) && !isTableCandidate(lines[nextIndex])) {
    return boundary;
  }

  let start = Math.max(0, previousIndex);
  while (start > 0 && isTableCandidate(lines[start - 1])) {
    start -= 1;
  }

  let end = Math.max(nextIndex, start);
  while (end < lines.length && isTableCandidate(lines[end])) {
    end += 1;
  }

  const tableLines = lines.slice(start, end);
  const hasSeparator = tableLines.some((line) => TABLE_SEPARATOR_RE.test(line));
  const cutsTable = hasSeparator && start < boundary && boundary < end;
  return cutsTable ? end : boundary;
}

function extendContinuationBoundary(lines: string[], boundary: number): number {
  const previous = lines[boundary - 1] ?? '';
  const next = lines[boundary] ?? '';

  if (!isContinuationLine(next) && !continuesListThroughBlank(lines, boundary)) {
    return boundary;
  }

  const previousLooksStructured = isListLike(previous) || isContinuationLine(previous) || previous.trim() === '';
  const nextStartsStructured = isListLike(next) || next.trim() === '' || isIndentedContinuation(next);
  if (!previousLooksStructured && !nextStartsStructured) {
    return boundary;
  }

  let end = boundary;
  while (end < lines.length) {
    const line = lines[end];
    const following = lines[end + 1] ?? '';
    if (isContinuationLine(line)) {
      end += 1;
      continue;
    }
    if (line.trim() === '' && (isContinuationLine(following) || isListLike(following))) {
      end += 1;
      continue;
    }
    break;
  }
  return end;
}

function isTableCandidate(line: string | undefined): boolean {
  return typeof line === 'string' && line.includes('|') && line.trim().length > 0;
}

function isContinuationLine(line: string): boolean {
  return isIndentedContinuation(line) || isListLike(line) || line.trim().startsWith('>');
}

function isIndentedContinuation(line: string): boolean {
  return /^( {2,}|\t)/.test(line);
}

function isListLike(line: string): boolean {
  return LIST_MARKER_RE.test(line);
}

function continuesListThroughBlank(lines: string[], boundary: number): boolean {
  const previous = lines[boundary - 1] ?? '';
  const next = lines[boundary] ?? '';
  const following = lines[boundary + 1] ?? '';
  return previous.trim() === '' && next.trim() === '' && (isListLike(following) || isContinuationLine(following));
}
