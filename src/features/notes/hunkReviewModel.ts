/**
 * Hunk-level diff segmentation, per-hunk decision state machine, and full
 * Markdown composition (C4 §3.2.2).
 *
 * Pure logic module with zero DOM or Tauri dependencies.
 */
import type { DiffLine } from './hooks/useAIEditState';

export type HunkDecisionState = 'pending' | 'accepted' | 'rejected' | 'tweaked';

export interface ReviewableHunk {
  /** 0-based change hunk index (displayed as id + 1 in UI) */
  id: number;
  /** 1-based starting line number in the original document */
  oldStartLine: number;
  /** 1-based starting line number in the proposed document */
  newStartLine: number;
  /** Original lines removed in this hunk */
  removedLines: string[];
  /** AI candidate lines added in this hunk */
  addedLines: string[];
  /** Up to 2 preceding unchanged lines for standalone reading */
  contextBefore: string[];
  /** Up to 2 following unchanged lines for standalone reading */
  contextAfter: string[];
  status: HunkDecisionState;
  /** User-edited text when `status === 'tweaked'` (`''` deletes the hunk) */
  tweakedText?: string;
}

export interface HunkDocumentPlan {
  /** Line diffs omit EOF terminators; retain source bytes for lossless composition. */
  documents?: { original: string; proposed: string };
  segments: Array<
    | { kind: 'unchanged'; lines: string[] }
    | { kind: 'hunk'; hunk: ReviewableHunk }
  >;
  hunks: ReviewableHunk[];
}

interface RawSegment {
  kind: 'unchanged' | 'change';
  lines: DiffLine[];
}

const MAX_CHANGE_RUN_LCS_CELLS = 4096;

function splitChangeRunOnIdenticalLines(changeLines: readonly DiffLine[]): DiffLine[] {
  const removed = changeLines.filter((l) => l.type === 'removed');
  const added = changeLines.filter((l) => l.type === 'added');
  if (
    removed.length === 0 ||
    added.length === 0 ||
    removed.length * added.length > MAX_CHANGE_RUN_LCS_CELLS
  ) {
    return [...changeLines];
  }

  // Do not erase a reviewable run whose only difference is the EOF terminator.
  if (removed.length === added.length && removed.every((line, index) => line.content === added[index].content)) {
    return [...changeLines];
  }
  // `diffLines` merges EOF unchanged lines into adjacent hunks when their
  // terminators differ. Recover non-empty identical lines for standalone review.
  const n = removed.length;
  const m = added.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (
        removed[i].content === added[j].content &&
        removed[i].content.trim().length > 0
      ) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  if (dp[0][0] === 0) {
    return [...changeLines];
  }

  const expanded: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let rStart = 0;
  let aStart = 0;

  while (i < n && j < m) {
    if (
      removed[i].content === added[j].content &&
      removed[i].content.trim().length > 0 &&
      dp[i][j] === 1 + dp[i + 1][j + 1]
    ) {
      for (let r = rStart; r < i; r += 1) expanded.push(removed[r]);
      for (let a = aStart; a < j; a += 1) expanded.push(added[a]);
      expanded.push({
        type: 'unchanged',
        content: removed[i].content,
        lineNumber: {
          old: removed[i].lineNumber.old,
          new: added[j].lineNumber.new,
        },
      });
      i += 1;
      j += 1;
      rStart = i;
      aStart = j;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  for (let r = rStart; r < n; r += 1) expanded.push(removed[r]);
  for (let a = aStart; a < m; a += 1) expanded.push(added[a]);
  return expanded;
}

/**
 * Splits line-level `DiffLine[]` into alternating unchanged segments and
 * reviewable hunks with 1-based line coordinates and surrounding 2-line context.
 */
export function buildHunkDocumentPlan(
  diffLines: readonly DiffLine[],
  documents?: HunkDocumentPlan['documents'],
): HunkDocumentPlan {
  if (!Array.isArray(diffLines) || diffLines.length === 0) {
    return { segments: [], hunks: [], documents };
  }

  const initialRuns: RawSegment[] = [];
  for (const line of diffLines) {
    const kind: RawSegment['kind'] = line.type === 'unchanged' ? 'unchanged' : 'change';
    const prev = initialRuns[initialRuns.length - 1];
    if (prev && prev.kind === kind) {
      prev.lines.push(line);
    } else {
      initialRuns.push({ kind, lines: [line] });
    }
  }

  const normalizedLines: DiffLine[] = [];
  for (const run of initialRuns) {
    if (run.kind === 'unchanged') {
      normalizedLines.push(...run.lines);
    } else {
      normalizedLines.push(...splitChangeRunOnIdenticalLines(run.lines));
    }
  }

  const rawSegments: RawSegment[] = [];
  for (const line of normalizedLines) {
    const kind: RawSegment['kind'] = line.type === 'unchanged' ? 'unchanged' : 'change';
    const prev = rawSegments[rawSegments.length - 1];
    if (prev && prev.kind === kind) {
      prev.lines.push(line);
    } else {
      rawSegments.push({ kind, lines: [line] });
    }
  }

  const segments: HunkDocumentPlan['segments'] = [];
  const hunks: ReviewableHunk[] = [];
  let lastOldLine = 0;
  let lastNewLine = 0;

  for (let idx = 0; idx < rawSegments.length; idx += 1) {
    const seg = rawSegments[idx];
    if (seg.kind === 'unchanged') {
      const textLines = seg.lines.map((l) => l.content);
      const tail = seg.lines[seg.lines.length - 1];
      if (tail?.lineNumber.old != null) lastOldLine = tail.lineNumber.old;
      else lastOldLine += textLines.length;
      if (tail?.lineNumber.new != null) lastNewLine = tail.lineNumber.new;
      else lastNewLine += textLines.length;
      segments.push({ kind: 'unchanged', lines: textLines });
      continue;
    }

    const removedLines: string[] = [];
    const addedLines: string[] = [];
    let firstOld: number | undefined;
    let firstNew: number | undefined;

    for (const line of seg.lines) {
      if (line.type === 'removed') {
        if (firstOld === undefined && line.lineNumber.old != null) {
          firstOld = line.lineNumber.old;
        }
        removedLines.push(line.content);
      } else if (line.type === 'added') {
        if (firstNew === undefined && line.lineNumber.new != null) {
          firstNew = line.lineNumber.new;
        }
        addedLines.push(line.content);
      }
    }

    const oldStartLine = firstOld ?? lastOldLine + 1;
    const newStartLine = firstNew ?? lastNewLine + 1;
    lastOldLine = firstOld !== undefined ? firstOld + removedLines.length - 1 : lastOldLine;
    lastNewLine = firstNew !== undefined ? firstNew + addedLines.length - 1 : lastNewLine;

    const prevSeg = idx > 0 ? rawSegments[idx - 1] : undefined;
    const nextSeg = idx + 1 < rawSegments.length ? rawSegments[idx + 1] : undefined;
    const contextBefore =
      prevSeg?.kind === 'unchanged' ? prevSeg.lines.slice(-2).map((l) => l.content) : [];
    const contextAfter =
      nextSeg?.kind === 'unchanged' ? nextSeg.lines.slice(0, 2).map((l) => l.content) : [];

    const hunk: ReviewableHunk = {
      id: hunks.length,
      oldStartLine,
      newStartLine,
      removedLines,
      addedLines,
      contextBefore,
      contextAfter,
      status: 'pending',
    };
    hunks.push(hunk);
    segments.push({ kind: 'hunk', hunk });
  }

  return { segments, hunks, documents };
}

/**
 * Immutably updates the decision state (and optional tweaked text) of a single hunk.
 */
export function updateHunkDecision(
  plan: HunkDocumentPlan,
  hunkId: number,
  decision: HunkDecisionState,
  tweakedText?: string,
): HunkDocumentPlan {
  let changed = false;
  const nextHunks: ReviewableHunk[] = [];

  const nextSegments = plan.segments.map((seg) => {
    if (seg.kind !== 'hunk') return seg;
    if (seg.hunk.id !== hunkId) {
      nextHunks.push(seg.hunk);
      return seg;
    }

    changed = true;
    const normalizedTweak =
      decision === 'tweaked'
        ? (tweakedText !== undefined
            ? tweakedText.replace(/\r\n?/g, '\n')
            : (seg.hunk.tweakedText ?? seg.hunk.addedLines.join('\n')))
        : undefined;

    const updatedHunk: ReviewableHunk = {
      ...seg.hunk,
      status: decision,
      ...(decision === 'tweaked' ? { tweakedText: normalizedTweak } : {}),
    };
    if (decision !== 'tweaked') {
      delete updatedHunk.tweakedText;
    }
    nextHunks.push(updatedHunk);
    return { kind: 'hunk' as const, hunk: updatedHunk };
  });

  if (!changed) return plan;
  return {
    ...plan,
    segments: nextSegments,
    hunks: nextHunks,
  };
}

/**
 * Marks all `pending` hunks as `accepted` while preserving explicit `rejected`
 * and `tweaked` decisions (used by `[全部采纳]`).
 */
export function acceptAllPendingHunks(plan: HunkDocumentPlan): HunkDocumentPlan {
  let result = plan;
  for (const hunk of plan.hunks) {
    if (hunk.status === 'pending') {
      result = updateHunkDecision(result, hunk.id, 'accepted');
    }
  }
  return result;
}

/**
 * Composes full document Markdown from a `HunkDocumentPlan`:
 * - `accepted`: emits `addedLines`
 * - `rejected` (or unresolved `pending`): retains `removedLines`
 * - `tweaked`: emits `tweakedText.split('\n')` (`''` deletes the hunk lines)
 */
export function composeMarkdownFromHunkPlan(plan: HunkDocumentPlan): {
  markdown: string;
  acceptedOrTweakedCount: number;
  rejectedCount: number;
  pendingCount: number;
} {
  const outLines: string[] = [];
  const originalLines = plan.documents?.original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const proposedLines = plan.documents?.proposed.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const chunks: string[] = [];
  let oldOffset = 0;
  let newOffset = 0;
  let useProposedContext = false;
  const newline = plan.documents?.original.includes('\r\n') ? '\r\n' : '\n';
  let acceptedOrTweakedCount = 0;
  let rejectedCount = 0;
  let pendingCount = 0;

  for (const seg of plan.segments) {
    if (seg.kind === 'unchanged') {
      outLines.push(...seg.lines);
      const contextLines = useProposedContext ? proposedLines : originalLines;
      const offset = useProposedContext ? newOffset : oldOffset;
      chunks.push(...contextLines.slice(offset, offset + seg.lines.length));
      oldOffset += seg.lines.length;
      newOffset += seg.lines.length;
      continue;
    }

    const { hunk } = seg;
    useProposedContext = hunk.status === 'accepted' || hunk.status === 'tweaked';
    if (hunk.status === 'accepted') {
      chunks.push(...proposedLines.slice(newOffset, newOffset + hunk.addedLines.length));
    } else if (hunk.status === 'tweaked') {
      const text = hunk.tweakedText ?? hunk.addedLines.join('\n');
      if (text) {
        const sourceTail = proposedLines[newOffset + hunk.addedLines.length - 1]
          ?? originalLines[oldOffset + hunk.removedLines.length - 1];
        chunks.push(text.replace(/\r\n?/g, '\n').replace(/\n/g, newline)
          + (sourceTail?.endsWith('\n') && !text.endsWith('\n') ? newline : ''));
      }
    } else {
      chunks.push(...originalLines.slice(oldOffset, oldOffset + hunk.removedLines.length));
    }
    oldOffset += hunk.removedLines.length;
    newOffset += hunk.addedLines.length;
    switch (hunk.status) {
      case 'accepted': {
        acceptedOrTweakedCount += 1;
        outLines.push(...hunk.addedLines);
        break;
      }
      case 'tweaked': {
        acceptedOrTweakedCount += 1;
        const text = hunk.tweakedText ?? hunk.addedLines.join('\n');
        if (text !== '') {
          outLines.push(...text.split('\n'));
        }
        break;
      }
      case 'rejected': {
        rejectedCount += 1;
        outLines.push(...hunk.removedLines);
        break;
      }
      case 'pending':
      default: {
        pendingCount += 1;
        outLines.push(...hunk.removedLines);
        break;
      }
    }
  }

  let markdown = outLines.join('\n');
  if (plan.documents) {
    markdown = chunks.reduce((result, chunk) => result + (result && !result.endsWith('\n') ? newline : '') + chunk, '');
    if (acceptedOrTweakedCount === 0) markdown = plan.documents.original;
    else if (plan.hunks.every((hunk) => hunk.status === 'accepted')) markdown = plan.documents.proposed;
  }
  return {
    markdown,
    acceptedOrTweakedCount,
    rejectedCount,
    pendingCount,
  };
}
