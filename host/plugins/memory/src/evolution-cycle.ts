/**
 * Memory evolution cycle — TS port of `dstu-memory/src/memory/evolution.rs`
 * (`run_throttled` / `run_evolution_cycle` and Phases 1-5).
 *
 * The LLM promotion pass lives in `runPromotionThrottled` in the Rust module and is
 * not part of this cycle; it is gated on the L02 LLM completion service.
 */
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import type { EvolutionTuning, MemoryListItem } from '../api.ts';
import type { MemoryVfsDependencies } from '../repository/vfs.ts';
import {
  deleteNoteWithFolderItem, getNote, getNoteTagsJson, markPending, readNoteContent,
  setNoteTagsJson, updateNote,
} from '../repository/vfs.ts';
import { insertAuditLog, type AuditEntryInput } from '../repository/audit.ts';
import {
  daysSinceBestSignal, extractHits, extractLastHitMs, extractLastInjectedMs, extractUsed,
  signalWithinDays, updatedAtAgeDays, HIGH_FREQ_HITS_THRESHOLD, HIGH_FREQ_USED_THRESHOLD,
  TAG_IMPORTANT, TAG_STALE,
} from './evolution.ts';

export const FOLDER_OVERFLOW_THRESHOLD = 20;
export const EVOLUTION_SCAN_BATCH_SIZE = 200;
const TAG_ARCHIVED = '_archived';

export interface EvolutionReport {
  stale_demoted: number;
  high_freq_promoted: number;
  duplicates_merged: number;
  archived_dormant: number;
  archived_quota: number;
}

export interface EvolutionLogger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export interface EvolutionCycleHost {
  readonly db: DatabaseHandle;
  readonly deps: MemoryVfsDependencies;
  readonly tuning: EvolutionTuning;
  list(folderPath: string | null | undefined, limit: number, offset: number): MemoryListItem[];
  listShallow(folderPath: string | null | undefined, limit: number, offset: number): MemoryListItem[];
  getTree(): Record<string, unknown> | null;
  markPending(resourceId: string): void;
  disableIndex(resourceId: string, reason: string): Promise<void>;
  audit(entry: AuditEntryInput): void;
  readonly log: EvolutionLogger;
  nowMs(): number;
}

function emptyReport(): EvolutionReport {
  return {
    stale_demoted: 0, high_freq_promoted: 0, duplicates_merged: 0,
    archived_dormant: 0, archived_quota: 0,
  };
}

function hasChanges(report: EvolutionReport): boolean {
  return report.stale_demoted > 0 || report.high_freq_promoted > 0
    || report.duplicates_merged > 0 || report.archived_dormant > 0
    || report.archived_quota > 0;
}

/** Rust's process-wide `static LAST_EVOLUTION_MS`: one instance per memory plugin, shared by pipeline variants. */
export class EvolutionThrottle {
  lastEvolutionMs = 0;
}

/** Rust `MemoryEvolution::run_throttled`. */
export async function runThrottledEvolution(host: EvolutionCycleHost,
  intervalMs: number, throttle: EvolutionThrottle): Promise<EvolutionReport | null> {
  const nowMs = host.nowMs();
  const last = throttle.lastEvolutionMs;
  if (nowMs - last < intervalMs) return null;
  throttle.lastEvolutionMs = nowMs;

  try {
    const report = await runEvolutionCycle(host);
    if (hasChanges(report)) {
      host.log.info(`[Evolution] Throttled cycle: demoted=${report.stale_demoted}, `
        + `promoted=${report.high_freq_promoted}, merged=${report.duplicates_merged}, `
        + `archived=${report.archived_dormant}+${report.archived_quota}`);
    }
    return report;
  } catch (error) {
    // Rust rolls the throttle timestamp back so a failed cycle is retried next time.
    throttle.lastEvolutionMs = last;
    host.log.warn(`[Evolution] Throttled cycle failed (non-fatal): ${errorText(error)}`);
    return null;
  }
}

/** Rust `MemoryEvolution::run_evolution_cycle`. */
export async function runEvolutionCycle(host: EvolutionCycleHost): Promise<EvolutionReport> {
  const report = emptyReport();

  const allMemories: MemoryListItem[] = [];
  let offset = 0;
  for (;;) {
    const page = host.list(null, EVOLUTION_SCAN_BATCH_SIZE, offset);
    if (page.length === 0) break;
    allMemories.push(...page);
    if (page.length < EVOLUTION_SCAN_BATCH_SIZE) break;
    offset = saturatingAdd(offset, EVOLUTION_SCAN_BATCH_SIZE);
  }
  if (allMemories.length === 0) return report;

  report.stale_demoted = demoteStaleMemories(host, allMemories);
  report.high_freq_promoted = promoteHighFreqMemories(host, allMemories);
  report.duplicates_merged = await checkFolderOverflow(host);
  report.archived_dormant = await archiveDormantMemories(host, allMemories);
  report.archived_quota = await enforceCategoryQuota(host);

  host.log.info(`[Evolution] Cycle complete: demoted=${report.stale_demoted}, `
    + `promoted=${report.high_freq_promoted}, merged=${report.duplicates_merged}, `
    + `archived_dormant=${report.archived_dormant}, archived_quota=${report.archived_quota}`);
  return report;
}

function readTags(db: SqlExecutor, noteId: string): string[] | null {
  const raw = getNoteTagsJson(db, noteId);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Rust `from_str::<Vec<String>>(..).unwrap_or_default()`: any non-string empties the Vec.
    return Array.isArray(parsed) && parsed.every((tag): tag is string => typeof tag === 'string')
      ? parsed : [];
  } catch {
    return [];
  }
}

function writeTags(deps: MemoryVfsDependencies, db: SqlExecutor, noteId: string,
  tags: readonly string[]): boolean {
  return setNoteTagsJson(deps, db, noteId, JSON.stringify(tags));
}

/** Rust `demote_stale_memories` (Phase 1). */
function demoteStaleMemories(host: EvolutionCycleHost, memories: readonly MemoryListItem[]): number {
  const nowMs = host.nowMs();
  let demoted = 0;
  const entries: Array<{ noteId: string; title: string; days: number; hits: number }> = [];

  host.db.transaction(scope => {
    for (const memory of memories) {
      if (memory.title.startsWith('__')) continue;
      if (memory.memoryType === 'note' || memory.memoryType === 'study') continue;

      const tags = readTags(scope, memory.id);
      if (tags === null) continue;
      if (tags.includes(TAG_STALE) || tags.includes(TAG_ARCHIVED)) continue;

      const hits = extractHits(tags);
      const lastHitMs = extractLastHitMs(tags);
      const lastInjectedMs = extractLastInjectedMs(tags);

      if (signalWithinDays(nowMs, lastHitMs, host.tuning.stale_hit_days)) continue;
      if (signalWithinDays(nowMs, lastInjectedMs, host.tuning.stale_injected_days)) continue;
      if (lastHitMs === null && lastInjectedMs === null
        && updatedAtAgeDays(nowMs, memory.updatedAt) <= host.tuning.stale_hit_days) continue;

      const daysSinceSignal = daysSinceBestSignal(nowMs, lastHitMs, lastInjectedMs, memory.updatedAt);
      if (hits < host.tuning.stale_min_hits) {
        if (writeTags(host.deps, scope, memory.id, [...tags, TAG_STALE])) {
          demoted += 1;
          entries.push({ noteId: memory.id, title: memory.title, days: daysSinceSignal, hits });
          host.log.debug(`[Evolution] Demoted stale memory: ${memory.title} `
            + `(${daysSinceSignal}d, ${hits}hits)`);
        }
      }
    }
  }, { behavior: 'immediate' });

  for (const entry of entries) {
    host.audit({
      source: 'evolution', operation: 'update_tags', success: true,
      noteId: entry.noteId, title: entry.title, contentPreview: null, folder: null,
      event: 'STALE_DEMOTE', confidence: null,
      reason: `距最近活跃信号 ${entry.days} 天（命中 ${entry.hits} 次）：`
        + '搜索命中与注入在场分别超出各自窗口，标记为 _stale',
      sessionId: null, durationMs: null, extraJson: null,
    });
  }
  return demoted;
}

/** Rust `promote_high_freq_memories` (Phase 2). */
function promoteHighFreqMemories(host: EvolutionCycleHost,
  memories: readonly MemoryListItem[]): number {
  let promoted = 0;
  host.db.transaction(scope => {
    for (const memory of memories) {
      if (memory.title.startsWith('__')) continue;
      const tags = readTags(scope, memory.id);
      if (tags === null || tags.includes(TAG_IMPORTANT)) continue;
      const hits = extractHits(tags);
      const used = extractUsed(tags);
      if (used >= HIGH_FREQ_USED_THRESHOLD || hits >= HIGH_FREQ_HITS_THRESHOLD) {
        const newTags = tags.filter(tag => tag !== TAG_STALE);
        newTags.push(TAG_IMPORTANT);
        if (writeTags(host.deps, scope, memory.id, newTags)) {
          promoted += 1;
          host.log.debug(`[Evolution] Promoted high-freq memory: ${memory.title} `
            + `(used=${used}, hits=${hits})`);
        }
      }
    }
  }, { behavior: 'immediate' });
  return promoted;
}

function collectFolderPaths(children: unknown, parentPath: string, out: string[]): void {
  if (!Array.isArray(children)) return;
  for (const node of children) {
    if (node === null || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    const folder = record['folder'];
    if (folder === null || typeof folder !== 'object') continue;
    const title = (folder as Record<string, unknown>)['title'];
    if (typeof title !== 'string' || title.startsWith('__')) continue;
    const path = parentPath === '' ? title : `${parentPath}/${title}`;
    out.push(path);
    collectFolderPaths(record['children'], path, out);
  }
}

function allFolderPaths(host: EvolutionCycleHost): string[] {
  const folders: string[] = [''];
  const tree = host.getTree();
  if (tree !== null) collectFolderPaths(tree['children'], '', folders);
  return folders;
}

function listAllShallow(host: EvolutionCycleHost, folder: string): MemoryListItem[] {
  const items: MemoryListItem[] = [];
  let offset = 0;
  for (;;) {
    const page = host.listShallow(folder === '' ? null : folder, 200, offset);
    if (page.length === 0) break;
    items.push(...page);
    if (page.length < 200) break;
    offset = saturatingAdd(offset, 200);
  }
  return items;
}

function splitMergeFragments(content: string): string[] {
  return content.split('\n\n').map(fragment => fragment.trim()).filter(fragment => fragment !== '');
}

/** Rust `check_folder_overflow` (Phase 3). */
async function checkFolderOverflow(host: EvolutionCycleHost): Promise<number> {
  const folders = allFolderPaths(host);
  let mergedCount = 0;

  for (const folder of folders) {
    const items = listAllShallow(host, folder);
    const active = items.filter(item => !item.title.startsWith('__') && !item.isArchived);
    if (active.length <= FOLDER_OVERFLOW_THRESHOLD) continue;

    const groups = new Map<string, MemoryListItem[]>();
    for (const memory of active) {
      const key = `${memory.title}\u0000${memory.memoryType}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [memory]);
      else group.push(memory);
    }

    let folderMerged = 0;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const keep = group[0]!;
      const combined: string[] = [];
      const seen = new Set<string>();
      let contentReadFailed = false;
      for (const memory of group) {
        // Rust evolution.rs:457-486 matches Ok(Some)/Ok(None)/Err of get_note_content.
        let content: string | null;
        try {
          content = readNoteContent(host.deps, host.db, memory.id);
        } catch (error) {
          host.log.warn(`[Evolution] Failed to read content for duplicate merge ${memory.id}: `
            + errorText(error));
          contentReadFailed = true;
          break;
        }
        if (content === null) {
          host.log.warn(`[Evolution] Empty note content when merging group '${keep.title}': ${memory.id}`);
          contentReadFailed = true;
          break;
        }
        for (const fragment of splitMergeFragments(content)) {
          if (seen.has(fragment)) continue;
          seen.add(fragment);
          combined.push(fragment);
        }
      }
      if (contentReadFailed) continue;
      const combinedContent = combined.join('\n\n');
      if (combinedContent.trim() === '') {
        host.log.warn(`[Evolution] Skip empty merge output for title '${keep.title}', `
          + `group_size=${group.length}`);
        continue;
      }

      let updated;
      try {
        updated = updateNote(host.deps, host.db, keep.id, { content: combinedContent });
      } catch (error) {
        host.log.warn(`[Evolution] Failed to update merged memory ${keep.id}: ${errorText(error)}`);
        continue;
      }
      host.markPending(updated.resourceId);

      for (const duplicate of group.slice(1)) {
        const resourceId = getNote(host.deps, host.db, duplicate.id)?.resourceId ?? null;
        try {
          deleteNoteWithFolderItem(host.deps, host.db, duplicate.id);
        } catch (error) {
          host.log.warn(`[Evolution] Failed to delete duplicate ${duplicate.id}: ${errorText(error)}`);
          continue;
        }
        if (resourceId !== null) {
          await host.disableIndex(resourceId, 'evolution merged duplicate');
        }
        folderMerged += 1;
        host.log.debug(`[Evolution] Merged duplicate '${keep.title}' (${duplicate.id} → ${keep.id})`);
      }
    }

    if (folderMerged > 0) {
      host.log.info(`[Evolution] Folder '${folder}': merged ${folderMerged} duplicate memories `
        + `(was ${active.length} active)`);
      mergedCount += folderMerged;
    }
  }
  return mergedCount;
}

/** Rust `archive_memory_note`. */
async function archiveMemoryNote(host: EvolutionCycleHost, noteId: string, title: string,
  eventReason: string): Promise<boolean> {
  const note = getNote(host.deps, host.db, noteId);
  if (note === undefined) return false;
  if (note.tags.includes(TAG_ARCHIVED)) return false;

  writeTags(host.deps, host.db, noteId, [...note.tags, TAG_ARCHIVED]);
  await host.disableIndex(note.resourceId, 'memory archived');

  host.audit({
    source: 'evolution', operation: 'update_tags', success: true,
    noteId, title, contentPreview: null, folder: null, event: 'ARCHIVE', confidence: null,
    reason: eventReason, sessionId: null, durationMs: null, extraJson: null,
  });
  host.log.debug(`[Evolution] Archived memory: ${title} (${noteId})`);
  return true;
}

/** Rust `archive_dormant_memories` (Phase 4). */
async function archiveDormantMemories(host: EvolutionCycleHost,
  memories: readonly MemoryListItem[]): Promise<number> {
  const nowMs = host.nowMs();
  let archived = 0;
  const archiveHorizonDays = saturatingAdd(host.tuning.stale_hit_days,
    host.tuning.archive_after_stale_days);

  for (const memory of memories) {
    if (memory.title.startsWith('__') || !memory.isStale || memory.isArchived) continue;
    if (memory.memoryType === 'note' || memory.memoryType === 'study' || memory.isImportant) continue;

    const tags = readTags(host.db, memory.id);
    if (tags === null) continue;
    if (tags.includes(TAG_ARCHIVED) || !tags.includes(TAG_STALE)) continue;

    if (extractHits(tags) >= host.tuning.stale_min_hits) continue;
    const lastHitMs = extractLastHitMs(tags);
    const lastInjectedMs = extractLastInjectedMs(tags);
    const daysSinceSignal = daysSinceBestSignal(nowMs, lastHitMs, lastInjectedMs, memory.updatedAt);
    if (signalWithinDays(nowMs, lastInjectedMs,
      saturatingAdd(host.tuning.stale_injected_days, host.tuning.archive_after_stale_days))) {
      continue;
    }
    if (daysSinceSignal <= archiveHorizonDays) continue;

    if (await archiveMemoryNote(host, memory.id, memory.title,
      `标记 _stale 后持续无活跃信号（距最近信号 ${daysSinceSignal} 天，超过归档水位 `
      + `${archiveHorizonDays} 天），自动归档并移出检索索引`)) {
      archived += 1;
    }
  }
  return archived;
}

/** Rust `enforce_category_quota` (Phase 5). */
async function enforceCategoryQuota(host: EvolutionCycleHost): Promise<number> {
  const folders = allFolderPaths(host);
  let archivedTotal = 0;

  for (const folder of folders) {
    const items = listAllShallow(host, folder);
    const active = items.filter(item => !item.title.startsWith('__')
      && !item.isStale && !item.isArchived);
    if (active.length <= host.tuning.category_quota) continue;
    const excess = active.length - host.tuning.category_quota;

    const candidates = active
      .filter(item => !item.isImportant && item.memoryType === 'fact')
      .sort((a, b) => a.hits - b.hits || a.updatedAt.localeCompare(b.updatedAt));

    let folderArchived = 0;
    for (const memory of candidates.slice(0, excess)) {
      if (await archiveMemoryNote(host, memory.id, memory.title,
        `分类 '${folder === '' ? '（根目录）' : folder}' 活跃记忆 ${active.length} 条超出预算 `
        + `${host.tuning.category_quota}，按最弱优先归档（命中 ${memory.hits} 次）`)) {
        folderArchived += 1;
      }
    }
    if (folderArchived > 0) {
      host.log.info(`[Evolution] Folder '${folder}': archived ${folderArchived} memories over `
        + `quota ${host.tuning.category_quota} (was ${active.length} active)`);
      archivedTotal += folderArchived;
    }
  }
  return archivedTotal;
}

/** i64 saturating add for config-derived day counts. */
function saturatingAdd(a: number, b: number): number {
  const value = a + b;
  return value > 2 ** 63 - 1 ? 2 ** 63 - 1 : value;
}


function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
