import type { MemoryInspectionView } from '@/api/memoryApi';

export interface SnapshotMemoryRule {
  id: string;
  instruction: string;
  scope: string;
  pinned: boolean;
}

export interface SnapshotMemoryWeakPoint {
  subject: string;
  knowledge_point: string;
}

export interface SnapshotMemoryGoal {
  goal: string;
}

export interface MessageMemoryAttributionSnapshot {
  rules: SnapshotMemoryRule[];
  weakPoints: SnapshotMemoryWeakPoint[];
  goals: SnapshotMemoryGoal[];
  renderedKernel: string;
  rulesVersion: number;
  profileVersion: number;
  capturedAt: number;
}

export interface FrozenRuleRef {
  id: string;
  instruction: string;
  scope?: string;
  pinned?: boolean;
}

export interface ParsedFrozenMemorySnapshot {
  renderedKernel: string;
  rulesVersion: number;
  profileVersion: number;
  includedRuleIds: string[];
  includedRules: FrozenRuleRef[];
  includedWeakPointKeys: string[];
  includedLegacyNoteIds: string[];
}

const STORAGE_KEY = 'deepstudent.memoryAttributionSnapshots.v1';
const MAX_PERSISTED_SNAPSHOTS = 300;

let memorySnapshotCache: Map<string, MessageMemoryAttributionSnapshot> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneSnapshot(snapshot: MessageMemoryAttributionSnapshot): MessageMemoryAttributionSnapshot {
  return {
    rules: snapshot.rules.map((r) => ({ ...r })),
    weakPoints: snapshot.weakPoints.map((wp) => ({ ...wp })),
    goals: snapshot.goals.map((g) => ({ ...g })),
    renderedKernel: snapshot.renderedKernel,
    rulesVersion: snapshot.rulesVersion,
    profileVersion: snapshot.profileVersion,
    capturedAt: snapshot.capturedAt,
  };
}

export function buildMemorySnapshotKey(params: {
  sessionId?: string | null;
  messageId?: string | null;
  variantId?: string | null;
}): string | null {
  const messageId = typeof params.messageId === 'string' ? params.messageId.trim() : '';
  if (!messageId) return null;
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  const variantId = typeof params.variantId === 'string' && params.variantId.trim()
    ? params.variantId.trim()
    : 'default';
  return `${sessionId}:${messageId}:${variantId}`;
}

export function parseFrozenMemorySnapshot(
  sessionMetadata: Record<string, unknown> | null | undefined,
): ParsedFrozenMemorySnapshot | null {
  if (!isRecord(sessionMetadata)) return null;
  const raw = sessionMetadata.memoryKernelSnapshot;
  if (!isRecord(raw)) return null;

  const includedRuleIds = Array.isArray(raw.includedRuleIds)
    ? raw.includedRuleIds.filter((item): item is string => typeof item === 'string')
    : [];
  const includedWeakPointKeys = Array.isArray(raw.includedWeakPointKeys)
    ? raw.includedWeakPointKeys.filter((item): item is string => typeof item === 'string')
    : [];
  const includedLegacyNoteIds = Array.isArray(raw.includedLegacyNoteIds)
    ? raw.includedLegacyNoteIds.filter((item): item is string => typeof item === 'string')
    : [];

  const includedRules: FrozenRuleRef[] = [];
  if (Array.isArray(raw.includedRules)) {
    for (const item of raw.includedRules) {
      if (!isRecord(item)) continue;
      if (typeof item.id === 'string' && typeof item.instruction === 'string') {
        includedRules.push({
          id: item.id,
          instruction: item.instruction,
          ...(typeof item.scope === 'string' ? { scope: item.scope } : {}),
          ...(typeof item.pinned === 'boolean' ? { pinned: item.pinned } : {}),
        });
      }
    }
  }

  return {
    renderedKernel: typeof raw.renderedKernel === 'string' ? raw.renderedKernel : '',
    rulesVersion: typeof raw.rulesVersion === 'number' ? raw.rulesVersion : 0,
    profileVersion: typeof raw.profileVersion === 'number' ? raw.profileVersion : 0,
    includedRuleIds,
    includedRules,
    includedWeakPointKeys,
    includedLegacyNoteIds,
  };
}

export function hasNonEmptyFrozenSnapshot(frozen: ParsedFrozenMemorySnapshot | null): boolean {
  return Boolean(
    frozen && (
      frozen.includedRuleIds.length > 0 ||
      frozen.includedRules.length > 0 ||
      frozen.includedWeakPointKeys.length > 0 ||
      frozen.includedLegacyNoteIds.length > 0 ||
      frozen.renderedKernel.trim() !== ''
    ),
  );
}

export function snapshotFromSessionFrozen(
  frozen: ParsedFrozenMemorySnapshot,
): MessageMemoryAttributionSnapshot {
  const frozenById = new Map(frozen.includedRules.map((rule) => [rule.id, rule]));
  const orderedIds = Array.from(
    new Set([
      ...frozen.includedRuleIds,
      ...frozen.includedRules.map((rule) => rule.id),
    ]),
  );

  const rules: SnapshotMemoryRule[] = orderedIds.map((ruleId) => {
    const frozenRule = frozenById.get(ruleId);
    return {
      id: ruleId,
      instruction: frozenRule?.instruction ?? ruleId,
      scope: frozenRule?.scope ?? 'global',
      pinned: frozenRule?.pinned ?? false,
    };
  });

  const weakPoints: SnapshotMemoryWeakPoint[] = frozen.includedWeakPointKeys.map((key) => {
    const sepIndex = key.indexOf(':');
    return {
      subject: sepIndex > 0 ? key.slice(0, sepIndex) : '',
      knowledge_point: sepIndex > 0 ? key.slice(sepIndex + 1) : key,
    };
  });

  return {
    rules,
    weakPoints,
    goals: [],
    renderedKernel: frozen.renderedKernel,
    rulesVersion: frozen.rulesVersion,
    profileVersion: frozen.profileVersion,
    capturedAt: Date.now(),
  };
}

export function snapshotFromInspectionView(
  view: MemoryInspectionView,
): MessageMemoryAttributionSnapshot {
  const liveRules = view.hardRules?.rules ?? [];
  const liveWeakPoints = view.learnerProfile?.weak_points ?? [];
  const liveGoals = view.learnerProfile?.goals ?? [];

  return {
    rules: liveRules.map((rule) => ({
      id: rule.id,
      instruction: rule.instruction,
      scope: rule.scope,
      pinned: Boolean(rule.pinned),
    })),
    weakPoints: liveWeakPoints.map((wp) => ({
      subject: wp.subject,
      knowledge_point: wp.knowledge_point,
    })),
    goals: liveGoals.map((goalItem) => ({
      goal: goalItem.goal,
    })),
    renderedKernel: typeof view.renderedKernelPreview === 'string' ? view.renderedKernelPreview : '',
    rulesVersion: typeof view.hardRules?.version === 'number' ? view.hardRules.version : 0,
    profileVersion: typeof view.learnerProfile?.version === 'number' ? view.learnerProfile.version : 0,
    capturedAt: Date.now(),
  };
}

export function parseMessageMemorySnapshot(
  raw: unknown,
): MessageMemoryAttributionSnapshot | null {
  if (!isRecord(raw)) return null;

  // Format 1: structured MessageMemoryAttributionSnapshot
  if (Array.isArray(raw.rules)) {
    const rules: SnapshotMemoryRule[] = [];
    for (const item of raw.rules) {
      if (!isRecord(item)) continue;
      if (typeof item.id === 'string' && typeof item.instruction === 'string') {
        rules.push({
          id: item.id,
          instruction: item.instruction,
          scope: typeof item.scope === 'string' ? item.scope : 'global',
          pinned: Boolean(item.pinned),
        });
      }
    }
    const weakPoints: SnapshotMemoryWeakPoint[] = [];
    if (Array.isArray(raw.weakPoints)) {
      for (const item of raw.weakPoints) {
        if (!isRecord(item)) continue;
        if (typeof item.knowledge_point === 'string') {
          weakPoints.push({
            subject: typeof item.subject === 'string' ? item.subject : '',
            knowledge_point: item.knowledge_point,
          });
        }
      }
    }
    const goals: SnapshotMemoryGoal[] = [];
    if (Array.isArray(raw.goals)) {
      for (const item of raw.goals) {
        if (typeof item === 'string' && item.trim()) {
          goals.push({ goal: item });
        } else if (isRecord(item) && typeof item.goal === 'string' && item.goal.trim()) {
          goals.push({ goal: item.goal });
        }
      }
    }
    return {
      rules,
      weakPoints,
      goals,
      renderedKernel: typeof raw.renderedKernel === 'string' ? raw.renderedKernel : '',
      rulesVersion: typeof raw.rulesVersion === 'number' ? raw.rulesVersion : 0,
      profileVersion: typeof raw.profileVersion === 'number' ? raw.profileVersion : 0,
      capturedAt: typeof raw.capturedAt === 'number' ? raw.capturedAt : Date.now(),
    };
  }

  // Format 2: backend memoryKernelSnapshot shape
  if (
    Array.isArray(raw.includedRules) ||
    Array.isArray(raw.includedRuleIds) ||
    Array.isArray(raw.includedWeakPointKeys) ||
    typeof raw.renderedKernel === 'string'
  ) {
    const frozen = parseFrozenMemorySnapshot({ memoryKernelSnapshot: raw });
    if (frozen) {
      return snapshotFromSessionFrozen(frozen);
    }
  }

  return null;
}

export function extractMessageMemorySnapshotFromMeta(
  messageMeta: Record<string, unknown> | null | undefined,
): MessageMemoryAttributionSnapshot | null {
  if (!isRecord(messageMeta)) return null;
  return (
    parseMessageMemorySnapshot(messageMeta.memoryAttributionSnapshot) ??
    parseMessageMemorySnapshot(messageMeta.memoryKernelSnapshot) ??
    null
  );
}

function loadCache(): Map<string, MessageMemoryAttributionSnapshot> {
  if (memorySnapshotCache) return memorySnapshotCache;
  memorySnapshotCache = new Map();
  if (typeof window === 'undefined' || !window.localStorage) {
    return memorySnapshotCache;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return memorySnapshotCache;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return memorySnapshotCache;
    for (const [key, value] of Object.entries(parsed)) {
      const snap = parseMessageMemorySnapshot(value);
      if (snap) {
        memorySnapshotCache.set(key, snap);
      }
    }
  } catch {
    // Ignore storage read errors in restricted environments.
  }
  return memorySnapshotCache;
}

function persistCache(cache: Map<string, MessageMemoryAttributionSnapshot>): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    while (cache.size > MAX_PERSISTED_SNAPSHOTS) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(cache.entries())));
  } catch {
    // Ignore quota / private-mode storage errors.
  }
}

export function getPersistedMessageMemorySnapshot(
  key: string | null,
): MessageMemoryAttributionSnapshot | null {
  if (!key) return null;
  const found = loadCache().get(key);
  return found ? cloneSnapshot(found) : null;
}

/**
 * Write-once persistence: once a message has captured its memory attribution snapshot,
 * subsequent calls for the same key return the existing immutable snapshot without mutating it.
 */
export function savePersistedMessageMemorySnapshot(
  key: string,
  snapshot: MessageMemoryAttributionSnapshot,
): MessageMemoryAttributionSnapshot {
  const cache = loadCache();
  const existing = cache.get(key);
  if (existing) {
    return cloneSnapshot(existing);
  }
  const cloned = cloneSnapshot(snapshot);
  cache.set(key, cloned);
  persistCache(cache);
  return cloneSnapshot(cloned);
}

export function clearPersistedMessageMemorySnapshots(): void {
  memorySnapshotCache = new Map();
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore storage errors.
    }
  }
}
