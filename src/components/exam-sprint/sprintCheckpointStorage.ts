import type {
  SprintCompletedItemRecord,
  SprintCompoundPlan,
  SprintCompoundQueueItem,
} from './sprintContracts';

export const SPRINT_CHECKPOINT_STORAGE_PREFIX = 'ds.dailySprint.checkpoint.v1:';

export interface PersistedSprintQueueEntry {
  entryKey: string;
  item: SprintCompoundQueueItem;
  requeuedOnce: boolean;
}

export interface PersistedSprintCheckpoint {
  version: 1;
  savedAtMs: number;
  dateKey: string;
  planSessionId: string;
  plan: SprintCompoundPlan;
  queue: PersistedSprintQueueEntry[];
  cursor: number;
  completedRecords: SprintCompletedItemRecord[];
  elapsedSeconds: number;
}

export function getLocalSprintDateKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getSprintCheckpointStorageKey(scopeId: string | null | undefined): string {
  const normalized = typeof scopeId === 'string' && scopeId.trim().length > 0
    ? scopeId.trim()
    : '__global__';
  return `${SPRINT_CHECKPOINT_STORAGE_PREFIX}${normalized}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadSprintCheckpoint(
  scopeId: string | null | undefined,
): PersistedSprintCheckpoint | null {
  if (typeof globalThis.localStorage === 'undefined') return null;
  const key = getSprintCheckpointStorageKey(scopeId);
  try {
    const raw = globalThis.localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) return null;
    if (typeof parsed.planSessionId !== 'string' || !parsed.planSessionId.trim()) return null;
    if (typeof parsed.dateKey !== 'string' || !parsed.dateKey.trim()) return null;
    if (!isRecord(parsed.plan) || !Array.isArray(parsed.plan.items)) return null;
    if (!Array.isArray(parsed.queue) || !Array.isArray(parsed.completedRecords)) return null;
    if (parsed.completedRecords.length === 0) return null;
    const cursor = typeof parsed.cursor === 'number' && Number.isFinite(parsed.cursor)
      ? Math.max(0, Math.trunc(parsed.cursor))
      : 0;
    const elapsedSeconds = typeof parsed.elapsedSeconds === 'number' && Number.isFinite(parsed.elapsedSeconds)
      ? Math.max(0, Math.trunc(parsed.elapsedSeconds))
      : 0;
    const savedAtMs = typeof parsed.savedAtMs === 'number' && Number.isFinite(parsed.savedAtMs)
      ? parsed.savedAtMs
      : Date.now();
    return {
      version: 1,
      savedAtMs,
      dateKey: parsed.dateKey,
      planSessionId: parsed.planSessionId,
      plan: parsed.plan as unknown as SprintCompoundPlan,
      queue: parsed.queue as PersistedSprintQueueEntry[],
      cursor,
      completedRecords: parsed.completedRecords as SprintCompletedItemRecord[],
      elapsedSeconds,
    };
  } catch {
    return null;
  }
}

export function saveSprintCheckpoint(
  scopeId: string | null | undefined,
  checkpoint: Omit<PersistedSprintCheckpoint, 'version' | 'savedAtMs' | 'dateKey' | 'planSessionId'> & {
    dateKey?: string;
    savedAtMs?: number;
  },
): void {
  if (typeof globalThis.localStorage === 'undefined') return;
  const key = getSprintCheckpointStorageKey(scopeId);
  if (checkpoint.completedRecords.length === 0) {
    try {
      globalThis.localStorage.removeItem(key);
    } catch {
      // Ignore storage removal errors.
    }
    return;
  }
  const payload: PersistedSprintCheckpoint = {
    version: 1,
    savedAtMs: checkpoint.savedAtMs ?? Date.now(),
    dateKey: checkpoint.dateKey ?? getLocalSprintDateKey(),
    planSessionId: checkpoint.plan.planSessionId,
    plan: checkpoint.plan,
    queue: checkpoint.queue,
    cursor: Math.max(0, Math.trunc(checkpoint.cursor)),
    completedRecords: checkpoint.completedRecords,
    elapsedSeconds: Math.max(0, Math.trunc(checkpoint.elapsedSeconds)),
  };
  try {
    globalThis.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Ignore storage quota / private mode failures.
  }
}

export function clearSprintCheckpoint(
  scopeId: string | null | undefined,
  expectedPlanSessionId?: string | null,
): void {
  if (typeof globalThis.localStorage === 'undefined') return;
  const key = getSprintCheckpointStorageKey(scopeId);
  try {
    if (expectedPlanSessionId) {
      const existing = loadSprintCheckpoint(scopeId);
      if (existing && existing.planSessionId !== expectedPlanSessionId) {
        return;
      }
    }
    globalThis.localStorage.removeItem(key);
  } catch {
    // Ignore storage removal errors.
  }
}
