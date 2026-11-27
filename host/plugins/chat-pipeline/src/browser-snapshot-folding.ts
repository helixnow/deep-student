/**
 * Sliding-window browser snapshot folding for request-local LLM histories.
 *
 * Keeps the most recent N (default 2) browser snapshot / extract_content tool
 * outputs intact and folds older ones down to a single compact summary line
 * while preserving tool-call metadata (`ok`, `url`, `title`, `action`, `ref`,
 * `session_id`, `ref_epoch`, etc.).
 *
 * Non-destructive: never mutates the caller's message array or persisted DB
 * messages. 100% Web-API portable (no Node builtins or globals).
 */
import type { LegacyChatMessage } from './microcompact.ts';

export const DEFAULT_KEEP_RECENT_BROWSER_SNAPSHOTS = 2;

export interface FoldBrowserSnapshotsOptions {
  /** Number of most recent browser snapshot/extract outputs to preserve intact (default 2). */
  keepRecentSnapshots?: number;
}

type FoldableField = 'snapshot' | 'content' | 'markdown' | 'observations';

interface FoldableMatch {
  field: FoldableField;
  value: string;
  record: Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBrowserSnapshotString(value: unknown): value is string {
  return typeof value === 'string'
    && value.includes('<untrusted_web_content')
    && value.includes('kind="browser_snapshot"');
}

function isBrowserExtractOrSnapshotString(value: unknown): value is string {
  return typeof value === 'string'
    && value.includes('<untrusted_web_content')
    && (value.includes('kind="browser_extract"') || value.includes('kind="browser_snapshot"'));
}

function isBrowserObserveString(value: unknown): value is string {
  return typeof value === 'string'
    && value.includes('<untrusted_web_content')
    && value.includes('kind="browser_observe"');
}

function parseToolPayload(message: LegacyChatMessage): Record<string, unknown> | null {
  if (typeof message.content === 'string' && message.content.trim().startsWith('{')) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(message.content);
    } catch {
      parsed = null;
    }
    if (isPlainRecord(parsed)) return parsed;
  }
  const dataJson = message.tool_result?.data_json;
  if (isPlainRecord(dataJson)) return dataJson;
  return null;
}

function detectFoldableMatch(message: LegacyChatMessage): FoldableMatch | null {
  if (message.role !== 'tool') return null;
  const record = parseToolPayload(message);
  if (record === null) return null;

  if (isBrowserSnapshotString(record.snapshot)) {
    return { field: 'snapshot', value: record.snapshot, record };
  }
  if (isBrowserExtractOrSnapshotString(record.content)) {
    return { field: 'content', value: record.content, record };
  }
  if (isBrowserExtractOrSnapshotString(record.markdown)) {
    return { field: 'markdown', value: record.markdown, record };
  }
  if (isBrowserObserveString(record.observations)) {
    return { field: 'observations', value: record.observations, record };
  }
  return null;
}

function formatFoldedSummary(record: Record<string, unknown>, originalLength: number, field: FoldableField): string {
  const url = typeof record.url === 'string' && record.url.trim() !== '' ? record.url : 'unknown';
  const title = typeof record.title === 'string' && record.title.trim() !== '' ? record.title : 'untitled';
  const epoch = record.ref_epoch !== undefined && record.ref_epoch !== null
    ? String(record.ref_epoch)
    : 'none';
  if (field === 'observations') {
    return `[earlier browser observations folded: url=${url}, title=${title}, epoch=${epoch}, chars=${originalLength}; inspect latest observation for current diagnostics]`;
  }
  return `[earlier browser snapshot folded: url=${url}, title=${title}, epoch=${epoch}, chars=${originalLength}; inspect latest snapshot for current page state]`;
}

/**
 * Non-destructively folds historical browser snapshot / extract_content payloads
 * in `role: 'tool'` messages, preserving the most recent `keepRecentSnapshots`
 * (default 2) completely intact.
 */
export function foldHistoricalBrowserSnapshots(
  messages: readonly LegacyChatMessage[],
  options?: FoldBrowserSnapshotsOptions,
): LegacyChatMessage[] {
  const rawKeep = options?.keepRecentSnapshots ?? DEFAULT_KEEP_RECENT_BROWSER_SNAPSHOTS;
  const keepRecent = Number.isFinite(rawKeep) ? Math.max(0, Math.trunc(rawKeep)) : DEFAULT_KEEP_RECENT_BROWSER_SNAPSHOTS;

  const matches = new Map<number, FoldableMatch>();
  const matchedIndices: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const match = detectFoldableMatch(messages[index]!);
    if (match !== null) {
      matches.set(index, match);
      matchedIndices.push(index);
    }
  }

  if (matchedIndices.length <= keepRecent) {
    return messages.slice();
  }

  const foldCount = matchedIndices.length - keepRecent;
  const foldIndices = new Set<number>(matchedIndices.slice(0, foldCount));

  return messages.map((message, index) => {
    if (!foldIndices.has(index)) return message;
    const match = matches.get(index)!;
    const summary = formatFoldedSummary(match.record, match.value.length, match.field);
    const foldedRecord: Record<string, unknown> = {
      ...match.record,
      [match.field]: summary,
    };
    const next: LegacyChatMessage = {
      ...message,
      content: JSON.stringify(foldedRecord),
      ...(message.tool_result != null ? {
        tool_result: {
          ...message.tool_result,
          data_json: foldedRecord,
        },
      } : {}),
    };
    return next;
  });
}
