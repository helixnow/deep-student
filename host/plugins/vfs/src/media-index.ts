/** vfs/media_index.rs: deterministic transcript windows and citation enrichment. */
import { charCount, rustTrim } from '../../../platform/util/portable.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { CreateUnitInput } from '../../vfs-repos/api.ts';
import type { FusedRetrievalHit } from '../../vfs-index/api.ts';
import type { VfsDatabase } from '../api.ts';
import { fileIdForResource, resourceIdForFile } from '../repository/media-index.ts';
import { vfsRepositories } from '../repository/services.ts';
import type { VfsUnitIndexService } from './unit-index-service.ts';

export const TRANSCRIPT_TEXT_SOURCE = 'transcript';
export const WINDOW_TARGET_MS = 90_000;
export const WINDOW_TARGET_CHARS = 800;
export const MAX_READ_SPAN_MS = 600_000;
export interface MediaTimeRange { startMs: number; endMs: number }
export interface TranscriptLine extends MediaTimeRange { text: string }
export interface MediaWindow { range: MediaTimeRange; text: string }
export interface TranscriptRead { content: string; range: MediaTimeRange; totalMs: number; truncated: boolean; lineCount: number }

export function formatMediaTimestamp(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  const tail = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${tail}` : tail;
}
export function mediaCitation(id: string, startMs: number): string { return `[媒体@${id}:${formatMediaTimestamp(startMs)}]`; }
export function segmentMetadataJson(range: MediaTimeRange): string { return `{"startMs":${range.startMs},"endMs":${range.endMs}}`; }
export function timeRangeFromMetadata(value: unknown): MediaTimeRange | null {
  if (value === null || typeof value !== 'object') return null;
  const { startMs, endMs } = value as MediaTimeRange;
  return Number.isInteger(startMs) && Number.isInteger(endMs) && endMs >= startMs ? { startMs, endMs } : null;
}
function stamped(line: TranscriptLine): string { return `[${formatMediaTimestamp(line.startMs)}] ${rustTrim(line.text)}`; }
export function buildWindows(lines: readonly TranscriptLine[]): MediaWindow[] {
  const windows: MediaWindow[] = [];
  let current: TranscriptLine[] = [], count = 0;
  const flush = () => {
    if (current.length === 0) return;
    windows.push({ range: { startMs: current[0]!.startMs, endMs: Math.max(...current.map(l => l.endMs)) },
      text: current.map(stamped).join('\n') });
    current = []; count = 0;
  };
  for (const line of lines) {
    const chars = charCount(rustTrim(line.text));
    if (chars === 0) continue;
    if (current.length > 0 && (line.endMs - current[0]!.startMs > WINDOW_TARGET_MS || count + chars > WINDOW_TARGET_CHARS)) flush();
    current.push(line); count += chars;
  }
  flush();
  return windows;
}
export function loadFinishedLines(conn: SqlExecutor, id: string): TranscriptLine[] {
  return vfsRepositories().mediaTranscripts.listSegments(conn, id)
    .filter(row => row.status === 1 && rustTrim(row.text) !== '')
    .map(row => ({ startMs: row.startMs, endMs: row.endMs, text: row.text }));
}
export function transcriptUnitsForResource(conn: SqlExecutor, id: string): CreateUnitInput[] | null {
  const fileId = fileIdForResource(conn, id);
  if (fileId === null) return null;
  const windows = buildWindows(loadFinishedLines(conn, fileId));
  if (windows.length === 0) return null;
  return windows.map((window, unitIndex) => ({ resourceId: id, unitIndex, imageBlobHash: null,
    imageMimeType: null, textContent: window.text, textSource: TRANSCRIPT_TEXT_SOURCE }));
}
export function unitTimeRanges(conn: SqlExecutor, id: string): MediaTimeRange[] {
  const fileId = fileIdForResource(conn, id);
  return fileId === null ? [] : buildWindows(loadFinishedLines(conn, fileId)).map(w => w.range);
}
export function rangeForUnit(ranges: readonly MediaTimeRange[], index: number): MediaTimeRange | null { return ranges[index] ?? null; }
export function refreshTranscriptIndex(database: VfsDatabase, index: VfsUnitIndexService, fileId: string): number {
  const resourceId = resourceIdForFile(database.getConnSafe(), fileId);
  if (resourceId === null) return 0;
  if (transcriptUnitsForResource(database.getConnSafe(), resourceId) === null) {
    vfsRepositories().indexStates.markPending(database.getConnSafe(), resourceId);
    return 0;
  }
  return index.syncResourceUnits({ resourceId, resourceType: 'file' }).length;
}
export function attachMediaTimeRanges(database: VfsDatabase, hits: FusedRetrievalHit[],
  log: { debug(message: string, ...args: unknown[]): void }): void {
  if (hits.length === 0) return;
  try {
    const conn = database.getConnSafe();
    const media = new Map<string, { fileId: string; windows: MediaWindow[] } | null>();
    for (const { hit } of hits) {
      if (hit.resourceType != null && hit.resourceType !== 'file') continue;
      const id = hit.identity.resourceId;
      if (!media.has(id)) {
        const fileId = fileIdForResource(conn, id);
        const windows = fileId === null ? [] : buildWindows(loadFinishedLines(conn, fileId));
        media.set(id, fileId !== null && windows.length > 0 ? { fileId, windows } : null);
      }
      const entry = media.get(id);
      if (!entry) continue;
      const range = timeRangeFromMetadata(hit.metadata)
        ?? (hit.identity.pageIndex == null ? null : entry.windows[hit.identity.pageIndex]?.range);
      if (range) { hit.identity.timeRange = range; hit.sourceId = entry.fileId; }
    }
  } catch (error) { log.debug('[MediaIndex] time range enrichment skipped: %s', error instanceof Error ? error.message : String(error)); }
}
export function readTranscriptRange(conn: SqlExecutor, fileId: string, startS?: number | null, endS?: number | null): TranscriptRead | null {
  const lines = loadFinishedLines(conn, fileId);
  if (lines.length === 0) return null;
  const totalMs = Math.max(...lines.map(l => l.endMs));
  const toMs = (seconds: number) => Math.round(Math.max(0, seconds) * 1000);
  const startMs = startS == null ? 0 : toMs(startS);
  const end = endS == null ? null : toMs(endS);
  const requested = end !== null && end > startMs ? end : null;
  const cap = startMs + MAX_READ_SPAN_MS;
  const endMs = Math.min(requested ?? cap, cap);
  const selected = lines.filter(l => l.endMs > startMs && l.startMs < endMs);
  return { content: selected.map(stamped).join('\n'), range: { startMs, endMs }, totalMs,
    truncated: requested !== null && requested > cap, lineCount: selected.length };
}
